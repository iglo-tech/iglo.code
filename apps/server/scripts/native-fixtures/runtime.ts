// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off -- External protocol/native fixture with bounded process deadlines.
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/bunRuntime";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
  resolveHostModuleUrl,
} from "@t3tools/shared/hostProcess";
import * as BunPtyAdapter from "../../src/terminal/BunPtyAdapter.ts";
import type { PtyExitEvent, PtyProcess } from "../../src/terminal/PtyAdapter.ts";
import * as WorkspaceSearchIndex from "../../src/workspace/WorkspaceSearchIndex.ts";
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  makeAntigravityStderrHandler,
  prepareAntigravityProfile,
} from "../../src/provider/antigravityAuthSupport.ts";

const workspace = process.env.T3_NATIVE_SMOKE_WORKSPACE!;
const platform = await Effect.runPromise(HostProcessPlatform);
NodeAssert.strict.equal(
  await Effect.runPromise(HostProcessIsExecutable),
  process.env.T3_NATIVE_SMOKE_COMPILED === "true",
);
for (const [name, pinned] of [
  ["@ff-labs/fff-node", "0.9.4"],
  ["@napi-rs/keyring", "1.3.0"],
]) {
  const manifest = JSON.parse(
    await NodeFSP.readFile(
      NodePath.join(process.cwd(), "node_modules", name!, "package.json"),
      "utf8",
    ),
  );
  NodeAssert.strict.equal(
    manifest.version,
    pinned,
    `Native smoke must exercise the pinned ${name}`,
  );
}

function observePty(pty: PtyProcess, marker: string) {
  let output = "";
  const ready = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<PtyExitEvent>();
  const timer = setTimeout(() => {
    ready.reject(new Error(`PTY did not emit ${marker}`));
    exited.reject(new Error("PTY did not exit"));
  }, 10_000);
  const stopData = pty.onData((data) => {
    output += data;
    if (output.includes(marker)) ready.resolve();
  });
  const stopExit = pty.onExit((event) => {
    clearTimeout(timer);
    if (!output.includes(marker)) ready.reject(new Error("PTY exited before readiness"));
    exited.resolve(event);
  });
  // Both promises are observed immediately, including failure cleanup.
  void ready.promise.catch(() => {});
  void exited.promise.catch(() => {});
  return {
    ready: ready.promise,
    exited: exited.promise,
    output: () => output,
    dispose: () => {
      clearTimeout(timer);
      stopData();
      stopExit();
    },
  };
}

const adapter = await Effect.runPromise(BunPtyAdapter.make());
for (const mode of ["io", "kill", "interrupt"]) {
  const pty = await Effect.runPromise(
    adapter.spawn({
      shell: "/bin/sh",
      args: [
        "-c",
        mode !== "io"
          ? "printf 'PTY-READY\\n'; read waiting"
          : "printf 'PTY-READY\\n'; read value; printf '<input:%s>\\n🐧\\n' \"$value\"; stty size; i=0; while [ \"$i\" -lt 2000 ]; do printf '終'; i=$((i + 1)); done; printf 'STREAM-END\\n'; exit 7",
      ],
      cwd: workspace,
      cols: 80,
      rows: 24,
      env: process.env,
    }),
  );
  const observed = observePty(pty, "PTY-READY");
  let exited = false;
  try {
    await observed.ready;
    if (mode === "kill") pty.kill("SIGTERM");
    else if (mode === "interrupt") pty.write("\x03");
    else {
      pty.resize(100, 41);
      pty.write("bun-pty-input\r");
    }
    const event = await observed.exited;
    exited = true;
    if (mode === "kill") NodeAssert.strict.equal(event.signal, 15);
    else if (mode === "interrupt") NodeAssert.strict.equal(event.signal, 2);
    else {
      NodeAssert.strict.equal(event.exitCode, 7);
      NodeAssert.strict.match(observed.output(), /<input:bun-pty-input>/);
      NodeAssert.strict.match(observed.output(), /41\s+100/);
      NodeAssert.strict.match(observed.output(), /🐧/u);
      NodeAssert.strict.equal(observed.output().match(/終/gu)?.length, 2000);
      NodeAssert.strict.match(observed.output(), /STREAM-END/);
    }
    NodeAssert.strict.throws(() => process.kill(pty.pid, 0), /No such process|ESRCH/);
  } finally {
    if (!exited) {
      pty.kill("SIGKILL");
      await observed.exited.catch(() => {});
    }
    observed.dispose();
  }
}
process.stdout.write("Bun PTY input, resize, exit and captured-child cleanup passed.\n");

await NodeFSP.mkdir(NodePath.join(workspace, "src"));
await NodeFSP.writeFile(
  NodePath.join(workspace, "src/needle.ts"),
  "const native = 'bun-native-needle';\n",
);
await Effect.runPromise(
  Effect.gen(function* () {
    const index = yield* WorkspaceSearchIndex.make(workspace, "content");
    const paths = yield* index.search("needle", 10, "file");
    NodeAssert.strict.deepEqual(paths.entries, [{ path: "src/needle.ts", kind: "file" }]);
    const content = yield* index.searchContents({
      query: "bun-native-needle",
      limit: 10,
      caseSensitive: true,
      wholeWord: false,
      useRegex: false,
    });
    NodeAssert.strict.deepEqual(
      content.matches.map(({ path, lineNumber }) => ({ path, lineNumber })),
      [{ path: "src/needle.ts", lineNumber: 1 }],
    );
  }).pipe(Effect.scoped),
);
process.stdout.write("Pinned fff native path/content search and scoped index disposal passed.\n");

const requireNative = NodeModule.createRequire(resolveHostModuleUrl(import.meta.url));
const keyring = requireNative("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
// Read only a new, absent identity. Never inspect, write or delete a user's credentials.
try {
  const entry = new keyring.AsyncEntry(
    `iglo-native-smoke-${process.pid}-${NodePath.basename(NodePath.dirname(workspace))}`,
    "absent-smoke-account",
  );
  const password = await entry.getPassword(AbortSignal.timeout(5_000));
  NodeAssert.strict.ok(password === null || password === undefined);
  process.stdout.write("Pinned keyring loaded; absent-entry read passed (no live credentials).\n");
} catch (cause) {
  if (
    platform !== "linux" ||
    !(cause instanceof Error) ||
    !/platform|storage|dbus|secret service|no entry/i.test(cause.message)
  )
    throw cause;
  process.stdout.write(
    `Pinned keyring loaded; host credential storage unavailable: ${cause.message}\n`,
  );
}

const compiled = process.env.T3_NATIVE_SMOKE_COMPILED === "true";
const application = process.env.T3_NATIVE_SMOKE_APPLICATION!;
const hostExecutable = compiled ? application : process.execPath;
const provideHost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(HostProcessExecutablePath, hostExecutable),
    Effect.provideService(HostProcessIsExecutable, compiled),
    Effect.provideService(HostProcessArguments, [hostExecutable, application]),
    Effect.provideService(HostProcessEnvironment, process.env),
    Effect.provide(NodeServices.layer),
  );
const invocation = await Effect.runPromise(provideHost(resolveSelfInvocation()));
function runChild(command: string, args: ReadonlyArray<string>, env = process.env, stdin = "") {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      command,
      [...args],
      { cwd: workspace, env, timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          NodeAssert.strict.throws(() => process.kill(child.pid!, 0), /No such process|ESRCH/);
          resolve({ stdout, stderr });
        } catch (cause) {
          reject(cause);
        }
      },
    );
    child.stdin?.end(stdin);
  });
}

const requests: string[] = [];
let endpointFailure: unknown;
const endpoint = NodeHttp.createServer(async (request, response) => {
  try {
    NodeAssert.strict.equal(request.headers.authorization, "Bearer native-smoke-fixture");
    let body = "";
    for await (const data of request) body += data;
    const rpc = JSON.parse(body) as {
      method: string;
      id?: number;
      params?: { arguments?: unknown };
    };
    requests.push(rpc.method);
    if (rpc.method !== "initialize") {
      NodeAssert.strict.equal(request.headers["mcp-session-id"], "native-smoke-session");
      NodeAssert.strict.equal(request.headers["mcp-protocol-version"], "2025-06-18");
    }
    if (rpc.method === "initialize") {
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "native-smoke-session",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "native-fixture", version: "1" },
          },
        }),
      );
    } else if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
    } else {
      NodeAssert.strict.equal(rpc.method, "tools/call");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { echo: rpc.params?.arguments } } })}\n\n`,
      );
    }
  } catch (cause) {
    endpointFailure = cause;
    response.writeHead(500);
    response.end("Fixture request failed");
  }
});
endpoint.listen(0, "127.0.0.1");
await NodeEvents.EventEmitter.once(endpoint, "listening");
try {
  const address = endpoint.address();
  NodeAssert.strict.ok(address !== null && typeof address !== "string");
  const env = {
    ...process.env,
    T3_ACP_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/mcp`,
    T3_ACP_MCP_AUTHORIZATION: "Bearer native-smoke-fixture",
  };
  const bridge = await runChild(
    invocation.command,
    selfInvocationArgs(invocation, ["acp-mcp-bridge"]),
    env,
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "native-smoke", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "bun-bridge" } },
      },
    ]
      .map((rpc) => JSON.stringify(rpc))
      .join("\n") + "\n",
  );
  NodeAssert.strict.equal(bridge.stderr, "");
  const replies = bridge.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  NodeAssert.strict.deepEqual(
    replies.map((reply) => reply.id),
    [1, 2],
  );
  NodeAssert.strict.deepEqual(replies[1].result.structuredContent, {
    echo: { text: "bun-bridge" },
  });
  const call = await runChild(
    invocation.command,
    selfInvocationArgs(invocation, ["acp-mcp-call", "echo", '{"text":"bun-call"}']),
    env,
  );
  NodeAssert.strict.deepEqual(JSON.parse(call.stdout), {
    structuredContent: { echo: { text: "bun-call" } },
  });
  if (endpointFailure) throw endpointFailure;
  NodeAssert.strict.deepEqual(requests, [
    "initialize",
    "notifications/initialized",
    "tools/call",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
} finally {
  await new Promise<void>((resolve, reject) =>
    endpoint.close((error) => (error ? reject(error) : resolve())),
  );
}
process.stdout.write(
  "ACP bridge and tool self-invocation passed with JSON/SSE and authenticated session reuse.\n",
);

const profile = await Effect.runPromise(
  provideHost(
    prepareAntigravityProfile({
      profileDirectory: NodePath.join(process.env.HOME!, "antigravity"),
      userHome: process.env.HOME!,
      baseEnv: process.env,
    }),
  ),
);
const authorizationUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=native-fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A14271%2F";
const relayed = await runChild("/bin/sh", [
  "-c",
  profile.browserCommand.replace("%s", authorizationUrl),
]);
NodeAssert.strict.equal(relayed.stdout, "");
NodeAssert.strict.equal(
  relayed.stderr,
  `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(authorizationUrl)}\n`,
);
const urls: string[] = [];
const handleStderr = makeAntigravityStderrHandler({
  onAuthorizationUrl: (url) =>
    Effect.sync(() => {
      urls.push(url);
    }),
});
await Effect.runPromise(handleStderr(relayed.stderr));
NodeAssert.strict.deepEqual(urls, [authorizationUrl]);
process.stdout.write(
  "Antigravity isolated profile, Bun relay preflight and authorization URL delivery passed.\n",
);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as Schema from "effect/Schema";
import {
  AuthSessionState,
  AuthWebSocketTicketResult,
  AuthMcpAuthorizationServerMetadata,
  AuthMcpRegisteredClient,
  AuthMcpApprovalDetails,
  AuthMcpApprovalRedirect,
  AuthMcpTokenResult,
  ExecutionEnvironmentDescriptor,
  Project,
  ProjectSnapshot,
} from "@t3tools/contracts";

const decodeExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
  Schema.toCodecJson(ExecutionEnvironmentDescriptor),
);
const decodeAuthSessionState = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState));
const decodeAuthWebSocketTicketResult = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthWebSocketTicketResult),
);
const decodeProject = Schema.decodeUnknownSync(Schema.toCodecJson(Project));
const decodeProjectSnapshot = Schema.decodeUnknownSync(Schema.toCodecJson(ProjectSnapshot));
const decodeMcpMetadata = Schema.decodeUnknownSync(
  Schema.toCodecJson(AuthMcpAuthorizationServerMetadata),
);
const decodeMcpClient = Schema.decodeUnknownSync(Schema.toCodecJson(AuthMcpRegisteredClient));
const decodeMcpApproval = Schema.decodeUnknownSync(Schema.toCodecJson(AuthMcpApprovalDetails));
const decodeMcpRedirect = Schema.decodeUnknownSync(Schema.toCodecJson(AuthMcpApprovalRedirect));
const decodeMcpToken = Schema.decodeUnknownSync(Schema.toCodecJson(AuthMcpTokenResult));
const decodeMcpInitialized = Schema.decodeUnknownSync(
  Schema.Struct({ result: Schema.Struct({ protocolVersion: Schema.String }) }),
);
const decodeMcpTools = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  }),
);
const decodeMcpToolResult = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      content: Schema.Array(Schema.Unknown),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  }),
);

export const redactEnvironmentLog = (value: string) =>
  value
    .replace(/(token=)[^\s"'<>]+/g, "$1<redacted>")
    .replace(/(Token: )[^\s]+/g, "$1<redacted>")
    .replace(/^[ \t]*[\u2580-\u259f ][\u2580-\u259f \t]*$/gm, "");

const collectProcess = (child: NodeChildProcess.ChildProcess) => {
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return () => redactEnvironmentLog(output);
};

async function run(
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env = process.env,
) {
  const child = NodeChildProcess.spawn(executable, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectProcess(child);
  const [code] = await NodeEvents.EventEmitter.once(child, "exit");
  NodeAssert.equal(code, 0, output());
  return output();
}

export type EnvironmentSmokeInput =
  | { readonly kind: "source"; readonly repoRoot: string; readonly bun: string }
  | { readonly kind: "archive"; readonly archive: string; readonly expectVersion: string };

/** One disposable environment fixture for API checks and the real web-client suite. */
export async function createEnvironmentFixture(
  input: EnvironmentSmokeInput,
  options: {
    readonly prepare?: (paths: {
      readonly scratch: string;
      readonly home: string;
      readonly workspace: string;
      readonly interpreter: string;
    }) => Promise<NodeJS.ProcessEnv>;
  } = {},
) {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-environment-smoke-"));
  const home = NodePath.join(scratch, "home");
  const workspace = NodePath.join(scratch, "workspace");
  await NodeFSP.mkdir(home);
  await NodeFSP.mkdir(workspace);
  let executable: string;
  let args: ReadonlyArray<string>;
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  if (input.kind === "archive") {
    await run("/usr/bin/tar", ["-xf", input.archive, "-C", scratch], scratch);
    const root = (await NodeFSP.readdir(scratch)).find(
      (name) => name !== "home" && name !== "workspace",
    );
    NodeAssert.ok(root, "The archive must contain an install directory.");
    cwd = NodePath.join(scratch, root);
    executable = NodePath.join(cwd, "t3");
    // No system Node, npm or Bun; helper execution must use the archive's runtime/bun.
    env = { PATH: "", HOME: home, SHELL: "/bin/sh", TMPDIR: scratch, T3CODE_HOME: home };
    const version = await run(executable, ["--version"], cwd, env);
    NodeAssert.ok(version.includes(input.expectVersion), `Unexpected CLI version: ${version}`);
    const reservation = NodeNet.createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    const address = reservation.address();
    NodeAssert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    args = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
      "--base-dir",
      home,
    ];
  } else {
    executable = input.bun;
    cwd = input.repoRoot;
    args = ["scripts/dev-runner.ts", "dev", "--home-dir", home];
    env = {
      HOME: home,
      SHELL: "/bin/sh",
      TMPDIR: scratch,
      PATH: `${NodePath.join(cwd, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`,
      T3CODE_HOME: home,
      T3CODE_DEV_INSTANCE: scratch,
      T3CODE_DEV_AUTH_TOKEN: "",
      T3CODE_DEV_ALLOWED_ORIGINS: "http://remote-client.example.test",
    };
    delete env.VITE_HTTP_URL;
    delete env.VITE_WS_URL;
  }
  const interpreter = input.kind === "archive" ? NodePath.join(cwd, "runtime/bun") : input.bun;
  const prepared = await options.prepare?.({ scratch, home, workspace, interpreter });
  env = { ...env, ...prepared };
  let server: NodeChildProcess.ChildProcess | undefined;
  let output = () => "";
  let pairingUrl = "";
  let serverOrigin = "";
  let cookie = "";
  const stop = async () => {
    if (server === undefined || server.exitCode !== null || server.signalCode !== null) return;
    const exited = NodeEvents.EventEmitter.once(server, "exit");
    // The captured process group contains only this fixture's Vite/server children.
    process.kill(-server.pid!, "SIGTERM");
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Server did not stop within 15s.")),
            15_000,
          );
          timeout.unref();
        }),
      ]);
    } catch (error) {
      process.kill(-server.pid!, "SIGKILL");
      await exited;
      throw error;
    }
  };
  const start = async () => {
    server = NodeChildProcess.spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (process.env.T3_SMOKE_DEBUG)
      console.error(`[environment-smoke] spawned pid=${server.pid} executable=${executable}`);
    output = collectProcess(server);
    // The server's published pairing URL is an observable startup milestone.
    // Readiness never depends on a fixed sleep or repeated domain assertions.
    pairingUrl = await new Promise<string>((resolve, reject) => {
      const child = server!;
      let startup = "";
      const timeout = setTimeout(
        () => reject(new Error(`Startup deadline exceeded.\n${output()}`)),
        90_000,
      );
      const inspect = (chunk: Buffer) => {
        if (process.env.T3_SMOKE_DEBUG)
          process.stderr.write(redactEnvironmentLog(chunk.toString()));
        startup += chunk.toString();
        const match = /https?:\/\/[^\s"'<>]+\/pair[?#]token=[^\s"'<>]+/.exec(startup);
        if (!match) return;
        serverOrigin =
          /Listening on (https?:\/\/[^\s]+)/.exec(startup)?.[1] ?? new URL(match[0]).origin;
        clearTimeout(timeout);
        child.stdout?.off("data", inspect);
        child.stderr?.off("data", inspect);
        resolve(match[0]);
      };
      child.stdout?.on("data", inspect);
      child.stderr?.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited (${code ?? signal}).\n${output()}`));
      });
    });
    return pairingUrl;
  };
  const request = async (route: string, options: RequestInit = {}): Promise<Response> => {
    if (process.env.T3_SMOKE_DEBUG)
      console.error(`[environment-smoke] ${options.method ?? "GET"} ${route}`);
    const response = await fetch(new URL(route, pairingUrl), {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { ...(cookie ? { cookie } : {}), ...options.headers },
    }).catch((error: unknown) => {
      throw new Error(`${options.method ?? "GET"} ${route}: ${String(error)}\n${output()}`);
    });
    // Drain bounded API responses even when a caller only needs their headers.
    // This releases the client's connection before restart or the next request.
    const body = await response.arrayBuffer();
    NodeAssert.ok(
      response.ok,
      `${options.method ?? "GET"} ${route}: ${response.status} ${new TextDecoder().decode(body)}\n${output()}`,
    );
    return new Response(body, { status: response.status, headers: response.headers });
  };
  try {
    await start();
  } catch (error) {
    await stop();
    await NodeFSP.rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return {
    scratch,
    home,
    workspace,
    input,
    get origin() {
      return new URL(pairingUrl).origin;
    },
    get pairingUrl() {
      return pairingUrl;
    },
    get serverOrigin() {
      return serverOrigin;
    },
    get log() {
      return output();
    },
    request,
    async pair() {
      const url = new URL(pairingUrl);
      const credential =
        url.searchParams.get("token") ?? new URLSearchParams(url.hash.slice(1)).get("token");
      NodeAssert.ok(credential, "The startup URL must carry a pairing credential.");
      const response = await request("/api/auth/browser-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const header = response.headers.get("set-cookie");
      NodeAssert.ok(header, "Pairing must issue a session cookie.");
      NodeAssert.match(header, /HttpOnly/i);
      cookie = header.split(";", 1)[0]!;
      return cookie;
    },
    async restart() {
      await stop();
      return start();
    },
    stop,
    async dispose() {
      await stop();
      await NodeFSP.rm(scratch, { recursive: true, force: true });
    },
  };
}

export type EnvironmentFixture = Awaited<ReturnType<typeof createEnvironmentFixture>>;

/** Public OAuth and MCP round trip, including redirects, response headers and session cleanup. */
async function checkMcp(fixture: EnvironmentFixture) {
  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const metadata = decodeMcpMetadata(
    await (await fixture.request("/.well-known/oauth-authorization-server")).json(),
  );
  NodeAssert.equal(metadata.issuer, fixture.origin);
  const registered = await fixture.request(
    "/oauth/mcp/register",
    jsonPost({
      client_name: "Runtime acceptance",
      redirect_uris: ["http://localhost:51234/callback"],
      token_endpoint_auth_method: "none",
    }),
  );
  NodeAssert.equal(registered.headers.get("cache-control"), "no-store");
  const client = decodeMcpClient(await registered.json());
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost:51234/callback",
    code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "runtime-acceptance",
    resource: `${fixture.origin}/mcp`,
  };
  const redirect = await fetch(
    new URL(`/oauth/mcp/authorize?${new URLSearchParams(authorization)}`, fixture.origin),
    {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  NodeAssert.equal(redirect.status, 302);
  NodeAssert.ok(redirect.headers.get("location")?.startsWith("/connect-agent?"));
  NodeAssert.equal(redirect.headers.get("cache-control"), "no-store");
  const approval = decodeMcpApproval(
    await (await fixture.request("/oauth/mcp/approval", jsonPost(authorization))).json(),
  );
  NodeAssert.ok(approval.csrfToken);
  const approved = decodeMcpRedirect(
    await (
      await fixture.request(
        "/oauth/mcp/decision",
        jsonPost({
          authorization,
          decision: {
            _tag: "browser-session",
            access: "read-only",
            csrfToken: approval.csrfToken,
          },
        }),
      )
    ).json(),
  );
  const callback = new URL(approved.redirectTo);
  NodeAssert.equal(callback.searchParams.get("state"), authorization.state);
  NodeAssert.equal(callback.searchParams.get("iss"), fixture.origin);
  const code = callback.searchParams.get("code");
  NodeAssert.ok(code);
  const tokenResponse = await fixture.request("/oauth/mcp/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: authorization.redirect_uri,
      code_verifier: verifier,
      resource: authorization.resource,
    }),
  });
  NodeAssert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  const token = decodeMcpToken(await tokenResponse.json());
  let sessionId = "";
  const rpc = async (id: number, method: string, params?: unknown) => {
    const response = await fixture.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    sessionId ||= response.headers.get("mcp-session-id") ?? "";
    const text = await response.text();
    const payload =
      text.startsWith("data:") || text.startsWith("event:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : text;
    NodeAssert.ok(payload, "MCP must return a JSON-RPC response.");
    return JSON.parse(payload) as unknown;
  };
  const initialized = decodeMcpInitialized(
    await rpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "runtime-acceptance", version: "1" },
    }),
  );
  NodeAssert.equal(initialized.result.protocolVersion, "2025-06-18");
  const tools = decodeMcpTools(await rpc(2, "tools/list"));
  NodeAssert.ok(tools.result.tools.some((tool) => tool.name === "orchestrator_capabilities"));
  const called = decodeMcpToolResult(
    await rpc(3, "tools/call", { name: "orchestrator_capabilities", arguments: {} }),
  );
  NodeAssert.notEqual(called.result.isError, true);
  NodeAssert.ok(called.result.content.length > 0);
  await fixture.request("/mcp", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token.access_token}`, "mcp-session-id": sessionId },
  });
}

/** Exercises the public transport/persistence boundary in both launch forms. */
export async function checkEnvironment(fixture: EnvironmentFixture) {
  if (process.env.T3_SMOKE_DEBUG) console.error("[environment-smoke] checking transport");
  const descriptor = decodeExecutionEnvironmentDescriptor(
    await (await fixture.request("/.well-known/t3/environment")).json(),
  );
  await fixture.pair();
  const session = decodeAuthSessionState(await (await fixture.request("/api/auth/session")).json());
  NodeAssert.ok(session.authenticated, "Pairing must authenticate subsequent requests.");
  const client = await fixture.request("/");
  NodeAssert.ok((await client.text()).includes("<html"), "The web client must be served.");
  const cors = await fixture.request(new URL("/api/auth/session", fixture.serverOrigin).href, {
    method: "OPTIONS",
    headers: {
      origin: "http://remote-client.example.test",
      "access-control-request-method": "GET",
    },
  });
  NodeAssert.ok(
    cors.headers.has("access-control-allow-origin"),
    "CORS headers must survive packaging.",
  );
  const ticket = decodeAuthWebSocketTicketResult(
    await (await fixture.request("/api/auth/websocket-ticket", { method: "POST" })).json(),
  );
  const socketUrl = new URL("/ws", fixture.origin);
  socketUrl.protocol = "ws:";
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  socketUrl.searchParams.set("orchestrationProtocol", "2");
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket upgrade deadline exceeded."));
    }, 10_000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket upgrade failed."));
      },
      { once: true },
    );
  });
  socket.close();
  await checkMcp(fixture);
  const projectId = NodeCrypto.randomUUID();
  const project = decodeProject(
    await (
      await fixture.request("/api/projects/mutate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "project.create",
          projectId,
          commandId: NodeCrypto.randomUUID(),
          title: "Runtime smoke project",
          workspaceRoot: fixture.workspace,
        }),
      })
    ).json(),
  );
  NodeAssert.equal(project.id, projectId);
  if (process.env.T3_SMOKE_DEBUG) console.error("[environment-smoke] restarting");
  await fixture.restart();
  const restored = decodeProjectSnapshot(await (await fixture.request("/api/projects")).json());
  NodeAssert.ok(
    restored.projects.some((entry) => entry.id === projectId),
    "Projects and session authentication must survive restart.",
  );
  const after = decodeExecutionEnvironmentDescriptor(
    await (await fixture.request("/.well-known/t3/environment")).json(),
  );
  NodeAssert.equal(after.environmentId, descriptor.environmentId);
}

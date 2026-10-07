#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - this external smoke harness owns disposable helper processes and state.
/** Installs and exercises the pinned Device packages with no Node or npm on PATH. */
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DeviceToolVersions } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { BUN_VERSION } from "@t3tools/shared/bunRuntime";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../src/processRunner.ts";
import {
  AGENT_DEVICE_VERSION,
  ensureAgentDevice,
  ensureDeviceHub,
} from "../src/device/DeviceToolchain.ts";
import { remoteDeviceScript } from "../src/device/sshDeviceScript.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "iglo-device-bun-smoke-"));
const bun = process.execPath;
const bin = NodePath.join(scratch, "bin");
const state = NodePath.join(scratch, "agent-state");
await NodeFSP.mkdir(bin);
await NodeFSP.mkdir(state);
await NodeFSP.symlink(bun, NodePath.join(bin, "bun"));
// These are independent OS tools. Deliberately omit node, npm and npx,
// including on Linux where they may otherwise live in /usr/bin.
for (const command of [
  "sh",
  "bash",
  "env",
  "ps",
  "kill",
  "tar",
  "gzip",
  "uname",
  "chmod",
  "mkdir",
  "rm",
  "cp",
  "which",
  "file",
]) {
  try {
    const executable = NodeChildProcess.execFileSync("/bin/sh", ["-c", `command -v ${command}`], {
      encoding: "utf8",
    }).trim();
    if (executable.startsWith("/")) await NodeFSP.symlink(executable, NodePath.join(bin, command));
  } catch {
    // Some optional OS tools are absent on minimal CI hosts.
  }
}
// No physical device or SDK is required for readiness and unavailable-device flows.
await NodeFSP.writeFile(
  NodePath.join(bin, "adb"),
  "#!/bin/sh\nif [ \"$1\" = version ]; then echo 'Android Debug Bridge version 1.0.41'; else printf 'List of devices attached\\n\\n'; fi\n",
  { mode: 0o755 },
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: bin,
  HOME: scratch,
  ANDROID_HOME: "",
  ANDROID_SDK_ROOT: "",
  AGENT_DEVICE_STATE_DIR: state,
  AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
  AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
  AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;

const run = (args: ReadonlyArray<string>, cwd = scratch) =>
  exec(bun, [...args], { cwd, env, timeout: 650_000, maxBuffer: 8 * 1024 * 1024 });
let agentEntry: string | undefined;
let hub: ReturnType<typeof NodeChildProcess.spawn> | undefined;
let remoteStarted = false;
const Probe = Schema.Struct({
  bunPath: Schema.String,
  platforms: Schema.Array(Schema.Struct({ platform: Schema.String, available: Schema.Boolean })),
});
const Started = Schema.Struct({
  hubPort: Schema.Number,
  daemonPort: Schema.Number,
  tools: DeviceToolVersions,
});
const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  text: string,
) => Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text);
const remote = async (mode: "probe" | "agent-start" | "stop") => {
  const result = await run(["-e", remoteDeviceScript("smoke", mode)]);
  return result.stdout.trim();
};

try {
  NodeAssert.strict.equal((await run(["--version"])).stdout.trim(), BUN_VERSION);
  await NodeAssert.strict.rejects(exec("node", ["--version"], { env }));
  await NodeAssert.strict.rejects(exec("npm", ["--version"], { env }));
  const tools = await Effect.runPromise(
    Effect.all([ensureDeviceHub(scratch), ensureAgentDevice(scratch)]).pipe(
      Effect.provide(ProcessRunner.layer),
      Effect.provideService(HostProcessEnvironment, env),
      Effect.provide(NodeServices.layer),
    ),
  );
  const [hubTool, agentTool] = tools;
  agentEntry = agentTool.entryPath;
  // Loading the WebRTC addon proves its required prebuild install step completed.
  await run(
    [
      "-e",
      "const {PeerConnection,cleanup}=require('node-datachannel');const peer=new PeerConnection('bun-smoke',{iceServers:[]});peer.close();cleanup();",
    ],
    hubTool.installDir,
  );
  const port = await Effect.runPromise(
    NetService.NetService.pipe(
      Effect.flatMap((net) => net.reserveLoopbackPort()),
      Effect.scoped,
      Effect.provide(NetService.layer),
    ),
  );
  hub = NodeChildProcess.spawn(
    bun,
    [hubTool.entryPath, "--port", String(port), "--host", "127.0.0.1", "--platform", "android"],
    { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const runningHub = hub;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Device hub did not become ready")), 30_000);
    let output = "";
    runningHub.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Expo Device Hub ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    runningHub.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    runningHub.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    runningHub.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Device hub exited before readiness (${code})`));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  NodeAssert.strict.equal((await fetch(`${origin}/readyz`)).status, 200);
  NodeAssert.strict.match(await (await fetch(origin)).text(), /<!DOCTYPE html>/i);
  const devices = decode(
    Schema.Struct({ emulators: Schema.Array(Schema.Unknown) }),
    await (await fetch(`${origin}/api/devices`)).text(),
  );
  NodeAssert.strict.deepEqual(devices.emulators, []);
  const listed = decode(
    Schema.Struct({ success: Schema.Boolean }),
    (await run([agentEntry, "devices", "--json"])).stdout,
  );
  NodeAssert.strict.equal(listed.success, true);
  const daemon = decode(
    Schema.Struct({ version: Schema.String, pid: Schema.Number, httpPort: Schema.Number }),
    await NodeFSP.readFile(NodePath.join(state, "daemon.json"), "utf8"),
  );
  NodeAssert.strict.equal(daemon.version, AGENT_DEVICE_VERSION);
  NodeAssert.strict.equal((await fetch(`http://127.0.0.1:${daemon.httpPort}/health`)).status, 200);
  const command = (
    await exec(NodePath.join(bin, "ps"), ["-p", String(daemon.pid), "-o", "command="], { env })
  ).stdout;
  NodeAssert.strict.ok(command.includes(bun), "Nested agent daemon must use the Bun interpreter");
  await run([agentEntry, "daemon", "stop", "--state-dir", state]);
  await NodeAssert.strict.rejects(fetch(`http://127.0.0.1:${daemon.httpPort}/health`));
  const probed = decode(Probe, await remote("probe"));
  NodeAssert.strict.equal(probed.bunPath, bun);
  NodeAssert.strict.equal(
    probed.platforms.find((platform) => platform.platform === "android")?.available,
    true,
  );
  remoteStarted = true;
  const started = decode(Started, await remote("agent-start"));
  NodeAssert.strict.equal((await fetch(`http://127.0.0.1:${started.hubPort}/readyz`)).status, 200);
  NodeAssert.strict.equal(
    (await fetch(`http://127.0.0.1:${started.daemonPort}/health`)).status,
    200,
  );
  NodeAssert.strict.equal(started.tools.agent.runningVersion, AGENT_DEVICE_VERSION);
  await remote("stop");
  remoteStarted = false;
  await NodeAssert.strict.rejects(fetch(`http://127.0.0.1:${started.daemonPort}/health`));
  console.log(
    "Pinned Device installs, native WebRTC, hub HTTP, nested agent daemon and remote Bun bootstrap passed.",
  );
} finally {
  if (remoteStarted) await remote("stop").catch(() => {});
  if (agentEntry) await run([agentEntry, "daemon", "stop", "--state-dir", state]).catch(() => {});
  if (hub && hub.exitCode === null && hub.signalCode === null) {
    const runningHub = hub;
    const exited = new Promise<void>((resolve) => runningHub.once("exit", () => resolve()));
    hub.kill("SIGTERM");
    await exited;
  }
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}

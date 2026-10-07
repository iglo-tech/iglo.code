// @effect-diagnostics nodeBuiltinImport:off - Acceptance setup builds real executables and release archives served by a local HTTP fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient } from "effect/http";
import { cliArchiveFileName, cliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterAll, afterEach, beforeAll, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Layer from "effect/Layer";

import { readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_STOP_MARKER_FILE } from "./cloud/serviceProtocol.ts";
import { ensurePinnedRuntimeInstalled } from "./cloud/pinnedRuntime.ts";
import * as ProcessRunner from "./processRunner.ts";

// Set T3_SERVICE_TEST_EXECUTABLE to an extracted archive's t3 to exercise its
// public __service-launcher command. Otherwise compile the production launcher.
const fixtureDir = NodeURL.fileURLToPath(new URL("./testUtils/", import.meta.url));
const bun = NodeChildProcess.execFileSync(
  process.env.T3_BUN_EXECUTABLE ?? "bun",
  ["--print", "process.execPath"],
  {
    encoding: "utf8",
  },
).trim();
let buildDir: string;
let releaseServer: NodeHttp.Server;
let releaseBaseUrl: string;
const releaseFiles = new Map<string, Buffer>();
const releaseRequests: string[] = [];
const platform = HostProcessPlatform.defaultValue();
const arch = HostProcessArchitecture.defaultValue();
const platformKey = (() => {
  const key = cliArchivePlatformKey(platform, arch);
  if (!key)
    throw new Error(`Service runtime acceptance requires a supported target: ${platform}-${arch}`);
  return key;
})();
const launchers = new Set<NodeChildProcess.ChildProcess>();
const homes = new Set<string>();

beforeAll(async () => {
  buildDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-service-build-"));
  for (const name of ["launcher", "child"]) {
    const output = NodePath.join(buildDir, name);
    NodeChildProcess.execFileSync(bun, [
      "build",
      "--compile",
      "--compile-autoload-package-json",
      NodePath.join(fixtureDir, `serviceRuntime.${name}.ts`),
      "--outfile",
      output,
    ]);
    if (platform === "darwin")
      NodeChildProcess.execFileSync("codesign", ["--force", "--sign", "-", output]);
  }
  for (const mode of ["source", "compiled"] as const) {
    for (const version of ["1.0.0", "1.1.0"]) {
      const archiveName = cliArchiveFileName(version, platformKey);
      const archiveRoot = NodePath.join(buildDir, archiveName.replace(/\.tar\.gz$/, ""));
      await NodeFSP.mkdir(archiveRoot, { recursive: true });
      const executable = NodePath.join(archiveRoot, "t3");
      if (mode === "compiled") await NodeFSP.copyFile(NodePath.join(buildDir, "child"), executable);
      else
        await NodeFSP.writeFile(
          executable,
          `#!${bun}\nimport ${JSON.stringify(NodePath.join(fixtureDir, "serviceRuntime.child.ts"))};\n`,
        );
      await NodeFSP.chmod(executable, 0o755);
      const archivePath = NodePath.join(buildDir, `${mode}-${archiveName}`);
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        archivePath,
        "-C",
        buildDir,
        NodePath.basename(archiveRoot),
      ]);
      const archive = await NodeFSP.readFile(archivePath);
      const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      releaseFiles.set(`/${mode}/v${version}/${archiveName}`, archive);
      releaseFiles.set(
        `/${mode}/v${version}/SHA256SUMS`,
        Buffer.from(`${digest}  ${archiveName}\n`),
      );
    }
  }
  releaseServer = NodeHttp.createServer((request, response) => {
    releaseRequests.push(request.url ?? "");
    const body = releaseFiles.get(request.url ?? "");
    response.writeHead(body ? 200 : 404);
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    releaseServer.once("listening", resolve);
    releaseServer.once("error", reject);
    releaseServer.listen(0, "127.0.0.1");
  });
  const address = releaseServer.address();
  if (!address || typeof address === "string") throw new Error("Missing release fixture port");
  releaseBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const launcher of launchers) {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const closed = waitForClose(launcher);
      launcher.kill("SIGTERM");
      await closed;
    }
  }
  launchers.clear();
  for (const home of homes) await NodeFSP.rm(home, { recursive: true, force: true });
  homes.clear();
});
afterAll(async () => {
  if (releaseServer?.listening)
    await new Promise<void>((resolve, reject) =>
      releaseServer.close((error) => (error ? reject(error) : resolve())),
    );
  releaseFiles.clear();
  if (buildDir) await NodeFSP.rm(buildDir, { recursive: true, force: true });
});

type RuntimeEvent = {
  event: string;
  pid: number;
  version: string;
  bun: string;
  dbValue: string;
  activeVersion: string;
  status: string;
  stopMarker: boolean;
  wal: boolean;
  backup: boolean;
};

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) return false;
  return (
    "event" in value &&
    typeof value.event === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    "version" in value &&
    typeof value.version === "string" &&
    "bun" in value &&
    typeof value.bun === "string" &&
    "dbValue" in value &&
    typeof value.dbValue === "string" &&
    "activeVersion" in value &&
    typeof value.activeVersion === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    "stopMarker" in value &&
    typeof value.stopMarker === "boolean" &&
    "wal" in value &&
    typeof value.wal === "boolean" &&
    "backup" in value &&
    typeof value.backup === "boolean"
  );
}

const setup = (mode: "source" | "compiled") =>
  Effect.gen(function* () {
    const home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-service-home-")),
    );
    homes.add(home);
    const dbPath = NodePath.join(home, "userdata", "statev2.sqlite");
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(dbPath), { recursive: true }));
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE history (value TEXT NOT NULL); INSERT INTO history VALUES ('original history')",
    );
    db.close();
    const filesystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const httpClient = yield* HttpClient.HttpClient;
    const hostPlatform = yield* HostProcessPlatform;
    const hostArchitecture = yield* HostProcessArchitecture;
    for (const version of ["1.0.0", "1.1.0"]) {
      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir: home,
        version,
        fs: filesystem,
        path: paths,
        runner,
        httpClient,
        platform: hostPlatform,
        arch: hostArchitecture,
        releaseBaseUrl: `${releaseBaseUrl}/${mode}`,
        validate: (staged) =>
          filesystem.stat(staged.entryPath).pipe(
            Effect.tap((stat) => Effect.sync(() => expect(stat.type).toBe("File"))),
            Effect.asVoid,
            Effect.orDie,
          ),
      });
      expect(yield* filesystem.readFileString(installed.sentinelPath)).toBe(`${version}\n`);
      expect(releaseRequests).toContain(`/${mode}/v${version}/SHA256SUMS`);
      expect(releaseRequests).toContain(
        `/${mode}/v${version}/${cliArchiveFileName(version, platformKey)}`,
      );
    }
    const statePath = NodePath.join(home, "runtime", "service-state.json");
    yield* Effect.promise(() =>
      writeServiceState(statePath, { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" }),
    );
    return { home, dbPath, statePath };
  }).pipe(
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, arch),
  );

function waitForClose(child: NodeChildProcess.ChildProcess) {
  return new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once("close", (code, signal) => resolve([code, signal]));
  });
}

function start(home: string, mode: "source" | "compiled", scenario = "lifecycle") {
  const executable =
    mode === "source"
      ? bun
      : (process.env.T3_SERVICE_TEST_EXECUTABLE ?? NodePath.join(buildDir, "launcher"));
  const args =
    mode === "source"
      ? [NodePath.join(fixtureDir, "serviceRuntime.launcher.ts")]
      : process.env.T3_SERVICE_TEST_EXECUTABLE
        ? ["__service-launcher"]
        : [];
  const child = NodeChildProcess.spawn(executable, args, {
    env: { ...process.env, PATH: "", T3CODE_HOME: home, T3_SERVICE_TEST_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launchers.add(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  const events: RuntimeEvent[] = [];
  const waiters: Array<{
    event: string;
    resolve: (value: RuntimeEvent) => void;
    reject: (error: Error) => void;
  }> = [];
  const closed = waitForClose(child);
  child.once("error", (error) => {
    diagnostics += error.message;
  });
  const lines = NodeReadline.createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (!line.startsWith("service-runtime:")) return;
    const event: unknown = JSON.parse(line.slice("service-runtime:".length));
    if (!isRuntimeEvent(event)) throw new Error(`Invalid runtime fixture event: ${line}`);
    const index = waiters.findIndex((waiter) => waiter.event === event.event);
    if (index < 0) events.push(event);
    else waiters.splice(index, 1)[0]!.resolve(event);
  });
  child.once("close", (code, signal) => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(
        new Error(`Launcher exited before ${waiter.event}: ${code}/${signal}\n${diagnostics}`),
      );
    }
  });
  return {
    child,
    closed,
    next(event: string): Promise<RuntimeEvent> {
      const index = events.findIndex((value) => value.event === event);
      if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]!);
      if (child.exitCode !== null || child.signalCode !== null)
        return Promise.reject(new Error(diagnostics));
      return new Promise((resolve, reject) => {
        waiters.push({ event, resolve, reject });
      });
    },
  };
}

async function stop(launcher: ReturnType<typeof start>) {
  launcher.child.kill("SIGTERM");
  const stopped = await launcher.next("stopped");
  expect(await launcher.closed).toEqual([0, null]);
  expect(stopped.stopMarker).toBe(true);
  expect(() => process.kill(stopped.pid, 0)).toThrow();
}

effectIt.layer(
  ProcessRunner.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(FetchHttpClient.layer),
  ),
)("real Bun service lifecycle", (it) => {
  it.effect.each(["source", "compiled"] as const)(
    "%s Bun launcher starts, stops and restarts a real Bun child",
    (mode) =>
      Effect.gen(function* () {
        const { home, statePath } = yield* setup(mode);
        yield* Effect.promise(async () => {
          const first = start(home, mode);
          const ready = await first.next("ready");
          expect(ready.bun).toBe("1.4.0");
          expect(ready.dbValue).toBe("original history");
          expect(ready.stopMarker).toBe(false);
          await stop(first);
          expect(
            await NodeFSP.readFile(
              NodePath.join(home, "runtime", SERVICE_STOP_MARKER_FILE),
              "utf8",
            ),
          ).toBeDefined();
          const restarted = start(home, mode);
          const restored = await restarted.next("ready");
          expect(restored.pid).not.toBe(ready.pid);
          expect(restored.dbValue).toBe("original history");
          expect(restored.stopMarker).toBe(false);
          await stop(restarted);
          expect((await readServiceState(statePath)).activeVersion).toBe("1.0.0");
        });
      }),
  );

  it.effect.each(["source", "compiled"] as const)(
    "%s Bun IPC commits an update only after the candidate is prepared",
    (mode) =>
      Effect.gen(function* () {
        const { home, dbPath, statePath } = yield* setup(mode);
        yield* Effect.promise(async () => {
          const launcher = start(home, mode, "commit");
          const previous = await launcher.next("accepted");
          expect(previous.activeVersion).toBe("1.0.0");
          expect(previous.status).toBe("pending");
          const trial = await launcher.next("trial");
          expect(trial.bun).toBe("1.4.0");
          expect(trial.version).toBe("1.1.0");
          expect(trial.activeVersion).toBe("1.0.0");
          expect(trial.status).toBe("pending");
          expect(trial.backup).toBe(true);
          const committed = await launcher.next("committed");
          expect(committed.activeVersion).toBe("1.1.0");
          expect(committed.status).toBe("committed");
          expect(committed.dbValue).toBe("migrated history");
          expect(committed.backup).toBe(false);
          expect(() => process.kill(previous.pid, 0)).toThrow();
          await stop(launcher);
          const state = await readServiceState(statePath);
          expect(state.activeVersion).toBe("1.1.0");
          expect(state.update?.status).toBe("committed");
          const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
          try {
            expect(db.prepare("SELECT value FROM history").get()?.value).toBe("migrated history");
          } finally {
            db.close();
          }
        });
      }),
  );

  it.effect.each(["source", "compiled"] as const)(
    "%s Bun launcher restores SQLite and WAL state after a failed update",
    (mode) =>
      Effect.gen(function* () {
        const { home, dbPath, statePath } = yield* setup(mode);
        yield* Effect.promise(async () => {
          const originalDatabase = await NodeFSP.readFile(dbPath);
          const launcher = start(home, mode, "rollback");
          const previous = await launcher.next("accepted");
          const failed = await launcher.next("failing");
          expect(failed.version).toBe("1.1.0");
          expect(failed.dbValue).toBe("failed migration");
          expect(failed.wal).toBe(true);
          expect(failed.backup).toBe(true);
          const restored = await launcher.next("rolled-back");
          expect(restored.bun).toBe("1.4.0");
          expect(restored.version).toBe("1.0.0");
          expect(restored.activeVersion).toBe("1.0.0");
          expect(restored.status).toBe("rolled-back");
          expect(restored.dbValue).toBe("original history");
          expect(restored.wal).toBe(false);
          expect(restored.backup).toBe(false);
          expect(() => process.kill(previous.pid, 0)).toThrow();
          expect(() => process.kill(failed.pid, 0)).toThrow();
          await stop(launcher);
          const state = await readServiceState(statePath);
          expect(state.update).toMatchObject({
            status: "rolled-back",
            reason: "candidate-exited:23",
          });
          expect(await NodeFSP.readFile(dbPath)).toEqual(originalDatabase);
          expect(await NodeFSP.readdir(NodePath.join(home, "userdata"))).toEqual([
            "statev2.sqlite",
          ]);
        });
      }),
  );
});

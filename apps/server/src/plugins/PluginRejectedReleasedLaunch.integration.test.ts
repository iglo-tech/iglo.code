import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CommandId, ProjectId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
const manifest = {
  id: "scope_probe",
  displayName: "Scope probe",
  version: "1",
  hostVersion: 1,
  requiredCapabilities: ["execution", "persistence"] as const,
  server: { tools: [], api: [], scheduleTargets: [] },
  web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
};
it.live.each(["before-release", "after-release"] as const)(
  "rejected acquisition stops its owned instructed launch: %s",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("pr4-scope-clean")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const marker = `${config.baseDir}/native-execution-started`;
        const binary = `${config.baseDir}/codex-external`;
        yield* fs.writeFileString(
          binary,
          `#!/usr/bin/env node
import * as readline from 'node:readline';
import * as fs from 'node:fs';
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.156.1\\n'); process.exit(0); }
const lines = readline.createInterface({ input: process.stdin });
lines.once('line', line => {
 const frame = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(marker + "-frames")}, JSON.stringify({method:frame.method,capabilities:Object.keys(frame.params?.capabilities ?? {})})+'\\n');
 if (frame.method === 'initialize' && frame.params.capabilities.optOutNotificationMethods) fs.appendFileSync(${JSON.stringify(marker)}, 'started\\n');
 process.exit(1);
});
`,
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providers: Object.fromEntries(
              ["codex", "claudeAgent", "opencode", "cursor", "grok", "antigravity", "pi"].map(
                (id) => [
                  id,
                  {
                    enabled: id === "codex",
                    binaryPath: id === "codex" ? binary : "/nonexistent/review-provider",
                  },
                ],
              ),
            ),
          }),
        );
        yield* spawner.string(
          ChildProcess.make("git", ["init", "-b", "main"], { cwd: config.baseDir }),
        );
        yield* spawner.string(
          ChildProcess.make(
            "git",
            [
              "-c",
              "user.name=Review",
              "-c",
              "user.email=review@example.invalid",
              "commit",
              "--allow-empty",
              "-m",
              "base",
            ],
            { cwd: config.baseDir },
          ),
        );
        const seed = yield* startEnvironment(config, []);
        yield* Context.get(seed.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const projectId = ProjectId.make("scope-project");
        const gate = `${config.baseDir}/setup-gate`;
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [gate]));
        yield* Context.get(seed.context, Projects.ProjectService).create({
          commandId: CommandId.make("create"),
          projectId,
          title: "Scope project",
          workspaceRoot: config.baseDir,
          scripts:
            phase === "before-release"
              ? [
                  {
                    id: "setup",
                    name: "Setup",
                    icon: "configure",
                    command: `printf 'SCOPE_GATED\n'; read gate < '${gate}'`,
                    async: false,
                    runOnWorktreeCreate: true,
                  },
                ]
              : [],
        });
        yield* Fiber.interrupt(seed.fiber);
        const owned = yield* Deferred.make<ThreadId>();
        const plugin: ServerPlugin = {
          manifest,
          migrations: [],
          acquire: Effect.gen(function* () {
            const host = yield* Host;
            const result = yield* host.launch({
              environmentId: host.environmentId,
              projectId,
              commandId: CommandId.make("owned"),
              title: "Owned launch",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "approval-required",
              workspace: { type: "current" },
              instruction: "Owned instruction",
            });
            yield* Deferred.succeed(owned, result.threadId);
            if (phase === "after-release")
              yield* host
                .lifecycle({
                  environmentId: host.environmentId,
                  projectId,
                  threadId: result.threadId,
                  afterCursor: 0,
                })
                .pipe(
                  Stream.filter(
                    (item) =>
                      (item.kind === "event" && item.event === "work-changed") ||
                      item.kind === "snapshot",
                  ),
                  Stream.mapEffect(() =>
                    host.inspect({
                      environmentId: host.environmentId,
                      projectId,
                      threadId: result.threadId,
                    }),
                  ),
                  Stream.filter((state) => state.runs.some((run) => run.status === "starting")),
                  Stream.runHead,
                );
            return yield* new PluginError({
              pluginId: manifest.id,
              code: "service",
              operation: "acquire",
              message: "Deterministic failure after committed launch",
            });
          }),
        };
        const server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const threadId = yield* Deferred.await(owned);
        const descriptor = (yield* Context.get(server.context, Registry.PluginRegistry).catalog)
          .plugins[0]!;
        expect(descriptor.status).toBe("unavailable");
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        yield* threads
          .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (e) =>
                e.event.type === "run.updated" &&
                ["failed", "interrupted", "cancelled"].includes(e.event.payload.status),
            ),
            Stream.runHead,
          );
        const attempted = yield* fs.exists(marker);
        const records = yield* threads.getThreadRecords(threadId, ["runs", "turnItems"]);
        expect(records.runs.map((run) => run.status)).toEqual(["interrupted"]);
        expect(attempted).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

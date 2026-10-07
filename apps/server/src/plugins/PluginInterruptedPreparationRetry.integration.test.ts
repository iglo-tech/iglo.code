import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
it.live.each([
  { scenario: "cancelled", workspace: "current", restartBeforeRetry: false },
  { scenario: "cancelled", workspace: "current", restartBeforeRetry: true },
  { scenario: "failed", workspace: "current", restartBeforeRetry: false },
  { scenario: "released", workspace: "current", restartBeforeRetry: false },
  { scenario: "cancelled", workspace: "exact-ref", restartBeforeRetry: false },
  { scenario: "cancelled", workspace: "exact-ref", restartBeforeRetry: true },
  { scenario: "failed", workspace: "exact-ref", restartBeforeRetry: false },
  { scenario: "released", workspace: "exact-ref", restartBeforeRetry: false },
] as const)(
  "instructed preparation recovery: $scenario $workspace",
  ({ scenario, workspace, restartBeforeRetry }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("fresh-pr4-cancel")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const binary = config.baseDir + "/provider-stub";
        yield* fs.writeFileString(
          binary,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ providers: { codex: { binaryPath: binary } } }),
        );
        const spawner = yield* Spawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawner
            .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
            .pipe(Effect.map((s) => s.trim()));
        yield* git("init", "-b", "main");
        yield* git(
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        );
        const head = yield* git("rev-parse", "HEAD");
        const fifo = config.baseDir + "/setup-gate";
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
        let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "fresh_probe",
            displayName: "Fresh probe",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution", "persistence"],
            server: { tools: [], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
            return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
          }),
        };
        let server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        let { host } = yield* Deferred.await(ready);
        const projects = Context.get(server.context, Projects.ProjectService);
        let threads = Context.get(server.context, Threads.ThreadManagementService);
        let tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        const projectId = ProjectId.make("fresh-project");
        yield* projects.create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Fresh",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
              command: `printf '%s%s\\n' 'PROBE_' 'GATE'; cat '${fifo}' >/dev/null; exit ${scenario === "failed" ? 7 : 0}`,
            },
          ],
        });
        const input = {
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Fresh launch",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace:
            workspace === "current"
              ? { type: "current" as const }
              : { type: "exact-ref" as const, ref: head, branch: "fresh/owned" },
          instruction: "First instruction",
        };
        const launch = yield* host.launch(input);
        const target = { environmentId: host.environmentId, projectId, threadId: launch.threadId };
        yield* tracker.stream(target.threadId).pipe(
          Stream.filter(
            (s) => s?.stages.some((stage) => stage.tail.includes("PROBE_GATE")) === true,
          ),
          Stream.runHead,
        );
        const before = yield* host.inspect(target);
        if (scenario === "cancelled")
          yield* host.interrupt({ ...target, commandId: CommandId.make("stop") });
        else {
          yield* spawner.exitCode(ChildProcess.make("/bin/sh", ["-c", `printf x > '${fifo}'`]));
          yield* tracker.stream(target.threadId).pipe(
            Stream.filter((s) => s?.phase === (scenario === "failed" ? "failed" : "done")),
            Stream.runHead,
          );
          if (scenario === "failed")
            yield* threads
              .streamStoredEventsFrom({
                threadId: target.threadId,
                afterSequence: 0,
                eventType: "run.updated",
              })
              .pipe(
                Stream.filter(
                  (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
                ),
                Stream.runHead,
              );
        }
        yield* projects.update({
          commandId: CommandId.make("remove-script"),
          projectId,
          scripts: [],
        });
        if (restartBeforeRetry) {
          yield* Fiber.interrupt(server.fiber);
          ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
          server = yield* startEnvironment(config, [plugin]);
          yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
          host = (yield* Deferred.await(ready)).host;
          threads = Context.get(server.context, Threads.ThreadManagementService);
          tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        }
        const blocked = yield* host
          .send({
            ...target,
            commandId: CommandId.make("before-retry"),
            instruction: "Before preparation retry",
            mode: "queue",
          })
          .pipe(Effect.result);
        expect(blocked._tag).toBe(scenario === "released" ? "Success" : "Failure");
        const retried = yield* host.launch(input).pipe(Effect.result);
        const prepRetry = yield* host
          .retryPreparation({
            ...target,
            commandId: CommandId.make("retry"),
            runId: before.runs[0]!.id,
          })
          .pipe(Effect.result);
        expect(prepRetry._tag).toBe(scenario === "released" ? "Failure" : "Success");
        if (prepRetry._tag === "Success")
          yield* threads
            .streamStoredEventsFrom({
              threadId: target.threadId,
              afterSequence: prepRetry.success.cursor,
              eventType: "checkpoint-scope.created",
            })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "checkpoint-scope.created" &&
                  event.payload.kind === "root_run" &&
                  event.payload.runId === before.runs[0]!.id,
              ),
              Stream.runHead,
            );
        if (scenario === "failed")
          yield* tracker.stream(target.threadId).pipe(
            Stream.filter(
              (s) =>
                s?.stages.some((stage) => stage.id === "agent" && stage.status === "done") === true,
            ),
            Stream.runHead,
          );
        const send = yield* host
          .send({
            ...target,
            commandId: CommandId.make("send"),
            instruction: "New work after cancellation",
            mode: "auto",
          })
          .pipe(Effect.result);
        yield* Fiber.interrupt(server.fiber);
        ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const restarted = yield* startEnvironment(config, [plugin]);
        yield* Context.get(restarted.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const restored = yield* Deferred.await(ready);
        const afterRestart = yield* restored.host
          .send({
            ...target,
            commandId: CommandId.make("send-after-restart"),
            instruction: "Work after restart",
            mode: "queue",
          })
          .pipe(Effect.result);
        expect(afterRestart._tag).toBe("Success");
        expect(send._tag).toBe("Success");
        const records = yield* Context.get(
          restarted.context,
          Threads.ThreadManagementService,
        ).getThreadRecords(target.threadId, ["messages"]);
        expect(
          records.messages.filter((message) => message.text === "First instruction"),
        ).toHaveLength(1);
        expect(retried._tag).toBe("Success");
        yield* Fiber.interrupt(restarted.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

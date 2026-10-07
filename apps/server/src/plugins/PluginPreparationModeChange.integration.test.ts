import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { startEnvironment, makeClient } from "./PluginHost.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Terminals from "../terminal/Manager.ts";

it.live.each([
  { raise: false, limited: true },
  { raise: true, limited: true },
  { raise: true, limited: false },
])(
  "settles scheduled preparation when its mode changes %o",
  ({ raise, limited }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("plugin-preparation-mode-change")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        // Only external provider I/O is substituted; no actual provider agents are started.
        const binary = `${config.baseDir}/codex-fixture`;
        yield* fs.writeFileString(
          binary,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ providers: { codex: { binaryPath: binary } } }),
        );
        const git = (...args: string[]) =>
          spawn.string(ChildProcess.make("git", args, { cwd: config.baseDir }));
        yield* git("init", "-b", "main");
        yield* git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        );
        const gate = `${config.baseDir}/gate`;
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [gate]));
        const acquired = yield* Deferred.make<Host["Service"]>();
        const projectId = ProjectId.make("project");
        const plugin: ServerPlugin = {
          manifest: {
            id: "review_probe",
            displayName: "Review probe",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution", "schedules"],
            server: { tools: [], api: [], scheduleTargets: ["review_probe.launch"] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            const host = yield* Host;
            yield* Deferred.succeed(acquired, host);
            return {
              tools: [],
              api: [],
              attention: Stream.empty,
              scheduleTargets: [
                {
                  id: "review_probe.launch",
                  invoke: () =>
                    host
                      .launch({
                        environmentId: host.environmentId,
                        projectId,
                        commandId: CommandId.make("launch"),
                        title: "Scheduled child",
                        modelSelection: {
                          instanceId: ProviderInstanceId.make("codex"),
                          model: "gpt-5.4",
                        },
                        runtimeMode: "approval-required",
                        workspace: { type: "current" },
                        instruction: "Start after setup",
                      })
                      .pipe(Effect.asVoid),
                },
              ],
            };
          }),
        };
        const server = yield* startEnvironment(config, [plugin]);
        const host = yield* Deferred.await(acquired);
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Review fixture",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf '%s%s\\n' 'REVIEW_' 'BLOCKED'; read gate < '${gate}'; :`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        let blocked = yield* Deferred.make<string>();
        let output = "";
        const unsubscribe = yield* Context.get(server.context, Terminals.TerminalManager).subscribe(
          (event) => {
            if (event.type !== "output") return Effect.void;
            output += event.data;
            return output.includes("REVIEW_BLOCKED")
              ? Deferred.succeed(blocked, event.threadId).pipe(Effect.asVoid)
              : Effect.void;
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const client = yield* makeClient(server.context, [AuthOrchestrationOperateScope]);
        const task = yield* client[WS_METHODS.scheduledTasksUpsert]({
          title: "Public scheduler launch",
          prompt: "unused",
          enabled: false,
          schedule: { type: "interval", everyMs: 60000 },
          projectId,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          dispatchTarget: {
            id: "review_probe.launch",
            payload: {},
            ...(limited
              ? { dispatchLimits: { runtimeMode: "approval-required", interactionMode: "default" } }
              : {}),
          },
        });
        yield* client[WS_METHODS.scheduledTasksRunNow]({
          id: task.task.id,
          occurrenceId: "occurrence",
        });
        const threadId = ThreadId.make(yield* Deferred.await(blocked));
        const target = { environmentId: host.environmentId, projectId, threadId };
        const before = yield* host.inspect(target);
        expect(before.runs[0]?.status).toBe("preparing");
        if (raise)
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("raise"),
            threadId,
            runtimeMode: "full-access",
          });
        yield* spawn.exitCode(
          ChildProcess.make("/bin/sh", ["-c", `printf 'continue\\n' > '${gate}'`]),
        );
        const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        if (raise && limited) {
          const threads = Context.get(server.context, Threads.ThreadManagementService);
          yield* threads
            .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          expect((yield* tracker.get(threadId))?.phase).toBe("failed");
          const failed = yield* host.inspect(target);
          expect(failed.runs[0]?.status).toBe("failed");
          const sql = Context.get(server.context, SqlClient.SqlClient);
          const [release] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId} AND application_event_version = 2 AND event_type = 'checkpoint-scope.created' AND json_extract(payload_json, '$.kind') = 'root_run'`;
          expect(release?.count).toBe(0);
          yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("lower"),
            threadId,
            runtimeMode: "approval-required",
          });
          blocked = yield* Deferred.make<string>();
          output = "";
          const retry = yield* host.retryPreparation({
            ...target,
            runId: failed.runs[0]!.id,
            commandId: CommandId.make("retry"),
          });
          expect(retry.status).toBe("accepted");
          yield* Deferred.await(blocked);
          yield* spawn.exitCode(
            ChildProcess.make("/bin/sh", ["-c", `printf 'continue\\n' > '${gate}'`]),
          );
          yield* tracker.stream(threadId).pipe(
            Stream.filter((s) => s?.phase === "done"),
            Stream.take(1),
            Stream.runDrain,
          );
          const records = yield* threads.getThreadRecords(threadId, ["messages"]);
          expect(records.messages.filter((m) => m.text === "Start after setup")).toHaveLength(1);
          expect(
            (yield* host.send({
              ...target,
              commandId: CommandId.make("send"),
              instruction: "Continue after restoring permission",
              mode: "queue",
            })).status,
          ).toBe("accepted");
        } else {
          yield* tracker.stream(threadId).pipe(
            Stream.filter((s) => s?.phase === "done"),
            Stream.take(1),
            Stream.runDrain,
          );
          expect((yield* host.inspect(target)).runs[0]?.status).not.toBe("preparing");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

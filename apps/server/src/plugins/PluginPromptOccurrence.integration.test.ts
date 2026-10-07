import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeClient, startEnvironment } from "./PluginHost.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live.each([true, false])(
  "validates occurrence identities before prompt dispatch, supplied=%s",
  (same) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("fresh-gilfoyle-schedule")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        // Substitute only the external provider executable. Core services and storage are real.
        yield* fs.writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"binaryPath":"/nonexistent/gilfoyle-provider-disabled"}}}',
        );
        const server = yield* startEnvironment(config, []);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const projectId = ProjectId.make("fixture");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Fixture",
          workspaceRoot: config.baseDir,
        });
        const tasks = Context.get(server.context, Tasks.ScheduledTaskService);
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        const client = yield* makeClient(server.context, [AuthOrchestrationOperateScope]);
        for (const name of ["a", "b"])
          yield* tasks.upsert({
            id: ScheduledTaskId.make(name),
            title: name,
            prompt: `instruction-${name}`,
            projectId,
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            schedule: { type: "interval", everyMs: 60000 },
            enabled: false,
          });
        const first = yield* client["scheduledTasks.runNow"]({
          id: ScheduledTaskId.make("a"),
          ...(same ? { occurrenceId: "shared" } : {}),
        }).pipe(Effect.result);
        const second = yield* client["scheduledTasks.runNow"]({
          id: ScheduledTaskId.make("b"),
          ...(same ? { occurrenceId: "shared" } : {}),
        }).pipe(Effect.result);
        const listed = yield* tasks.list();
        const snapshot = yield* threads.getShellSnapshot();
        const records = yield* Effect.forEach(snapshot.threads, (shell) =>
          threads.getThreadProjection(shell.id),
        );
        yield* Fiber.interrupt(server.fiber);
        if (same) {
          expect(first._tag).toBe("Failure");
          expect(second._tag).toBe("Failure");
          expect(records).toEqual([]);
          expect(listed.tasks.map((t) => t.runCount)).toEqual([0, 0]);
        } else {
          expect(second._tag).toBe("Success");
          expect(records.map((r) => r.thread.title).sort()).toEqual(["a", "b"]);
          expect(records.flatMap((r) => r.messages.map((m) => m.text)).sort()).toEqual([
            "instruction-a",
            "instruction-b",
          ]);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Targets from "../scheduling/ScheduleTargets.ts";

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const setup = (plugins: ReadonlyArray<ServerPlugin> = []) =>
  Effect.gen(function* () {
    const config = {
      ...(yield* makeReplayServerConfig("independent-pr4-review")),
      noBrowser: true,
      traceTimingEnabled: false,
    };
    const fs = yield* FileSystem.FileSystem;
    const binary = config.baseDir + "/codex-fixture";
    yield* fs.writeFileString(
      binary,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
    );
    yield* fs.chmod(binary, 0o755);
    yield* fs.writeFileString(
      config.settingsPath,
      JSON.stringify({ providers: { codex: { binaryPath: binary } } }),
    );
    const server = yield* startEnvironment(config, plugins);
    const host = Context.get(server.context, Host);
    const projects = Context.get(server.context, Projects.ProjectService);
    const threads = Context.get(server.context, Threads.ThreadManagementService);
    const projectId = ProjectId.make("review-project");
    yield* projects.create({
      commandId: CommandId.make("project"),
      projectId,
      title: "Review",
      workspaceRoot: config.baseDir,
    });
    return { server, host, threads, projectId, config };
  });
const preparedThread = (s: Effect.Success<ReturnType<typeof setup>>, threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* s.threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(threadId + ":create"),
      threadId,
      projectId: s.projectId,
      title: "Prepared thread",
      createdBy: "user",
      creationSource: "web",
      modelSelection: selection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* s.threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(threadId + ":prepare"),
      threadId,
      messageId: MessageId.make(threadId + ":prepare-message"),
      text: "Preparation is deliberately held",
      attachments: [],
      dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
      createdBy: "user",
      creationSource: "web",
    });
  });
for (const recovery of ["retry", "restart"] as const)
  it.live.each(["launch", "send", "interrupt"] as const)(
    `reconciles %s acknowledgement after deletion through ${recovery}`,
    (operation) =>
      Effect.scoped(
        Effect.gen(function* () {
          let ready = yield* Deferred.make<{
            host: Host["Service"];
            storage: Storage["Service"];
          }>();
          const plugin: ServerPlugin = {
            manifest: {
              id: "commands_review",
              displayName: "Review",
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
          const s = yield* setup([plugin]);
          const bound = yield* Deferred.await(ready);
          const input = {
            environmentId: s.host.environmentId,
            projectId: s.projectId,
            commandId: CommandId.make("lost-ack"),
            title: "Launch without provider work",
            modelSelection: selection,
            runtimeMode: "approval-required" as const,
            workspace: { type: "current" as const },
          };
          const target = {
            environmentId: input.environmentId,
            projectId: input.projectId,
            threadId: ThreadId.make("acknowledgement-target"),
            commandId: input.commandId,
          };
          if (operation !== "launch") yield* preparedThread(s, target.threadId);
          if (operation === "send") {
            const run = (yield* s.threads.getThreadRecords(target.threadId, ["runs"])).runs[0]!;
            yield* s.threads.dispatch({
              type: "prepared-run.release",
              commandId: CommandId.make("release-send-fixture"),
              threadId: target.threadId,
              runId: run.id,
            });
          }
          const execute = (host: Host["Service"]) =>
            operation === "launch"
              ? host.launch(input)
              : operation === "send"
                ? host.send({ ...target, instruction: "Deliberately queued", mode: "queue" })
                : host.interrupt(target);
          yield* bound.storage
            .sql`CREATE TRIGGER lose_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost ack'); END`;
          const failure = yield* execute(bound.host).pipe(Effect.flip);
          expect(failure.code).toBe("storage");
          const receipt = yield* bound.host.receipt(input.commandId);
          expect(receipt?.status).toBe("accepted");
          yield* bound.storage.sql`DROP TRIGGER lose_ack`;
          yield* s.threads.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-launched"),
            threadId: receipt!.threadId,
          });
          if (recovery === "retry") {
            const retry = yield* execute(bound.host).pipe(Effect.result);
            expect(retry._tag).toBe("Success");
          }
          expect(yield* bound.host.receipt(input.commandId)).toEqual(receipt);
          const pending = yield* bound.storage
            .sql`SELECT id FROM host_commands WHERE result IS NULL`;
          expect(pending).toHaveLength(recovery === "retry" ? 0 : 1);
          yield* Fiber.interrupt(s.server.fiber);
          ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
          const restarted = yield* startEnvironment(s.config, [plugin]);
          const recovered = yield* Deferred.await(ready);
          const recoveredReceipt = yield* recovered.host.receipt(input.commandId);
          const restartedPending = yield* recovered.storage
            .sql`SELECT id FROM host_commands WHERE result IS NULL`;
          expect(recoveredReceipt).toEqual(receipt);
          expect(restartedPending).toHaveLength(0);
          expect((yield* execute(recovered.host).pipe(Effect.result))._tag).toBe("Success");
          yield* Fiber.interrupt(restarted.fiber);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
it.live("rejects an old plugin occurrence retry after replacement with a prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* setup();
      const threadId = ThreadId.make("replacement-thread");
      yield* preparedThread(s, threadId);
      const tasks = Context.get(s.server.context, Tasks.ScheduledTaskService);
      const targets = Context.get(s.server.context, Targets.ScheduleTargets);
      const entered = yield* Deferred.make<void>();
      yield* targets.register("review.original", () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const id = ScheduledTaskId.make("plugin:review:reused");
      const occurrenceId = "old-committed-occurrence";
      const input = {
        id,
        title: "Original",
        prompt: "Replacement prompt must not run on old retry",
        projectId: s.projectId,
        threadId,
        schedule: { type: "interval" as const, everyMs: 60000 },
        enabled: false,
        workspaceStrategy: { type: "root" as const },
        modelSelection: selection,
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
      };
      yield* tasks.upsert({
        ...input,
        dispatchTarget: { id: "review.original", payload: { original: true } },
      });
      const f = yield* tasks.runNow({ id, occurrenceId }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(f);
      yield* tasks.delete({ id });
      yield* tasks.upsert(input);
      const before = yield* s.threads.getThreadRecords(threadId, ["messages", "runs"]);
      const retry = yield* tasks.runNow({ id, occurrenceId }).pipe(Effect.result);
      const after = yield* s.threads.getThreadRecords(threadId, ["messages", "runs"]);
      const records = yield* Context.get(
        s.server.context,
        SqlClient.SqlClient,
      )`SELECT id,status,error FROM scheduled_task_occurrences WHERE id=${occurrenceId}`;
      expect(after.messages).toHaveLength(before.messages.length);
      expect(after.messages.some((m) => m.text === input.prompt)).toBe(false);
      expect(records[0]?.status).toBe("failed");
      expect(retry._tag).toBe("Failure");
      yield* Fiber.interrupt(s.server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

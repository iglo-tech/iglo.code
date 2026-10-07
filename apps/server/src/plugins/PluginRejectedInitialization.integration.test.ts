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
import {
  AuthOrchestrationOperateScope,
  WS_METHODS,
  MessageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { makeClient, startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";

const manifest = {
  id: "independent_probe",
  displayName: "Independent probe",
  version: "1",
  hostVersion: 1,
  requiredCapabilities: ["execution", "persistence"] as const,
  server: { tools: [], api: [], scheduleTargets: [] },
  web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
};
const services = { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
const configEffect = Effect.gen(function* () {
  const config = {
    ...(yield* makeReplayServerConfig("root-independent-pr4")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    config.settingsPath,
    '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-provider"},"claudeAgent":{"binaryPath":"/nonexistent/independent-provider"}}}',
  );
  return config;
});

it.live("unreleased fixture fails before lost-ack trigger; released control reaches it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const plugin: ServerPlugin = {
        manifest,
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
          return services;
        }),
      };
      const config = yield* configEffect;
      const server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const bound = yield* Deferred.await(ready);
      const projects = Context.get(server.context, Projects.ProjectService);
      const threads = Context.get(server.context, Threads.ThreadManagementService);
      const projectId = ProjectId.make("fixture-project");
      const threadId = ThreadId.make("fixture-thread");
      yield* projects.create({
        projectId,
        commandId: CommandId.make("project"),
        title: "Fixture",
        workspaceRoot: config.baseDir,
      });
      yield* threads.dispatch({
        type: "thread.create",
        projectId,
        threadId,
        commandId: CommandId.make("create"),
        title: "Fixture",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* threads.dispatch({
        type: "message.dispatch",
        threadId,
        commandId: CommandId.make("prepare"),
        messageId: MessageId.make("prepare-message"),
        text: "Deliberately held",
        attachments: [],
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]!;
      yield* bound.storage
        .sql`CREATE TRIGGER lose_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost ack'); END`;
      const input = {
        environmentId: bound.host.environmentId,
        projectId,
        threadId,
        commandId: CommandId.make("send"),
        instruction: "Queued instruction",
        mode: "queue" as const,
      };
      const before = yield* bound.host.send(input).pipe(Effect.result);
      expect(before._tag).toBe("Failure");
      if (before._tag === "Failure") expect(before.failure.code).toBe("unavailable");
      expect(yield* bound.host.receipt(input.commandId)).toBeNull();
      yield* threads.dispatch({
        type: "prepared-run.release",
        threadId,
        runId: run.id,
        commandId: CommandId.make("release"),
      });
      const after = yield* bound.host.send(input).pipe(Effect.result);
      expect(after._tag).toBe("Failure");
      if (after._tag === "Failure") expect(after.failure.code).toBe("storage");
      expect((yield* bound.host.receipt(input.commandId))?.status).toBe("accepted");
      yield* Fiber.interrupt(server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["healthy", "acquire-error", "contribution-mismatch"] as const)(
  "native cancellation after startup outcome=%s",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fail = outcome !== "healthy";
        const config = yield* configEffect;
        const first = yield* startEnvironment(config, []);
        yield* Context.get(first.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const projectId = ProjectId.make("startup-project");
        const gate = config.baseDir + "/setup-gate";
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [gate]));
        yield* Context.get(first.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Startup",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf 'ACQUIRE_PREP_BLOCKED\\n'; read gate < '${gate}'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        yield* Fiber.interrupt(first.fiber);
        const threadReady = yield* Deferred.make<ThreadId>();
        let pluginStorage: Storage["Service"] | undefined;
        const plugin: ServerPlugin = {
          manifest,
          migrations: [],
          acquire: Effect.gen(function* () {
            const host = yield* Host;
            pluginStorage = yield* Storage;
            const result = yield* host.launch({
              environmentId: host.environmentId,
              projectId,
              commandId: CommandId.make("startup-launch"),
              title: "Startup",
              modelSelection: selection,
              runtimeMode: "approval-required",
              workspace: { type: "current" },
              instruction: "Held until setup",
            });
            yield* Deferred.succeed(threadReady, result.threadId);
            expect(
              (yield* host.inspect({
                environmentId: host.environmentId,
                projectId,
                threadId: result.threadId,
              })).preparationId,
            ).toBeDefined();
            if (outcome === "acquire-error")
              return yield* new PluginError({
                pluginId: manifest.id,
                code: "service",
                operation: "acquire",
                message: "Deterministic acquisition failure after committed launch",
              });
            if (outcome === "contribution-mismatch")
              return {
                ...services,
                scheduleTargets: [
                  { id: "independent_probe.undeclared", invoke: () => Effect.void },
                ],
              };
            return services;
          }),
        };
        const second = yield* startEnvironment(config, [plugin]);
        yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const threadId = yield* Deferred.await(threadReady);
        const tracker = Context.get(second.context, Tracker.WorktreeSetupTracker);
        if (fail)
          yield* tracker.stream(threadId).pipe(
            Stream.filter((snapshot) => snapshot?.phase === "cancelled"),
            Stream.runHead,
          );
        const descriptor = (yield* Context.get(second.context, Registry.PluginRegistry).catalog)
          .plugins[0]!;
        const sqlProbe = yield* pluginStorage!
          .sql`SELECT count(*) FROM host_cancelled_launches`.pipe(Effect.result);
        const client = yield* makeClient(second.context, [AuthOrchestrationOperateScope]);
        const { cancelled } = yield* client[WS_METHODS.worktreeSetupCancel]({ threadId });
        const state = yield* tracker.get(threadId);
        expect(descriptor.status).toBe(fail ? "unavailable" : "available");
        expect(sqlProbe._tag).toBe("Success");
        expect(cancelled).toBe(!fail);
        expect(state?.phase).toBe("cancelled");
        expect(yield* pluginStorage!.sql`SELECT id FROM host_cancelled_launches`).toHaveLength(1);
        yield* Fiber.interrupt(second.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

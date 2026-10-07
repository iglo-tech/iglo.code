import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexClient from "effect-codex-app-server/client";
import { CodexSettings } from "@t3tools/contracts";
import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as AdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as FileSystem from "effect/FileSystem";
import * as Ids from "../orchestration-v2/IdAllocator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Checkpoints from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Rollback from "../orchestration-v2/CheckpointRollbackService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  CheckpointScopeId,
  CheckpointRef,
  TurnItemId,
  ProviderSessionId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import {
  Host,
  Storage,
  type ServerPlugin,
  type PluginServices,
} from "@t3tools/plugin-host-contract/server";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const plugin = (id: string, acquire: ServerPlugin["acquire"]): ServerPlugin => ({
  manifest: {
    id,
    displayName: id,
    version: "1",
    hostVersion: 1,
    requiredCapabilities: ["execution", "persistence", "attention"],
    server: { tools: [], api: [], scheduleTargets: [] },
    web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
  },
  migrations: [],
  acquire,
});
const services = (attention: PluginServices["attention"]): PluginServices => ({
  tools: [],
  api: [],
  scheduleTargets: [],
  attention,
});
const setup = (plugins: ReadonlyArray<ServerPlugin>) =>
  Effect.gen(function* () {
    const config = {
      ...(yield* makeReplayServerConfig("pr4-independent-repro")),
      noBrowser: true,
      traceTimingEnabled: false,
    };
    yield* (yield* FileSystem.FileSystem).writeFileString(
      config.settingsPath,
      '{"providers":{"codex":{"binaryPath":"/nonexistent/pr4-native-execution-disabled"}}}',
    );
    const server = yield* startEnvironment(config, plugins);
    const host = Context.get(server.context, Host);
    const projects = Context.get(server.context, Projects.ProjectService);
    const threads = Context.get(server.context, Threads.ThreadManagementService);
    const projectId = ProjectId.make("isolated-review");
    yield* projects.create({
      commandId: CommandId.make("project-create"),
      projectId,
      title: "Isolated review",
      workspaceRoot: config.baseDir,
    });
    return { config, server, host, threads, projectId };
  });
const createThread = (s: Effect.Success<ReturnType<typeof setup>>, threadId: ThreadId) =>
  s.threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(threadId + ":create"),
    threadId,
    projectId: s.projectId,
    title: "Background task review",
    modelSelection: selection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

it.live("inspection excludes abandoned background work after native rollback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<{
        host: Host["Service"];
        storage: Storage["Service"];
      }>();
      const commands = plugin(
        "stop_review",
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
          return services(Stream.empty);
        }),
      );
      const s = yield* setup([commands]);
      const bound = yield* Deferred.await(ready);
      const threadId = ThreadId.make("background-thread");
      yield* createThread(s, threadId);
      const now = yield* DateTime.now;
      const runId = RunId.make("completed-run");
      const nodeId = NodeId.make("root");
      const providerThreadId = ProviderThreadId.make("background-provider-thread");
      const providerTurnId = ProviderTurnId.make("completed-provider-turn");
      const projection = yield* s.threads.getThreadProjection(threadId);
      // Persist the exact completed-root/live-background shape produced by native adapters.
      // No provider is started and no host/orchestration method is substituted.
      const seeded: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("seed:run"),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: selection.instanceId,
            modelSelection: selection,
            providerThreadId,
            userMessageId: MessageId.make("user-message"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make("seed:root"),
          type: "node.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId,
            providerTurnId,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make("seed:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: selection.instanceId,
            providerSessionId: ProviderSessionId.make("rollback-session"),
            appThreadId: threadId,
            ownerNodeId: nodeId,
            nativeThreadRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "native-review-thread",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("seed:turn"),
          type: "provider-turn.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: providerTurnId,
            providerThreadId,
            nodeId,
            runAttemptId: null,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make("seed:thread"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: now,
          payload: { ...projection.thread, activeProviderThreadId: providerThreadId },
        },
      ];
      const childId = NodeId.make("background-tool");
      const scopeId = CheckpointScopeId.make("review-baseline-scope");
      const checkpointId = CheckpointId.make("review-baseline");
      const rootEvent = seeded.find((event) => event.type === "node.updated");
      if (rootEvent?.type !== "node.updated") return yield* Effect.die("Missing root fixture");
      const extra: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make("seed:child"),
          type: "node.updated",
          threadId,
          runId,
          nodeId: childId,
          occurredAt: now,
          payload: {
            ...rootEvent.payload,
            id: childId,
            parentNodeId: nodeId,
            kind: "tool_call",
            status: "running",
            countsForRun: false,
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "background-cmd",
              strength: "strong",
            },
            completedAt: null,
          },
        },
        {
          id: EventId.make("seed:item"),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId: childId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("background-item"),
            threadId,
            runId,
            nodeId: childId,
            providerThreadId,
            providerTurnId,
            nativeItemRef: {
              driver: ProviderDriverKind.make("codex"),
              nativeId: "background-cmd",
              strength: "strong",
            },
            parentItemId: null,
            ordinal: 1,
            type: "command_execution",
            status: "running",
            title: null,
            input: "background command",
            startedAt: now,
            completedAt: null,
            updatedAt: now,
          },
        },
        {
          id: EventId.make("seed:scope"),
          type: "checkpoint-scope.created",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId: null,
            nodeId,
            parentScopeId: null,
            providerThreadId,
            kind: "manual",
            ordinalWithinParent: 0,
            advancesAppRunCount: false,
            cwd: s.config.baseDir,
            createdAt: now,
          },
        },
        {
          id: EventId.make("seed:checkpoint"),
          type: "checkpoint.captured",
          threadId,
          nodeId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId: null,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/review-baseline"),
            status: "ready",
            files: [],
            capturedAt: now,
          },
        },
      ];
      const persistence = yield* Layer.build(
        EventSink.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(EventStore.layer, Projections.layer)),
        ),
      ).pipe(Effect.provideContext(s.server.context));
      yield* Context.get(persistence, EventSink.EventSinkV2).write({
        events: [...seeded, ...extra],
      });
      const target = { environmentId: s.host.environmentId, projectId: s.projectId, threadId };
      const before = yield* bound.host.inspect(target);
      expect(before.outstandingWork.map((w) => w.id)).toContain(childId);
      expect(
        (yield* s.threads.getThreadShell(threadId))?.pendingBackgroundTasks?.length,
      ).toBeGreaterThan(0);
      const deps = yield* Layer.build(
        Layer.mergeAll(
          Ids.layer,
          Projections.layer,
          EventStore.layer,
          ProjectStore.layer,
          Executor.layer,
          Checkpoints.layer.pipe(Layer.provide(Layer.mergeAll(CheckpointStore.layer, Ids.layer))),
        ),
      ).pipe(Effect.provide(s.server.context));
      const context = s.server.context.pipe(Context.merge(persistence), Context.merge(deps));
      const ingestor = yield* Layer.build(Ingestor.layer).pipe(Effect.provide(context));
      const nativeThread = {
        id: "native-review-thread",
        sessionId: "native-review-thread",
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1782622440,
        updatedAt: 1782622440,
        status: { type: "idle" },
        path: "/tmp/isolated-native-thread.jsonl",
        cwd: s.config.baseDir,
        cliVersion: "0.156.1",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      };
      const transcript: Parameters<typeof CodexReplay.layerReplay>[0] = {
        provider: "codex",
        protocol: "codex.app-server",
        version: "0.156.1",
        scenario: "isolated-rollback",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              id: 1,
              method: "initialize",
              params: {
                clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.45" },
                capabilities: {
                  experimentalApi: true,
                  optOutNotificationMethods: ["turn/diff/updated"],
                },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 1,
              result: {
                userAgent: "review",
                codexHome: "/tmp/review-home",
                platformFamily: "unix",
                platformOs: "macos",
              },
            },
          },
          { type: "expect_outbound", frame: { method: "initialized" } },
          {
            type: "expect_outbound",
            frame: {
              id: 2,
              method: "thread/read",
              params: { threadId: "native-review-thread", includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 2,
              result: {
                thread: {
                  id: "native-review-thread",
                  historyMode: "paginated",
                  status: { type: "idle" },
                },
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/turns/list",
              params: {
                threadId: "native-review-thread",
                cursor: null,
                limit: 1,
                sortDirection: "desc",
                itemsView: "summary",
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              id: 3,
              result: {
                data: [
                  { id: "native-completed-turn", items: [], status: "completed", error: null },
                ],
                nextCursor: null,
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "thread/revert",
              params: { threadId: "native-review-thread", beforeTurnId: "native-completed-turn" },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: { thread: nativeThread } } },
        ],
      };
      let opened = 0;
      const adapter = Codex.makeCodexAdapterV2({
        crypto: yield* Crypto.Crypto,
        instanceId: selection.instanceId,
        settings: yield* decodeCodexSettings({}),
        environment: {},
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: Context.get(deps, Ids.IdAllocatorV2),
        serverConfig: s.config,
        clientFactory: {
          open: () =>
            Effect.gen(function* () {
              opened++;
              const replay = yield* Layer.build(CodexReplay.layerReplay(transcript));
              return Context.get(replay, CodexClient.CodexAppServerClient);
            }).pipe(Effect.orDie),
        },
      });
      const managerContext = yield* Layer.build(
        Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
          Layer.provide(AdapterRegistry.layerFromAdapters([adapter])),
        ),
      ).pipe(Effect.provide(context.pipe(Context.merge(ingestor))));
      const rollbackContext = yield* Layer.build(
        Layer.fresh(Rollback.layer).pipe(Layer.provide(RuntimePolicy.layer)),
      ).pipe(
        Effect.provide(context.pipe(Context.merge(managerContext))),
        Effect.provideService(Ids.IdAllocatorV2, Context.get(deps, Ids.IdAllocatorV2)),
      );
      yield* Context.get(rollbackContext, Rollback.CheckpointRollbackServiceV2).execute({
        threadId,
        providerThreadId,
        scopeId,
        checkpointId,
        restoreFiles: false,
      });
      expect(opened).toBe(1);
      const after = yield* bound.host.inspect(target);
      const shell = yield* s.threads.getThreadShell(threadId);
      expect(after.runs.at(-1)?.status).toBe("rolled_back");
      expect(shell?.pendingBackgroundTasks).toEqual([]);
      expect(after.outstandingWork).toEqual([]);

      yield* Fiber.interrupt(s.server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

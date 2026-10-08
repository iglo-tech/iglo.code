import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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
import { PluginCommandReceipt, PluginLaunchInput } from "@t3tools/plugin-host-contract/schema";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Spawner from "effect/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
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
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Startup from "../serverRuntimeStartup.ts";

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
    const server = yield* startEnvironment(config, plugins);
    yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
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

const LaunchRequest = Schema.Struct({ kind: Schema.Literal("launch"), input: PluginLaunchInput });
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(LaunchRequest));
const encodeIntent = Schema.encodeEffect(
  Schema.fromJsonString(
    LaunchRequest.mapFields((fields) => ({ ...fields, coreCommandId: CommandId })),
  ),
);
const encodeIdentity = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, CommandId])),
);
const decodeReceipt = Schema.decodeEffect(Schema.fromJsonString(PluginCommandReceipt));
const decodeInterruptIntent = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ input: Schema.Struct({ runId: Schema.String }) })),
);
it.live.each([
  "before workspace",
  "after branch reservation",
  "after physical checkout",
  "after workspace",
  "async setup",
] as const)("recovers exact-ref launch after loss %s", (crash) =>
  Effect.scoped(
    Effect.gen(function* () {
      let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const commands = plugin(
        "launch_review",
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
          return services(Stream.empty);
        }),
      );
      const s = yield* setup([commands]);
      const bound = yield* Deferred.await(ready);
      const spawner = yield* Spawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawner
          .string(ChildProcess.make("git", args, { cwd: s.config.baseDir }))
          .pipe(Effect.map((output) => output.trim()));
      yield* git("init", "-b", "main");
      yield* git(
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "isolated fixture",
      );
      const ref = yield* git("rev-parse", "HEAD");
      const commandId = CommandId.make("partial-exact-ref");
      const coreCommandId = CommandId.make(
        `plugin:${yield* encodeIdentity(["launch_review", commandId])}`,
      );
      let threadId = ThreadId.make("partial-launch-thread");
      const input = {
        environmentId: s.host.environmentId,
        projectId: s.projectId,
        commandId,
        title: "Exact-ref without initial instruction",
        modelSelection: selection,
        runtimeMode: "approval-required" as const,
        workspace: { type: "exact-ref" as const, ref, branch: "isolated-recovery" },
      };
      const request = yield* encodeRequest({ kind: "launch", input });
      const intent = yield* encodeIntent({ kind: "launch", input, coreCommandId });
      // Reachable crash prefix: BoundHost intent committed, then the core's thread.create
      // committed, but process loss happened before ThreadLaunchService forked preparation.
      yield* bound.storage
        .sql`INSERT INTO host_commands(id,request,intent) VALUES (${commandId},${request},${intent})`;
      if (crash !== "after workspace") {
        yield* s.threads.dispatch({
          type: "thread.create",
          commandId: coreCommandId,
          threadId,
          projectId: s.projectId,
          title: input.title,
          modelSelection: selection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: input.workspace.branch,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
      } else {
        threadId = (yield* s.host.launch({ ...input, commandId: coreCommandId })).threadId;
      }
      if (crash === "after branch reservation") {
        yield* git(
          "update-ref",
          "--create-reflog",
          "-m",
          `t3code-worktree:${Hex.encode(new TextEncoder().encode(`launch:${coreCommandId}`))}`,
          `refs/heads/${input.workspace.branch}`,
          ref,
          "",
        );
        expect((yield* s.threads.getThreadShell(threadId))?.worktreePath).toBeNull();
      }
      if (crash === "after physical checkout") {
        const physical = yield* Context.get(s.server.context, Git.GitVcsDriver).createWorktree(
          {
            cwd: s.config.baseDir,
            refName: ref,
            newRefName: input.workspace.branch,
            baseRefName: ref,
            path: null,
          },
          { ownerId: `launch:${coreCommandId}` },
        );
        expect((yield* s.threads.getThreadShell(threadId))?.worktreePath).toBeNull();
        expect(yield* git("worktree", "list", "--porcelain")).toContain(physical.worktree.path);
      }
      if (crash === "async setup") {
        const gate = s.config.baseDir + "/async-setup-gate";
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [gate]));
        yield* Context.get(s.server.context, Projects.ProjectService).update({
          commandId: CommandId.make("add-async-setup"),
          projectId: s.projectId,
          scripts: [
            {
              id: "gate",
              name: "Async setup",
              icon: "configure",
              command: `printf 'SETUP_RUNNING\\n'; cat '${gate}'`,
              runOnWorktreeCreate: true,
              async: true,
            },
          ],
        });
      }
      yield* Fiber.interrupt(s.server.fiber);
      // The ordinary checkout may advance while the environment is stopped.
      yield* git(
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "root advanced while offline",
      );
      expect(yield* git("rev-parse", "HEAD")).not.toBe(ref);
      ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const restarted = yield* startEnvironment(s.config, [commands]);
      yield* Context.get(restarted.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const recovered = yield* Deferred.await(ready);
      const restartedThreads = Context.get(restarted.context, Threads.ThreadManagementService);
      const receipt = yield* recovered.host.launch(input);
      expect(receipt?.status).toBe("accepted");
      const saved = yield* recovered.storage.sql<{
        result: string;
      }>`SELECT result FROM host_commands WHERE id=${commandId}`;
      expect((yield* decodeReceipt(saved[0]!.result)).status).toBe("accepted");
      const recoveredThread = yield* restartedThreads.getThreadShell(threadId);
      expect(recoveredThread?.worktreePath).not.toBe(null);
      expect(recoveredThread?.branch).toBe(input.workspace.branch);
      expect(
        (yield* recovered.host.inspect({
          environmentId: input.environmentId,
          projectId: input.projectId,
          threadId,
        })).workspacePath,
      ).toBe(recoveredThread!.worktreePath);
      const recoveredHead = yield* spawner.string(
        ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: recoveredThread!.worktreePath! }),
      );
      expect(recoveredHead.trim()).toBe(ref);
      expect(yield* git("rev-parse", "HEAD")).not.toBe(ref);
      expect(yield* recovered.host.launch(input)).toEqual(receipt);
      const tracker = Context.get(restarted.context, SetupTracker.WorktreeSetupTracker);
      if (crash === "async setup") {
        expect((yield* tracker.get(threadId))?.phase).toBe("running");
        expect(
          (yield* tracker.get(threadId))?.stages.find((stage) => stage.id === "agent")?.status,
        ).toBe("done");
        yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", `echo release > '${s.config.baseDir}/async-setup-gate'`]),
        );
        const completed = yield* tracker.stream(threadId).pipe(
          Stream.filter((snapshot) => snapshot?.phase === "done"),
          Stream.runHead,
        );
        expect(completed._tag).toBe("Some");
      }
      // Control: identical exact-ref request under a fresh durable identity.
      const fresh = yield* recovered.host.launch({
        ...input,
        commandId: CommandId.make("fresh-exact-ref"),
        workspace: { ...input.workspace, branch: "isolated-control" },
      });
      if (crash === "async setup") {
        expect((yield* tracker.get(fresh.threadId))?.phase).toBe("running");
        yield* spawner.exitCode(
          ChildProcess.make("sh", ["-c", `echo release > '${s.config.baseDir}/async-setup-gate'`]),
        );
      }
      const finished = yield* tracker.stream(fresh.threadId).pipe(
        Stream.filter((snapshot) => snapshot !== null && snapshot.phase !== "running"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(finished[0]?.phase).toBe("done");
      const controlThread = yield* restartedThreads.getThreadShell(fresh.threadId);
      expect(controlThread?.worktreePath).not.toBe(null);
      expect(controlThread?.branch).toBe("isolated-control");
      const controlHead = yield* spawner.string(
        ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: controlThread!.worktreePath! }),
      );
      expect(controlHead.trim()).toBe(ref);
      yield* Fiber.interrupt(restarted.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["automatic", "explicit"] as const)(
  "pins background interruption through lost acknowledgement: %s",
  (selectionMode) =>
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
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: nodeId,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 1,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [{ taskId: "still-running-command", kind: "command" }],
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
        const persistence = yield* Layer.build(
          EventSink.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(EventStore.layer, Projections.layer)),
          ),
        ).pipe(Effect.provideContext(s.server.context));
        yield* Context.get(persistence, EventSink.EventSinkV2).write({ events: seeded });
        const target = { environmentId: s.host.environmentId, projectId: s.projectId, threadId };
        expect((yield* bound.host.inspect(target)).outstandingWork.map((w) => w.id)).toEqual([
          "still-running-command",
        ]);
        const input = {
          ...target,
          commandId: CommandId.make("stop-background"),
          ...(selectionMode === "explicit" ? { runId } : {}),
        };
        yield* bound.storage
          .sql`CREATE TRIGGER lose_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
        expect(yield* bound.host.interrupt(input).pipe(Effect.flip)).toMatchObject({
          code: "storage",
        });
        const accepted = yield* bound.host.receipt(input.commandId);
        expect(accepted?.status).toBe("accepted");
        expect((yield* bound.host.inspect(target)).outstandingWork).toEqual([]);
        const [pending] = yield* bound.storage.sql<{
          intent: string;
        }>`SELECT intent FROM host_commands WHERE id=${input.commandId}`;
        expect((yield* decodeInterruptIntent(pending!.intent)).input.runId).toBe(runId);
        yield* s.threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("later-run"),
          threadId,
          messageId: MessageId.make("later-message"),
          text: "Later unrelated work",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const before = yield* bound.host.inspect(target);
        expect(before.runs.at(-1)?.status).toBe("preparing");
        yield* bound.storage.sql`DROP TRIGGER lose_ack`;
        expect(yield* bound.host.interrupt(input)).toEqual(accepted);
        expect(yield* bound.host.inspect(target)).toEqual(before);
        yield* Fiber.interrupt(s.server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

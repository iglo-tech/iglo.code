import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { Host, Storage, tool } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/http";
import { startEnvironment, origin } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import * as Claude from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Ids from "../orchestration-v2/IdAllocator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommands from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";
import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(ClaudeSettings)({});
it.live(
  "plugin native actions and replay stay within the calling thread's modes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const storageReady = yield* Deferred.make<Storage["Service"]>();
        const plugin = {
          ...fixture,
          manifest: {
            ...fixture.manifest,
            server: {
              ...fixture.manifest.server,
              tools: ["plugin_fixture_launch", "plugin_fixture_control"],
            },
          },
          acquire: Effect.gen(function* () {
            const boundHost = yield* Host;
            yield* Deferred.succeed(storageReady, yield* Storage);
            const services = yield* fixture.acquire;
            return {
              ...services,
              tools: [
                tool({
                  id: "plugin_fixture_launch",
                  description: "Launch through public plugin boundary",
                  input: Schema.Struct({
                    id: Schema.String,
                    runtimeMode: Schema.Literals(["approval-required", "full-access"]),
                  }),
                  output: Schema.Struct({ threadId: Schema.String, status: Schema.String }),
                  permission: {
                    readOnly: false,
                    destructive: false,
                    idempotent: true,
                    allowInReadOnly: false,
                  },
                  invoke: (input, caller) =>
                    boundHost
                      .launch({
                        environmentId: caller.environmentId,
                        projectId: caller.projectId,
                        commandId: CommandId.make(input.id),
                        title: input.id,
                        modelSelection: {
                          instanceId: caller.providerInstanceId,
                          model: "claude-sonnet-4-6",
                        },
                        runtimeMode: input.runtimeMode,
                        workspace: { type: "current" },
                      })
                      .pipe(Effect.map(({ threadId, status }) => ({ threadId, status }))),
                }),
                tool({
                  id: "plugin_fixture_control",
                  description: "Control a thread through the public plugin boundary",
                  input: Schema.Struct({
                    id: Schema.String,
                    threadId: ThreadId,
                    action: Schema.Literals(["send", "interrupt", "retry-preparation"]),
                  }),
                  output: Schema.Struct({ accepted: Schema.Boolean }),
                  permission: {
                    readOnly: false,
                    destructive: false,
                    idempotent: true,
                    allowInReadOnly: false,
                  },
                  invoke: (input, caller) => {
                    const target = {
                      environmentId: caller.environmentId,
                      projectId: caller.projectId,
                      threadId: ThreadId.make(input.threadId),
                      commandId: CommandId.make(input.id),
                    };
                    if (input.action === "retry-preparation")
                      return boundHost.inspect(target).pipe(
                        Effect.flatMap((state) =>
                          boundHost.retryPreparation({ ...target, runId: state.runs.at(-1)!.id }),
                        ),
                        Effect.map((result) => ({ accepted: result.status === "accepted" })),
                      );
                    return (
                      input.action === "send"
                        ? boundHost.send({
                            ...target,
                            instruction: "Guarded queued send",
                            mode: "queue",
                          })
                        : boundHost.interrupt(target)
                    ).pipe(Effect.map((result) => ({ accepted: result?.status === "accepted" })));
                  },
                }),
              ],
            };
          }),
        };
        const config = {
          ...(yield* makeReplayServerConfig("policy-promotion-independent")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fsPre = yield* FileSystem.FileSystem;
        yield* fsPre.writeFileString(
          config.settingsPath,
          '{"providers":{"claudeAgent":{"binaryPath":"/nonexistent/review-provider"},"codex":{"binaryPath":"/nonexistent/review-provider"}}}',
        );
        const server = yield* startEnvironment(config, [plugin]);
        const projectId = ProjectId.make("policy-promotion-project");
        const threadId = ThreadId.make("policy-promotion-thread");
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const selection = { instanceId, model: "claude-sonnet-4-6" };
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Promotion",
          workspaceRoot: config.baseDir,
        });
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Promotion",
          createdBy: "user",
          creationSource: "web",
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("active-caller"),
          threadId,
          messageId: MessageId.make("active-caller"),
          text: "Keep caller active without production I/O",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        const deps = yield* Layer.build(
          Layer.mergeAll(Ids.layer, Projections.layer, layerEventSink),
        ).pipe(Effect.provide(server.context));
        const fs = yield* FileSystem.FileSystem;
        const nativeFrames = yield* Queue.unbounded<SDKMessage>();
        const opened: Claude.ClaudeAgentSdkQueryOpenInput[] = [];
        const adapter = Claude.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId,
          settings,
          environment: {},
          attachmentsDir: config.attachmentsDir,
          fileSystem: fs,
          path: yield* Path.Path,
          idAllocator: Context.get(deps, Ids.IdAllocatorV2),
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed("native-policy-promotion"),
            open: (input) =>
              Effect.sync(() => {
                opened.push(input);
                return {
                  messages: Stream.fromQueue(nativeFrames),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.sync(() => {}).pipe(Effect.andThen(Queue.shutdown(nativeFrames))),
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const ingestion = yield* Layer.build(
          Ingestor.layer.pipe(Layer.provide(ThreadCommands.layer)),
        ).pipe(Effect.provide(server.context.pipe(Context.merge(deps))));
        const mgrContext = yield* Layer.build(
          Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
            Layer.provide(Registry.layerFromAdapters([adapter])),
          ),
        ).pipe(Effect.provide(server.context.pipe(Context.merge(deps), Context.merge(ingestion))));
        const manager = Context.get(mgrContext, Manager.ProviderSessionManagerV2);
        const sessionId = ProviderSessionId.make("policy-promotion-session");
        const supervisedPolicy = {
          cwd: config.baseDir,
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        };
        const runtime = yield* manager.open({
          threadId,
          providerSessionId: sessionId,
          modelSelection: selection,
          runtimePolicy: supervisedPolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: supervisedPolicy,
        });
        const projection = yield* threads.getThreadRecords(threadId, []);
        const turn = (attempt: string, runtimePolicy: typeof supervisedPolicy) => ({
          appThread: projection.thread,
          threadId,
          runId: RunId.make(attempt),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make(attempt),
          rootNodeId: NodeId.make(attempt),
          providerThread,
          modelSelection: selection,
          runtimePolicy,
          message: {
            createdBy: "user" as const,
            creationSource: "web" as const,
            messageId: MessageId.make(attempt),
            text: "Review",
            attachments: [],
          },
        });
        yield* runtime.startTurn(turn("supervised-turn", supervisedPolicy));
        const credential = ProviderSessions.readMcpProviderSession(threadId)!;
        expect(credential.runtimePolicy?.runtimeMode).toBe("approval-required");
        const http = Context.get(server.context, HttpClient.HttpClient);
        const headers = {
          authorization: credential.authorizationHeader,
          accept: "application/json, text/event-stream",
        };
        const init = yield* http.post(`${origin(server.context)}/mcp`, {
          headers,
          body: HttpBody.text(
            encode({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "isolated-review", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        yield* init.text;
        const call = (name: string, args: Schema.JsonObject) =>
          http
            .post(`${origin(server.context)}/mcp`, {
              headers: {
                ...headers,
                "mcp-protocol-version": "2025-06-18",
                ...(init.headers["mcp-session-id"] === undefined
                  ? {}
                  : { "mcp-session-id": init.headers["mcp-session-id"] }),
              },
              body: HttpBody.text(
                encode({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/call",
                  params: { name, arguments: args },
                }),
                "application/json",
              ),
            })
            .pipe(Effect.flatMap((r) => r.text));
        const nativeDenied = yield* call("t3_thread_launch", {
          title: "native-escalation",
          runtimeMode: "full-access",
        });
        expect(nativeDenied).toContain("runtime_mode_escalation_denied");
        const control = yield* call("plugin_fixture_launch", {
          id: "plugin-control",
          runtimeMode: "approval-required",
        });
        expect(control).toContain('"isError":false');
        const escalated = yield* call("plugin_fixture_launch", {
          id: "plugin-escalation",
          runtimeMode: "full-access",
        });
        expect(escalated).toContain('"isError":true');
        const snapshot = yield* threads.getShellSnapshot();
        const child = snapshot.threads.find((t) => t.title === "plugin-escalation");
        expect(child).toBeUndefined();
        expect(snapshot.threads.find((t) => t.title === "plugin-control")?.runtimeMode).toBe(
          "approval-required",
        );
        // A failed target lookup leaves a pending intent. Recovery must retain
        // the authenticated caller's ceiling even without that caller's context.
        const futureId = ThreadId.make("future-target");
        expect(
          yield* call("plugin_fixture_control", {
            id: "future-send",
            threadId: futureId,
            action: "send",
          }),
        ).toContain('"isError":true');
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("future-create"),
          threadId: futureId,
          projectId,
          title: "Future target",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("future-prepare"),
          threadId: futureId,
          messageId: MessageId.make("future-prepare"),
          text: "Held preparation",
          attachments: [],
          dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
          createdBy: "user",
          creationSource: "web",
        });
        for (const action of ["send", "interrupt", "retry-preparation"] as const)
          expect(
            yield* call("plugin_fixture_control", {
              id: `denied-${action}`,
              threadId: futureId,
              action,
            }),
          ).toContain('"code":"unauthorized"');
        const replay = yield* Bound.make("fixture").pipe(
          Effect.provideService(Host, Context.get(server.context, Host)),
          Effect.provideService(Storage, yield* Deferred.await(storageReady)),
        );
        yield* replay.recover;
        expect(
          (yield* threads.getThreadRecords(futureId, ["messages"])).messages.map(
            (message) => message.text,
          ),
        ).toEqual(["Held preparation"]);
        expect(
          (yield* threads.getShellSnapshot()).threads.some(
            (thread) => thread.title === "plugin-escalation",
          ),
        ).toBe(false);
        yield* threads.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("lower-target"),
          threadId: futureId,
          runtimeMode: "approval-required",
        });
        yield* replay.recover;
        expect(
          (yield* threads.getThreadRecords(futureId, ["messages"])).messages.map(
            (message) => message.text,
          ),
        ).toEqual(["Held preparation"]);
        const prepared = (yield* threads.getThreadRecords(futureId, ["runs"])).runs.find(
          (run) => run.status === "preparing",
        )!;
        yield* threads.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make("release-target"),
          threadId: futureId,
          runId: prepared.id,
        });
        // The pending command succeeds after both its ceiling and workspace fit.
        // Another recovery must not enqueue it twice.
        yield* replay.recover;
        yield* replay.recover;
        expect(
          (yield* threads.getThreadRecords(futureId, ["messages"])).messages.map(
            (message) => message.text,
          ),
        ).toEqual(["Held preparation", "Guarded queued send"]);
        expect(
          yield* call("plugin_fixture_control", {
            id: "allowed-interrupt",
            threadId: futureId,
            action: "interrupt",
          }),
        ).toContain('"isError":false');
        // Launch inherits the caller's interaction mode; it cannot leave plan mode.
        yield* threads.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("plan-caller"),
          threadId,
          interactionMode: "plan",
        });
        expect(
          yield* call("plugin_fixture_launch", {
            id: "plan-child",
            runtimeMode: "approval-required",
          }),
        ).toContain('"isError":false');
        expect(
          (yield* threads.getShellSnapshot()).threads.find(
            (thread) => thread.title === "plan-child",
          )?.interactionMode,
        ).toBe("plan");
        const callerRun = (yield* threads.getThreadShell(threadId))!.activeRunId!;
        yield* threads.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-caller"),
          threadId,
          runId: callerRun,
          holdQueue: true,
        });
        expect(
          yield* call("plugin_fixture_launch", {
            id: "stopped-child",
            runtimeMode: "approval-required",
          }),
        ).toContain('"isError":true');
        yield* replay.recover;
        expect(
          (yield* threads.getShellSnapshot()).threads.some(
            (thread) => thread.title === "stopped-child",
          ),
        ).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

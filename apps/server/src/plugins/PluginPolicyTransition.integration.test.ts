import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
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
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
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
import { startEnvironment, origin, makeClient } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import * as Claude from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Ids from "../orchestration-v2/IdAllocator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(ClaudeSettings)({});
it.live.each(["replacement", "continuation", "unchanged continuation"] as const)(
  "retains the applied Claude policy across %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const plugin = {
          ...fixture,
          acquire: fixture.acquire.pipe(
            Effect.map((s) => ({
              ...s,
              tools: s.tools.map((t) => ({
                ...t,
                permission: { ...t.permission, allowInReadOnly: false },
                invoke: (...[input, caller]: Parameters<typeof t.invoke>) =>
                  caller.runtimeMode === "full-access"
                    ? t.invoke(input, caller)
                    : Effect.fail(
                        new PluginError({
                          pluginId: "fixture",
                          code: "unauthorized",
                          operation: t.id,
                          message: "This mutation requires the applied full-access mode.",
                        }),
                      ),
              })),
            })),
          ),
        };
        const config = {
          ...(yield* makeReplayServerConfig("policy-promotion-independent")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [plugin]);
        const host = Context.get(server.context, Host);
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
        const deps = yield* Layer.build(
          Layer.mergeAll(Ids.layer, Projections.layer, layerEventSink),
        ).pipe(Effect.provide(server.context));
        const fs = yield* FileSystem.FileSystem;
        const nativeFrames = yield* Queue.unbounded<SDKMessage>();
        const opened: Claude.ClaudeAgentSdkQueryOpenInput[] = [];
        let closed = 0;
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
                  close: Effect.sync(() => {
                    closed++;
                  }).pipe(Effect.andThen(Queue.shutdown(nativeFrames))),
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const mgrContext = yield* Layer.build(
          Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
            Layer.provide(Registry.layerFromAdapters([adapter])),
          ),
        ).pipe(
          Effect.provide(
            server.context.pipe(
              Context.merge(deps),
              Context.add(Ingestor.ProviderEventIngestorV2, {
                normalize: () => Effect.succeed([]),
                ingestNormalized: () => Effect.succeed([]),
              }),
            ),
          ),
        );
        const manager = Context.get(mgrContext, Manager.ProviderSessionManagerV2);
        const sessionId = ProviderSessionId.make("policy-promotion-session");
        const readOnlyPolicy = {
          cwd: config.baseDir,
          runtimeMode:
            scenario === "replacement" ? ("full-access" as const) : ("approval-required" as const),
          interactionMode: "default" as const,
          ...(scenario === "replacement" ? { sandboxPolicy: { type: "readOnly" } } : {}),
        };
        const writablePolicy =
          scenario === "unchanged continuation"
            ? readOnlyPolicy
            : {
                ...readOnlyPolicy,
                runtimeMode: "full-access" as const,
                ...(scenario === "replacement"
                  ? { sandboxPolicy: { type: "workspaceWrite" } }
                  : {}),
              };
        const runtime = yield* manager.open({
          threadId,
          providerSessionId: sessionId,
          modelSelection: selection,
          runtimePolicy: readOnlyPolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: readOnlyPolicy,
        });
        let projection = yield* threads.getThreadRecords(threadId, []);
        const turn = (attempt: string, runtimePolicy: typeof readOnlyPolicy) => ({
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
        const terminal = yield* Deferred.make<void>();
        if (runtime.subscribeEvents === undefined)
          return yield* Effect.die("Missing event subscription");
        const sub = yield* runtime.subscribeEvents;
        yield* sub.events.pipe(
          Stream.runForEach((e) =>
            e.type === "turn.terminal"
              ? Deferred.succeed(terminal, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* runtime.startTurn(turn("readonly-turn", readOnlyPolicy));
        expect(opened[0]?.options.permissionMode).toBe(
          scenario === "replacement" ? "dontAsk" : "default",
        );
        expect(opened[0]?.options.allowedTools).not.toContain(
          "mcp__t3-code__plugin_fixture_report",
        );
        const credential = ProviderSessions.readMcpProviderSession(threadId)!;
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
                clientInfo: { name: "independent-review", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        yield* init.text;
        const call = (id: string) =>
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
                  params: {
                    name: "plugin_fixture_report",
                    arguments: { id, summary: "Read-only policy must deny this mutation" },
                  },
                }),
                "application/json",
              ),
            })
            .pipe(Effect.flatMap((r) => r.text));
        expect(yield* call("before")).toContain('"isError":true');
        yield* Queue.offer(nativeFrames, {
          type: "system",
          subtype: "task_started",
          task_id: "background-task",
          tool_use_id: "background-tool",
          description: "Background review",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Research",
          uuid: "00000000-0000-4000-8000-000000000901",
          session_id: "native-policy-promotion",
        });
        yield* Queue.offer(nativeFrames, {
          type: "result",
          subtype: "success",
          duration_ms: 10,
          duration_api_ms: 10,
          is_error: false,
          num_turns: 1,
          result: "Background review continues",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "us",
            iterations: [],
            server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
            service_tier: "standard",
            speed: "standard",
          },
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-4000-8000-000000000902",
          session_id: "native-policy-promotion",
          terminal_reason: "completed",
        });
        yield* Deferred.await(terminal);
        expect(yield* runtime.hasPendingBackgroundWork!).toBe(true);
        yield* threads.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("select-mode"),
          threadId,
          runtimeMode: writablePolicy.runtimeMode,
        });
        projection = yield* threads.getThreadRecords(threadId, []);
        yield* manager.open({
          threadId,
          providerSessionId: sessionId,
          modelSelection: selection,
          runtimePolicy: writablePolicy,
        });
        yield* runtime.resumeThread({
          threadId,
          providerThread,
          modelSelection: selection,
          runtimePolicy: writablePolicy,
        });
        if (scenario === "replacement") {
          const refused = yield* runtime
            .startTurn(turn("writable-turn", writablePolicy))
            .pipe(Effect.flip);
          expect(refused.message).toContain("Failed to start");
        } else {
          const continuation = turn("continuation", writablePolicy);
          yield* runtime.startTurn({
            ...continuation,
            message: { ...continuation.message, createdBy: "agent", creationSource: "provider" },
          });
        }
        expect(opened).toHaveLength(1);
        expect(closed).toBe(0);
        const result = yield* call("after");
        const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const reports = yield* client["plugins.fixture.list"]({
          environmentId: host.environmentId,
        });
        expect(result).toContain('"isError":true');
        expect(reports).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

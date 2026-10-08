import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
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
import * as Fiber from "effect/Fiber";
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
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";

import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(ClaudeSettings)({});
it.live.each(["late predecessor", "cancelled predecessor"] as const)(
  "keeps replacement permissions when a Claude start is detached: %s",
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
          Layer.mergeAll(Ids.layer, Projections.layer, layerEventSink, Executor.layer),
        ).pipe(Effect.provide(server.context));
        const fs = yield* FileSystem.FileSystem;
        const opened: Claude.ClaudeAgentSdkQueryOpenInput[] = [];
        const opening = yield* Deferred.make<void>();
        const allowOpen = yield* Deferred.make<void>();
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
              Effect.gen(function* () {
                const frames = yield* Queue.unbounded<SDKMessage>();
                opened.push(input);
                if (opened.length === 1) {
                  yield* Deferred.succeed(opening, undefined);
                  yield* Deferred.await(allowOpen);
                }
                return {
                  messages: Stream.fromQueue(frames),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(frames),
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const context = server.context.pipe(Context.merge(deps));
        const ingestor = yield* Layer.build(Ingestor.layer).pipe(Effect.provide(context));
        const mgrContext = yield* Layer.build(
          Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
            Layer.provide(Registry.layerFromAdapters([adapter])),
          ),
        ).pipe(Effect.provide(context.pipe(Context.merge(ingestor))));
        const manager = Context.get(mgrContext, Manager.ProviderSessionManagerV2);
        const sessionId = ProviderSessionId.make("policy-promotion-session");
        const readOnlyPolicy = {
          cwd: config.baseDir,
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
        };
        const writablePolicy = { ...readOnlyPolicy, runtimeMode: "full-access" as const };
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
        const projection = yield* threads.getThreadRecords(threadId, []);
        const turn = (
          attempt: string,
          runtimePolicy: typeof readOnlyPolicy | typeof writablePolicy,
        ) => ({
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
        const firstPolicy = writablePolicy;
        const firstStart = yield* runtime
          .startTurn(turn("first", firstPolicy))
          .pipe(Effect.forkScoped);
        yield* Deferred.await(opening);
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
                clientInfo: { name: "credential-ownership-test", version: "1" },
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
        const before = yield* call("before");
        expect(before).toContain('"isError":true');
        if (scenario === "cancelled predecessor") yield* Fiber.interrupt(firstStart);
        const stopCommandId = CommandId.make("client-session-stop");
        const operator = yield* makeClient(server.context, [AuthOrchestrationOperateScope]);
        yield* operator[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "provider-session.detach",
          commandId: stopCommandId,
          threadId,
          providerSessionId: sessionId,
          reason: "client-requested",
        });
        const outboxContext = yield* Layer.build(Outbox.layer).pipe(Effect.provide(context));
        const effectRows = yield* Context.get(outboxContext, Outbox.EffectOutboxV2).listByCommandId(
          stopCommandId,
        );
        expect(effectRows.map((row) => row.request.type)).toEqual(["provider-session.detach"]);
        const detachRequest = effectRows[0]!.request;
        if (detachRequest.type !== "provider-session.detach")
          return yield* Effect.die("Wrong stop effect");
        yield* manager.detach({
          providerSessionId: detachRequest.providerSessionId,
          threadId: effectRows[0]!.threadId,
          ...(detachRequest.detail === undefined ? {} : { detail: detachRequest.detail }),
        });
        const replacement = yield* manager.open({
          threadId,
          providerSessionId: ProviderSessionId.make("replacement-runtime"),
          modelSelection: selection,
          runtimePolicy: readOnlyPolicy,
        });
        const replacementThread = yield* replacement.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: readOnlyPolicy,
        });
        const secondPolicy = readOnlyPolicy;
        yield* replacement.startTurn({
          ...turn("second", secondPolicy),
          providerThread: replacementThread,
        });
        const currentCredential = ProviderSessions.readMcpProviderSession(threadId)!;
        if (scenario === "late predecessor") {
          yield* Deferred.succeed(allowOpen, undefined);
          yield* Fiber.join(firstStart);
        }
        // Never print credentials. Compare identities and native policy options only.
        expect(credential.providerSessionId).not.toBe(currentCredential.providerSessionId);
        expect(opened.map((query) => query.options.permissionMode)).toEqual([
          "bypassPermissions",
          "default",
        ]);
        const oldCall = yield* call("old-credential");
        expect(oldCall).toContain('"invalid_mcp_credential"');
        const freshCall = (id: string) =>
          Effect.gen(function* () {
            const cred = currentCredential;
            const freshHeaders = {
              authorization: cred.authorizationHeader,
              accept: "application/json, text/event-stream",
            };
            const init = yield* http.post(`${origin(server.context)}/mcp`, {
              headers: freshHeaders,
              body: HttpBody.text(
                encode({
                  jsonrpc: "2.0",
                  id: 10,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "replacement-native-query", version: "1" },
                  },
                }),
                "application/json",
              ),
            });
            yield* init.text;
            const resp = yield* http.post(`${origin(server.context)}/mcp`, {
              headers: {
                ...freshHeaders,
                "mcp-protocol-version": "2025-06-18",
                ...(init.headers["mcp-session-id"]
                  ? { "mcp-session-id": init.headers["mcp-session-id"] }
                  : {}),
              },
              body: HttpBody.text(
                encode({
                  jsonrpc: "2.0",
                  id: 11,
                  method: "tools/call",
                  params: {
                    name: "plugin_fixture_report",
                    arguments: { id, summary: "Replacement supervised query" },
                  },
                }),
                "application/json",
              ),
            });
            return yield* resp.text;
          });
        const freshResult = yield* freshCall("replacement-mutation");
        expect(freshResult).toContain('"isError":true');
        const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const reports = yield* client["plugins.fixture.list"]({
          environmentId: host.environmentId,
        });
        expect(ProviderSessions.readMcpProviderSession(threadId)?.runtimePolicy?.runtimeMode).toBe(
          secondPolicy.runtimeMode,
        );
        expect(reports).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

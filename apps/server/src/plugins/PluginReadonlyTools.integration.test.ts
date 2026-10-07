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
import { tool } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
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

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeListing = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            annotations: Schema.optional(
              Schema.Struct({ readOnlyHint: Schema.optional(Schema.Boolean) }),
            ),
          }),
        ),
        nextCursor: Schema.optional(Schema.String),
      }),
    }),
  ),
);
const settings = Schema.decodeSync(ClaudeSettings)({});
it.live(
  "preapproves ordinary read-only plugin tools in native Claude queries",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ids = ["plugin_fixture_query", "plugin_fixture_allowed", "plugin_fixture_mutation"];
        const plugin = {
          ...fixture,
          manifest: { ...fixture.manifest, server: { ...fixture.manifest.server, tools: ids } },
          acquire: fixture.acquire.pipe(
            Effect.map((s) => ({
              ...s,
              tools: ids.map((id, i) =>
                tool({
                  id,
                  description: "Permission boundary probe",
                  input: Schema.Struct({ id: Schema.String }),
                  output: Schema.Struct({ ok: Schema.Boolean }),
                  permission: {
                    readOnly: i === 0,
                    destructive: false,
                    idempotent: true,
                    allowInReadOnly: i === 1,
                  },
                  invoke: () => Effect.succeed({ ok: true }),
                }),
              ),
            })),
          ),
        };
        const config = {
          ...(yield* makeReplayServerConfig("policy-promotion-independent")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
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
        const readOnlyPolicy = {
          cwd: config.baseDir,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          sandboxPolicy: { type: "readOnly" as const },
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
        const projection = yield* threads.getThreadRecords(threadId, []);
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
        yield* runtime.startTurn(turn("readonly-turn", readOnlyPolicy));
        const options = opened[0]!.options;
        const credential = ProviderSessions.readMcpProviderSession(threadId)!;
        expect(options.permissionMode).toBe("dontAsk");
        // Native preapproval and authenticated MCP execution must agree on read-only permissions.
        expect(options.allowedTools).toContain("mcp__t3-code__plugin_fixture_query");
        expect(options.allowedTools).toContain("mcp__t3-code__plugin_fixture_allowed");
        expect(options.allowedTools).not.toContain("mcp__t3-code__plugin_fixture_mutation");
        expect(credential.readOnlyPluginTools).toEqual([
          "plugin_fixture_allowed",
          "plugin_fixture_query",
        ]);
        expect(
          Claude.claudeMcpQueryOverrides({ threadId, readOnlySandbox: false }).allowedTools,
        ).toContain("mcp__t3-code__*");
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
        expect(init.status).toBe(200);
        yield* init.text;
        const call = (method: string, params: Schema.JsonObject) =>
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
                encode({ jsonrpc: "2.0", id: 2, method, params }),
                "application/json",
              ),
            })
            .pipe(Effect.flatMap((r) => r.text));
        let cursor: string | undefined;
        const listedTools: ReturnType<typeof decodeListing>["result"]["tools"][number][] = [];
        for (let page = 0; page < 10; page++) {
          const listed = decodeListing(
            yield* call("tools/list", cursor === undefined ? {} : { cursor }),
          );
          listedTools.push(...listed.result.tools);
          cursor = listed.result.nextCursor;
          if (cursor === undefined) break;
        }
        expect(
          listedTools.find((t) => t.name === "plugin_fixture_query")?.annotations?.readOnlyHint,
        ).toBe(true);
        for (const name of ids) {
          const result = yield* call("tools/call", { name, arguments: { id: "probe" } });
          expect(result).toContain(
            name === "plugin_fixture_mutation" ? '"isError":true' : '"isError":false',
          );
          if (name === "plugin_fixture_mutation") expect(result).toContain('"code":"unauthorized"');
          else expect(result).toContain('"ok":true');
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);

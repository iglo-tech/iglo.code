import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  MessageId,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient } from "effect/http";
import { startEnvironment, makeClient, origin } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Config from "../config.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Ids from "../orchestration-v2/IdAllocator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { layerEventSink } from "../orchestration-v2/runtimeLayer.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Sessions from "../mcp/McpProviderSession.ts";
import { makeReplayAdapter } from "../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const SESSION = "ses_f148ca2deffeJcwCnRQtb0YFNX";
const out = (type: string, input?: unknown) => ({
  type: "expect_outbound" as const,
  frame: input === undefined ? { type } : { type, input },
});
const reply = (operation: string, data: unknown) => ({
  type: "emit_inbound" as const,
  frame: { type: "sdk.response", operation, data },
});
let eventOrdinal = 0;
const event = (type: string, data: Record<string, unknown>) => ({
  type: "emit_inbound" as const,
  frame: {
    type: "sdk.event",
    event: {
      id: `evt_${type.replaceAll(".", "")}${++eventOrdinal}0000`,
      created: 1,
      type,
      data,
      durable: { aggregateID: SESSION, seq: eventOrdinal, version: 1 },
    },
  },
});
it.live.each(["changed-compaction", "changed-user-turn", "unchanged-compaction"] as const)(
  "OpenCode applied compaction policy: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        eventOrdinal = 0;
        const plugin = {
          ...fixture,
          acquire: fixture.acquire.pipe(
            Effect.map((s) => ({
              ...s,
              tools: s.tools.map((t) => ({
                ...t,
                permission: { ...t.permission, allowInReadOnly: false },
                invoke: (...args: Parameters<typeof t.invoke>) =>
                  args[1].runtimeMode === "full-access"
                    ? t.invoke(...args)
                    : Effect.fail(
                        new PluginError({
                          pluginId: "fixture",
                          code: "unauthorized",
                          operation: t.id,
                          message: "Applied full access is required.",
                        }),
                      ),
              })),
            })),
          ),
        };
        const config = {
          ...(yield* makeReplayServerConfig("plugin-opencode-policy")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const binaryPath = `${config.baseDir}/opencode`;
        yield* fs.writeFileString(
          binaryPath,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.0.18\\n"; else exit 1; fi\n',
        );
        yield* fs.chmod(binaryPath, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          encode({ providers: { opencode: { binaryPath, enabled: true } } }),
        );
        const server = yield* startEnvironment(config, [plugin]);
        const host = Context.get(server.context, Host);
        const instanceId = ProviderInstanceId.make("opencode");
        yield* Context.get(server.context, Providers.ProviderRegistry).refreshInstance(instanceId);
        expect(
          (yield* host.providers()).find((p) => p.instanceId === instanceId)?.toolsSupported,
        ).toBe(true);
        const projectId = ProjectId.make("policy-project");
        const threadId = ThreadId.make("thread:opencode2-adapter");
        const selection = { instanceId, model: "opencode/big-pickle" };
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Policy",
          workspaceRoot: config.baseDir,
        });
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        yield* threads.dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Policy",
          createdBy: "user",
          creationSource: "web",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const deps = yield* Layer.build(
          Layer.mergeAll(Ids.layer, Projections.layer, layerEventSink, Executor.layer),
        ).pipe(Effect.provide(server.context));
        const ctx = server.context.pipe(
          Context.merge(deps),
          Context.add(Config.ServerConfig, config),
        );
        const ingestor = yield* Layer.build(Ingestor.layer).pipe(Effect.provide(ctx));
        const mcprules = [
          { action: "t3-code-*", resource: "*", effect: "deny" },
          { action: "t3-code-thread_opencode2-adapter_*", resource: "*", effect: "allow" },
        ];
        const narrow = [
          { action: "shell", resource: "*", effect: "ask" },
          { action: "edit", resource: "*", effect: "ask" },
          { action: "external_directory", resource: "*", effect: "ask" },
          ...mcprules,
          { action: "t3-code-thread_opencode2-adapter_plugin_*", resource: "*", effect: "ask" },
        ];
        const broad = [{ action: "*", resource: "*", effect: "allow" }, ...mcprules];
        const native = {
          id: SESSION,
          permissions: broad,
          projectID: "global",
          model: { id: "big-pickle", providerID: "opencode", variant: "default" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1790656601394, updated: 1790656601394 },
          location: { directory: config.baseDir },
        };
        const models = {
          location: { directory: config.baseDir },
          data: [
            {
              id: "big-pickle",
              modelID: "big-pickle",
              providerID: "opencode",
              family: "big-pickle",
              name: "Big Pickle",
              compatibility: { reasoningField: "reasoning_content" },
              package: "@opencode/ai/providers/openai-compatible",
              settings: {
                apiKey: "public",
                baseURL: "https://opencode.ai/zen/v1",
                provider: "opencode",
              },
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              variants: [],
              time: { released: 1760659200000 },
              cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
              status: "active",
              enabled: true,
              limit: { context: 200000, input: 160000, output: 32000 },
            },
          ],
        };
        const promptReply = {
          data: {
            id: "msg_0eb735d41001NJee1EvVePJAK5",
            sessionID: SESSION,
            time: { created: 1790656601410 },
            type: "user",
            payload: { text: "hi" },
            delivery: "steer",
          },
        };
        const entries = [
          out("event.subscribe"),
          out("model.list", "<any>"),
          reply("model.list", models),
          out("session.create", {
            location: { directory: config.baseDir },
            model: { providerID: "opencode", id: "big-pickle" },
            permissions: broad,
          }),
          reply("session.create", { data: native }),
          out("mcp.add", "<any>"),
          reply("mcp.add", null),
          out("session.instructions.entry.put", "<any>"),
          reply("session.instructions.entry.put", null),
          out("session.prompt", "<any>"),
          reply("session.prompt", promptReply),
          event("session.execution.succeeded", { sessionID: SESSION }),
        ];
        if (scenario !== "unchanged-compaction")
          entries.push(
            out("session.get", { sessionID: SESSION }),
            reply("session.get", { data: native }),
            out("agent.list", "<any>"),
            reply("agent.list", {
              location: { directory: config.baseDir },
              data: [
                {
                  id: "build",
                  name: "Build",
                  request: { settings: {}, headers: {}, body: {} },
                  description: "The default agent.",
                  mode: "primary",
                  hidden: false,
                  permissions: [{ action: "*", resource: "*", effect: "allow" }],
                },
              ],
            }),
            out("session.update", { sessionID: SESSION, permissions: narrow }),
            reply("session.update", null),
          );
        const operation = scenario === "changed-user-turn" ? "session.prompt" : "session.compact";
        entries.push(
          out(operation, "<any>"),
          reply(
            operation,
            operation === "session.prompt"
              ? promptReply
              : { data: { ...promptReply.data, type: "compaction", payload: {} } },
          ),
          event("session.execution.succeeded", { sessionID: SESSION }),
          out("mcp.remove", "<any>"),
          reply("mcp.remove", null),
        );
        const adapter = yield* makeReplayAdapter({
          provider: "opencode",
          protocol: "opencode2-http.sse",
          version: "2.0.18",
          scenario: "compaction-policy",
          entries,
        }).pipe(Effect.provide(ctx));
        const managerContext = yield* Layer.build(
          Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
            Layer.provide(Registry.layerFromAdapters([adapter])),
          ),
        ).pipe(Effect.provide(ctx.pipe(Context.merge(ingestor))));
        const manager = Context.get(managerContext, Manager.ProviderSessionManagerV2);
        const full = {
          cwd: config.baseDir,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
        };
        const supervised = { ...full, runtimeMode: "approval-required" as const };
        const runtime = yield* manager.open({
          threadId,
          providerSessionId: ProviderSessionId.make("policy-session"),
          modelSelection: selection,
          runtimePolicy: full,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: selection,
          runtimePolicy: full,
        });
        const projection = yield* threads.getThreadRecords(threadId, []);
        let terminal = yield* Deferred.make<string>();
        const sub = yield* runtime.subscribeEvents!;
        yield* sub.events.pipe(
          Stream.runForEach((e) =>
            e.type === "turn.terminal"
              ? Deferred.succeed(terminal, e.status).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const turnInput = (id: string, policy: typeof full | typeof supervised) => ({
          appThread: projection.thread,
          threadId,
          runId: RunId.make(id),
          runOrdinal: id === "first" ? 1 : 2,
          providerTurnOrdinal: id === "first" ? 1 : 2,
          attemptId: RunAttemptId.make(id),
          rootNodeId: NodeId.make(id),
          providerThread,
          modelSelection: selection,
          runtimePolicy: policy,
          message: {
            messageId: MessageId.make(id),
            text: "hi",
            attachments: [],
            createdBy: "user" as const,
            creationSource: "web" as const,
          },
        });
        yield* runtime.startTurn(turnInput("first", full));
        expect(yield* Deferred.await(terminal)).toBe("completed");
        expect(Sessions.readMcpProviderSession(threadId)?.runtimePolicy?.runtimeMode).toBe(
          "full-access",
        );
        terminal = yield* Deferred.make<string>();
        const requestedPolicy = scenario === "unchanged-compaction" ? full : supervised;
        yield* threads.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("mode"),
          threadId,
          runtimeMode: requestedPolicy.runtimeMode,
        });
        yield* runtime.resumeThread({
          providerThread,
          threadId,
          modelSelection: selection,
          runtimePolicy: requestedPolicy,
        });
        const next = turnInput("second", requestedPolicy);
        if (scenario === "changed-user-turn") yield* runtime.startTurn(next);
        else
          yield* runtime.compactThread!({
            ...next,
            message: { ...next.message, text: "/compact" },
          });
        const status = yield* Deferred.await(terminal);
        expect(status).toBe("completed");
        const credential = Sessions.readMcpProviderSession(threadId)!;
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
                clientInfo: { name: "review", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        yield* init.text;
        const res = yield* http.post(`${origin(server.context)}/mcp`, {
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
                arguments: { id: "report", summary: "Applied permissions" },
              },
            }),
            "application/json",
          ),
        });
        const body = yield* res.text;
        expect(body).toContain(
          scenario === "unchanged-compaction" ? '"isError":false' : '"isError":true',
        );
        const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const reports = yield* client["plugins.fixture.list"]({
          environmentId: host.environmentId,
        });
        expect(reports).toHaveLength(scenario === "unchanged-compaction" ? 1 : 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

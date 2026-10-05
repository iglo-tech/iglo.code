import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CodexSettings,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Replay from "effect-codex-app-server/replay";
import * as Client from "effect-codex-app-server/client";
import { HttpClient, HttpBody } from "effect/unstable/http";
import { startEnvironment, origin, makeClient } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Codex from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderAdapterOpenSessionError } from "../orchestration-v2/ProviderAdapter.ts";
import * as Manager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Ids from "../orchestration-v2/IdAllocator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Ingestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { OrchestrationV2EventSinkLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import * as Sessions from "../mcp/McpProviderSession.ts";
import packageJson from "../../package.json" with { type: "json" };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(CodexSettings)({});
it.live("denies mutation before a native Codex turn applies the requested permissions", () =>
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
            })),
          })),
        ),
      };
      const config = {
        ...(yield* makeReplayServerConfig("codex-native-policy")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const server = yield* startEnvironment(config, [plugin]);
      const host = Context.get(server.context, Host);
      const projectId = ProjectId.make("codex-policy-project");
      const threadId = ThreadId.make("codex-policy-thread");
      const instanceId = ProviderInstanceId.make("codex");
      const selection = { instanceId, model: "gpt-5.4" };
      const requestedPolicy = {
        cwd: config.baseDir,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Codex policy",
        workspaceRoot: config.baseDir,
      });
      yield* Context.get(server.context, Threads.ThreadManagementService).dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Codex policy",
        createdBy: "user",
        creationSource: "web",
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      const deps = yield* Layer.build(
        Layer.mergeAll(
          Ids.layer,
          Projections.layer,
          OrchestrationV2EventSinkLayerLive,
          Executor.layer,
        ),
      ).pipe(Effect.provide(server.context));
      const context = server.context.pipe(Context.merge(deps));
      const ingestor = yield* Layer.build(Ingestor.layer).pipe(Effect.provide(context));
      const nativePolicy = {
        approvalPolicy: "on-request",
        sandbox: { type: "readOnly", networkAccess: false },
      };
      let sentParams: ReturnType<typeof Codex.codexThreadRuntimeParams> | undefined;
      const adapter = Codex.makeCodexAdapterV2({
        instanceId,
        settings,
        environment: {},
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: Context.get(deps, Ids.IdAllocatorV2),
        serverConfig: config,
        clientFactory: {
          open: (input) =>
            Effect.gen(function* () {
              sentParams = Codex.codexThreadRuntimeParams({
                threadId,
                modelSelection: selection,
                runtimePolicy: requestedPolicy,
              });
              const nativeThread = {
                id: "native-policy-thread",
                sessionId: "native-policy-thread",
                forkedFromId: null,
                preview: "",
                ephemeral: false,
                modelProvider: "openai",
                createdAt: 1782622440,
                updatedAt: 1782622440,
                status: { type: "idle" },
                path: "/tmp/native-policy-thread.jsonl",
                cwd: config.baseDir,
                cliVersion: "0.156.1",
                source: "vscode",
                threadSource: null,
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
              };
              const replay = yield* Layer.build(
                Replay.layerReplay({
                  provider: "codex",
                  protocol: "codex.app-server",
                  version: "0.156.1",
                  scenario: "native-policy",
                  entries: [
                    {
                      type: "expect_outbound",
                      frame: {
                        id: 1,
                        method: "initialize",
                        params: {
                          clientInfo: {
                            name: "T3 Code",
                            title: "T3 Code",
                            version: packageJson.version,
                          },
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
                      frame: { id: 2, method: "thread/start", params: sentParams },
                    },
                    {
                      type: "emit_inbound",
                      frame: {
                        id: 2,
                        result: {
                          thread: nativeThread,
                          model: "gpt-5.4",
                          modelProvider: "openai",
                          serviceTier: null,
                          cwd: config.baseDir,
                          instructionSources: [],
                          ...nativePolicy,
                          approvalsReviewer: "user",
                          reasoningEffort: "medium",
                        },
                      },
                    },
                  ],
                }),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterOpenSessionError({
                      driver: ProviderDriverKind.make("codex"),
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              return Context.get(replay, Client.CodexAppServerClient);
            }),
        },
      });
      const managerContext = yield* Layer.build(
        Manager.layerWithOptions({ idleTimeoutMs: 600000 }).pipe(
          Layer.provide(Registry.makeSingleLayer(adapter)),
        ),
      ).pipe(Effect.provide(context.pipe(Context.merge(ingestor))));
      const manager = Context.get(managerContext, Manager.ProviderSessionManagerV2);
      const runtime = yield* manager.open({
        threadId,
        providerSessionId: ProviderSessionId.make("codex-policy-session"),
        modelSelection: selection,
        runtimePolicy: requestedPolicy,
      });
      expect(Sessions.readMcpProviderSession(threadId)?.runtimePolicy).toBeUndefined();
      yield* runtime.ensureThread({
        threadId,
        modelSelection: selection,
        runtimePolicy: requestedPolicy,
      });

      const credential = Sessions.readMcpProviderSession(threadId)!;
      const http = Context.get(server.context, HttpClient.HttpClient);
      const headers = {
        authorization: credential.authorizationHeader,
        accept: "application/json, text/event-stream",
      };
      const init = yield* http.post(origin(server.context) + "/mcp", {
        headers,
        body: HttpBody.text(
          encode({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "native-policy-review", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      yield* init.text;
      const response = yield* http.post(origin(server.context) + "/mcp", {
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
              arguments: {
                id: "native-readonly-mutation",
                summary: "Must not mutate while native sandbox is readOnly",
              },
            },
          }),
          "application/json",
        ),
      });
      const result = yield* response.text;
      expect(result).toContain('"isError":true');
      const client = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
      const reports = yield* client["plugins.fixture.list"]({
        environmentId: host.environmentId,
      });
      expect(reports).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

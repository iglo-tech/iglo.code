import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type AuthEnvironmentScope,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
} from "@t3tools/contracts";
import type { ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { HttpBody, HttpClient, HttpServer } from "effect/http";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { expect } from "@effect/vitest";
import { Host } from "@t3tools/plugin-host-contract/server";
import * as NetAddress from "effect/net/NetAddress";
import * as Server from "../server.ts";
import * as Config from "../config.ts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Compiled from "./compiled.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as McpSessions from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const startEnvironment = (
  config: Config.ServerConfig["Service"],
  plugins?: ReadonlyArray<ServerPlugin>,
) =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<
      Context.Context<Layer.Success<typeof Server.layer>>,
      Layer.Error<typeof Server.layer>
    >();
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Server.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Config.ServerConfig, config),
                ...(plugins === undefined
                  ? []
                  : [Layer.succeed(Compiled.CompiledPlugins, plugins)]),
              ),
            ),
          ),
        );
        yield* Deferred.succeed(ready, context);
        return yield* Effect.never;
      }),
    ).pipe(
      Effect.tapCause((cause) => Deferred.failCause(ready, cause)),
      Effect.forkScoped,
    );
    return { context: yield* Deferred.await(ready), fiber };
  });

export const origin = (context: Context.Context<HttpServer.HttpServer>) => {
  const address = Context.get(context, HttpServer.HttpServer).address;
  if (!NetAddress.isInetAddress(address)) throw new Error("Expected a TCP test server");
  return `http://127.0.0.1:${address.port}`;
};
export const makeClient = (
  context: Context.Context<Auth.EnvironmentAuth | HttpServer.HttpServer>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
) =>
  Effect.gen(function* () {
    const auth = Context.get(context, Auth.EnvironmentAuth);
    const session = yield* auth.issueSession({ scopes });
    const ticket = yield* auth.issueWebSocketTicket(session);
    const url = new URL(`${origin(context).replace("http", "ws")}/ws`);
    url.searchParams.set("wsTicket", ticket.ticket);
    url.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeSocket.layerWebSocket(url.href), RpcSerialization.layerJson),
        ),
      ),
    );
    return yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
  });

/** Real environment and credentials for an adapter whose native transport is replayed. */
export const makePluginToolFixture = (
  provider: "codex" | "claudeAgent" | "opencode",
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const config = {
      ...(yield* makeReplayServerConfig(`plugin-tool-${provider}`)),
      noBrowser: true,
      traceTimingEnabled: false,
    };
    if (provider === "opencode") {
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
    }
    const server = yield* startEnvironment(config);
    const host = Context.get(server.context, Host);
    if (provider === "opencode")
      yield* Context.get(server.context, Providers.ProviderRegistry).refreshInstance(
        ProviderInstanceId.make(provider),
      );
    expect(
      (yield* host.providers()).find((item) => item.instanceId === provider)?.toolsSupported,
    ).toBe(true);
    const projectId = ProjectId.make(`plugin-tool-${provider}`);
    yield* Context.get(server.context, Projects.ProjectService).create({
      commandId: CommandId.make("project"),
      projectId,
      title: "Plugin tool",
      workspaceRoot: config.baseDir,
    });
    yield* Context.get(server.context, Threads.ThreadManagementService).dispatch({
      type: "thread.create",
      commandId: CommandId.make("thread"),
      threadId,
      projectId,
      title: "Plugin caller",
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId: ProviderInstanceId.make(provider), model: "fixture-model" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => ProviderSessions.clearMcpProviderSession(threadId)),
    );
    const issue = Effect.gen(function* () {
      const credential = yield* Context.get(server.context, McpSessions.McpSessionRegistry).issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make(provider),
      });
      ProviderSessions.setMcpProviderSession(credential.config);
      return credential.config;
    });
    const http = Context.get(server.context, HttpClient.HttpClient);
    const report = (
      connection: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
      id: string,
    ) =>
      Effect.gen(function* () {
        const headers = { ...connection.headers, accept: "application/json, text/event-stream" };
        const init = yield* http.post(connection.url, {
          headers,
          body: HttpBody.text(
            encode({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: provider, version: "1" },
              },
            }),
            "application/json",
          ),
        });
        expect(init.status).toBe(200);
        yield* init.text;
        const call = (method: string, params: Schema.JsonObject) =>
          http
            .post(connection.url, {
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
            .pipe(Effect.flatMap((response) => response.text));
        expect(yield* call("tools/list", {})).toContain('"name":"plugin_fixture_report"');
        const result = yield* call("tools/call", {
          name: "plugin_fixture_report",
          arguments: { id, summary: `${provider} report` },
        });
        expect(result).toContain('"isError":false');
        expect(result).toContain(encode(threadId));
        expect(result).toContain(encode(host.environmentId));
      });
    return { issue, report };
  });

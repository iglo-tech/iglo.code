import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { tool } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { startEnvironment, origin } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import * as PluginRegistry from "@t3tools/plugin-host-adapter/registry";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeListing = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(Schema.Struct({ name: Schema.String })),
      }),
    }),
  ),
);
it.live.each(["ordinary", "empty", "unsupported"] as const)(
  "isolates plugin MCP publication with %s schema",
  (schema) =>
    Effect.scoped(
      Effect.gen(function* () {
        const badTool = tool({
          id: "plugin_fixture_query",
          description: "Zero-argument query",
          input:
            schema === "empty"
              ? Schema.Struct({})
              : schema === "unsupported"
                ? Schema.String
                : Schema.Struct({ id: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          permission: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            allowInReadOnly: true,
          },
          invoke: () => Effect.succeed({ ok: true }),
        });
        const goodTool = tool({
          id: "plugin_good_query",
          description: "Healthy query",
          input: Schema.Struct({ id: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          permission: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            allowInReadOnly: true,
          },
          invoke: () => Effect.succeed({ ok: true }),
        });
        const bad = {
          ...fixture,
          manifest: {
            ...fixture.manifest,
            server: { ...fixture.manifest.server, tools: [badTool.id] },
          },
          acquire: fixture.acquire.pipe(Effect.map((s) => ({ ...s, tools: [badTool] }))),
        };
        const good = {
          manifest: {
            ...fixture.manifest,
            id: "good",
            server: { tools: [goodTool.id], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.succeed({
            tools: [goodTool],
            api: [],
            scheduleTargets: [],
            attention: Stream.succeed([]),
          }),
        };
        const config = {
          ...(yield* makeReplayServerConfig("empty-tool-isolation")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [bad, good]);
        const registry = Context.get(server.context, PluginRegistry.PluginRegistry);
        yield* registry.awaitToolsReady;
        const catalog = yield* registry.catalog;
        expect(catalog.plugins.map((p) => p.status)).toEqual([
          schema === "unsupported" ? "unavailable" : "available",
          "available",
        ]);
        const projectId = ProjectId.make("empty-tool-project"),
          threadId = ThreadId.make("empty-tool-thread"),
          instanceId = ProviderInstanceId.make("claudeAgent");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Probe",
          workspaceRoot: config.baseDir,
        });
        yield* Context.get(server.context, Threads.ThreadManagementService).dispatch({
          type: "thread.create",
          commandId: CommandId.make("thread"),
          threadId,
          projectId,
          title: "Probe",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId, model: "test-model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const credential = yield* Context.get(server.context, Sessions.McpSessionRegistry).issue({
          threadId,
          providerInstanceId: instanceId,
        });
        ProviderSessions.setMcpProviderSession({
          ...credential.config,
          runtimePolicy: {
            cwd: config.baseDir,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => ProviderSessions.clearMcpProviderSession(threadId)),
        );
        const http = Context.get(server.context, HttpClient.HttpClient);
        const headers = {
          authorization: credential.config.authorizationHeader,
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
        const listing = decodeListing(yield* call("tools/list", {}));
        const pluginNames = listing.result.tools
          .filter((t) => t.name.startsWith("plugin_"))
          .map((t) => t.name);
        expect(pluginNames).toEqual(
          schema === "unsupported"
            ? ["plugin_good_query"]
            : ["plugin_fixture_query", "plugin_good_query"],
        );
        const result = yield* call("tools/call", { name: goodTool.id, arguments: { id: "probe" } });
        expect(result).toContain('"isError":false');
        if (schema !== "unsupported") {
          const query = yield* call("tools/call", {
            name: badTool.id,
            arguments: schema === "empty" ? {} : { id: "probe" },
          });
          expect(query).toContain('"isError":false');
          expect(query).toContain('"ok":true');
        }
        // An ordinary core tool remains usable: the defect is plugin publication, not core boot/auth.
        const core = yield* call("tools/call", { name: "t3_project_list", arguments: {} });
        expect(core).toContain('"isError":false');
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

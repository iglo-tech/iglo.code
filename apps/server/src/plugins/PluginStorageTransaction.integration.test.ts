import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeSqlite from "node:sqlite";
import { Host, Storage, tool, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/contracts";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { startEnvironment, origin } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Mcp from "../mcp/McpSessionRegistry.ts";
import * as Sessions from "../mcp/McpProviderSession.ts";
import { HttpClient, HttpBody } from "effect/http";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live("a failed deferred constraint must roll back the private plugin transaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<Storage["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "storage_probe",
          displayName: "Storage probe",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["persistence", "tools"],
          server: { tools: ["plugin_storage_probe_write"], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [
          {
            id: 1,
            name: "schema",
            run: Effect.gen(function* () {
              const { sql } = yield* Storage;
              yield* sql`CREATE TABLE parents(id INTEGER PRIMARY KEY)`;
              yield* sql`CREATE TABLE children(id TEXT PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)`;
              yield* sql`INSERT INTO parents VALUES(1)`;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PluginError({
                    pluginId: "storage_probe",
                    code: "storage",
                    operation: "migrate",
                    message: "migration failed",
                    cause,
                  }),
              ),
            ),
          },
        ],
        acquire: Effect.gen(function* () {
          const storage = yield* Storage;
          yield* Deferred.succeed(ready, storage);
          return {
            api: [],
            scheduleTargets: [],
            attention: Stream.empty,
            tools: [
              tool({
                id: "plugin_storage_probe_write",
                description: "Isolated transaction reproduction",
                input: Schema.Struct({ id: Schema.String, parentId: Schema.Int }),
                output: Schema.Struct({ accepted: Schema.Boolean }),
                permission: {
                  readOnly: false,
                  destructive: false,
                  idempotent: true,
                  allowInReadOnly: true,
                },
                invoke: (input) =>
                  storage.sql
                    .withTransaction(
                      Effect.gen(function* () {
                        yield* storage.sql`INSERT INTO children VALUES(${input.id},${input.parentId})`;
                        return { accepted: true };
                      }),
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.fail(
                          new PluginError({
                            pluginId: "storage_probe",
                            code: "storage",
                            operation: "write",
                            message: "The plugin write transaction failed.",
                            cause,
                          }),
                        ),
                      ),
                    ),
              }),
            ],
          };
        }),
      };
      const config = {
        ...(yield* makeReplayServerConfig("storage-isolation")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      yield* (yield* FileSystem.FileSystem).writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/isolated-provider"}}}',
      );
      const server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const storage = yield* Deferred.await(ready),
        host = Context.get(server.context, Host);
      const projectId = ProjectId.make("storage-project"),
        threadId = ThreadId.make("storage-thread");
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Storage",
        workspaceRoot: config.baseDir,
      });
      yield* Context.get(server.context, Threads.ThreadManagementService).dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Storage",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const credential = yield* Context.get(server.context, Mcp.McpSessionRegistry).issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      Sessions.setMcpProviderSession(credential.config);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => Sessions.clearMcpProviderSession(threadId)),
      );
      const http = Context.get(server.context, HttpClient.HttpClient);
      const headers = {
        authorization: credential.config.authorizationHeader,
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
              clientInfo: { name: "isolated", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      yield* init.text;
      const invoke = (id: string, parentId: number) =>
        http
          .post(origin(server.context) + "/mcp", {
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
                params: { name: "plugin_storage_probe_write", arguments: { id, parentId } },
              }),
              "application/json",
            ),
          })
          .pipe(Effect.flatMap((r) => r.text));
      const initial = yield* invoke("control", 1);
      expect(initial).toContain('"isError":false');
      const bad = yield* invoke("orphan", 999);
      const visible = yield* storage.sql`SELECT * FROM children ORDER BY id`;
      const independent = new NodeSqlite.DatabaseSync(storage.directory + "/state.sqlite", {
        readOnly: true,
      });
      const committed = independent.prepare("SELECT * FROM children ORDER BY id").all();
      independent.close();
      const goodAfter = yield* invoke("after", 1);
      const core = yield* host.projects();
      expect(goodAfter).toContain('"isError":false');
      expect(yield* storage.sql`SELECT id FROM children ORDER BY id`).toEqual([
        { id: "after" },
        { id: "control" },
      ]);
      expect(core).toHaveLength(1);
      yield* Fiber.interrupt(server.fiber);
      expect(bad).toContain('"isError":true');
      expect(visible).toEqual(committed);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

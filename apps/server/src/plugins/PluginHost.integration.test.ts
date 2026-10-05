import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Host, Storage, Schedules, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { EnvironmentId, type PluginLaunchInput } from "@t3tools/plugin-host-contract/schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Context from "effect/Context";
import { startEnvironment, makeClient, origin as testOrigin } from "./PluginHost.testkit.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import { ScheduledTaskId } from "@t3tools/contracts";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as Projects from "../project/ProjectService.ts";
import * as McpSessions from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessions from "../mcp/McpProviderSession.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const ToolResult = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optional(Schema.Boolean),
      structuredContent: Schema.JsonObject,
    }),
  }),
);
const decodeToolResult = Schema.decodeUnknownSync(ToolResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live(
  "reports through authenticated MCP into the real environment's private plugin store",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("plugin-host")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const { context, fiber: environment } = yield* startEnvironment(config);
        const server = Context.get(context, HttpServer.HttpServer);
        const address = server.address;
        if (!NetAddress.isInetAddress(address)) return yield* Effect.die("Expected a TCP server");
        const origin = `http://127.0.0.1:${address.port}`;
        const host = Context.get(context, Host);
        const projects = Context.get(context, Projects.ProjectService);
        const projectId = ProjectId.make("fixture-project");
        yield* projects.create({
          commandId: CommandId.make("fixture-project"),
          projectId,
          title: "Fixture",
          workspaceRoot: config.baseDir,
        });
        const launched = yield* host.launch({
          environmentId: host.environmentId,
          commandId: CommandId.make("fixture-launch"),
          projectId,
          title: "Fixture report",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          workspace: { type: "current" },
        });
        const registry = Context.get(context, Registry.PluginRegistry);
        expect((yield* registry.catalog).plugins[0]?.status).toBe("available");
        const credential = yield* Context.get(context, McpSessions.McpSessionRegistry).issue({
          threadId: launched.threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        ProviderSessions.setMcpProviderSession(credential.config);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => ProviderSessions.clearMcpProviderSession(launched.threadId)),
        );
        const client = Context.get(context, HttpClient.HttpClient);
        const init = yield* client.post(`${origin}/mcp`, {
          headers: {
            authorization: credential.config.authorizationHeader,
            accept: "application/json, text/event-stream",
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "fixture", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        expect(init.status).toBe(200);
        yield* init.text;
        const call = (
          method: string,
          params: Schema.JsonObject,
          authorization = credential.config.authorizationHeader,
        ) =>
          client
            .post(`${origin}/mcp`, {
              headers: {
                authorization,
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-06-18",
                ...(init.headers["mcp-session-id"] === undefined
                  ? {}
                  : { "mcp-session-id": init.headers["mcp-session-id"] }),
              },
              body: HttpBody.text(
                encodeJson({ jsonrpc: "2.0", id: 2, method, params }),
                "application/json",
              ),
            })
            .pipe(
              Effect.flatMap((response) =>
                response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
              ),
            );
        const discovered = yield* call("tools/list", {});
        expect(discovered.status).toBe(200);
        expect(discovered.text).toContain('"name":"plugin_fixture_report"');
        expect(discovered.text).toContain('"readOnlyHint":false');
        expect(credential.config.readOnlyPluginTools).toContain("plugin_fixture_report");
        const response = yield* call("tools/call", {
          name: "plugin_fixture_report",
          arguments: { id: "report-1", summary: "Needs a decision" },
        });
        expect(response.status, response.text).toBe(200);
        const result = decodeToolResult(response.text.match(/\{.*\}/s)?.[0] ?? response.text);
        expect(result.result.isError, response.text).toBe(false);
        expect(result.result.structuredContent).toMatchObject({
          id: "report-1",
          threadId: launched.threadId,
          projectId,
          environmentId: host.environmentId,
          resolved: false,
        });
        const invalid = yield* call("tools/call", {
          name: "plugin_fixture_report",
          arguments: { id: "bad-report", summary: "x".repeat(241) },
        });
        expect(invalid.text).toContain('"isError":true');
        for (const arguments_ of [
          { id: "blank-summary", summary: "   " },
          { id: "blank-summary-newline", summary: "\n\t" },
          { id: "blank-summary-leading", summary: " Needs a decision" },
          { id: "blank-summary-trailing", summary: "Needs a decision " },
          { id: "   ", summary: "Needs a decision" },
          { id: " report-leading", summary: "Needs a decision" },
          { id: "report-trailing ", summary: "Needs a decision" },
        ]) {
          const rejected = yield* call("tools/call", {
            name: "plugin_fixture_report",
            arguments: arguments_,
          });
          expect(rejected.text).toContain('"isError":true');
          expect(rejected.text).toContain('"code":"validation"');
        }
        const fresh = yield* Context.get(context, McpSessions.McpSessionRegistry).issue({
          threadId: launched.threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        ProviderSessions.setMcpProviderSession(fresh.config);
        const stale = yield* call("tools/call", {
          name: "plugin_fixture_report",
          arguments: { id: "stale-report", summary: "Must be rejected" },
        });
        expect(stale.text).toContain('"unauthorized"');
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* makeClient(context, [AuthOrchestrationReadScope]);
            const writer = yield* makeClient(context, [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            const openAttention = yield* reader["plugins.attention"]({
              environmentId: host.environmentId,
            }).pipe(Stream.take(1), Stream.runCollect);
            expect(openAttention[0]?.items).toMatchObject([
              {
                id: "report-1",
                link: { pageId: "fixture.reports", projectId, threadId: launched.threadId },
              },
            ]);
            expect(
              yield* reader["plugins.fixture.list"]({
                environmentId: EnvironmentId.make("wrong-environment"),
              }).pipe(Effect.flip),
            ).toMatchObject({ code: "unavailable" });
            const listed = yield* reader["plugins.fixture.list"]({
              environmentId: host.environmentId,
            });
            expect(listed).toHaveLength(1);
            expect(
              yield* reader["plugins.fixture.resolve"]({
                environmentId: host.environmentId,
                id: "report-1",
              }).pipe(Effect.flip),
            ).toMatchObject({
              _tag: "EnvironmentAuthorizationError",
              requiredScope: AuthOrchestrationOperateScope,
            });
            const initial = yield* Deferred.make<void>();
            const resolved = yield* Deferred.make<void>();
            const subscription = yield* reader["plugins.fixture.subscribe"]({
              environmentId: host.environmentId,
            }).pipe(
              Stream.runForEach((reports) =>
                reports[0]?.resolved
                  ? Deferred.succeed(resolved, undefined)
                  : Deferred.succeed(initial, undefined),
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(initial);
            yield* writer["plugins.fixture.resolve"]({
              environmentId: host.environmentId,
              id: "report-1",
            });
            yield* Deferred.await(resolved);
            yield* Fiber.interrupt(subscription);
            const attention = yield* reader["plugins.attention"]({
              environmentId: host.environmentId,
            }).pipe(Stream.take(1), Stream.runCollect);
            expect(attention[0]?.items).toEqual([]);
            yield* writer["plugins.fixture.schedule"]({
              environmentId: host.environmentId,
              id: "report-1",
              everyMs: 60_000,
            });
            const scheduled = (yield* reader["scheduledTasks.list"]({})).tasks[0]!;
            expect(scheduled.dispatchTarget).toEqual({
              id: "fixture.reminder",
              payload: { id: "report-1" },
            });
            const occurrenceId = "fixture-reminder-occurrence";
            expect(
              (yield* writer["scheduledTasks.runNow"]({ id: scheduled.id, occurrenceId })).task
                .lastRunStatus,
            ).toBe("succeeded");
            yield* writer["plugins.fixture.resolve"]({
              environmentId: host.environmentId,
              id: "report-1",
            });
            yield* writer["scheduledTasks.runNow"]({ id: scheduled.id, occurrenceId });
            expect(
              (yield* reader["plugins.fixture.list"]({ environmentId: host.environmentId }))[0]
                ?.resolved,
            ).toBe(true);
            expect((yield* reader["scheduledTasks.list"]({})).tasks[0]?.runCount).toBe(1);
          }),
        );
        yield* Fiber.interrupt(environment);
        const restarted = yield* startEnvironment(config);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const refreshedClient = yield* makeClient(restarted.context, [
              AuthOrchestrationReadScope,
            ]);
            expect(
              yield* refreshedClient["plugins.fixture.list"]({ environmentId: host.environmentId }),
            ).toMatchObject([{ id: "report-1", resolved: true, threadId: launched.threadId }]);
            const refreshedCredential = yield* Context.get(
              restarted.context,
              McpSessions.McpSessionRegistry,
            ).issue({
              threadId: launched.threadId,
              providerInstanceId: ProviderInstanceId.make("codex"),
            });
            expect(refreshedCredential.config.authorizationHeader).not.toBe(
              credential.config.authorizationHeader,
            );
            ProviderSessions.setMcpProviderSession(refreshedCredential.config);
            const restartedHttp = Context.get(restarted.context, HttpClient.HttpClient);
            const discovery = yield* restartedHttp.post(`${testOrigin(restarted.context)}/mcp`, {
              headers: {
                authorization: refreshedCredential.config.authorizationHeader,
                accept: "application/json, text/event-stream",
              },
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id: 4,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-06-18",
                    capabilities: {},
                    clientInfo: { name: "restarted-fixture", version: "1" },
                  },
                }),
                "application/json",
              ),
            });
            expect(discovery.status).toBe(200);
            yield* discovery.text;
            const tool = yield* restartedHttp.post(`${testOrigin(restarted.context)}/mcp`, {
              headers: {
                authorization: refreshedCredential.config.authorizationHeader,
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2025-06-18",
                ...(discovery.headers["mcp-session-id"] === undefined
                  ? {}
                  : { "mcp-session-id": discovery.headers["mcp-session-id"] }),
              },
              body: HttpBody.text(
                encodeJson({
                  jsonrpc: "2.0",
                  id: 5,
                  method: "tools/call",
                  params: {
                    name: "plugin_fixture_report",
                    arguments: { id: "report-1", summary: "Needs a decision" },
                  },
                }),
                "application/json",
              ),
            });
            const text = yield* tool.text;
            expect(tool.status, text).toBe(200);
            expect(decodeToolResult(text.match(/\{.*\}/s)?.[0] ?? text).result.isError).toBe(false);
          }),
        );
        yield* Fiber.interrupt(restarted.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.live(
  "reconciles a plugin launch acknowledgement without duplicating work or moving its exact ref",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("plugin-commands")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const environment = yield* startEnvironment(config);
        const context = environment.context;
        const core = Context.get(context, Host);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawner.string(ChildProcess.make("git", args, { cwd: config.baseDir }));
        yield* git("init");
        yield* git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "Initial",
        );
        const projectId = ProjectId.make("plugin-command-project");
        yield* Context.get(context, Projects.ProjectService).create({
          commandId: CommandId.make("plugin-command-project"),
          projectId,
          title: "Fixture",
          workspaceRoot: config.baseDir,
        });
        const firstHead = (yield* git("rev-parse", "HEAD")).trim();
        const acquire = () =>
          Effect.gen(function* () {
            const ready = yield* Deferred.make<{
              host: Host["Service"];
              storage: Storage["Service"];
            }>();
            const scope = yield* Scope.make();
            const plugin: ServerPlugin = {
              manifest: {
                id: "command_fixture",
                displayName: "Commands",
                version: "1",
                hostVersion: 1,
                requiredCapabilities: ["execution", "persistence"],
                server: { tools: [], api: [], scheduleTargets: [] },
                web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
              },
              migrations: [],
              acquire: Effect.gen(function* () {
                const host = yield* Host;
                const storage = yield* Storage;
                yield* Deferred.succeed(ready, { host, storage });
                return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
              }),
            };
            const child = yield* Layer.build(
              Registry.layer({
                environmentId: core.environmentId,
                directory: `${config.stateDir}/command-plugins`,
                plugins: [plugin],
              }),
            ).pipe(Effect.provide(context), Scope.provide(scope));
            const registry = Context.get(child, Registry.PluginRegistry);
            yield* registry.start;
            expect((yield* registry.catalog).plugins[0]?.status).toBe("available");
            return { ...(yield* Deferred.await(ready)), scope };
          });
        const first = yield* acquire();
        const input: PluginLaunchInput = {
          environmentId: core.environmentId,
          projectId,
          commandId: CommandId.make("exact-launch"),
          title: "Exact launch",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          workspace: { type: "exact-ref", ref: "HEAD", branch: "fixture/exact" },
        };
        // Lose the private acknowledgement after core commits, as a process failure would.
        yield* first.storage
          .sql`CREATE TRIGGER fail_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
        expect(yield* first.host.launch(input).pipe(Effect.flip)).toMatchObject({
          _tag: "PluginError",
          code: "storage",
        });
        const accepted = yield* first.host.receipt(input.commandId);
        expect(accepted?.status).toBe("accepted");
        yield* git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "Moved head",
        );
        yield* first.storage.sql`DROP TRIGGER fail_ack`;
        yield* Scope.close(first.scope, Exit.void);
        const recovered = yield* acquire();
        const retry = yield* recovered.host.launch(input);
        expect(retry).toEqual(accepted);
        expect(
          yield* recovered.host.launch({ ...input, title: "Changed input" }).pipe(Effect.flip),
        ).toMatchObject({ code: "conflict" });
        const [intent] = yield* recovered.storage.sql<{
          intent: string;
        }>`SELECT intent FROM host_commands WHERE id = ${input.commandId}`;
        expect(intent?.intent).toContain(firstHead);
        const snapshot = yield* recovered.host.reconcile({
          environmentId: core.environmentId,
          projectId,
        });
        expect(snapshot.threads.map((thread) => thread.threadId)).toEqual([retry.threadId]);
        const gap = yield* recovered.host
          .lifecycle({
            environmentId: core.environmentId,
            projectId,
            afterCursor: snapshot.cursor + 1,
          })
          .pipe(Stream.take(1), Stream.runCollect);
        expect(gap[0]).toMatchObject({
          kind: "snapshot",
          replayGap: true,
          threads: [{ threadId: retry.threadId }],
        });
        const replay = yield* recovered.host
          .lifecycle({ environmentId: core.environmentId, projectId, afterCursor: 0 })
          .pipe(Stream.take(1), Stream.runCollect);
        expect(replay[0]).toMatchObject({ kind: "event", projectId, threadId: retry.threadId });
        expect(
          yield* recovered.host
            .inspect({
              environmentId: EnvironmentId.make("another-environment"),
              projectId,
              threadId: retry.threadId,
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "unavailable" });
        const deleted = yield* Deferred.make<void>();
        const deletionStream = yield* recovered.host
          .lifecycle({
            environmentId: core.environmentId,
            projectId,
            threadId: retry.threadId,
            afterCursor: snapshot.cursor,
          })
          .pipe(
            Stream.filter(
              (item) => item.kind === "snapshot" && item.replayGap && item.threads.length === 0,
            ),
            Stream.take(1),
            Stream.runForEach(() => Deferred.succeed(deleted, undefined)),
            Effect.forkScoped,
          );
        yield* Context.get(context, Threads.ThreadManagementService).dispatch({
          type: "thread.delete",
          threadId: retry.threadId,
          commandId: CommandId.make("delete-fixture-thread"),
        });
        yield* Deferred.await(deleted);
        yield* Fiber.join(deletionStream);
        const deletedReplay = yield* recovered.host
          .lifecycle({
            environmentId: core.environmentId,
            projectId,
            threadId: retry.threadId,
            afterCursor: 0,
          })
          .pipe(Stream.take(1), Stream.runCollect);
        expect(deletedReplay[0]).toMatchObject({ kind: "snapshot", replayGap: true, threads: [] });
        yield* Scope.close(recovered.scope, Exit.void);
        yield* Fiber.interrupt(environment.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.live(
  "redelivers interrupted schedule intent after restart without repeating the plugin result",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("plugin-schedule-recovery")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const recorded = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<{
          schedules: Schedules["Service"];
          storage: Storage["Service"];
        }>();
        let pauseAfterCommit = true;
        const plugin: ServerPlugin = {
          manifest: {
            id: "schedule_fixture",
            displayName: "Schedule fixture",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["schedules", "persistence"],
            server: { tools: [], api: [], scheduleTargets: ["schedule_fixture.dispatch"] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [
            {
              id: 1,
              name: "occurrences",
              run: Effect.gen(function* () {
                const { sql } = yield* Storage;
                yield* sql`CREATE TABLE occurrences (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginError({
                      pluginId: "schedule_fixture",
                      code: "storage",
                      operation: "migrate",
                      message: "Could not create fixture store",
                      cause,
                    }),
                ),
              ),
            },
          ],
          acquire: Effect.gen(function* () {
            const schedules = yield* Schedules;
            const storage = yield* Storage;
            yield* Deferred.succeed(ready, { schedules, storage });
            return {
              tools: [],
              api: [],
              attention: Stream.empty,
              scheduleTargets: [
                {
                  id: "schedule_fixture.dispatch",
                  invoke: ({ occurrenceId, payload }) =>
                    storage.sql`INSERT OR IGNORE INTO occurrences VALUES (${occurrenceId}, ${encodeJson(payload)})`.pipe(
                      Effect.mapError(
                        (cause) =>
                          new PluginError({
                            pluginId: "schedule_fixture",
                            code: "storage",
                            operation: "dispatch",
                            message: "Could not record occurrence",
                            cause,
                          }),
                      ),
                      Effect.andThen(Deferred.succeed(recorded, undefined)),
                      Effect.andThen(
                        Effect.suspend(() => (pauseAfterCommit ? Effect.never : Effect.void)),
                      ),
                    ),
                },
              ],
            };
          }),
        };
        const first = yield* startEnvironment(config, [plugin]);
        const host = Context.get(first.context, Host);
        const projectId = ProjectId.make("scheduled-project");
        yield* Context.get(first.context, Projects.ProjectService).create({
          commandId: CommandId.make("scheduled-project"),
          projectId,
          title: "Scheduled",
          workspaceRoot: config.baseDir,
        });
        const services = yield* Deferred.await(ready);
        const schedule = {
          id: "one",
          target: "schedule_fixture.dispatch",
          projectId,
          title: "Scheduled operation",
          enabled: false,
          schedule: { type: "interval" as const, everyMs: 60_000 },
          payload: { version: "original" },
        };
        yield* services.schedules.upsert(schedule);
        const taskId = ScheduledTaskId.make("plugin:schedule_fixture:one");
        const tasks = Context.get(first.context, ScheduledTasks.ScheduledTaskService);
        const dispatch = yield* tasks
          .runNow({ id: taskId, occurrenceId: "stable-occurrence" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(recorded);
        yield* Fiber.interrupt(dispatch);
        expect((yield* tasks.list()).tasks[0]?.lastRunStatus).toBe("running");
        expect(
          yield* tasks
            .runNow({ id: taskId, occurrenceId: "different-occurrence" })
            .pipe(Effect.flip),
        ).toMatchObject({
          _tag: "ScheduledTaskError",
          message: expect.stringContaining("Another occurrence is pending"),
        });
        // Edits cannot replace the already committed occurrence's payload.
        yield* services.schedules.upsert({ ...schedule, payload: { version: "edited" } });
        yield* Fiber.interrupt(first.fiber);
        pauseAfterCommit = false;
        const second = yield* startEnvironment(config, [plugin]);
        const restartedTasks = Context.get(second.context, ScheduledTasks.ScheduledTaskService);
        expect(
          (yield* restartedTasks.runNow({ id: taskId, occurrenceId: "stable-occurrence" })).task
            .lastRunStatus,
        ).toBe("succeeded");
        expect((yield* restartedTasks.list()).tasks[0]?.runCount).toBe(1);
        // Reopen through the plugin's public storage ownership, not core SQL.
        const verification = yield* Deferred.make<Storage["Service"]>();
        const inspectionPlugin: ServerPlugin = {
          ...plugin,
          manifest: { ...plugin.manifest, server: { tools: [], api: [], scheduleTargets: [] } },
          acquire: Effect.gen(function* () {
            yield* Deferred.succeed(verification, yield* Storage);
            return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
          }),
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inspectionContext = yield* Layer.build(
              Registry.layer({
                environmentId: host.environmentId,
                directory: `${config.stateDir}/plugins`,
                plugins: [inspectionPlugin],
              }),
            ).pipe(Effect.provide(second.context));
            yield* Context.get(inspectionContext, Registry.PluginRegistry).start;
            const storage = yield* Deferred.await(verification);
            const rows = yield* storage.sql<{
              id: string;
              payload: string;
            }>`SELECT * FROM occurrences`;
            expect(rows).toEqual([
              { id: "stable-occurrence", payload: encodeJson({ version: "original" }) },
            ]);
          }),
        );
        yield* Fiber.interrupt(second.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

it.live(
  "boots ordinary thread and scheduling services with zero compiled plugins",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("zero-plugins")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, []);
        expect(
          (yield* Context.get(server.context, Registry.PluginRegistry).catalog).plugins,
        ).toEqual([]);
        const host = Context.get(server.context, Host);
        const settings = Context.get(server.context, Settings.ServerSettingsService);
        const currentSettings = yield* settings.getSettings;
        yield* settings.updateSettings({
          providers: {
            opencode: { ...currentSettings.providers.opencode, serverUrl: "http://127.0.0.1:1" },
          },
        });
        const external = (yield* host.providers()).find(
          (provider) => provider.instanceId === "opencode",
        );
        expect(external).toMatchObject({
          toolsSupported: false,
          reason: expect.stringContaining("Externally owned"),
        });

        const projectId = ProjectId.make("ordinary-project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("ordinary-project"),
          projectId,
          title: "Ordinary",
          workspaceRoot: config.baseDir,
        });
        const launched = yield* host.launch({
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("ordinary-launch"),
          title: "Ordinary thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          workspace: { type: "current" },
        });
        expect(launched.status).toBe("accepted");
        const tasks = Context.get(server.context, ScheduledTasks.ScheduledTaskService);
        const scheduled = yield* tasks.upsert({
          projectId,
          title: "Ordinary prompt",
          prompt: "Continue",
          enabled: false,
          schedule: { type: "interval", everyMs: 60_000 },
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
        expect(scheduled.task.dispatchTarget).toBeUndefined();
        expect((yield* tasks.runNow({ id: scheduled.task.id })).task.lastRunStatus).toBe(
          "succeeded",
        );
        yield* Fiber.interrupt(server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30_000 },
);

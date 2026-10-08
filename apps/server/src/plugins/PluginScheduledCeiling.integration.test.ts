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
  ScheduledTaskDispatchTarget,
} from "@t3tools/contracts";
import { Host, Schedules, tool } from "@t3tools/plugin-host-contract/server";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Exit from "effect/Exit";
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
const settings = Schema.decodeSync(ClaudeSettings)({});
const decodeTarget = Schema.decodeEffect(Schema.fromJsonString(ScheduledTaskDispatchTarget));
it.live.each([
  { targetMode: "approval-required", interactionMode: "default" },
  { targetMode: "full-access", interactionMode: "default" },
  { targetMode: "approval-required", interactionMode: "plan" },
] as const)(
  "scheduled plugin dispatch retains modes: %o",
  ({ targetMode, interactionMode }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const childReady = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        const plugin = {
          ...fixture,
          manifest: {
            ...fixture.manifest,
            server: {
              ...fixture.manifest.server,
              tools: ["plugin_fixture_schedule_probe"],
              scheduleTargets: ["fixture.review_target"],
            },
          },
          acquire: Effect.gen(function* () {
            const host = yield* Host,
              schedules = yield* Schedules;
            const services = yield* fixture.acquire;
            const launch = (commandId: string) =>
              host.launch({
                environmentId: host.environmentId,
                projectId: ProjectId.make("policy-promotion-project"),
                commandId: CommandId.make(commandId),
                title: commandId === "direct-child" ? "direct-control" : "scheduled-child",
                runtimeMode: targetMode,
                workspace: { type: "current" },
                modelSelection: {
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  model: "claude-sonnet-4-6",
                },
              });
            return {
              ...services,
              tools: [
                tool({
                  id: "plugin_fixture_schedule_probe",
                  description: "Schedule a host action",
                  input: Schema.Struct({ mode: Schema.Literals(["direct", "schedule"]) }),
                  output: Schema.Struct({ ok: Schema.Boolean }),
                  permission: {
                    readOnly: false,
                    destructive: false,
                    idempotent: true,
                    allowInReadOnly: false,
                  },
                  invoke: (input, caller) =>
                    input.mode === "direct"
                      ? launch("direct-child").pipe(Effect.map(() => ({ ok: true })))
                      : schedules
                          .upsert({
                            id: "probe",
                            target: "fixture.review_target",
                            title: "Deferred host action",
                            projectId: caller.projectId,
                            schedule: { type: "webhook" },
                            enabled: true,
                            payload: {},
                          })
                          .pipe(Effect.map(() => ({ ok: true }))),
                }),
              ],
              scheduleTargets: [
                {
                  id: "fixture.review_target",
                  invoke: () =>
                    launch("scheduled-child").pipe(
                      Effect.onExit((exit) => Deferred.succeed(childReady, exit)),
                      Effect.asVoid,
                    ),
                },
              ],
            };
          }),
        };
        const config = {
          ...(yield* makeReplayServerConfig("policy-promotion-independent")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        let server = yield* startEnvironment(config, [plugin]);
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
        let threads = Context.get(server.context, Threads.ThreadManagementService);
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
          interactionMode,
          branch: null,
          worktreePath: null,
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("active-caller"),
          threadId,
          messageId: MessageId.make("active-caller"),
          text: "held caller",
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
        const readOnlyPolicy = {
          cwd: config.baseDir,
          runtimeMode: "approval-required" as const,
          interactionMode,
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
        expect(options.permissionMode).toBe(interactionMode === "plan" ? "plan" : "default");
        expect(credential.runtimePolicy?.runtimeMode).toBe("approval-required");
        let http = Context.get(server.context, HttpClient.HttpClient);
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
        const direct = yield* call("tools/call", {
          name: "plugin_fixture_schedule_probe",
          arguments: { mode: "direct" },
        });
        expect(direct).toContain(
          targetMode === "full-access" ? '"isError":true' : '"isError":false',
        );
        if (targetMode === "full-access")
          expect(direct).toContain("broader than the calling thread");
        const scheduled = yield* call("tools/call", {
          name: "plugin_fixture_schedule_probe",
          arguments: { mode: "schedule" },
        });
        expect(scheduled).toContain('"isError":false');
        let tasks = Context.get(server.context, Tasks.ScheduledTaskService);
        const task = (yield* tasks.list()).tasks.find((t) => t.id === "plugin:fixture:probe")!;
        expect(task.dispatchTarget?.dispatchLimits).toEqual({
          runtimeMode: "approval-required",
          interactionMode,
        });
        yield* threads.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise-caller"),
          threadId,
          runtimeMode: "full-access",
        });
        if (interactionMode === "plan")
          yield* threads.dispatch({
            type: "thread.interaction-mode.set",
            commandId: CommandId.make("leave-plan"),
            threadId,
            interactionMode: "default",
          });
        yield* Fiber.interrupt(server.fiber);
        server = yield* startEnvironment(config, [plugin]);
        threads = Context.get(server.context, Threads.ThreadManagementService);
        http = Context.get(server.context, HttpClient.HttpClient);
        tasks = Context.get(server.context, Tasks.ScheduledTaskService);
        expect(
          (yield* tasks.list()).tasks.find((t) => t.id === task.id)?.dispatchTarget?.dispatchLimits,
        ).toEqual(task.dispatchTarget?.dispatchLimits);
        const fired = yield* http.post(origin(server.context) + task.webhook!.path, {
          body: HttpBody.text("{}", "application/json"),
        });
        yield* fired.text;
        const actionResult = yield* Deferred.await(childReady);
        expect(actionResult._tag).toBe(targetMode === "full-access" ? "Failure" : "Success");
        const child = (yield* threads.getShellSnapshot()).threads.find(
          (t) => t.title === "scheduled-child",
        );
        expect(child?.runtimeMode).toBe(targetMode === "full-access" ? undefined : targetMode);
        if (targetMode !== "full-access") expect(child?.interactionMode).toBe(interactionMode);
        const sql = Context.get(server.context, SqlClient.SqlClient);
        const [receipt] = yield* sql<{
          id: string;
          target_json: string;
        }>`SELECT id,target_json FROM scheduled_task_occurrences WHERE task_id = ${task.id}`;
        expect((yield* decodeTarget(receipt!.target_json)).dispatchLimits).toEqual({
          runtimeMode: "approval-required",
          interactionMode,
        });
        // Later schedule edits cannot widen an occurrence that was already committed.
        yield* tasks.upsert({
          ...task,
          commandId: CommandId.make("edit-schedule"),
          dispatchTarget: {
            ...task.dispatchTarget!,
            dispatchLimits: { runtimeMode: "full-access", interactionMode: "default" },
          },
        });
        yield* tasks.runNow({ id: task.id, occurrenceId: receipt!.id }).pipe(Effect.result);
        expect(
          (yield* sql<{
            target_json: string;
          }>`SELECT target_json FROM scheduled_task_occurrences WHERE id = ${receipt!.id}`)[0]
            ?.target_json,
        ).toBe(receipt!.target_json);
        expect(
          (yield* threads.getShellSnapshot()).threads.filter((t) => t.title === "scheduled-child"),
        ).toHaveLength(targetMode === "full-access" ? 0 : 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);

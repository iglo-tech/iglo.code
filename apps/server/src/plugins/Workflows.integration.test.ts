import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { plugin } from "@t3tools/plugin-workflows/server";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as ProviderSessions from "@t3tools/provider-core/server/mcpSession";
import * as McpSessions from "../mcp/McpSessionRegistry.ts";
import { Run, RunSummary } from "@t3tools/plugin-workflows/contracts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Projects from "../project/ProjectService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live("accepts one report for a reserved workflow attempt and returns its receipt on retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = { ...(yield* makeReplayServerConfig("workflows")), noBrowser: true };
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* spawner.exitCode(ChildProcess.make("git", ["init", config.baseDir]));
      yield* spawner.exitCode(
        ChildProcess.make("git", [
          "-C",
          config.baseDir,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        ]),
      );
      const { context } = yield* startEnvironment(config, [
        {
          ...plugin,
          acquire: Effect.gen(function* () {
            const host = yield* Host;
            // Keep real launch, core receipts and MCP authentication; replace the external provider turn.
            return yield* plugin.acquire.pipe(
              Effect.provideService(
                Host,
                Host.of({
                  ...host,
                  providers: () =>
                    host.providers().pipe(
                      Effect.map((providers) =>
                        providers.map((provider) => ({
                          ...provider,
                          available: provider.instanceId === "codex",
                        })),
                      ),
                    ),
                  launch: (input) => host.launch({ ...input, instruction: undefined }),
                }),
              ),
            );
          }),
        },
      ]);
      const host = Context.get(context, Host);
      const registry = Context.get(context, Registry.PluginRegistry);
      const projectId = ProjectId.make("workflow-project");
      yield* Context.get(context, Projects.ProjectService).create({
        commandId: CommandId.make("workflow-project"),
        projectId,
        title: "Workflow",
        workspaceRoot: config.baseDir,
      });
      expect(
        yield* spawner.exitCode(
          ChildProcess.make("git", ["-C", config.baseDir, "update-ref", "--stdin"], {
            stdin: Stream.make(
              new TextEncoder().encode(
                Array.from(
                  { length: 110 },
                  (_, index) => `create refs/heads/a${index.toString().padStart(3, "0")} HEAD\n`,
                ).join(""),
              ),
            ),
          }),
        ),
      ).toBe(0);
      const workspaceInput = { projectId, key: "workspace-retry", ref: "HEAD", readOnly: false };
      const owned = yield* host.prepareWorkspace(workspaceInput);
      const firstRefs = yield* Context.get(context, Git.GitVcsDriver).listRefs({
        cwd: config.baseDir,
      });
      expect(firstRefs.nextCursor).not.toBeNull();
      expect(firstRefs.refs.some((ref) => ref.name === owned.branch)).toBe(false);
      expect(yield* host.prepareWorkspace(workspaceInput)).toEqual(owned);
      expect(yield* host.verifyWorkspace({ projectId, path: owned.path })).toEqual({
        head: owned.head,
        clean: true,
      });
      expect(
        yield* host.execute({
          projectId,
          path: owned.path,
          command: "git",
          args: ["rev-parse", "HEAD"],
          timeoutMs: 5000,
        }),
      ).toMatchObject({ exitCode: 0, timedOut: false, stdout: `${owned.head}\n` });
      const invoke = Effect.fnUntraced(function* (method: string, input: unknown) {
        const api = yield* registry.api(`plugins.workflows.${method}`);
        const result = api.invoke(input);
        if (!Effect.isEffect(result)) return yield* Effect.die("Expected a command");
        return yield* result;
      });
      const run = yield* invoke("start", {
        environmentId: host.environmentId,
        projectId,
        clientRequestId: "start-1",
        workspace: { type: "current" },
        input: {},
        definition: {
          version: 1,
          id: "sequence",
          revision: 1,
          title: "Sequence",
          entry: "implement",
          atLimit: "review",
          nodes: [
            {
              id: "implement",
              kind: "agent",
              title: "Implement",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              runtimeMode: "approval-required",
              instruction: "Implement the request",
              report: { fields: [{ name: "ready", type: "boolean", required: true }] },
              next: { to: "review" },
            },
            {
              id: "review",
              kind: "human",
              title: "Review",
              approve: { to: "done" },
              changes: { to: "done" },
            },
            { id: "done", kind: "end", title: "Done", outcome: "completed" },
          ],
        },
      });
      expect(run).toMatchObject({
        state: "running",
        attempts: [{ nodeId: "implement", phase: "launching" }],
      });
      const started = yield* decodeRun(run);
      const api = yield* registry.api("plugins.workflows.subscribe");
      const stream = api.invoke({ environmentId: host.environmentId, projectId });
      if (!Stream.isStream(stream)) return yield* Effect.die("Expected subscription");
      const active = yield* stream.pipe(
        Stream.mapEffect((value) => decodeRuns(value)),
        Stream.flatMap(Stream.fromArray),
        Stream.filter((run) => run.id === started.id && run.attempts[0]?.phase === "running"),
        Stream.take(1),
        Stream.runCollect,
      );
      const threadId = active[0]!.attempts[0]!.threadId!;
      const sessions = Context.get(context, McpSessions.McpSessionRegistry);
      const http = Context.get(context, HttpClient.HttpClient);
      const issue = sessions.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      const first = (yield* issue).config;
      ProviderSessions.setMcpProviderSession(first);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => ProviderSessions.clearMcpProviderSession(threadId)),
      );
      const report = Effect.fnUntraced(function* (connection: typeof first) {
        const headers = {
          authorization: connection.authorizationHeader,
          accept: "application/json, text/event-stream",
        };
        const initialize = yield* http.post(connection.endpoint, {
          headers,
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "workflow-test", version: "1" },
              },
            }),
            "application/json",
          ),
        });
        expect(initialize.status).toBe(200);
        yield* initialize.text;
        const response = yield* http.post(connection.endpoint, {
          headers: {
            ...headers,
            "mcp-protocol-version": "2025-06-18",
            ...(initialize.headers["mcp-session-id"]
              ? { "mcp-session-id": initialize.headers["mcp-session-id"]! }
              : {}),
          },
          body: HttpBody.text(
            encodeJson({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "plugin_workflows_report",
                arguments: {
                  version: 1,
                  clientRetryKey: "native-report",
                  outcome: "completed",
                  summary: "Implemented",
                  data: { ready: true },
                  evidence: [],
                },
              },
            }),
            "application/json",
          ),
        });
        return yield* response.text;
      });
      const accepted = yield* report(first);
      expect(accepted).toContain('"isError":false');
      expect(accepted).toContain(started.attempts[0]!.id);
      expect(yield* report(first)).toBe(accepted);
      yield* sessions.revokeProviderSession(first.providerSessionId);
      const refreshed = (yield* issue).config;
      ProviderSessions.setMcpProviderSession(refreshed);
      const revoked = yield* http.post(first.endpoint, {
        headers: { authorization: first.authorizationHeader },
        body: HttpBody.text("{}", "application/json"),
      });
      expect(revoked.status).toBe(401);
      expect(yield* report(refreshed)).toBe(accepted);
      const reported = yield* invoke("get", {
        environmentId: host.environmentId,
        projectId,
        runId: started.id,
      });
      expect(reported).toMatchObject({
        state: "running",
        trace: [],
        attempts: [{ phase: "reported", report: { data: { ready: true } } }],
      });
      const now = DateTime.nowUnsafe();
      const failedId = RunId.make("required-follow-up-failed-before-start");
      // Core's queued_start_failed disposition retains startedAt=null; persist that actual shape.
      const sinkContext = yield* Layer.build(
        EventSink.layer.pipe(
          Layer.provide(
            Layer.mergeAll(ProjectionStore.layer, EventStore.layerFromOrchestrationEventStore),
          ),
          Layer.provide(Layer.succeedContext(context)),
        ),
      );
      yield* Context.get(sinkContext, EventSink.EventSinkV2).write({
        events: (["completed", "failed"] as const).map((status, index) => {
          const runId = index === 0 ? RunId.make("reported-execution") : failedId;
          return {
            id: EventId.make(`workflow-native-result-${index}`),
            type: "run.created" as const,
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: index + 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              providerThreadId: null,
              userMessageId: MessageId.make(`message-${runId}`),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: now,
              startedAt: index === 0 ? now : null,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          };
        }),
      });
      expect(
        yield* host.inspect({ environmentId: host.environmentId, projectId, threadId }),
      ).toMatchObject({ resultRunId: failedId, outstandingWork: [] });
      const failed = yield* stream.pipe(
        Stream.mapEffect((value) => decodeRuns(value)),
        Stream.flatMap(Stream.fromArray),
        Stream.filter((run) => run.id === started.id && run.state === "unresolved"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(failed[0]).toMatchObject({
        state: "unresolved",
        attempts: [{ phase: "failed" }],
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

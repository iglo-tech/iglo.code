import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError, type PluginThreadState } from "@t3tools/plugin-host-contract/schema";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);

const modes = [
  "stop-followup",
  "natural-followup",
  "workflow-resume",
  "failed-followup",
  "interrupted-followup",
  "failed-monitor",
  "resume-inspect-outage",
  "resume-inspect-stale",
] as const;
it.live.each(modes)(
  "retains workflow generation outcomes across native follow-ups and explicit Resume: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const resuming = mode.startsWith("resume-inspect") || mode === "workflow-resume";
        let inspectUnavailable = false;
        let staleInspection: PluginThreadState | null = null;
        let admittedSends = 0;
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          inspect: (input) =>
            inspectUnavailable && staleInspection !== null
              ? Effect.succeed(staleInspection)
              : inspectUnavailable
                ? Effect.fail(
                    new PluginError({
                      pluginId: "host",
                      code: "service",
                      operation: "inspect",
                      message: "Post-admission native inspection outage",
                    }),
                  )
                : test.core.inspect(input),
          send: (input) =>
            Effect.gen(function* () {
              const old = yield* test.core.receipt(input.commandId);
              if (old) return old;
              if (mode === "resume-inspect-stale")
                staleInspection = yield* test.core.inspect(input);
              admittedSends++;
              yield* test.threads
                .dispatch({
                  type: "message.dispatch",
                  threadId: input.threadId,
                  commandId: input.commandId,
                  messageId: MessageId.make(`${input.commandId}:message`),
                  text: input.instruction,
                  attachments: [],
                  dispatchMode: { type: "defer_start" },
                  createdBy: "agent",
                  creationSource: "mcp",
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new PluginError({
                        pluginId: "host",
                        operation: "send",
                        code: "service",
                        message: "Could not commit fixture execution",
                        cause,
                      }),
                  ),
                );
              if (mode.startsWith("resume-inspect")) inspectUnavailable = true;
              return (yield* test.core.receipt(input.commandId))!;
            }),
        });
        let runtime = yield* test.boot(host);
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            clientRequestId: "start",
            definition: sequence,
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const threadId = started.attempts[0]!.threadId!;
        const now = DateTime.nowUnsafe();
        const runId = RunId.make("settled-run");
        const root = NodeId.make("root");
        const providerThreadId = ProviderThreadId.make("provider");
        const providerTurnId = ProviderTurnId.make("turn");
        const attemptId = RunAttemptId.make("attempt");
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        // Substitute external lifecycle input while retaining the actual sink, projections and services.
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("run"),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "fixture" },
                providerThreadId,
                userMessageId: MessageId.make("message"),
                rootNodeId: root,
                activeAttemptId: attemptId,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make("root"),
              type: "node.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: root,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: root,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("provider"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerThreadId,
                driver,
                providerInstanceId: instanceId,
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
                pendingBackgroundTasks: [
                  {
                    taskId: "owned-background",
                    kind: "command",
                    description: "Retained native command",
                  },
                ],
              },
            },
            {
              id: EventId.make("turn"),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: root,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: 1,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("attempt"),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: root,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
        const target = { ...test.scope, threadId };
        const before = yield* test.core.inspect(target);
        expect(before.outstandingWork.length).toBeGreaterThan(0);
        expect(before.runs.map((run) => run.status)).toEqual(["completed"]);
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          db.prepare(
            "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].executionRunId',?) WHERE id=?",
          ).run(runId, started.id);
        } finally {
          db.close();
        }
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        if (!resuming)
          yield* tool.invoke(
            {
              version: 1,
              clientRetryKey: "report",
              outcome: "completed",
              summary: "Claimed success",
              data: { ready: true },
              evidence: [],
            },
            {
              ...test.scope,
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: "fixture",
              runtimeMode: "approval-required",
            },
          );
        yield* runtime.invoke("reconcile", test.scope);
        expect(
          (yield* runtime
            .invoke("get", { ...test.scope, runId: started.id })
            .pipe(Effect.flatMap(decodeRun))).state,
        ).toBe("running");
        if (!resuming) yield* runtime.close;
        if (mode === "stop-followup" || resuming) {
          yield* test.threads.dispatch({
            type: "thread.stop",
            threadId,
            commandId: CommandId.make("manual-stop"),
            reason: "Explicit user Stop",
          });
        } else {
          const records = yield* test.threads.getProjectThreadRecords(target, [
            "runs",
            "nodes",
            "providerThreads",
          ]);
          const provider = records.providerThreads.find((item) => item.id === providerThreadId)!;
          const ended = DateTime.nowUnsafe();
          const status =
            mode === "failed-followup"
              ? ("failed" as const)
              : mode === "interrupted-followup"
                ? ("interrupted" as const)
                : ("completed" as const);
          yield* test.sink.write({
            events: [
              {
                id: EventId.make("original-settled"),
                type: "run.updated",
                threadId,
                runId,
                occurredAt: ended,
                payload: {
                  ...records.runs.find((run) => run.id === runId)!,
                  status,
                  completedAt: ended,
                },
              },
              ...records.nodes
                .filter((node) => node.runId === runId)
                .map((node) => ({
                  id: EventId.make(`original-node:${node.id}`),
                  type: "node.updated" as const,
                  threadId,
                  runId,
                  occurredAt: ended,
                  payload: { ...node, status, completedAt: ended },
                })),
              {
                id: EventId.make("native-background-completed"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: ended,
                payload: { ...provider, pendingBackgroundTasks: [], updatedAt: ended },
              },
            ],
          });
        }
        if (resuming) {
          yield* runtime.invoke("reconcile", test.scope);
          yield* runtime.invoke("reconcile", test.scope);
          const interrupted = yield* runtime
            .invoke("get", { ...test.scope, runId: started.id })
            .pipe(Effect.flatMap(decodeRun));
          expect(interrupted.allowedActions).toContain("resume");
          yield* runtime.invoke("resume", {
            ...test.scope,
            runId: started.id,
            expectedRevision: interrupted.revision,
            clientRequestId: "explicit-workflow-resume",
          });
          yield* runtime.invoke("reconcile", test.scope);
          if (mode.startsWith("resume-inspect")) {
            const pending = yield* runtime
              .invoke("get", { ...test.scope, runId: started.id })
              .pipe(Effect.flatMap(decodeRun));
            expect(pending.attempts[0]!.phase).toBe("resuming");
          }
          yield* runtime.close;
          inspectUnavailable = false;
          runtime = yield* test.boot(host);
          yield* runtime.invoke("reconcile", test.scope);
          const resumedTool = (yield* runtime.registry.tools).find(
            (item) => item.tool.id === "plugin_workflows_report",
          )!.tool;
          yield* resumedTool.invoke(
            {
              version: 1,
              clientRetryKey: "new-generation-report",
              outcome: "completed",
              summary: "Resumed work completed",
              data: { ready: true },
              evidence: [],
            },
            {
              ...test.scope,
              threadId,
              providerInstanceId: instanceId,
              providerSessionId: "fixture",
              runtimeMode: "approval-required",
            },
          );
        } else {
          // Actual native follow-up admission, outside a workflow Resume command.
          yield* test.threads.dispatch({
            type: "message.dispatch",
            threadId,
            commandId: CommandId.make("native-follow-up"),
            messageId: MessageId.make("native-follow-up"),
            text: "Queued native continuation",
            attachments: [],
            dispatchMode: {
              type: mode === "failed-monitor" ? "queue_after_active" : "defer_start",
            },
            createdBy: "agent",
            creationSource: mode === "failed-monitor" ? "server" : "mcp",
            ...(mode === "failed-monitor"
              ? {
                  notification: {
                    source: { kind: "monitor" as const },
                    outcome: "failed" as const,
                    summary: "Unrelated monitor failed",
                  },
                }
              : {}),
          });
        }
        const follow = yield* test.threads.getProjectThreadRecords(target, [
          "runs",
          "nodes",
          "turnItems",
        ]);
        const next = follow.runs.find((item) => item.ordinal === 2)!;
        expect(next).toBeDefined();
        const endedAt = DateTime.nowUnsafe();
        const status = mode === "failed-monitor" ? ("failed" as const) : ("completed" as const);
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("followup-completed"),
              type: "run.updated",
              threadId,
              runId: next.id,
              occurredAt: endedAt,
              payload: { ...next, status, startedAt: endedAt, completedAt: endedAt },
            },
            ...follow.nodes
              .filter((item) => item.runId === next.id)
              .map((item) => ({
                id: EventId.make(`node-completed:${item.id}`),
                type: "node.updated" as const,
                threadId,
                runId: next.id,
                occurredAt: endedAt,
                payload: { ...item, status, completedAt: endedAt },
              })),
            ...follow.turnItems
              .filter((item) => item.runId === next.id)
              .map((item) => ({
                id: EventId.make(`item-completed:${item.id}`),
                type: "turn-item.updated" as const,
                threadId,
                runId: next.id,
                occurredAt: endedAt,
                payload: {
                  ...item,
                  status,
                  completedAt: endedAt,
                  updatedAt: endedAt,
                },
              })),
          ],
        });
        if (!resuming) runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        const current = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        const native = yield* test.core.inspect(target);
        const records = yield* test.threads.getProjectThreadRecords(target, ["turnItems", "runs"]);

        expect(native.outstandingWork).toEqual([]);
        expect(native.runs.find((run) => run.id === runId)?.interruptRequested === true).toBe(
          mode === "stop-followup" || resuming,
        );
        const unsuccessful = ["stop-followup", "failed-followup", "interrupted-followup"].includes(
          mode,
        );
        const expected = unsuccessful ? "unresolved" : "awaiting-review";
        if (mode === "stop-followup")
          expect(
            records.turnItems.filter((item) => item.type === "run_interrupt_request").length,
          ).toBeGreaterThan(0);
        yield* runtime.close;
        const restarted = yield* test.boot(host);
        yield* restarted.invoke("reconcile", test.scope);
        const retained = yield* restarted
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));

        expect(current.state).toBe(expected);
        expect(retained.state).toBe(expected);
        expect(current.attempts[0]!.resumeCount).toBe(resuming ? 1 : 0);
        expect(admittedSends).toBe(resuming ? 1 : 0);
        expect(native.runs).toHaveLength(2);
        if (unsuccessful) expect(current.allowedActions).not.toContain("approve");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

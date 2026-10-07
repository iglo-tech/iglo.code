import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
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

it.live.each([
  "manual-stop",
  "manual-stop-with-queue",
  "natural-completion",
  "workflow-cancel",
] as const)(
  "honors explicit native stop after report with outstanding background work: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const host = Host.of({ ...test.core });
        const runtime = yield* test.boot(host);
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
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
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
        if (mode === "manual-stop-with-queue") {
          const original = (yield* test.threads.getProjectThreadRecords(target, [
            "runs",
          ])).runs.find((run) => run.id === runId)!;
          yield* test.sink.write({
            events: [
              {
                id: EventId.make("provider-still-running"),
                type: "run.updated",
                threadId,
                runId,
                occurredAt: now,
                payload: { ...original, status: "running", completedAt: null },
              },
            ],
          });
          yield* test.threads.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queued-native-message"),
            messageId: MessageId.make("queued-native-message"),
            threadId,
            text: "Ordinary queued follow-up",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          expect(
            (yield* test.threads.getProjectThreadRecords(target, ["runs"])).runs.filter(
              (run) => run.status === "queued",
            ),
          ).toHaveLength(1);
        }
        if (mode.startsWith("manual-stop")) {
          yield* test.threads.dispatch({
            type: "thread.stop",
            threadId,
            commandId: CommandId.make("manual-stop"),
            reason: "Explicit user Stop",
          });
        } else if (mode === "natural-completion") {
          const provider = (yield* test.threads.getProjectThreadRecords(target, [
            "providerThreads",
          ])).providerThreads.find((item) => item.id === providerThreadId)!;
          const ended = DateTime.nowUnsafe();
          yield* test.sink.write({
            events: [
              {
                id: EventId.make("native-background-completed"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: ended,
                payload: { ...provider, pendingBackgroundTasks: [], updatedAt: ended },
              },
            ],
          });
        } else {
          const state = yield* runtime
            .invoke("get", { ...test.scope, runId: started.id })
            .pipe(Effect.flatMap(decodeRun));
          yield* runtime.invoke("cancel", {
            ...test.scope,
            runId: state.id,
            expectedRevision: state.revision,
            clientRequestId: "cancel",
          });
        }
        if (mode === "manual-stop-with-queue") {
          const endedAt = DateTime.nowUnsafe();
          const stopped = yield* test.threads.getProjectThreadRecords(target, ["runs", "nodes"]);
          yield* test.sink.write({
            events: [
              {
                id: EventId.make("provider-stop-settled"),
                type: "run.updated",
                threadId,
                runId,
                occurredAt: endedAt,
                payload: {
                  ...stopped.runs.find((run) => run.id === runId)!,
                  status: "interrupted",
                  completedAt: endedAt,
                },
              },
              ...stopped.nodes
                .filter((node) => node.runId === runId)
                .map((node) => ({
                  id: EventId.make(`provider-stop-node:${node.id}`),
                  type: "node.updated" as const,
                  threadId,
                  runId,
                  occurredAt: endedAt,
                  payload: { ...node, status: "interrupted" as const, completedAt: endedAt },
                })),
            ],
          });
        }
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        const current = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        const native = yield* test.core.inspect(target);
        const records = yield* test.threads.getProjectThreadRecords(target, ["turnItems", "runs"]);

        expect(native.outstandingWork).toEqual([]);
        expect(native.runs.find((run) => run.id === runId)?.interruptRequested === true).toBe(
          mode.startsWith("manual-stop") || mode === "workflow-cancel",
        );
        const expected = mode.startsWith("manual-stop")
          ? "unresolved"
          : mode === "workflow-cancel"
            ? "canceled"
            : "awaiting-review";
        if (mode.startsWith("manual-stop"))
          expect(
            records.turnItems.filter((item) => item.type === "run_interrupt_request").length,
          ).toBeGreaterThan(0);
        yield* runtime.close;
        const restarted = yield* test.boot(host);
        yield* restarted.invoke("reconcile", test.scope);
        const retained = yield* restarted
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));

        if (mode === "manual-stop-with-queue") {
          expect(
            records.runs.filter((run) =>
              ["preparing", "starting", "running", "waiting"].includes(run.status),
            ),
          ).toEqual([]);
          expect(records.runs.find((run) => run.id === runId)!.status).toBe("interrupted");
          const queued = records.runs.find((run) => run.status === "queued")!;
          expect(queued).toBeDefined();
          expect(queued.queueHeld).toBe(true);
          expect(
            (yield* test.threads.getProjectThreadRecords(target, ["runs"])).runs.find(
              (run) => run.id === queued.id,
            )?.queueHeld,
          ).toBe(true);
        }
        expect(current.state).toBe(expected);
        expect(retained.state).toBe(expected);
        if (mode.startsWith("manual-stop")) expect(current.allowedActions).not.toContain("approve");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

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

it.live.each(["workflow", "host", "direct-core"] as const)(
  "cleans settled native background work through %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        let interrupts = 0;
        const host = Host.of({
          ...test.core,
          interrupt: (input) => {
            interrupts++;
            return test.core.interrupt(input);
          },
        });
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
        if (mode === "direct-core")
          yield* test.threads.dispatch({
            type: "run.interrupt",
            threadId,
            runId,
            commandId: CommandId.make("direct-stop"),
          });
        else if (mode === "host")
          yield* host.interrupt({ ...target, runId, commandId: CommandId.make("host-stop") });
        else {
          const current = yield* runtime
            .invoke("get", { ...test.scope, runId: started.id })
            .pipe(Effect.flatMap(decodeRun));
          yield* runtime.invoke("cancel", {
            ...test.scope,
            runId: current.id,
            expectedRevision: current.revision,
            clientRequestId: "cancel",
          });
          yield* runtime.invoke("reconcile", test.scope);
          yield* runtime.invoke("reconcile", test.scope);
          expect(interrupts).toBe(1);
        }
        expect((yield* test.core.inspect(target)).outstandingWork).toEqual([]);
        yield* runtime.close;
        const restarted = yield* test.boot(host);
        yield* restarted.invoke("reconcile", test.scope);
        expect((yield* test.core.inspect(target)).outstandingWork).toEqual([]);
        if (mode === "workflow") expect(interrupts).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

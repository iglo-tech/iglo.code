import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Host } from "@t3tools/plugin-host-contract/server";
import { CommandId, EventId, MessageId, NodeId, RuntimeRequestId } from "@t3tools/contracts";
import { AttentionPage, Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodePage = Schema.decodeUnknownEffect(AttentionPage);

it.live(
  "keeps workflow attention when its thread is read or snoozed and clears each request on its own answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        // The replayed provider reports its execution interrupted once the test says so; the
        // thread, its requests, read state and snooze are real core state.
        let interrupted = false;
        const runtime = yield* test.boot(
          Host.of({
            ...test.core,
            lifecycle: () => Stream.never,
            inspect: (target) =>
              test.core.inspect(target).pipe(
                Effect.map((state) =>
                  interrupted
                    ? {
                        ...state,
                        runs: state.runs.map((run) => ({ ...run, status: "interrupted" })),
                        resultRunId: state.runs.at(-1)?.id ?? null,
                        outstandingWork: [],
                        checkpoints: [],
                      }
                    : state,
                ),
              ),
          }),
        );
        const attention = runtime
          .invoke("attention-page", test.scope)
          .pipe(Effect.flatMap(decodePage));
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition: sequence,
            clientRequestId: "start",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const threadId = started.attempts[0]!.threadId!;
        yield* test.threads.dispatch({
          type: "message.dispatch",
          threadId,
          commandId: CommandId.make("deferred"),
          messageId: MessageId.make("message"),
          text: "Provider native execution",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
          "runs",
        ]);
        const began = DateTime.nowUnsafe();
        const native = { ...records.runs[0]!, status: "waiting" as const, startedAt: began };
        // Two questions wait in the thread's native queue, answered in order.
        const request = (id: string, offset: number) => ({
          id: RuntimeRequestId.make(id),
          nodeId: NodeId.make(`${id}-node`),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input" as const,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: DateTime.makeUnsafe(DateTime.toEpochMillis(began) + offset),
          resolvedAt: null,
        });
        const approval = request("approval", 0);
        const question = request("question", 1);
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("native-wait-run"),
              type: "run.updated",
              threadId,
              runId: native.id,
              occurredAt: began,
              payload: native,
            },
            ...[approval, question].map((item) => ({
              id: EventId.make(`${item.id}-pending`),
              type: "runtime-request.updated" as const,
              threadId,
              occurredAt: began,
              payload: item,
            })),
          ],
        });
        yield* runtime.invoke("reconcile", test.scope);
        const waiting = yield* attention;
        expect(waiting.total).toBe(1);
        const items = waiting.runs[0]!.items;
        expect(
          items.map((item) => [item.kind, item.threadId, item.request?.id, item.request?.position]),
        ).toEqual([
          ["needs-input", threadId, "approval", 1],
          ["needs-input", threadId, "question", 2],
        ]);

        // Reading the thread is presentation; nothing workflow-owned moves. Native
        // attention keeps its priority: a thread with a pending request cannot be snoozed.
        const visit = (id: string) =>
          test.threads.dispatch({
            type: "thread.visit",
            commandId: CommandId.make(id),
            threadId,
            visitedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          });
        const snooze = (id: string) =>
          test.threads.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make(id),
            threadId,
            snoozedUntil: DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { hours: 4 })),
          });
        yield* visit("visit");
        expect((yield* Effect.result(snooze("snooze-refused")))._tag).toBe("Failure");
        yield* runtime.invoke("reconcile", test.scope);
        expect(yield* attention).toEqual(waiting);
        const unchanged = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(unchanged.attempts[0]).toMatchObject({ phase: "waiting-input", report: null });

        // Each item clears only on its own native resolution.
        const answered = DateTime.nowUnsafe();
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("approval-resolved"),
              type: "runtime-request.updated",
              threadId,
              occurredAt: answered,
              payload: { ...approval, status: "resolved", resolvedAt: answered },
            },
          ],
        });
        yield* runtime.invoke("reconcile", test.scope);
        const remaining = (yield* attention).runs[0]!.items;
        expect(remaining.map((item) => [item.id, item.request?.position])).toEqual([
          [items[1]!.id, 1],
        ]);
        // The last answer arrives, then native execution is interrupted: the run stops for a person.
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("question-resolved"),
              type: "runtime-request.updated",
              threadId,
              occurredAt: answered,
              payload: { ...question, status: "resolved", resolvedAt: answered },
            },
          ],
        });
        interrupted = true;
        yield* runtime.invoke("reconcile", test.scope);
        const stopped = yield* attention;
        expect(stopped.runs[0]!.items).toEqual([
          expect.objectContaining({
            kind: "interrupted",
            attemptId: started.attempts[0]!.id,
            threadId,
            request: null,
          }),
        ]);
        // Without a pending request the thread can be snoozed; the workflow decision stays.
        yield* snooze("snooze");
        yield* visit("visit-again");
        yield* runtime.invoke("reconcile", test.scope);
        expect(yield* attention).toEqual(stopped);
        expect(
          (yield* runtime
            .invoke("get", { ...test.scope, runId: started.id })
            .pipe(Effect.flatMap(decodeRun))).state,
        ).toBe("unresolved");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { CommandId, MessageId, EventId, NodeId, RuntimeRequestId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each([
  "unobserved-wait",
  "persisted-wait",
  "unobserved-human-deadline",
  "resolved-before-recovery",
  "late-human-response",
  "expired-active-before-wait",
] as const)("recovers timing of actual native input wait: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
      let runtime = yield* test.boot(host);
      const get = (id: string) =>
        runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.flatMap(decodeRun));
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent"
            ? {
                ...node,
                timeoutMs: 60000,
                ...(scenario.endsWith("deadline") || scenario === "late-human-response"
                  ? { humanTimeoutMs: 60000 }
                  : {}),
              }
            : node,
        ),
      });
      const started = yield* runtime
        .invoke("start", {
          ...test.scope,
          definition,
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
      // Persist the provider request before the workflow sees its lifecycle wake, then crash.
      yield* runtime.close;
      const old = DateTime.toEpochMillis(DateTime.nowUnsafe()) - 3_600_000;
      const began = DateTime.makeUnsafe(
        old + (scenario === "expired-active-before-wait" ? 65000 : 1000),
      );
      const answered = ["resolved-before-recovery", "late-human-response"].includes(scenario);
      const answeredAt = DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 1000);
      const request = {
        id: RuntimeRequestId.make("input"),
        nodeId: NodeId.make("input-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: answered ? ("resolved" as const) : ("pending" as const),
        responseCapability: { type: "message" as const },
        createdAt: began,
        resolvedAt: answered ? answeredAt : null,
      };
      const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runs",
      ]);
      const nativeRun = {
        ...records.runs[0]!,
        rootNodeId: request.nodeId,
        status: answered ? ("running" as const) : ("waiting" as const),
        requestedAt: DateTime.makeUnsafe(old),
        startedAt: DateTime.makeUnsafe(old),
      };
      const node = {
        id: request.nodeId,
        threadId,
        runId: nativeRun.id,
        parentNodeId: null,
        rootNodeId: request.nodeId,
        kind: "user_input_request" as const,
        status: answered ? ("completed" as const) : ("waiting" as const),
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: request.id,
        checkpointScopeId: null,
        startedAt: began,
        completedAt: answered ? answeredAt : null,
      };
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("native-wait-run"),
            type: "run.updated",
            threadId,
            runId: nativeRun.id,
            occurredAt: began,
            payload: nativeRun,
          },
          {
            id: EventId.make("native-wait-node"),
            type: "node.updated",
            threadId,
            runId: nativeRun.id,
            occurredAt: began,
            payload: node,
          },
          {
            id: EventId.make("input-pending"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: began,
            payload: request,
          },
        ],
      });
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        db.prepare(
          "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',?,'$.attempts[0].phase',?,'$.attempts[0].waitStartedAt',?) WHERE id=?",
        ).run(
          old,
          scenario === "persisted-wait" ? 59000 : 60000,
          scenario === "persisted-wait" ? "waiting-input" : "running",
          scenario === "persisted-wait" ? old + 1000 : null,
          started.id,
        );
      } finally {
        db.close();
      }
      const recorded = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runtimeRequests",
      ]);
      expect(DateTime.toEpochMillis(recorded.runtimeRequests[0]!.createdAt)).toBe(
        DateTime.toEpochMillis(began),
      );
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const waiting = yield* get(started.id);
      if (
        scenario.endsWith("deadline") ||
        scenario === "late-human-response" ||
        scenario === "expired-active-before-wait"
      ) {
        expect(waiting.state).toBe("unresolved");
        expect(waiting.reason).toContain(
          scenario === "expired-active-before-wait" ? "execution timeout" : "human-response",
        );
      } else {
        const resolvedAt = DateTime.nowUnsafe();
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("input-resolved"),
              type: "runtime-request.updated",
              threadId,
              occurredAt: resolvedAt,
              payload: { ...request, status: "resolved", resolvedAt },
            },
            {
              id: EventId.make("input-node-completed"),
              type: "node.updated",
              threadId,
              runId: nativeRun.id,
              occurredAt: resolvedAt,
              payload: { ...node, status: "completed", completedAt: resolvedAt },
            },
            {
              id: EventId.make("input-run-resumed"),
              type: "run.updated",
              threadId,
              runId: nativeRun.id,
              occurredAt: resolvedAt,
              payload: { ...nativeRun, status: "running" },
            },
          ],
        });
        yield* runtime.invoke("reconcile", test.scope);
        const resumed = yield* get(started.id);
        expect(resumed.state).toBe("running");
        expect(resumed.attempts[0]!.remainingMs).toBeGreaterThan(50000);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
it.live.each([
  "completed-offline",
  "completed-online",
  "still-active",
  "completed-late",
  "late-report",
] as const)("retains settlement before the execution deadline: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      let unavailable = false;
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        inspect: (input) =>
          unavailable
            ? Effect.fail(
                new PluginError({
                  pluginId: "host",
                  operation: "inspect",
                  code: "service",
                  message: "Observation outage",
                }),
              )
            : test.core.inspect(input),
      });
      let runtime = yield* test.boot(host);
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent" ? { ...node, timeoutMs: 60000 } : node,
        ),
      });
      const start = yield* runtime
        .invoke("start", {
          ...test.scope,
          definition,
          clientRequestId: "start",
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      unavailable = true;
      const threadId = start.attempts[0]!.threadId!;
      const tool = (yield* runtime.registry.tools).find(
        (item) => item.tool.id === "plugin_workflows_report",
      )!.tool;
      yield* tool.invoke(completed, {
        ...test.scope,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "fixture",
        runtimeMode: "approval-required",
      });
      yield* runtime.close;
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const began = now - (scenario === "completed-online" ? 30000 : 3600000);
      const startedAt = DateTime.makeUnsafe(began);
      const finishedAt = DateTime.makeUnsafe(
        began + (scenario === "completed-late" ? 65000 : 1000),
      );
      const nativeId = RunId.make("actual-completed-run");
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("actual-result"),
            type: "run.created",
            threadId,
            runId: nativeId,
            occurredAt: finishedAt,
            payload: {
              id: nativeId,
              threadId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              providerThreadId: null,
              userMessageId: MessageId.make("initial"),
              rootNodeId: null,
              activeAttemptId: null,
              status: scenario === "still-active" ? "running" : "completed",
              requestedAt: startedAt,
              startedAt,
              completedAt: scenario === "still-active" ? null : finishedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        db.prepare(
          "UPDATE workflow_runs SET data=json_set(data,'$.createdAt',?,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',60000,'$.attempts[0].report.receipt.acceptedAt',?) WHERE id=?",
        ).run(began, began, began + (scenario === "late-report" ? 65000 : 500), start.id);
        db.prepare(
          "UPDATE workflow_reports SET receipt=json_set(receipt,'$.acceptedAt',?) WHERE attempt_id=?",
        ).run(began + (scenario === "late-report" ? 65000 : 500), start.attempts[0]!.id);
      } finally {
        db.close();
      }
      unavailable = false;
      const aggregate = yield* test.core.inspect({ ...test.scope, threadId });
      if (scenario !== "still-active") {
        expect(aggregate.outstandingWork).toEqual([]);
        expect(aggregate.requests).toEqual([]);
        expect(aggregate.checkpoints).toEqual([]);
      }
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const state = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runs",
      ]);
      const completion = records.runs[0]!.completedAt;
      expect(completion === null ? null : DateTime.toEpochMillis(completion)).toBe(
        scenario === "still-active" ? null : DateTime.toEpochMillis(finishedAt),
      );
      expect(state.state).toBe(
        scenario === "still-active" || scenario === "completed-late" || scenario === "late-report"
          ? "unresolved"
          : "awaiting-review",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

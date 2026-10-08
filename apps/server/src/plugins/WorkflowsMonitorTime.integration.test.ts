import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import {
  CommandId,
  CheckpointId,
  CheckpointScopeId,
  CheckpointRef,
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
it.live.each([
  "monitor-late-artifact",
  "monitor-late-error-artifact",
  "monitor-timely-artifact",
  "ordinary-late-artifact",
  "monitor-no-artifact",
  "monitor-late-run",
] as const)("scopes settlement accounting to result-relevant artifacts: %s", (scenario) =>
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
      const began = now - 3600000;
      const initialEnd = DateTime.makeUnsafe(began + 1000);
      const followEnd = DateTime.makeUnsafe(scenario === "monitor-late-run" ? now : began + 2000);
      const initialId = RunId.make("actual-completed-run");
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("initial-result"),
            type: "run.created",
            threadId,
            runId: initialId,
            occurredAt: initialEnd,
            payload: {
              id: initialId,
              threadId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              providerThreadId: null,
              userMessageId: MessageId.make("initial"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: DateTime.makeUnsafe(began),
              startedAt: DateTime.makeUnsafe(began),
              completedAt: initialEnd,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const monitor = scenario !== "ordinary-late-artifact";
      yield* test.threads.dispatch({
        type: "message.dispatch",
        threadId,
        commandId: CommandId.make("followup"),
        messageId: MessageId.make("followup"),
        text: "Follow-up",
        attachments: [],
        dispatchMode: { type: monitor ? "queue_after_active" : "defer_start" },
        createdBy: "agent",
        creationSource: monitor ? "server" : "mcp",
        ...(monitor
          ? {
              notification: {
                source: { kind: "monitor" as const },
                outcome: "completed" as const,
                summary: "Monitor result",
              },
            }
          : {}),
      });
      const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runs",
        "nodes",
        "turnItems",
      ]);
      const follow = records.runs.find((run) => run.ordinal === 2)!;
      expect(follow).toBeDefined();
      expect(follow.rootNodeId).not.toBeNull();
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("followup-result"),
            type: "run.updated",
            threadId,
            runId: follow.id,
            occurredAt: followEnd,
            payload: {
              ...follow,
              status: "completed",
              requestedAt: initialEnd,
              startedAt: initialEnd,
              completedAt: followEnd,
            },
          },
          ...records.nodes
            .filter((node) => node.runId === follow.id)
            .map((node) => ({
              id: EventId.make(`node:${node.id}`),
              type: "node.updated" as const,
              threadId,
              runId: follow.id,
              occurredAt: followEnd,
              payload: { ...node, status: "completed" as const, completedAt: followEnd },
            })),
          ...records.turnItems
            .filter((item) => item.runId === follow.id)
            .map((item) => ({
              id: EventId.make(`item:${item.id}`),
              type: "turn-item.updated" as const,
              threadId,
              runId: follow.id,
              occurredAt: followEnd,
              payload: {
                ...item,
                status: "completed" as const,
                completedAt: followEnd,
                updatedAt: followEnd,
              },
            })),
        ],
      });
      if (scenario !== "monitor-no-artifact" && scenario !== "monitor-late-run") {
        const capturedAt = DateTime.makeUnsafe(
          scenario === "monitor-timely-artifact" ? began + 3000 : now,
        );
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("follow-checkpoint"),
              type: "checkpoint.captured",
              threadId,
              runId: follow.id,
              occurredAt: capturedAt,
              payload: {
                id: CheckpointId.make("follow-checkpoint"),
                threadId,
                scopeId: CheckpointScopeId.make("follow-scope"),
                runId: follow.id,
                nodeId: follow.rootNodeId!,
                parentCheckpointId: null,
                ordinalWithinScope: 1,
                appRunOrdinal: 2,
                ref: CheckpointRef.make("refs/t3/follow-checkpoint"),
                status: scenario === "monitor-late-error-artifact" ? "error" : "ready",
                files: [],
                capturedAt,
              },
            },
          ],
        });
      }
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        db.prepare(
          "UPDATE workflow_runs SET data=json_set(data,'$.createdAt',?,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',60000,'$.attempts[0].executionRunId',?,'$.attempts[0].report.receipt.acceptedAt',?) WHERE id=?",
        ).run(began, began, initialId, began + 500, start.id);
        db.prepare(
          "UPDATE workflow_reports SET receipt=json_set(receipt,'$.acceptedAt',?) WHERE attempt_id=?",
        ).run(began + 500, start.attempts[0]!.id);
      } finally {
        db.close();
      }
      unavailable = false;
      const state = yield* test.core.inspect({ ...test.scope, threadId });
      expect(state.outstandingWork).toEqual([]);
      expect(state.requests).toEqual([]);
      expect(state.runs.find((run) => run.id === follow.id)?.resultRelevant).toBe(!monitor);
      expect(state.resultRunId).toBe(monitor ? initialId : follow.id);
      expect(state.checkpoints).toHaveLength(
        scenario === "monitor-no-artifact" || scenario === "monitor-late-run" ? 0 : 1,
      );
      if (state.checkpoints.length) {
        expect(state.checkpoints[0]!.runId).toBe(follow.id);
        expect(state.checkpoints[0]!.status).toBe(
          scenario === "monitor-late-error-artifact" ? "error" : "ready",
        );
      }
      const persisted = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runs",
      ]);
      const nativeFollow = persisted.runs.find((run) => run.id === follow.id)!;
      expect(DateTime.toEpochMillis(nativeFollow.requestedAt)).toBeLessThanOrEqual(
        DateTime.toEpochMillis(nativeFollow.startedAt!),
      );
      expect(DateTime.toEpochMillis(nativeFollow.startedAt!)).toBeLessThanOrEqual(
        DateTime.toEpochMillis(nativeFollow.completedAt!),
      );
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const run = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      const expected = monitor ? "awaiting-review" : "unresolved";
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const retained = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(retained.state).toBe(run.state);
      expect(run.state).toBe(expected);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
it.live.each([
  "report-inflight",
  "report-after-commit",
  "report-before-replay",
  "report-before-crash",
] as const)("settles only after queued reminder work: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<void>();
      let outage = true;
      let sends = 0;
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        send: (input) =>
          Effect.gen(function* () {
            const retained = yield* test.core.receipt(input.commandId);
            if (retained) return retained;
            if (outage) {
              yield* Deferred.succeed(failed, undefined);
              return yield* new PluginError({
                pluginId: "host",
                operation: "send",
                code: "service",
                message: "Deterministic send outage",
              });
            }
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(released);
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
            sends++;
            yield* Deferred.succeed(finished, undefined);
            return (yield* test.core.receipt(input.commandId))!;
          }),
      });
      let runtime = yield* test.boot(host);
      const get = (id: string) =>
        runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.flatMap(decodeRun));
      const start = yield* runtime
        .invoke("start", {
          ...test.scope,
          definition: sequence,
          clientRequestId: "start",
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      const threadId = start.attempts[0]!.threadId!;
      const now = DateTime.nowUnsafe();
      const runId = RunId.make("completed-original");
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("completed-original"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              providerThreadId: null,
              userMessageId: MessageId.make("initial-message"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      yield* Deferred.await(failed);
      const report = Effect.gen(function* () {
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        yield* tool.invoke(completed, {
          ...test.scope,
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "authenticated-fixture",
          runtimeMode: "approval-required",
        });
        if (scenario !== "report-before-crash") yield* runtime.invoke("reconcile", test.scope);
      });
      const beforeReplay =
        scenario === "report-before-replay" || scenario === "report-before-crash";
      if (beforeReplay) yield* report;
      yield* runtime.close;
      outage = false;
      runtime = yield* test.boot(host);
      if (!beforeReplay) yield* Deferred.await(entered);
      if (scenario === "report-after-commit") {
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(finished);
      }
      if (!beforeReplay) yield* report;
      if (beforeReplay) yield* runtime.invoke("reconcile", test.scope);
      const before = yield* get(start.id);
      if (scenario === "report-inflight") {
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(finished);
      }
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const retained = yield* get(start.id);
      expect(before.state).toBe(beforeReplay ? "awaiting-review" : "running");
      expect(retained.state).toBe(beforeReplay ? "awaiting-review" : "running");
      expect(sends).toBe(beforeReplay ? 0 : 1);
      if (!beforeReplay) {
        const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
          "runs",
          "nodes",
          "turnItems",
        ]);
        const execution = records.runs
          .toSorted((left, right) => left.ordinal - right.ordinal)
          .at(-1)!;
        const settledAt = DateTime.nowUnsafe();
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("reminder-settled"),
              type: "run.updated",
              threadId,
              runId: execution.id,
              occurredAt: settledAt,
              payload: { ...execution, status: "completed", completedAt: settledAt },
            },
            ...records.nodes
              .filter((node) => node.runId === execution.id)
              .map((node) => ({
                id: EventId.make(`reminder-node-settled:${node.id}`),
                type: "node.updated" as const,
                threadId,
                runId: execution.id,
                occurredAt: settledAt,
                payload: { ...node, status: "completed" as const, completedAt: settledAt },
              })),
            ...records.turnItems
              .filter((item) => item.runId === execution.id)
              .map((item) => ({
                id: EventId.make(`reminder-item-settled:${item.id}`),
                type: "turn-item.updated" as const,
                threadId,
                runId: execution.id,
                occurredAt: settledAt,
                payload: {
                  ...item,
                  status: "completed" as const,
                  completedAt: settledAt,
                  updatedAt: settledAt,
                },
              })),
          ],
        });
        yield* runtime.invoke("reconcile", test.scope);
        const ready = yield* get(start.id);
        expect(ready.state).toBe("awaiting-review");
        yield* runtime.invoke("gate", {
          ...test.scope,
          runId: start.id,
          expectedRevision: ready.revision,
          clientRequestId: "approve-after-settlement",
          decision: "approve",
        });
        expect((yield* get(start.id)).state).toBe("completed");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

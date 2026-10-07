import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const encodeCommandParts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
it.live.each([
  "missing-offline",
  "missing-online",
  "completion-late",
  "accepted-offline",
  "lostack-offline",
  "lostack-online",
  "lostack-late",
  "lostack-active",
  "lostack-unstarted",
] as const)("uses retained settlement for missing-report recovery: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      let observing = true;
      let sends = 0;
      let loseAck = scenario.startsWith("lostack");
      let launches = 0;
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        launch: (input) =>
          Effect.gen(function* () {
            const previous = yield* test.core.receipt(input.commandId);
            const receipt = previous ?? (yield* test.core.launch(input));
            if (!previous) launches++;
            if (loseAck)
              return yield* new PluginError({
                pluginId: "host",
                operation: "launch",
                code: "service",
                message: "Committed launch ACK lost",
              });
            return receipt;
          }),
        inspect: (input) =>
          observing
            ? test.core.inspect(input)
            : Effect.fail(
                new PluginError({
                  pluginId: "host",
                  operation: "inspect",
                  code: "service",
                  message: "Observation outage",
                }),
              ),
        send: (input) =>
          Effect.gen(function* () {
            const receipt = yield* test.core.receipt(input.commandId);
            if (receipt) return receipt;
            sends++;
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
                      message: "Fixture send could not commit",
                      cause,
                    }),
                ),
              );
            return (yield* test.core.receipt(input.commandId))!;
          }),
      });
      let runtime = yield* test.boot(host);
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent" ? { ...node, timeoutMs: 60000 } : node,
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
      const admission = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(admission.attempts[0]!.phase).toBe(
        scenario.startsWith("lostack") ? "launching" : "running",
      );
      const launchReceipt = yield* test.core.receipt(
        CommandId.make(
          `plugin:${encodeCommandParts(["workflows", `${started.attempts[0]!.id}:launch:0`])}`,
        ),
      );
      expect(launchReceipt?.status).toBe("accepted");
      observing = false;
      if (scenario === "accepted-offline") {
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
      }
      yield* runtime.close;
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const began =
        now - (scenario === "missing-online" || scenario === "lostack-online" ? 30000 : 3600000);
      const finishedAt = DateTime.makeUnsafe(
        began + (scenario === "completion-late" || scenario === "lostack-late" ? 65000 : 1000),
      );
      const nativeId = RunId.make("actual-settled-work");
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
              status:
                scenario === "lostack-active"
                  ? "running"
                  : scenario === "lostack-unstarted"
                    ? "preparing"
                    : "completed",
              requestedAt: DateTime.makeUnsafe(began),
              startedAt: scenario === "lostack-unstarted" ? null : DateTime.makeUnsafe(began),
              completedAt:
                scenario === "lostack-active" || scenario === "lostack-unstarted"
                  ? null
                  : finishedAt,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        db.prepare(
          "UPDATE workflow_runs SET data=json_set(data,'$.createdAt',?,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',60000) WHERE id=?",
        ).run(began, began, started.id);
        if (scenario === "accepted-offline")
          db.prepare(
            "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].report.receipt.acceptedAt',?) WHERE id=?",
          ).run(began + 500, started.id);
      } finally {
        db.close();
      }
      observing = true;
      loseAck = false;
      const aggregate = yield* test.core.inspect({ ...test.scope, threadId });
      if (scenario !== "lostack-active" && scenario !== "lostack-unstarted")
        expect(aggregate.outstandingWork).toEqual([]);
      expect(aggregate.requests).toEqual([]);
      expect(aggregate.checkpoints).toEqual([]);
      if (scenario !== "lostack-active" && scenario !== "lostack-unstarted")
        expect(aggregate.settledAt).toBe(DateTime.toEpochMillis(finishedAt));
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const run = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      const native = yield* test.core.inspect({ ...test.scope, threadId });

      expect(launches).toBe(1);
      expect(run.attempts[0]!.report === null).toBe(scenario !== "accepted-offline");
      if (scenario === "lostack-offline") {
        expect(native.runs).toHaveLength(2);
        expect(native.runs.find((run) => run.id === nativeId)?.status).toBe("completed");
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          const command = db
            .prepare("SELECT result FROM host_commands WHERE id=?")
            .get(`${started.attempts[0]!.id}:launch:0`);
          expect(command?.result).toEqual(expect.any(String));
        } finally {
          db.close();
        }
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(retained.state).toBe("running");
      }
      if (
        scenario.startsWith("missing") ||
        scenario === "lostack-offline" ||
        scenario === "lostack-online"
      ) {
        expect(sends).toBe(1);
        expect(run.state).toBe("running");
        expect(run.attempts[0]!.remainingMs).toBe(59000);
        expect(native.runs).toHaveLength(2);
      } else {
        expect(sends).toBe(0);
        expect(run.state).toBe(scenario === "accepted-offline" ? "awaiting-review" : "unresolved");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

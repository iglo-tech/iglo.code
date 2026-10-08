import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Run, RunSummary, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownSync(Definition);
const decodeSummaries = Schema.decodeUnknownSync(Schema.Array(RunSummary));
it.live.each([
  "expired-recovery",
  "expired-live",
  "still-unavailable",
  "unexpired-control",
] as const)("bounds retained reminder admission: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const entered = yield* Deferred.make<void>();

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
          definition: decodeDefinition({
            ...sequence,
            nodes: sequence.nodes.map((node) =>
              node.kind === "agent" ? { ...node, timeoutMs: 60000 } : node,
            ),
          }),
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
      yield* runtime.close;
      const records = yield* test.threads.getProjectThreadRecords({ ...test.scope, threadId }, [
        "runs",
      ]);
      const wallNow = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const reminderAt = wallNow - (scenario !== "unexpired-control" ? 3600000 : 1000);
      const original = records.runs[0]!;
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("earlier-settlement"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: DateTime.makeUnsafe(reminderAt),
            payload: {
              ...original,
              requestedAt: DateTime.makeUnsafe(reminderAt - 1000),
              startedAt: DateTime.makeUnsafe(reminderAt - 1000),
              completedAt: DateTime.makeUnsafe(reminderAt),
            },
          },
        ],
      });
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        db.prepare(
          "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',59000) WHERE id=?",
        ).run(reminderAt, start.id);
        const row = db.prepare("SELECT data FROM workflow_runs WHERE id=?").get(start.id)!;
        const before = JSON.parse(String(row.data));
        expect(before.attempts[0].phase).toBe("reminding");
        expect(before.attempts[0].reminderSent).toBe(false);
        const pending = db
          .prepare(
            "SELECT COUNT(*) AS n FROM host_commands WHERE json_extract(intent,'$.kind')='send' AND result IS NULL",
          )
          .get()!;
        expect(pending.n).toBe(1);
      } finally {
        db.close();
      }
      if (scenario === "expired-live" || scenario === "still-unavailable") {
        // Reboot while transport remains unavailable. Live retry has the same deadline rule.
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        outage = scenario === "still-unavailable";
        yield* runtime.invoke("reconcile", test.scope);
      } else {
        outage = false;
        runtime = yield* test.boot(host);
        const unresolved = Effect.gen(function* () {
          const api = yield* runtime.registry.api("plugins.workflows.subscribe");
          const observation = api.invoke(test.scope);
          if (!Stream.isStream(observation)) return yield* Effect.die("Expected subscription");
          yield* observation.pipe(
            Stream.filter((value) =>
              decodeSummaries(value).some(
                (run) => run.id === start.id && run.state === "unresolved",
              ),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        });
        yield* Effect.raceFirst(Deferred.await(finished), unresolved);
        yield* runtime.invoke("reconcile", test.scope);
      }
      const current = yield* get(start.id);
      const native = yield* test.core.inspect({ ...test.scope, threadId });
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const reboot = yield* get(start.id);
      const rebootNative = yield* test.core.inspect({ ...test.scope, threadId });
      expect(sends).toBe(scenario === "unexpired-control" ? 1 : 0);
      expect(native.runs).toHaveLength(scenario === "unexpired-control" ? 2 : 1);
      expect(current.state).toBe(scenario === "unexpired-control" ? "running" : "unresolved");
      expect(reboot.state).toBe(scenario === "unexpired-control" ? "running" : "unresolved");
      expect(rebootNative.runs).toHaveLength(scenario === "unexpired-control" ? 2 : 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

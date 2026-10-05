import * as NodeSqlite from "node:sqlite";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { fixture, sequence, parallel } from "./Workflows.testkit.ts";

const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeRun = Schema.decodeUnknownEffect(Run);
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(Run));

it.effect.each([
  { mode: "timeout", resume: false },
  { mode: "timeout", resume: true },
  { mode: "cancel", resume: false },
  { mode: "cancel", resume: true },
])("$mode interrupts native work after resume=$resume", ({ mode, resume }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: [{ ...sequence.nodes[0], timeoutMs: 60_000 }, ...sequence.nodes.slice(1)],
      });
      const started = yield* test.start(definition);
      yield* test.reconcile;
      const threadId = started.attempts[0]!.threadId!;
      if (resume) {
        // Repeated native interruptions must not consume a later cancellation's effect identity.
        for (let generation = 1; generation <= 2; generation++) {
          test.settle(threadId, "interrupted");
          yield* test.reconcile;
          const interrupted = yield* test.query(started.id);
          expect(interrupted.allowedActions).toContain("resume");
          yield* test.reconcile;
          yield* test.invoke("resume", {
            environmentId: test.environmentId,
            projectId: test.projectId,
            runId: started.id,
            expectedRevision: interrupted.revision,
            clientRequestId: `resume-${generation}`,
          });
          yield* test.reconcile;
          expect(test.threads.get(threadId)!.runs.at(-1)!.status).toBe("running");
          yield* test.restart;
          yield* test.reconcile;
        }
      }
      if (mode === "timeout") yield* TestClock.adjust("2 minutes");
      else {
        const current = yield* test.query(started.id);
        yield* test.invoke("cancel", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: started.id,
          expectedRevision: current.revision,
          clientRequestId: "cancel",
        });
      }
      yield* test.reconcile;
      yield* test.reconcile;
      const stopped = yield* test.query(started.id);
      expect(stopped.state).toBe(mode === "timeout" ? "unresolved" : "canceled");
      expect(test.threads.get(threadId)!.runs.map((run) => run.status)).not.toContain("running");
      yield* test.restart;
      yield* test.reconcile;
      expect(test.threads.get(threadId)!.runs.map((run) => run.status)).not.toContain("running");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects join admission outside its matching fork", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      for (const definition of [
        { ...parallel, entry: "join" },
        {
          ...parallel,
          nodes: parallel.nodes.map((node) =>
            node.kind === "human"
              ? { ...node, approve: { to: "join", repeat: { max: 1, atLimit: "done" } } }
              : node,
          ),
        },
      ]) {
        const validation = yield* test.invoke("validate", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          definition,
        });
        expect(validation).toMatchObject({ runnable: false });
        expect((yield* test.start(definition).pipe(Effect.result))._tag).toBe("Failure");
      }
      expect(test.launches).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "recovers a persisted stranded join with consumed generation=%s",
  (consumed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const started = yield* test.start(consumed ? parallel : { ...sequence, entry: "review" });
        yield* test.reconcile;
        if (consumed) {
          const forked = yield* test.query(started.id);
          for (const attempt of forked.attempts) {
            yield* test.report(attempt.threadId!, {
              version: 1,
              clientRetryKey: "report",
              outcome: "completed",
              summary: "Pass",
              data: { verdict: "pass" },
              evidence: [],
            });
            test.settle(attempt.threadId!);
          }
          yield* test.reconcile;
          yield* test.reconcile;
        }
        const reviewed = yield* test.query(started.id);
        expect(reviewed.state).toBe("awaiting-review");
        if (consumed) expect(reviewed.reviews[0]?.consumed).toBe(true);
        const legacy = yield* decodeRun({
          ...reviewed,
          definition: { ...parallel, entry: "join" },
          state: "running",
          currentNode: "join",
          gate: null,
          visits: reviewed.visits + 1,
          allowedActions: ["cancel"],
        });
        const encoded = yield* encodeRun(legacy);
        // Restore the old persisted failure, including its already completed node effect.
        const database = new NodeSqlite.DatabaseSync(
          `${test.directory}/plugins/workflows/state.sqlite`,
        );
        try {
          database
            .prepare("UPDATE workflow_runs SET data = ?, state = 'running' WHERE id = ?")
            .run(encoded, legacy.id);
          database
            .prepare(
              "INSERT OR IGNORE INTO workflow_outbox (id, run_id, kind, status) VALUES (?, ?, 'node', 'done')",
            )
            .run(`${legacy.id}:node:${legacy.visits}`, legacy.id);
        } finally {
          database.close();
        }
        yield* test.restart;
        yield* test.reconcile;
        const recovered = yield* test.query(legacy.id);
        expect(recovered.state).toBe("unresolved");
        expect(recovered.reason).toContain("fork generation");
        expect(recovered.allowedActions).toContain("retry");
        yield* test.invoke("retry", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: recovered.id,
          expectedRevision: recovered.revision,
          clientRequestId: "fresh-fork",
        });
        yield* test.reconcile;
        const retried = yield* test.query(recovered.id);
        expect(retried.state).toBe("running");
        expect(retried.reviews.at(-1)?.consumed).toBe(false);
        expect(retried.reviews.at(-1)?.generation).toBe(consumed ? 2 : 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

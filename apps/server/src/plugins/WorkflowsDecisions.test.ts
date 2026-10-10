import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CatalogEntry, Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { completed, fixture, sequence } from "./Workflows.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const implement = sequence.nodes[0]!;

/** Implement, run checks, then route on the recorded check result with one bounded repeat. */
const checked = (maxVisits?: number) =>
  decodeDefinition({
    version: 1,
    id: "checked",
    revision: 1,
    title: "Checked implementation",
    entry: "implement",
    atLimit: "review",
    ...(maxVisits === undefined ? {} : { maxVisits }),
    nodes: [
      { ...implement, next: { to: "checks" } },
      {
        id: "checks",
        kind: "check",
        title: "Checks",
        command: "project-check",
        args: [],
        next: { to: "decide" },
      },
      {
        id: "decide",
        kind: "decision",
        title: "Check result",
        source: "checks",
        rules: [
          {
            when: {
              op: "all",
              terms: [
                { op: "eq", path: "outcome", value: "completed" },
                {
                  op: "any",
                  terms: [
                    { op: "eq", path: "exitCode", value: 0 },
                    { op: "eq", path: "timedOut", value: true },
                  ],
                },
              ],
            },
            route: { to: "review" },
          },
        ],
        otherwise: { to: "implement", repeat: { max: 1, atLimit: "review" } },
      },
      {
        id: "review",
        kind: "human",
        title: "Human review",
        approve: { to: "done" },
        changes: { to: "stopped" },
      },
      { id: "done", kind: "end", title: "Done", outcome: "completed" },
      { id: "stopped", kind: "end", title: "Changes requested", outcome: "failed" },
    ],
  });

it.effect(
  "routes on recorded check results through an initial visit, one repeat and At limit, then a human decision",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const definition = yield* checked();
        expect(yield* test.invoke("validate", { ...scope, definition })).toMatchObject({
          runnable: true,
          problems: [],
        });
        test.setCheck({ exitCode: 1, timedOut: false, stdout: "1 test failed" });
        const started = yield* test.start(definition);
        const implementOnce = Effect.fnUntraced(function* (visit: number) {
          yield* test.reconcile;
          const run = yield* test.wait(
            started.id,
            (run) =>
              run.attempts.filter((attempt) => attempt.nodeId === "implement").length === visit &&
              run.attempts.at(-1)?.phase === "running",
          );
          const threadId = run.attempts.at(-1)!.threadId!;
          yield* test.report(threadId, completed);
          test.settle(threadId);
          yield* test.reconcile;
        });

        // Initial visit: the failed check result drives the decision to its Otherwise repeat.
        yield* implementOnce(1);
        const repeated = yield* test.wait(started.id, (run) =>
          run.trace.some((item) => item.nodeId === "decide"),
        );
        const check = repeated.attempts.find((attempt) => attempt.nodeId === "checks")!;
        expect(check).toMatchObject({
          phase: "failed",
          check: { outcome: "failed", exitCode: 1, stdout: "1 test failed" },
        });
        expect(repeated.trace.find((item) => item.nodeId === "checks")).toMatchObject({
          route: "next",
          chosen: "decide",
          sourceIds: [check.id],
        });
        expect(repeated.trace.find((item) => item.nodeId === "decide")).toMatchObject({
          route: "otherwise",
          chosen: "implement",
          considered: [{ matched: false }],
          reason: "Admitted a bounded repeat.",
          repeatCount: 1,
          repeat: { max: 1, atLimit: "review", exhausted: false },
        });

        // A restart keeps the counter; the repeated visit's failure exhausts it.
        yield* test.restart;
        yield* implementOnce(2);
        const limited = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
        expect(limited.repeats).toEqual({ "decide:implement": 1 });
        expect(limited.attempts.filter((attempt) => attempt.nodeId === "implement")).toHaveLength(
          2,
        );
        expect(limited.trace.at(-1)).toMatchObject({
          nodeId: "decide",
          route: "otherwise",
          chosen: "review",
          reason: "The repeat limit was reached.",
          repeatCount: 1,
          repeat: { max: 1, atLimit: "review", exhausted: true },
        });
        expect(limited).toMatchObject({
          automationStopped: true,
          gate: { nodeId: "review" },
          allowedActions: ["cancel", "approve", "request-changes"],
        });
        yield* test.restart;
        const reloaded = yield* test.query(started.id);
        expect(reloaded.repeats).toEqual(limited.repeats);
        expect(reloaded.trace).toEqual(limited.trace);

        // The human decision follows its authored destination and is recorded with its route.
        const decided = yield* test
          .invoke("gate", {
            ...scope,
            runId: started.id,
            clientRequestId: "changes",
            expectedRevision: reloaded.revision,
            decision: "request-changes",
          })
          .pipe(Effect.flatMap(decodeRun));
        expect(decided).toMatchObject({ state: "failed", currentNode: "stopped" });
        expect(decided.trace.at(-1)).toMatchObject({
          nodeId: "review",
          route: "changes",
          chosen: "stopped",
          reason: "Human decision: request-changes.",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("takes the first matching nested rule on a passing check and approves to its end", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      test.setCheck({ exitCode: 0, timedOut: false, stdout: "ok" });
      const started = yield* test.start(yield* checked());
      yield* test.reconcile;
      const running = yield* test.wait(started.id, (run) => run.attempts[0]?.phase === "running");
      yield* test.report(running.attempts[0]!.threadId!, completed);
      test.settle(running.attempts[0]!.threadId!);
      yield* test.reconcile;
      const review = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      expect(review.trace.at(-1)).toMatchObject({
        nodeId: "decide",
        route: "rules.0",
        chosen: "review",
        considered: [{ matched: true }],
        reason: "First matching rule.",
        repeatCount: null,
      });
      expect(review.trace.at(-1)?.repeat).toBeUndefined();
      expect(review).toMatchObject({ automationStopped: false, repeats: {} });
      const approved = yield* test
        .invoke("gate", {
          ...scope,
          runId: started.id,
          clientRequestId: "approve",
          expectedRevision: review.revision,
          decision: "approve",
        })
        .pipe(Effect.flatMap(decodeRun));
      expect(approved).toMatchObject({ state: "completed", currentNode: "done" });
      expect(approved.trace.at(-1)).toMatchObject({ route: "approve", chosen: "done" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("sends the run to At limit when the whole-run visit bound is exhausted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setCheck({ exitCode: 0, timedOut: false, stdout: "ok" });
      // Implement and the check use both visits; the decision would be the third.
      const started = yield* test.start(yield* checked(2));
      yield* test.reconcile;
      const running = yield* test.wait(started.id, (run) => run.attempts[0]?.phase === "running");
      yield* test.report(running.attempts[0]!.threadId!, completed);
      test.settle(running.attempts[0]!.threadId!);
      yield* test.reconcile;
      const limited = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      expect(limited).toMatchObject({ automationStopped: true, currentNode: "review" });
      expect(limited.trace.at(-1)).toMatchObject({
        nodeId: "checks",
        route: "next",
        chosen: "review",
        reason: "The whole-run visit limit was reached.",
      });
      expect(limited.trace.some((item) => item.nodeId === "decide")).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "locates invalid operands, removed fields and repeat targets at their exact controls",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const valid = yield* checked();
        const definition = yield* decodeDefinition({
          ...valid,
          nodes: valid.nodes.flatMap((node): ReadonlyArray<unknown> =>
            node.kind === "decision"
              ? [
                  {
                    ...node,
                    rules: [
                      {
                        when: {
                          op: "all",
                          terms: [
                            { op: "eq", path: "outcome", value: "passed" },
                            {
                              op: "any",
                              terms: [
                                { op: "gt", path: "timedOut", value: 1 },
                                { op: "eq", path: "data.removed", value: true },
                              ],
                            },
                          ],
                        },
                        route: { to: "gone" },
                      },
                    ],
                    otherwise: { to: "implement", repeat: { max: 1, atLimit: "done-removed" } },
                  },
                ]
              : [node],
          ),
        });
        const entry = yield* test
          .invoke("validate", { ...scope, definition })
          .pipe(Effect.flatMap(decodeEntry));
        expect(entry.runnable).toBe(false);
        const located = (entry.problems ?? []).map(({ severity, nodeId, control }) => ({
          severity,
          nodeId,
          control,
        }));
        for (const control of [
          "rules.0",
          "otherwise.repeat",
          "rules.0.when.0",
          "rules.0.when.1.0",
          "rules.0.when.1.1",
        ])
          expect(located).toContainEqual({ severity: "error", nodeId: "decide", control });
        expect(
          yield* test
            .invoke("save", { ...scope, definition, expectedRevision: null })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "validation" });
        expect(test.launches).toHaveLength(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not spend a repeat that the whole-run visit limit diverts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setCheck({ exitCode: 1, timedOut: false, stdout: "1 test failed" });
      // Implement, the check and the decision use all three visits; the repeat cannot run.
      const started = yield* test.start(yield* checked(3));
      yield* test.reconcile;
      const running = yield* test.wait(started.id, (run) => run.attempts[0]?.phase === "running");
      yield* test.report(running.attempts[0]!.threadId!, completed);
      test.settle(running.attempts[0]!.threadId!);
      yield* test.reconcile;
      const limited = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      expect(limited).toMatchObject({ automationStopped: true, repeats: {} });
      expect(limited.trace.at(-1)).toMatchObject({
        nodeId: "decide",
        route: "otherwise",
        chosen: "review",
        reason: "The whole-run visit limit was reached.",
        repeatCount: 0,
        repeat: { max: 1, atLimit: "review", exhausted: false, outcome: "visit-limit" },
      });
      expect(limited.attempts.filter((attempt) => attempt.nodeId === "implement")).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "withholds a human gate's Request changes repeat that the whole-run visit limit would divert",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        // Implement and the gate use both visits, so Request changes cannot repeat Implement.
        const started = yield* test.start(yield* decodeDefinition({ ...sequence, maxVisits: 2 }));
        yield* test.reconcile;
        const running = yield* test.wait(started.id, (run) => run.attempts[0]?.phase === "running");
        yield* test.report(running.attempts[0]!.threadId!, completed);
        test.settle(running.attempts[0]!.threadId!);
        yield* test.reconcile;
        const gate = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
        expect(gate).toMatchObject({
          automationStopped: false,
          allowedActions: ["cancel", "approve"],
          withheld: [
            { action: "request-changes", to: "implement", repeat: true, cause: "visit-limit" },
          ],
        });
        // A direct request is refused rather than silently returning to the same gate.
        expect(
          yield* test
            .invoke("gate", {
              ...scope,
              runId: started.id,
              clientRequestId: "changes",
              expectedRevision: gate.revision,
              decision: "request-changes",
            })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "conflict" });
        const after = yield* test.query(started.id);
        expect(after).toMatchObject({ repeats: {}, revision: gate.revision });
        expect(after.trace).toHaveLength(gate.trace.length);
        expect(after.attempts).toHaveLength(1);
        const approved = yield* test
          .invoke("gate", {
            ...scope,
            runId: started.id,
            clientRequestId: "approve",
            expectedRevision: gate.revision,
            decision: "approve",
          })
          .pipe(Effect.flatMap(decodeRun));
        expect(approved).toMatchObject({ state: "completed", withheld: [] });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects two repeats to one step and decisions on steps that do not run before them",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const valid = yield* checked();
        const definition = yield* decodeDefinition({
          ...valid,
          nodes: valid.nodes.map((node): unknown =>
            node.kind === "decision"
              ? {
                  ...node,
                  source: "review",
                  rules: [
                    {
                      when: { op: "eq", path: "outcome", value: "failed" },
                      route: { to: "implement", repeat: { max: 2, atLimit: "review" } },
                    },
                  ],
                }
              : node,
          ),
        });
        const entry = yield* test
          .invoke("validate", { ...scope, definition })
          .pipe(Effect.flatMap(decodeEntry));
        expect(entry.runnable).toBe(false);
        expect(entry.problems).toContainEqual({
          severity: "error",
          nodeId: "decide",
          control: "otherwise.repeat",
          message:
            "decide: Rule 1 already repeats back to implement, and repeats from one step to the same step share one counter. Return to a different step or keep a single repeat route.",
        });
        const upstream = yield* decodeDefinition({
          ...valid,
          nodes: [
            ...valid.nodes.map((node) =>
              node.kind === "decision" ? { ...node, source: "later" } : node,
            ),
            { ...implement, id: "later", next: { to: "done" } },
          ],
        });
        const later = yield* test
          .invoke("validate", { ...scope, definition: upstream })
          .pipe(Effect.flatMap(decodeEntry));
        expect(later.problems).toContainEqual({
          severity: "error",
          nodeId: "decide",
          control: "source",
          message:
            "decide: later never runs before this decision, so there is no result to decide on. Choose an earlier step.",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

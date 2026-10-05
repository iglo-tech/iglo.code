import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { fixture, sequence, completed, parallel } from "./Workflows.testkit.ts";
import * as Schema from "effect/Schema";
import { Definition, Run, RunSummary, CatalogEntry } from "@t3tools/plugin-workflows/contracts";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";

const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.effect("joins three isolated frozen reviewers only after every reported execution settles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const started = yield* test.start(parallel);
      yield* test.reconcile;
      const forked = yield* test.wait(
        started.id,
        (run) =>
          run.attempts.length === 3 && run.attempts.every((attempt) => attempt.phase === "running"),
      );
      expect(
        new Set(
          test.launches.map(
            (launch) => launch.workspace.type === "existing" && launch.workspace.path,
          ),
        ).size,
      ).toBe(3);
      expect(forked.attempts.map((attempt) => attempt.skill?.name)).toEqual([
        "code-review",
        "code-review",
        undefined,
      ]);
      for (const attempt of forked.attempts)
        yield* test.report(attempt.threadId!, {
          ...completed,
          data: { verdict: attempt.branchId === "code" ? "changes" : "pass" },
        });
      test.settle(forked.attempts[1]!.threadId!);
      test.settle(forked.attempts[0]!.threadId!);
      yield* test.reconcile;
      expect((yield* test.query(started.id)).reviews[0]?.result).toBeNull();
      yield* test.restart;
      test.settle(forked.attempts[2]!.threadId!);
      yield* test.reconcile;
      const joined = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      expect(joined.reviews).toMatchObject([
        {
          result: "all_completed",
          head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          branches: [{ id: "code" }, { id: "security" }, { id: "ux" }],
        },
      ]);
      expect(joined.trace.at(-1)?.sourceIds).toHaveLength(4);
      test.setHead("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      const invalidated = yield* test
        .invoke("gate", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: joined.id,
          expectedRevision: joined.revision,
          clientRequestId: "approve",
          decision: "approve",
        })
        .pipe(Effect.flatMap(decodeRun));
      expect(invalidated).toMatchObject({
        state: "unresolved",
        reason: "The pull request head changed after review.",
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reserves the entire fork budget before launching and rejects changed reviewer input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const limited = yield* test.start({ ...parallel, maxVisits: 3 });
        yield* test.reconcile;
        expect(
          yield* test.wait(limited.id, (run) => run.state === "awaiting-review"),
        ).toMatchObject({ attempts: [], reviews: [] });
        expect(test.launches).toHaveLength(0);
        const run = yield* test.start(parallel, "next");
        yield* test.reconcile;
        const fork = yield* test.wait(
          run.id,
          (run) =>
            run.attempts.every((attempt) => attempt.phase === "running") &&
            run.attempts.length === 3,
        );
        for (const attempt of fork.attempts) {
          yield* test.report(attempt.threadId!, { ...completed, data: { verdict: "pass" } });
          test.settle(attempt.threadId!);
        }
        test.setDirty(true);
        yield* test.reconcile;
        const stale = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(stale.reviews[0]?.result).toBe("stale");
        expect(stale.trace.at(-1)?.chosen).toBe("unresolved");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("sends one missing-report reminder and then retains unresolved attention", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const run = yield* test.start(sequence);
      yield* test.reconcile;
      const threadId = run.attempts[0]!.threadId!;
      test.settle(threadId);
      yield* test.reconcile;
      const reminded = yield* test.wait(run.id, (run) => run.attempts[0]!.reminderSent);
      expect(reminded.attempts[0]).toMatchObject({ reminderSent: true });
      yield* test.restart;
      test.settle(threadId);
      yield* test.reconcile;
      const unresolved = yield* test.wait(run.id, (run) => run.state === "unresolved");
      expect(unresolved).toMatchObject({
        reason: "Execution settled after one reminder without an accepted report.",
        allowedActions: ["cancel", "retry"],
      });
      expect(test.threads.get(threadId)?.runs).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "pauses execution timeout during native input waits and resumes the same native attempt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const node = sequence.nodes[0]!;
        const run = yield* test.start(
          yield* decodeDefinition({
            ...sequence,
            nodes: [{ ...node, timeoutMs: 60_000 }, ...sequence.nodes.slice(1)],
          }),
        );
        yield* test.reconcile;
        const threadId = run.attempts[0]!.threadId!;
        const state = test.threads.get(threadId)!;
        test.threads.set(threadId, {
          ...state,
          requests: [{ id: "input", kind: "user-input", status: "pending" }],
        });
        yield* test.reconcile;
        yield* TestClock.adjust("2 minutes");
        yield* test.reconcile;
        expect(yield* test.query(run.id)).toMatchObject({
          state: "running",
          attempts: [{ phase: "waiting-input", remainingMs: 60_000 }],
        });
        yield* test.restart;
        test.threads.set(threadId, {
          ...state,
          runs: [{ id: state.runs[0]!.id, status: "interrupted" }],
          requests: [],
        });
        yield* test.reconcile;
        const interrupted = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(interrupted.allowedActions).toContain("resume");
        yield* test.invoke("resume", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: run.id,
          expectedRevision: interrupted.revision,
          clientRequestId: "resume",
        });
        yield* test.reconcile;
        yield* test.report(threadId, completed);
        test.settle(threadId);
        yield* test.reconcile;
        const reviewed = yield* test.wait(run.id, (run) => run.state === "awaiting-review");
        expect(reviewed.attempts).toHaveLength(1);
        expect(reviewed.attempts[0]?.resumeCount).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reconciles a lost host launch acknowledgement without creating a second thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      test.loseAcknowledgement();
      const run = yield* test.start(sequence);
      yield* test.reconcile;
      yield* test.restart;
      yield* test.reconcile;
      const current = yield* test.query(run.id);
      expect(test.launches).toHaveLength(1);
      expect(current.attempts).toHaveLength(1);
      expect(current.attempts[0]).toMatchObject({
        phase: "running",
        threadId: run.attempts[0]!.threadId,
      });
      const receipt = yield* test.report(current.attempts[0]!.threadId!, completed);
      yield* test.restart;
      expect(yield* test.report(current.attempts[0]!.threadId!, completed)).toEqual(receipt);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "saves YAML atomically, exposes invalid catalog entries and freezes scheduled occurrences",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        yield* test.invoke("save", { ...scope, definition: sequence, expectedRevision: null });
        expect(
          yield* test
            .invoke("save", { ...scope, definition: sequence, expectedRevision: null })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "conflict" });
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${test.directory}/.t3code/workflows/invalid.yaml`,
          "entry: [unclosed",
        );
        expect(yield* test.invoke("catalog", scope)).toContainEqual({
          source: ".t3code/workflows/invalid.yaml",
          definition: null,
          runnable: false,
          reasons: ["Invalid workflow YAML."],
        });
        yield* test.scheduled("occurrence-one");
        yield* test.invoke("save", {
          ...scope,
          definition: { ...sequence, revision: 2, title: "New title" },
          expectedRevision: 1,
        });
        yield* test.scheduled("occurrence-one");
        yield* test.scheduled("occurrence-two");
        const runs = yield* test.invoke("list", scope).pipe(Effect.flatMap(decodeRuns));
        expect(runs).toHaveLength(2);
        expect(runs.map((run) => run.definition.revision).sort()).toEqual([1, 2]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects unbound callers, undeclared fields and reports after explicit cancellation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const run = yield* test.start(sequence);
        yield* test.reconcile;
        expect(
          yield* test.report("unrelated", completed).pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({
          code: "unauthorized",
        });
        const threadId = run.attempts[0]!.threadId!;
        expect(
          yield* test
            .report(threadId, { ...completed, data: { ready: "yes" } })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ message: "data.ready must be boolean." });
        expect(
          yield* test
            .report(threadId, { ...completed, data: { ready: true, unknown: true } })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "validation" });
        const current = yield* test.query(run.id);
        yield* test.invoke("cancel", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: run.id,
          clientRequestId: "cancel",
          expectedRevision: current.revision,
        });
        expect(
          yield* test.report(threadId, completed).pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({
          code: "conflict",
        });
        yield* test.restart;
        expect(yield* test.query(run.id)).toMatchObject({
          state: "canceled",
          allowedActions: [],
          trace: [],
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("records one permitted rework and uses At limit on the next request after restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const started = yield* test.start(sequence);
      yield* test.reconcile;
      yield* test.report(started.attempts[0]!.threadId!, completed);
      test.settle(started.attempts[0]!.threadId!);
      yield* test.reconcile;
      const review = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      const command = {
        environmentId: test.environmentId,
        projectId: test.projectId,
        runId: started.id,
        clientRequestId: "changes",
        expectedRevision: review.revision,
        decision: "request-changes",
      };
      const repeated = yield* test.invoke("gate", command).pipe(Effect.flatMap(decodeRun));
      expect(yield* test.invoke("gate", command)).toEqual(repeated);
      expect(repeated).toMatchObject({ repeats: { "review:implement": 1 }, visits: 3 });
      yield* test.reconcile;
      yield* test.restart;
      const second = (yield* test.query(started.id)).attempts.at(-1)!;
      expect(second.threadId).not.toBe(started.attempts[0]!.threadId);
      yield* test.report(second.threadId!, completed);
      test.settle(second.threadId!);
      yield* test.reconcile;
      const nextReview = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
      const limited = yield* test
        .invoke("gate", {
          ...command,
          clientRequestId: "changes-again",
          expectedRevision: nextReview.revision,
        })
        .pipe(Effect.flatMap(decodeRun));
      expect(limited.attempts).toHaveLength(2);
      expect(limited.trace.at(-1)).toMatchObject({
        chosen: "review",
        reason: "The repeat limit was reached.",
        repeatCount: 1,
      });
      expect(
        yield* test
          .invoke("gate", { ...command, clientRequestId: "stale-click" })
          .pipe(Effect.flip, Effect.orDie),
      ).toMatchObject({ code: "conflict" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("selects the first typed rule while missing optional comparisons remain false", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const implement = sequence.nodes[0]!;
      if (implement.kind !== "agent") return yield* Effect.die("Expected agent");
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: [
          {
            ...implement,
            report: {
              fields: [
                { name: "ready", type: "boolean", required: true },
                { name: "verdict", type: "enum", required: true, values: ["pass", "changes"] },
                { name: "count", type: "number", required: true },
                { name: "optional", type: "string", required: false },
              ],
            },
            next: { to: "route" },
          },
          {
            id: "route",
            title: "Route",
            kind: "decision",
            source: "implement",
            rules: [
              { when: { op: "ne", path: "data.optional", value: "absent" }, route: { to: "done" } },
              {
                when: {
                  op: "all",
                  terms: [
                    { op: "eq", path: "data.ready", value: true },
                    { op: "in", path: "data.verdict", values: ["pass"] },
                    {
                      op: "any",
                      terms: [
                        { op: "gte", path: "data.count", value: 2 },
                        { op: "present", path: "data.optional" },
                      ],
                    },
                  ],
                },
                route: { to: "review" },
              },
              { when: { op: "eq", path: "data.ready", value: true }, route: { to: "done" } },
            ],
            otherwise: { to: "done" },
          },
          ...sequence.nodes.slice(1),
        ],
      });
      const run = yield* test.start(definition);
      yield* test.reconcile;
      const attempt = run.attempts[0]!;
      yield* test.report(attempt.threadId!, {
        ...completed,
        data: { ready: true, verdict: "pass", count: 2 },
      });
      test.settle(attempt.threadId!);
      yield* test.reconcile;
      const decided = yield* test.wait(run.id, (run) => run.state === "awaiting-review");
      expect(decided.trace.at(-1)).toMatchObject({
        chosen: "review",
        considered: [{ matched: false }, { matched: true }],
        reason: "First matching rule.",
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("routes an immutable accepted report only after all native work has settled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const started = yield* test.start(sequence);
      yield* test.reconcile;
      const run = yield* test.query(started.id);
      const threadId = run.attempts[0]!.threadId!;
      const receipt = yield* test.report(threadId, completed);
      expect(yield* test.report(threadId, completed)).toEqual(receipt);
      expect(
        yield* test
          .report(threadId, { ...completed, summary: "Changed" })
          .pipe(Effect.flip, Effect.orDie),
      ).toMatchObject({ code: "conflict" });
      test.settle(threadId, "completed", [{ id: "child", status: "running" }]);
      yield* test.reconcile;
      expect(yield* test.query(run.id)).toMatchObject({ state: "running", trace: [] });
      test.settle(threadId);
      yield* test.reconcile;
      expect(yield* test.query(run.id)).toMatchObject({
        state: "awaiting-review",
        trace: [{ chosen: "review", sourceIds: [receipt.id] }],
        allowedActions: ["cancel", "approve", "request-changes"],
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects invalid graph contracts before saving or starting any work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const agent = sequence.nodes[0]!;
      for (const definition of [
        { ...sequence, nodes: [{ ...agent, next: { to: "missing" } }, ...sequence.nodes.slice(1)] },
        {
          ...sequence,
          nodes: [{ ...agent, next: { to: "implement" } }, ...sequence.nodes.slice(1)],
        },
        {
          ...sequence,
          nodes: [
            { ...agent, next: { to: "route" } },
            {
              id: "route",
              title: "Bad source",
              kind: "decision",
              source: "implement",
              rules: [
                { when: { op: "gt", path: "data.ready", value: 1 }, route: { to: "review" } },
              ],
              otherwise: { to: "done" },
            },
            ...sequence.nodes.slice(1),
          ],
        },
        {
          ...parallel,
          nodes: parallel.nodes.map((node) =>
            node.kind === "join" ? { ...node, fork: "unknown" } : node,
          ),
        },
        {
          ...parallel,
          nodes: parallel.nodes.map((node) =>
            node.kind === "parallel"
              ? {
                  ...node,
                  branches: node.branches.map((branch) => ({
                    ...branch,
                    runtimeMode: "full-access",
                  })),
                }
              : node,
          ),
        },
      ]) {
        expect(
          yield* test
            .invoke("save", {
              environmentId: test.environmentId,
              projectId: test.projectId,
              definition,
              expectedRevision: null,
            })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "validation" });
      }
      expect(test.launches).toHaveLength(0);
      expect(
        yield* test.invoke("list", {
          environmentId: test.environmentId,
          projectId: test.projectId,
        }),
      ).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects excess reporting payloads and cannot turn an interrupted claim into success",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const run = yield* test.start(sequence);
        yield* test.reconcile;
        const thread = run.attempts[0]!.threadId!;
        expect(
          yield* test
            .report(thread, {
              ...completed,
              data: Object.fromEntries(
                Array.from({ length: 32 }, (_, index) => [`field${index}`, "x".repeat(4000)]),
              ),
            })
            .pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "validation" });
        yield* test.report(thread, completed);
        test.settle(thread, "interrupted");
        yield* test.reconcile;
        const unresolved = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(unresolved).toMatchObject({ trace: [], attempts: [{ phase: "interrupted" }] });
        expect(unresolved.allowedActions).not.toContain("resume");
        yield* test.restart;
        expect(yield* test.query(run.id)).toMatchObject({ state: "unresolved", trace: [] });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("waits for required checkpoints and records a failed checkpoint instead of success", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const run = yield* test.start(sequence);
      yield* test.reconcile;
      const threadId = run.attempts[0]!.threadId!;
      yield* test.report(threadId, completed);
      test.settle(threadId);
      const state = test.threads.get(threadId)!;
      test.threads.set(threadId, {
        ...state,
        checkpoints: [{ id: "checkpoint", status: "pending", commit: null }],
      });
      yield* test.reconcile;
      expect(yield* test.query(run.id)).toMatchObject({ state: "running", trace: [] });
      test.threads.set(threadId, {
        ...state,
        checkpoints: [{ id: "checkpoint", status: "error", commit: null }],
      });
      yield* test.reconcile;
      expect(yield* test.wait(run.id, (run) => run.state === "unresolved")).toMatchObject({
        attempts: [{ phase: "failed" }],
        trace: [],
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("expires an agent execution and review human waits at their persisted deadlines", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const short = yield* decodeDefinition({
        ...sequence,
        nodes: [{ ...sequence.nodes[0], timeoutMs: 60_000 }, ...sequence.nodes.slice(1)],
      });
      const run = yield* test.start(short);
      yield* test.reconcile;
      yield* TestClock.adjust("1 minute");
      yield* test.reconcile;
      expect(yield* test.wait(run.id, (run) => run.state === "unresolved")).toMatchObject({
        reason: "The execution timeout expired.",
      });
      const reviewed = yield* test.start(parallel, "reviews");
      yield* test.reconcile;
      const fork = yield* test.wait(
        reviewed.id,
        (run) =>
          run.attempts.length === 3 && run.attempts.every((attempt) => attempt.phase === "running"),
      );
      for (const attempt of fork.attempts) {
        const state = test.threads.get(attempt.threadId!)!;
        test.threads.set(attempt.threadId!, {
          ...state,
          requests: [{ id: "approval", kind: "approval", status: "pending" }],
        });
      }
      yield* test.reconcile;
      yield* test.restart;
      yield* TestClock.adjust("2 hours");
      yield* test.reconcile;
      const expired = yield* test.wait(reviewed.id, (run) => run.state === "unresolved");
      expect(expired.reviews[0]?.result).toBe("unresolved");
      expect(expired.attempts.every((attempt) => attempt.phase === "unresolved")).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains an interrupted check after restart and runs it again only on explicit retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        test.holdCheck();
        const definition = yield* decodeDefinition({
          ...sequence,
          nodes: [
            {
              id: "implement",
              kind: "check",
              title: "Check",
              command: "project-check",
              args: [],
              next: { to: "review" },
            },
            ...sequence.nodes.slice(1),
          ],
        });
        const run = yield* test.start(definition);
        yield* test.reconcile;
        yield* test.wait(run.id, (run) => run.attempts[0]?.phase === "running");
        yield* test.nextCheck;
        yield* test.restart;
        yield* test.reconcile;
        const interrupted = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(interrupted.attempts[0]?.check).toMatchObject({
          interrupted: true,
          outcome: "unresolved",
        });
        expect(test.commands).toHaveLength(1);
        yield* test.invoke("retry", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: run.id,
          expectedRevision: interrupted.revision,
          clientRequestId: "retry-check",
        });
        yield* test.reconcile;
        const repeated = yield* test.wait(
          run.id,
          (run) => run.attempts.length === 2 && run.attempts[1]?.phase === "running",
        );
        yield* test.nextCheck;
        expect(repeated.visits).toBe(2);
        expect(test.commands).toHaveLength(2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "runs the development example manually and from a durable schedule with exactly one review-driven repeat",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const catalog = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
        const definition = catalog.find(
          (entry) => entry.definition?.id === "development-review",
        )!.definition!;
        for (const mode of ["manual", "scheduled"]) {
          const started =
            mode === "manual"
              ? yield* test.start(definition, mode)
              : yield* test.scheduled("example-occurrence", "development-review").pipe(
                  Effect.andThen(test.invoke("list", scope)),
                  Effect.flatMap(decodeRuns),
                  Effect.map((runs) => runs[0]!),
                );
          yield* test.reconcile;
          let run = yield* test.query(started.id);
          for (let generation = 1; generation <= 2; generation++) {
            const implementation = run.attempts.findLast(
              (attempt) => attempt.nodeId === "implement",
            )!;
            yield* test.report(implementation.threadId!, {
              ...completed,
              evidence: [{ kind: "commit", reference: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
            });
            test.settle(implementation.threadId!);
            yield* test.reconcile;
            const fork = yield* test.wait(
              started.id,
              (run) =>
                run.reviews.at(-1)?.generation === generation &&
                run.attempts
                  .filter((attempt) => attempt.branchId && attempt.generation === generation)
                  .every((attempt) => attempt.phase === "running"),
            );
            const branches = fork.attempts.filter(
              (attempt) => attempt.branchId && attempt.generation === generation,
            );
            expect(branches).toHaveLength(3);
            for (const branch of branches)
              yield* test.report(branch.threadId!, {
                ...completed,
                data: { verdict: branch.branchId === "code" ? "changes" : "pass" },
                evidence: [{ kind: "commit", reference: fork.reviews.at(-1)!.head }],
              });
            test.settle(branches[0]!.threadId!);
            yield* test.reconcile;
            expect((yield* test.query(started.id)).reviews.at(-1)?.result).toBeNull();
            for (const branch of branches.slice(1)) test.settle(branch.threadId!);
            yield* test.reconcile;
            yield* test.wait(started.id, (run) =>
              generation === 1
                ? run.attempts.some(
                    (attempt) => attempt.nodeId === "implement" && attempt.id !== implementation.id,
                  )
                : run.state === "awaiting-review",
            );
            yield* test.restart;
            yield* test.reconcile;
            run = yield* test.query(started.id);
          }
          expect(run).toMatchObject({
            state: "awaiting-review",
            repeats: { "rework:implement": 1 },
          });
          expect(run.attempts.filter((attempt) => attempt.nodeId === "implement")).toHaveLength(2);
          expect(run.reviews.map((review) => review.result)).toEqual([
            "all_completed",
            "all_completed",
          ]);
          expect(run.trace.at(-1)).toMatchObject({
            chosen: "human",
            reason: "The repeat limit was reached.",
            repeatCount: 1,
          });
          expect(
            new Set(run.attempts.flatMap((attempt) => (attempt.threadId ? [attempt.threadId] : [])))
              .size,
          ).toBe(8);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps unavailable providers visible and refuses execution before admitting a run", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      test.setProviderAvailable(false);
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      expect(yield* test.invoke("validate", { ...scope, definition: sequence })).toMatchObject({
        runnable: false,
      });
      expect(yield* test.start(sequence).pipe(Effect.flip, Effect.orDie)).toMatchObject({
        code: "unsupported",
      });
      expect(yield* test.invoke("list", scope)).toEqual([]);
      expect(test.launches).toHaveLength(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reconciles later runs fairly while an older batch remains in native input waits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const runs = [];
      for (let index = 0; index < 101; index++) {
        const run = yield* test.start(sequence, `batch-${index}`);
        yield* test.reconcile;
        runs.push(run);
        const threadId = run.attempts[0]!.threadId!;
        const state = test.threads.get(threadId)!;
        test.threads.set(threadId, {
          ...state,
          requests: [{ id: "input", kind: "user-input", status: "pending" }],
        });
      }
      const last = runs.at(-1)!;
      const threadId = last.attempts[0]!.threadId!;
      test.threads.set(threadId, { ...test.threads.get(threadId)!, requests: [] });
      yield* test.report(threadId, completed);
      test.settle(threadId);
      yield* test.reconcile;
      yield* test.reconcile;
      yield* test.reconcile;
      expect(yield* test.query(last.id)).toMatchObject({ state: "awaiting-review" });
      const latest = yield* test
        .invoke("list", { environmentId: test.environmentId, projectId: test.projectId })
        .pipe(Effect.flatMap(decodeRuns));
      expect(latest).toHaveLength(20);
      expect(latest[0]).not.toHaveProperty("input");
      expect(latest[0]?.attempts[0]).not.toHaveProperty("report");
      const page = yield* test
        .invoke("list", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          before: latest.at(-1)!.id,
        })
        .pipe(Effect.flatMap(decodeRuns));
      expect(page).toHaveLength(20);
      expect(page.some((run) => latest.some((item) => item.id === run.id))).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "serializes a pending protocol follow-up with cancellation and interrupts every owned active run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const started = yield* test.start(sequence);
        yield* test.reconcile;
        const threadId = started.attempts[0]!.threadId!;
        test.holdSend();
        test.settle(threadId);
        const reconciling = yield* test.reconcile.pipe(Effect.forkScoped);
        yield* test.sendStarted;
        const observed = yield* test.query(started.id);
        const canceling = yield* test
          .invoke("cancel", {
            environmentId: test.environmentId,
            projectId: test.projectId,
            runId: started.id,
            expectedRevision: observed.revision + 1,
            clientRequestId: "cancel-race",
          })
          .pipe(Effect.forkScoped);
        yield* test.releaseSend;
        yield* Fiber.join(reconciling);
        const cancellation = yield* Fiber.join(canceling);
        expect(cancellation).toMatchObject({ state: "canceled" });
        yield* test.reconcile;
        expect(test.threads.get(threadId)?.runs.at(-1)?.status).toBe("interrupted");
        expect(
          yield* test.report(threadId, completed).pipe(Effect.flip, Effect.orDie),
        ).toMatchObject({ code: "conflict" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retries unresolved reviews as a new frozen generation rather than revisiting an end",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const started = yield* test.start(parallel);
        yield* test.reconcile;
        const fork = yield* test.wait(
          started.id,
          (run) =>
            run.attempts.length === 3 &&
            run.attempts.every((attempt) => attempt.phase === "running"),
        );
        for (const attempt of fork.attempts) {
          yield* test.report(attempt.threadId!, { ...completed, data: { verdict: "pass" } });
          test.settle(attempt.threadId!);
        }
        test.setDirty(true);
        yield* test.reconcile;
        const stale = yield* test.wait(started.id, (run) => run.state === "unresolved");
        expect(stale.attempts.every((attempt) => attempt.phase === "stale")).toBe(true);
        test.setDirty(false);
        test.setHead("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        yield* test.invoke("retry", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: started.id,
          expectedRevision: stale.revision,
          clientRequestId: "new-reviews",
        });
        yield* test.reconcile;
        const repeated = yield* test.wait(
          started.id,
          (run) =>
            run.reviews.at(-1)?.generation === 2 &&
            run.attempts
              .filter((attempt) => attempt.generation === 2)
              .every((attempt) => attempt.phase === "running"),
        );
        expect(repeated.reviews.map((review) => review.head)).toEqual([
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ]);
        expect(
          repeated.reviews[1]?.branches.every(
            (branch) =>
              !repeated.reviews[0]?.branches.some((old) => old.attemptId === branch.attemptId),
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "uses a project-authored example override for scheduling and retains later native failures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const catalog = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
        const template = catalog.find(
          (entry) => entry.definition?.id === "development-review",
        )!.definition!;
        yield* test.invoke("save", {
          ...scope,
          definition: { ...template, title: "Configured review" },
          expectedRevision: null,
        });
        const configured = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
        expect(configured.filter((entry) => entry.definition?.id === template.id)).toHaveLength(1);
        yield* test.scheduled("configured-occurrence", template.id);
        const runs = yield* test.invoke("list", scope).pipe(Effect.flatMap(decodeRuns));
        expect(runs[0]?.definition.title).toBe("Configured review");
        const started = yield* test.start(sequence, "later-failure");
        yield* test.reconcile;
        const threadId = started.attempts[0]!.threadId!;
        yield* test.report(threadId, completed);
        const state = test.threads.get(threadId)!;
        test.threads.set(threadId, {
          ...state,
          runs: [
            { id: state.runs[0]!.id, status: "completed" },
            { id: "background-follow-up", status: "failed" },
          ],
        });
        yield* test.reconcile;
        expect(yield* test.wait(started.id, (run) => run.state === "unresolved")).toMatchObject({
          attempts: [{ phase: "failed" }],
          trace: [],
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

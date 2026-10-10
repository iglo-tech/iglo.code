import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AttentionPage, Definition, Run } from "@t3tools/plugin-workflows/contracts";
import * as Queue from "effect/Queue";
import { fixture, completed, parallel, sequence } from "./Workflows.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodePage = Schema.decodeUnknownEffect(AttentionPage);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type Fork = Extract<Definition["nodes"][number], { kind: "parallel" }>;
const fork = parallel.nodes.find((node): node is Fork => node.kind === "parallel")!;
/** `count` reviewers that all use the same installed skill, each with its own identity. */
const reviewers = (count: number, timeoutMs?: number) =>
  decodeDefinition({
    ...parallel,
    nodes: parallel.nodes.map((node) =>
      node.kind === "parallel"
        ? {
            ...node,
            branches: Array.from({ length: count }, (_, index) => ({
              ...fork.branches[0]!,
              id: `r${index + 1}`,
              title: `Reviewer ${index + 1}`,
              skill: "code-review",
              instruction: `Review focus ${index + 1}`,
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            })),
          }
        : node,
    ),
  });
const pass = { ...completed, data: { verdict: "pass" } };

const harness = Effect.gen(function* () {
  const test = yield* fixture;
  const scope = { environmentId: test.environmentId, projectId: test.projectId };
  const attention = (input: { readonly before?: string; readonly limit?: number } = {}) =>
    test.invoke("attention-page", { ...scope, ...input }).pipe(Effect.flatMap(decodePage));
  const command = (method: string, run: Run, clientRequestId: string) =>
    test
      .invoke(method, { ...scope, runId: run.id, expectedRevision: run.revision, clientRequestId })
      .pipe(Effect.flatMap(decodeRun));
  return { test, scope, attention, command };
});

it.effect(
  "keeps more than five same-skill reviewers distinct and decides only on the persisted join",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { test, attention } = yield* harness;
        const run = yield* test.start(yield* reviewers(6));
        yield* test.reconcile;
        const forked = yield* test.wait(
          run.id,
          (run) =>
            run.attempts.length === 6 && run.attempts.every((item) => item.phase === "running"),
        );
        // Same skill, distinct identities, threads and isolated checkouts of one frozen head.
        expect(forked.attempts.map((attempt) => attempt.branchId)).toEqual([
          "r1",
          "r2",
          "r3",
          "r4",
          "r5",
          "r6",
        ]);
        expect(new Set(forked.attempts.map((attempt) => attempt.threadId)).size).toBe(6);
        expect(new Set(forked.attempts.map((attempt) => attempt.skill?.name))).toEqual(
          new Set(["code-review"]),
        );
        const review = forked.overview!.review!;
        expect(review).toMatchObject({ required: 6, reported: 0, settled: 0, result: null });
        expect(new Set(review.branches.map((branch) => branch.workspace?.path)).size).toBe(6);
        expect(review.branches.every((branch) => branch.workspace?.frozenHead === HEAD)).toBe(true);
        // Running reviewers are progress, not a decision for anyone.
        expect((yield* attention()).total).toBe(0);

        // An early "changes" verdict is a claim; its siblings keep running.
        const [first, ...rest] = forked.attempts;
        yield* test.report(first!.threadId!, { ...completed, data: { verdict: "changes" } });
        yield* test.reconcile;
        const early = yield* test.query(run.id);
        expect(early.overview!.review).toMatchObject({ reported: 1, settled: 0, result: null });
        expect(early.attempts.map((attempt) => attempt.phase)).toEqual([
          "reported",
          "running",
          "running",
          "running",
          "running",
          "running",
        ]);
        expect(early.state).toBe("running");

        // Every report accepted while one execution still runs remains pending.
        for (const attempt of rest) yield* test.report(attempt.threadId!, pass);
        for (const attempt of forked.attempts.slice(0, 5)) test.settle(attempt.threadId!);
        yield* test.reconcile;
        const reported = yield* test.query(run.id);
        expect(reported.overview!.review).toMatchObject({
          required: 6,
          reported: 6,
          settled: 5,
          result: null,
        });
        expect(reported.currentNode).toBe("join");
        expect(reported.trace).toEqual([]);
        expect((yield* attention()).total).toBe(0);

        test.settle(forked.attempts[5]!.threadId!);
        yield* test.reconcile;
        const joined = yield* test.wait(run.id, (run) => run.state === "awaiting-review");
        expect(joined.overview!.review).toMatchObject({
          reported: 6,
          settled: 6,
          result: "all_completed",
        });
        expect(joined.trace.at(-1)).toMatchObject({ nodeId: "join", chosen: "review" });
        const page = yield* attention();
        expect(page).toMatchObject({ total: 1, before: null });
        expect(page.runs[0]!.items).toEqual([
          expect.objectContaining({
            kind: "needs-review",
            nodeId: "review",
            gateRevision: joined.gate!.revision,
          }),
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("explains failed, missing-report and timed-out reviewers in the aggregate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, attention } = yield* harness;
      const run = yield* test.start(yield* reviewers(3, 60_000));
      yield* test.reconcile;
      const forked = yield* test.wait(
        run.id,
        (run) =>
          run.attempts.length === 3 && run.attempts.every((item) => item.phase === "running"),
      );
      const [failed, missing] = forked.attempts.map((attempt) => attempt.threadId!);
      yield* test.report(failed!, { ...pass, outcome: "failed" });
      test.settle(failed!);
      // Settled without a report: one reminder, then settled again without one.
      test.settle(missing!);
      yield* test.reconcile;
      yield* test.wait(run.id, (run) => run.attempts[1]!.reminderSent);
      test.settle(missing!);
      yield* test.reconcile;
      const partial = yield* test.query(run.id);
      expect(partial.overview!.review).toMatchObject({ settled: 2, result: null });
      // The last reviewer passes its deadline while still running.
      yield* TestClock.adjust("2 minutes");
      yield* test.reconcile;
      const stopped = yield* test.wait(run.id, (run) => run.state === "unresolved");
      const review = stopped.overview!.review!;
      expect(review).toMatchObject({ result: "failed", reported: 1, settled: 3 });
      expect(review.branches.map((branch) => [branch.id, branch.phase, branch.reason])).toEqual([
        ["r1", "failed", null],
        ["r2", "unresolved", "Execution settled after one reminder without an accepted report."],
        ["r3", "unresolved", "The review branch deadline expired."],
      ]);
      // An unsuccessful sibling never cancels the others.
      expect(review.branches.some((branch) => branch.phase === "canceled")).toBe(false);
      expect(stopped.stop).toEqual({ kind: "failed", attemptId: null });
      expect((yield* attention()).runs[0]!.items).toEqual([
        expect.objectContaining({ kind: "failed", nodeId: "unresolved" }),
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancels every reviewer of the active generation from the backend", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, attention, command } = yield* harness;
      const run = yield* test.start(yield* reviewers(3));
      yield* test.reconcile;
      const forked = yield* test.wait(
        run.id,
        (run) =>
          run.attempts.length === 3 && run.attempts.every((item) => item.phase === "running"),
      );
      yield* test.report(forked.attempts[0]!.threadId!, pass);
      const canceled = yield* command("cancel", yield* test.query(run.id), "cancel");
      expect(canceled.state).toBe("canceled");
      expect(canceled.overview!.review).toMatchObject({ result: "canceled", reported: 1 });
      expect(canceled.overview!.review!.branches.map((branch) => branch.phase)).toEqual([
        "canceled",
        "canceled",
        "canceled",
      ]);
      expect((yield* attention()).total).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reruns a stale review as a new generation on the verified head without mixing generations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { test, attention, command } = yield* harness;
        const run = yield* test.start(yield* reviewers(2));
        yield* test.reconcile;
        const forked = yield* test.wait(
          run.id,
          (run) =>
            run.attempts.length === 2 && run.attempts.every((item) => item.phase === "running"),
        );
        for (const attempt of forked.attempts) {
          yield* test.report(attempt.threadId!, pass);
          test.settle(attempt.threadId!);
        }
        test.setHead(NEW_HEAD);
        yield* test.reconcile;
        const stale = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(stale.overview!.review).toMatchObject({
          generation: 1,
          head: HEAD,
          result: "stale",
          cause: "head-changed",
        });
        expect(stale.stop).toEqual({ kind: "review-stale", attemptId: null });
        expect(stale.allowedActions).toContain("retry");
        expect(stale.recovery).toMatchObject({ retryNodeId: "reviews" });
        expect((yield* attention()).runs[0]!.items).toEqual([
          expect.objectContaining({ kind: "review-stale" }),
        ]);

        // Retry is the rerun; repeating its request identity returns the same committed result.
        yield* command("retry", stale, "rerun");
        const replay = yield* command("retry", stale, "rerun");
        expect(replay.revision).toBe(stale.revision + 1);
        yield* test.reconcile;
        const rerun = yield* test.wait(
          run.id,
          (run) =>
            run.attempts.length === 4 &&
            run.attempts.slice(2).every((item) => item.phase === "running"),
        );
        const second = rerun.overview!.review!;
        expect(second).toMatchObject({ generation: 2, head: NEW_HEAD, result: null, reported: 0 });
        // The new generation lists only its own attempts, threads and frozen head.
        expect(second.branches.map((branch) => branch.attemptId)).toEqual(
          rerun.attempts.slice(2).map((attempt) => attempt.id),
        );
        expect(rerun.attempts.slice(2).map((attempt) => attempt.generation)).toEqual([2, 2]);
        expect(
          second.branches.every(
            (branch) =>
              branch.workspace?.frozenHead === NEW_HEAD &&
              !forked.attempts.some((attempt) => attempt.threadId === branch.threadId),
          ),
        ).toBe(true);
        expect(rerun.reviews.map((review) => [review.generation, review.result])).toEqual([
          [1, "stale"],
          [2, null],
        ]);
        expect((yield* attention()).total).toBe(0);

        // An unverifiable head never admits a generation.
        test.setForgeAvailable(false);
        for (const attempt of rerun.attempts.slice(2)) {
          yield* test.report(attempt.threadId!, pass);
          test.settle(attempt.threadId!);
        }
        yield* test.reconcile;
        const unverifiable = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(unverifiable.overview!.review).toMatchObject({
          generation: 2,
          result: "unresolved",
          cause: "head-unverifiable",
        });
        expect(unverifiable.stop).toEqual({ kind: "review-unverifiable", attemptId: null });
        yield* command("retry", unverifiable, "rerun-again");
        yield* test.reconcile;
        const refused = yield* test.wait(run.id, (run) => run.state === "unresolved");
        expect(refused.reviews).toHaveLength(2);
        expect(refused.stop).toEqual({ kind: "review-unverifiable", attemptId: null });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "lists every pending native request in queue order and clears each on its own resolution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { test, attention } = yield* harness;
        const run = yield* test.start(yield* reviewers(2));
        yield* test.reconcile;
        const forked = yield* test.wait(
          run.id,
          (run) =>
            run.attempts.length === 2 && run.attempts.every((item) => item.phase === "running"),
        );
        const [a, b] = forked.attempts.map((attempt) => attempt.threadId!);
        const request = (id: string, kind: string, createdAt: number, resolved = false) => ({
          id,
          kind,
          status: resolved ? "resolved" : "pending",
          createdAt,
          resolvedAt: resolved ? createdAt + 1 : null,
        });
        const ask = (threadId: string, requests: ReadonlyArray<ReturnType<typeof request>>) =>
          test.threads.set(threadId, { ...test.threads.get(threadId)!, requests });
        ask(a!, [request("a2", "user-input", 2), request("a1", "approval", 1)]);
        ask(b!, [request("b1", "approval", 3)]);
        yield* test.reconcile;
        const waiting = yield* attention();
        expect(waiting.total).toBe(1);
        const items = waiting.runs[0]!.items;
        expect(
          items.map((item) => [
            item.kind,
            item.branchId,
            item.request?.id,
            item.request?.position,
            item.request?.pending,
          ]),
        ).toEqual([
          ["needs-input", "r1", "a1", 1, 2],
          ["needs-input", "r1", "a2", 2, 2],
          ["needs-input", "r2", "b1", 1, 1],
        ]);
        const host = yield* test.hostAttention.pipe(
          Stream.filter((summary) => summary.pluginId === "workflows"),
          Stream.runHead,
        );
        expect(host._tag === "Some" && host.value).toMatchObject({
          total: 1,
          items: [
            {
              id: run.id,
              reason: "Needs input: 3 native requests",
              link: {
                pageId: "workflows.runs",
                state: { run: run.id, attempt: forked.attempts[0]!.id },
              },
            },
          ],
        });

        // Answering the first request clears only that item; the next one moves up.
        ask(a!, [request("a2", "user-input", 2), request("a1", "approval", 1, true)]);
        yield* test.reconcile;
        const answered = (yield* attention()).runs[0]!.items;
        expect(answered.map((item) => [item.id, item.request?.position])).toEqual([
          [items[1]!.id, 1],
          [items[2]!.id, 1],
        ]);
        // A restart keeps the remaining requests.
        yield* test.restart;
        expect((yield* attention()).runs[0]!.items.map((item) => item.id)).toEqual([
          items[1]!.id,
          items[2]!.id,
        ]);
        ask(a!, [request("a2", "user-input", 2, true)]);
        ask(b!, [request("b1", "approval", 3, true)]);
        yield* test.reconcile;
        expect(yield* attention()).toMatchObject({ total: 0, runs: [] });
        expect((yield* test.query(run.id)).state).toBe("running");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("counts every distinct run needing attention beyond the capped newest pages", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, attention } = yield* harness;
      const stopped = yield* decodeDefinition({
        version: 1,
        id: "stopped",
        revision: 1,
        title: "Stopped",
        entry: "stop",
        atLimit: "stop",
        nodes: [{ id: "stop", kind: "end", title: "Stop", outcome: "unresolved" }],
      });
      const ids: string[] = [];
      for (let index = 0; index < 130; index++)
        ids.push((yield* test.start(stopped, `start-${index}`)).id);
      const newest = ids.toReversed();
      const first = yield* attention();
      expect(first.total).toBe(130);
      expect(first.runs.map((run) => run.runId)).toEqual(newest.slice(0, 25));
      const second = yield* attention({ before: first.before! });
      expect(second.total).toBe(130);
      expect(second.runs.map((run) => run.runId)).toEqual(newest.slice(25, 50));
      expect(second.runs[0]!.items).toEqual([expect.objectContaining({ kind: "unresolved" })]);
      // A widened read returns the newest runs up to the server's bound, never more.
      const widened = yield* attention({ limit: 100 });
      expect(widened.runs.map((run) => run.runId)).toEqual(newest.slice(0, 100));
      expect(widened).toMatchObject({ total: 130, before: newest[99] });
      expect((yield* Effect.result(attention({ limit: 101 })))._tag).toBe("Failure");
      // The host summary lists at most 100 runs but reports the full count.
      const host = yield* test.hostAttention.pipe(
        Stream.filter((summary) => summary.pluginId === "workflows"),
        Stream.runHead,
      );
      expect(host._tag === "Some" && [host.value.items.length, host.value.total]).toEqual([
        100, 130,
      ]);
      yield* test.restart;
      expect((yield* attention()).total).toBe(130);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("locates unsupported reviewer reporting and removed-reviewer rules on the server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, scope } = yield* harness;
      const definition = yield* reviewers(2);
      const invalid = yield* decodeDefinition({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.kind === "parallel"
            ? {
                ...node,
                branches: node.branches.map((branch, index) =>
                  index === 1
                    ? { ...branch, modelSelection: { instanceId: "unconfigured", model: "x" } }
                    : branch,
                ),
              }
            : node.kind === "join"
              ? {
                  ...node,
                  rules: [
                    {
                      when: { op: "eq", path: "branches.r9.data.verdict", value: "pass" },
                      route: { to: "review" },
                    },
                  ],
                }
              : node,
        ),
      });
      const entry = (yield* test.invoke("validate", { ...scope, definition: invalid })) as {
        readonly runnable: boolean;
        readonly problems: ReadonlyArray<{ readonly nodeId?: string; readonly control?: string }>;
      };
      expect(entry.runnable).toBe(false);
      expect(entry.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: "reviews", control: "branches.1.modelSelection" }),
          expect.objectContaining({
            nodeId: "join",
            control: "rules.0.when",
            message: expect.stringContaining("reviewer r9, which is no longer in reviews"),
          }),
        ]),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const stoppedDefinition = decodeDefinition({
  version: 1,
  id: "stopped",
  revision: 1,
  title: "Stopped",
  entry: "stop",
  atLimit: "stop",
  nodes: [{ id: "stop", kind: "end", title: "Stop", outcome: "unresolved" }],
});

it.effect("re-reads attention only after commits that can change it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, scope } = yield* harness;
      yield* test.start(yield* stoppedDefinition, "stopped");
      const run = yield* test.start(sequence, "running");
      yield* test.reconcile;
      const pages = yield* Queue.unbounded<AttentionPage>();
      yield* test.stream("attention", scope).pipe(
        Stream.mapEffect((value) => decodePage(value)),
        Stream.runForEach((page) => Queue.offer(pages, page)),
        Effect.forkScoped,
      );
      expect((yield* Queue.take(pages)).total).toBe(1);
      const before = test.redactions();
      // A report on a running step cannot change attention; the request it waits on can.
      const threadId = run.attempts[0]!.threadId!;
      test.threads.set(threadId, {
        ...test.threads.get(threadId)!,
        requests: [
          { id: "question", kind: "user-input", status: "pending", createdAt: 1, resolvedAt: null },
        ],
      });
      yield* test.report(threadId, completed);
      const waiting = yield* Queue.take(pages);
      expect(waiting.total).toBe(2);
      // One read of the two listed runs, after the relevant commit only.
      expect(test.redactions() - before).toBe(2);
      expect(yield* Queue.size(pages)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("counts every pending request beyond the retained queue", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, attention } = yield* harness;
      const run = yield* test.start(sequence);
      yield* test.reconcile;
      const threadId = run.attempts[0]!.threadId!;
      test.threads.set(threadId, {
        ...test.threads.get(threadId)!,
        requests: Array.from({ length: 40 }, (_, index) => ({
          id: `request-${index}`,
          kind: "user-input",
          status: "pending",
          createdAt: index,
          resolvedAt: null,
        })),
      });
      yield* test.reconcile;
      const items = (yield* attention()).runs[0]!.items;
      expect(items).toHaveLength(32);
      expect(items.map((item) => [item.request?.position, item.request?.pending]).at(-1)).toEqual([
        32, 40,
      ]);
      expect((yield* test.query(run.id)).attempts[0]).toMatchObject({ pendingRequests: 40 });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

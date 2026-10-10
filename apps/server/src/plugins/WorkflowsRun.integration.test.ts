import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Yaml from "yaml";
import {
  Definition as DefinitionSchema,
  Run,
  RunSummary,
  StartPreview,
  ThreadLink,
  type Definition,
} from "@t3tools/plugin-workflows/contracts";
import { completed, fixture, sequence } from "./Workflows.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));
const decodePreview = Schema.decodeUnknownEffect(StartPreview);
const decodeLink = Schema.decodeUnknownEffect(Schema.NullOr(ThreadLink));

/** A project catalog file and the saved-start request the Run dialog sends for it. */
const harness = Effect.gen(function* () {
  const test = yield* fixture;
  const fs = yield* FileSystem.FileSystem;
  const catalog = `${test.directory}/.t3code/workflows`;
  yield* fs.makeDirectory(catalog, { recursive: true });
  const save = (definition: Definition) =>
    fs.writeFileString(`${catalog}/sequence.yaml`, Yaml.stringify(definition));
  yield* save(sequence);
  const scope = { environmentId: test.environmentId, projectId: test.projectId };
  const startSaved = (
    clientRequestId: string,
    options: {
      readonly revision?: number;
      readonly task?: string;
      readonly workspace?: "new-worktree" | "current";
    } = {},
  ) =>
    test.invoke("launch", {
      ...scope,
      clientRequestId,
      definitionId: "sequence",
      revision: options.revision ?? 1,
      task: options.task ?? "Ship the change",
      workspace: options.workspace ?? "current",
    });
  const command = (method: string, runId: string, clientRequestId: string, revision: number) =>
    test.invoke(method, { ...scope, runId, clientRequestId, expectedRevision: revision });
  const list = (before?: string) =>
    test
      .invoke("list", { ...scope, ...(before === undefined ? {} : { before }) })
      .pipe(Effect.flatMap(decodeRuns));
  /** The thread link stream's current value. */
  const thread = (threadId: string) =>
    test.stream("thread", { ...scope, threadId }).pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.flatMap((links) => decodeLink(links[0])),
    );
  return { test, save, scope, startSaved, command, list, thread };
});

it.effect("starts one saved revision across a lost response and a later catalog edit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, save, scope, startSaved, command, list } = yield* harness;
      const preview = yield* test
        .invoke("preview", { ...scope, definitionId: "sequence" })
        .pipe(Effect.flatMap(decodePreview));
      expect(preview).toMatchObject({
        definitionId: "sequence",
        revision: 1,
        source: ".t3code/workflows/sequence.yaml",
        runnable: true,
        agents: [{ nodeId: "implement", providerInstanceId: "codex", model: "fixture" }],
        workspace: { path: test.directory, branch: "main" },
      });

      const first = yield* startSaved("intent-1").pipe(Effect.flatMap(decodeRun));
      expect(first).toMatchObject({
        state: "running",
        input: { task: "Ship the change" },
        definition: { id: "sequence", revision: 1 },
        source: { trigger: "manual", catalogSource: ".t3code/workflows/sequence.yaml" },
        workspace: { type: "current" },
        // Cancel is authorized as soon as the start is acknowledged.
        allowedActions: ["cancel"],
      });

      // The response was lost, then the workflow was edited before the client retried.
      yield* save({ ...sequence, revision: 2, title: "Sequence v2" });
      const retried = yield* startSaved("intent-1").pipe(Effect.flatMap(decodeRun));
      expect(retried.id).toBe(first.id);
      expect(retried.definition.revision).toBe(1);
      expect(yield* list()).toHaveLength(1);

      // The same identity cannot be reused for different input.
      const reused = yield* startSaved("intent-1", { task: "Something else" }).pipe(
        Effect.flip,
        Effect.orDie,
      );
      expect(reused).toMatchObject({ code: "conflict" });
      // A new intent for the reviewed revision is refused with the current one named.
      const changed = yield* startSaved("intent-2").pipe(Effect.flip, Effect.orDie);
      expect(changed).toMatchObject({ code: "conflict" });
      expect(changed.message).toContain("revision 2");
      expect(yield* list()).toHaveLength(1);

      // Run again is a new identity that resolves the current saved revision.
      const again = yield* startSaved("intent-3", { revision: 2, workspace: "new-worktree" }).pipe(
        Effect.flatMap(decodeRun),
      );
      expect(again.id).not.toBe(first.id);
      expect(again).toMatchObject({
        definition: { revision: 2, title: "Sequence v2" },
        workspace: { type: "exact-ref" },
      });
      expect((yield* list()).map((run) => run.id)).toEqual([again.id, first.id]);

      yield* test.reconcile;
      const launched = yield* test.query(first.id);
      expect(launched.revision).toBeGreaterThan(first.revision);
      // A cancel decided against an older snapshot is refused rather than applied blindly.
      const stale = yield* command("cancel", first.id, "cancel-0", first.revision).pipe(
        Effect.flip,
        Effect.orDie,
      );
      expect(stale).toMatchObject({ code: "conflict" });
      const canceled = yield* command("cancel", first.id, "cancel-1", launched.revision).pipe(
        Effect.flatMap(decodeRun),
      );
      expect(canceled).toMatchObject({ state: "canceled", allowedActions: [] });
      // A retried cancel returns its original result instead of failing as terminal.
      const replay = yield* command("cancel", first.id, "cancel-1", launched.revision).pipe(
        Effect.flatMap(decodeRun),
      );
      expect(replay.revision).toBe(canceled.revision);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps accepted claims, settlement, gate revisions and thread ownership distinct across restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { test, startSaved, command, thread } = yield* harness;
        const started = yield* startSaved("intent").pipe(Effect.flatMap(decodeRun));
        yield* test.reconcile;
        const threadId = (yield* test.query(started.id)).attempts[0]!.threadId!;
        yield* test.report(threadId, completed);
        yield* test.reconcile;
        // The report is accepted while native execution is still running.
        const reported = yield* test.query(started.id);
        expect(reported).toMatchObject({
          state: "running",
          trace: [],
          attempts: [
            { phase: "reported", report: { outcome: "completed", data: { ready: true } } },
          ],
        });
        expect(yield* thread(threadId)).toMatchObject({
          runId: started.id,
          attemptId: reported.attempts[0]!.id,
          nodeId: "implement",
          phase: "reported",
          reportAccepted: true,
          workflowTitle: "Sequence",
          nodeTitle: "Implement",
        });
        expect(yield* thread("unowned-thread")).toBeNull();

        test.settle(threadId);
        yield* test.reconcile;
        const gated = yield* test.wait(started.id, (run) => run.state === "awaiting-review");
        expect(gated.gate).toMatchObject({ nodeId: "review", revision: gated.revision });
        expect(gated.allowedActions).toEqual(["cancel", "approve", "request-changes"]);
        expect(gated.trace.at(-1)).toMatchObject({ nodeId: "implement", chosen: "review" });
        // Attention opens the run page with this exact run selected.
        const [attention] = yield* test.registry
          .attention(test.environmentId)
          .pipe(Stream.take(1), Stream.runCollect);
        expect(attention?.items.find((item) => item.id === started.id)?.link).toEqual({
          pageId: "workflows.runs",
          projectId: test.projectId,
          state: { run: started.id },
          threadId,
        });

        const stale = yield* test
          .invoke("gate", {
            environmentId: test.environmentId,
            projectId: test.projectId,
            runId: started.id,
            clientRequestId: "stale",
            expectedRevision: gated.revision - 1,
            decision: "approve",
          })
          .pipe(Effect.flip, Effect.orDie);
        expect(stale).toMatchObject({ code: "conflict" });
        expect((yield* test.query(started.id)).revision).toBe(gated.revision);
        const approve = () =>
          test
            .invoke("gate", {
              environmentId: test.environmentId,
              projectId: test.projectId,
              runId: started.id,
              clientRequestId: "approve",
              expectedRevision: gated.gate!.revision,
              decision: "approve",
            })
            .pipe(Effect.flatMap(decodeRun));
        const approved = yield* approve();
        expect(approved).toMatchObject({ state: "completed", allowedActions: [] });
        expect((yield* approve()).revision).toBe(approved.revision);
        // Cancel racing the completed run is refused with the run left as it settled.
        const late = yield* command("cancel", started.id, "late-cancel", gated.revision).pipe(
          Effect.flip,
          Effect.orDie,
        );
        expect(late).toMatchObject({ code: "conflict" });

        // A later manual message in the thread does not reopen the historical attempt.
        const state = test.threads.get(threadId)!;
        test.threads.set(threadId, {
          ...state,
          runs: [...state.runs, { id: "manual-follow-up", status: "running" }],
        });
        yield* test.reconcile;
        const after = yield* test.query(started.id);
        expect(after.revision).toBe(approved.revision);
        expect(after.attempts[0]!.phase).toBe("completed");
        expect(yield* thread(threadId)).toMatchObject({
          attemptId: reported.attempts[0]!.id,
          phase: "completed",
          runState: "completed",
        });

        yield* test.restart;
        const restored = yield* test.query(started.id);
        expect(restored).toEqual(after);
        expect((yield* thread(threadId))?.attemptId).toBe(reported.attempts[0]!.id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exposes Resume and Retry only with their server-owned recovery targets", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, startSaved, command } = yield* harness;
      const started = yield* startSaved("intent").pipe(Effect.flatMap(decodeRun));
      expect(started.recovery).toEqual({ retryNodeId: null, resumeAttemptId: null });
      yield* test.reconcile;
      const threadId = (yield* test.query(started.id)).attempts[0]!.threadId!;
      // Native Stop interrupts the attempt; it is never treated as success.
      test.settle(threadId, "interrupted");
      yield* test.reconcile;
      yield* test.reconcile;
      const interrupted = yield* test.wait(started.id, (run) => run.state === "unresolved");
      const attempt = interrupted.attempts[0]!;
      expect(attempt.phase).toBe("interrupted");
      expect(interrupted.allowedActions).toEqual(["cancel", "retry", "resume"]);
      expect(interrupted.recovery).toEqual({
        retryNodeId: "implement",
        resumeAttemptId: attempt.id,
      });

      const retried = yield* command("retry", started.id, "retry", interrupted.revision).pipe(
        Effect.flatMap(decodeRun),
      );
      expect(retried.state).toBe("running");
      expect(retried.attempts).toHaveLength(2);
      expect(retried.attempts[1]).toMatchObject({ nodeId: "implement", phase: "launching" });
      expect(retried.attempts[1]!.id).not.toBe(attempt.id);
      expect(retried.recovery).toEqual({ retryNodeId: null, resumeAttemptId: null });
      // Resume is no longer allowed once the retry superseded the interrupted attempt.
      const resume = yield* command("resume", started.id, "resume", retried.revision).pipe(
        Effect.flip,
        Effect.orDie,
      );
      expect(resume).toMatchObject({ code: "unsupported" });
      yield* test.reconcile;
      const second = (yield* test.query(started.id)).attempts[1]!;
      expect(second.threadId).not.toBe(threadId);

      // A missing report leaves only Retry: there is no session to resume safely.
      test.settle(second.threadId!);
      yield* test.reconcile;
      yield* test.wait(started.id, (run) => run.attempts[1]!.reminderSent);
      test.settle(second.threadId!);
      yield* test.reconcile;
      const missing = yield* test.wait(started.id, (run) => run.state === "unresolved");
      expect(missing.attempts[1]).toMatchObject({ report: null });
      expect(missing.allowedActions).toEqual(["cancel", "retry"]);
      expect(missing.recovery).toEqual({ retryNodeId: "implement", resumeAttemptId: null });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps an old run selectable and live outside the latest-run page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, startSaved, command, list } = yield* harness;
      const oldest = yield* startSaved("intent-0").pipe(Effect.flatMap(decodeRun));
      for (let index = 1; index <= 20; index++) yield* startSaved(`intent-${index}`);
      const latest = yield* list();
      expect(latest).toHaveLength(20);
      expect(latest.some((run) => run.id === oldest.id)).toBe(false);
      const older = yield* list(latest.at(-1)!.id);
      expect(older.map((run) => run.id)).toEqual([oldest.id]);
      expect(older[0]?.source).toEqual({
        trigger: "manual",
        catalogSource: ".t3code/workflows/sequence.yaml",
      });

      const api = yield* test.registry.api("plugins.workflows.watch");
      const stream = api.invoke({
        environmentId: test.environmentId,
        projectId: test.projectId,
        runId: oldest.id,
      });
      if (!Stream.isStream(stream)) return yield* Effect.die("Expected a run subscription");
      const updates = yield* Queue.unbounded<Run>();
      const fiber = yield* stream.pipe(
        Stream.mapEffect((value) => decodeRun(value)),
        Stream.runForEach((run) => Queue.offer(updates, run)),
        Effect.forkScoped,
      );
      const current = yield* Queue.take(updates);
      expect(current.id).toBe(oldest.id);
      yield* command("cancel", oldest.id, "cancel-oldest", current.revision);
      let next = yield* Queue.take(updates);
      while (next.state !== "canceled") next = yield* Queue.take(updates);
      expect(next).toMatchObject({ id: oldest.id, state: "canceled" });
      yield* Fiber.interrupt(fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("opens a long run on its newest visits with overview totals from the full snapshot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, startSaved, command } = yield* harness;
      const started = yield* startSaved("intent").pipe(Effect.flatMap(decodeRun));
      // Each native Stop followed by Retry admits one more visit in a new thread.
      for (let visit = 1; visit <= 52; visit++) {
        yield* test.reconcile;
        const running = yield* test.wait(
          started.id,
          (run) => run.attempts.at(-1)?.phase === "running",
        );
        if (visit === 52) break;
        test.settle(running.attempts.at(-1)!.threadId!, "interrupted");
        yield* test.reconcile;
        yield* test.reconcile;
        const stopped = yield* test.wait(started.id, (run) => run.state === "unresolved");
        yield* command("retry", started.id, `retry-${visit}`, stopped.revision);
      }
      const newest = yield* test.query(started.id);
      expect(newest.history).toMatchObject({ tail: true, offset: 2, limit: 50, attempts: 52 });
      expect(newest.attempts).toHaveLength(50);
      expect(newest.attempts.at(-1)!.phase).toBe("running");
      expect(newest.overview).toMatchObject({
        visits: 52,
        completedVisits: 0,
        activeAttempts: [{ id: newest.attempts.at(-1)!.id, phase: "running" }],
        review: null,
      });
      const oldest = yield* test
        .invoke("get", {
          environmentId: test.environmentId,
          projectId: test.projectId,
          runId: started.id,
          historyOffset: 0,
        })
        .pipe(Effect.flatMap(decodeRun));
      expect(oldest.history).toMatchObject({ tail: false, offset: 0 });
      expect(oldest.attempts[0]!.phase).toBe("interrupted");
      expect(oldest.attempts.some((attempt) => attempt.phase === "running")).toBe(false);
      // The overview does not depend on the loaded page.
      expect(oldest.overview).toEqual(newest.overview);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const direct = {
  ...sequence,
  atLimit: "done",
  nodes: [
    { ...sequence.nodes[0]!, next: { to: "done" } },
    ...sequence.nodes.filter((node) => node.kind === "end"),
  ],
} as Definition;

it.effect.each(["completion-first", "cancel-first"] as const)(
  "settles a cancel and natural completion decided on one revision exactly once: %s",
  (order) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { test, save, startSaved, command } = yield* harness;
        yield* save(direct);
        const started = yield* startSaved("intent").pipe(Effect.flatMap(decodeRun));
        yield* test.reconcile;
        const observed = yield* test.wait(
          started.id,
          (run) => run.attempts[0]?.phase === "running",
        );
        const threadId = observed.attempts[0]!.threadId!;
        // The user's Cancel and the agent's completion both act on the observed revision.
        if (order === "completion-first") {
          yield* test.report(threadId, completed);
          test.settle(threadId);
          yield* test.reconcile;
          yield* test.wait(started.id, (run) => run.state === "completed");
          const cancel = yield* command("cancel", started.id, "cancel", observed.revision).pipe(
            Effect.flip,
            Effect.orDie,
          );
          expect(cancel).toMatchObject({ code: "conflict" });
          expect(cancel.message).toContain("revision changed");
        } else {
          const canceled = yield* command("cancel", started.id, "cancel", observed.revision).pipe(
            Effect.flatMap(decodeRun),
          );
          expect(canceled.state).toBe("canceled");
          const report = yield* test.report(threadId, completed).pipe(Effect.flip);
          expect(report).toMatchObject({ code: "conflict" });
          test.settle(threadId);
          yield* test.reconcile;
        }
        const final = yield* test.query(started.id);
        expect(final.state).toBe(order === "completion-first" ? "completed" : "canceled");
        expect(final.attempts[0]!.phase).toBe(
          order === "completion-first" ? "completed" : "canceled",
        );
        expect(final.allowedActions).toEqual([]);
        // Exactly one terminal edge: completion routes to the end, cancellation routes nowhere.
        expect(final.trace.map((item) => item.chosen)).toEqual(
          order === "completion-first" ? ["done"] : [],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

const loopAgent = (id: string, title: string, next: string) => ({
  id,
  kind: "agent",
  title,
  modelSelection: { instanceId: "codex", model: "fixture" },
  runtimeMode: "approval-required",
  instruction: title,
  report: { fields: [{ name: "again", type: "boolean", required: true }] },
  next: { to: next },
});
const again = { op: "eq", path: "data.again", value: true };
const loop = Schema.decodeUnknownSync(DefinitionSchema)({
  version: 1,
  id: "loop",
  revision: 1,
  title: "Loop",
  entry: "work1",
  atLimit: "gate",
  maxVisits: 1000,
  nodes: [
    loopAgent("work1", "Work one", "d1"),
    {
      id: "d1",
      kind: "decision",
      title: "Again one",
      source: "work1",
      rules: [{ when: again, route: { to: "work1", repeat: { max: 20, atLimit: "gate" } } }],
      otherwise: { to: "work2" },
    },
    loopAgent("work2", "Work two", "d2"),
    {
      id: "d2",
      kind: "decision",
      title: "Again two",
      source: "work2",
      rules: [{ when: again, route: { to: "work1", repeat: { max: 20, atLimit: "gate" } } }],
      otherwise: { to: "done" },
    },
    {
      id: "gate",
      kind: "human",
      title: "Review",
      approve: { to: "done" },
      changes: { to: "done" },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
  ],
});

it.effect("keeps every visit's routing reachable when route history outgrows visits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const started = yield* test.start(loop);
      let work1 = 0;
      // Two routing records per visit: agent → decision, decision → next step.
      for (let visit = 1; visit <= 56; visit++) {
        yield* test.reconcile;
        const running = yield* test.wait(
          started.id,
          (run) => run.overview!.visits === visit && run.attempts.at(-1)?.phase === "running",
        );
        const attempt = running.attempts.at(-1)!;
        const repeat = attempt.nodeId === "work1" ? ++work1 <= 20 : true;
        yield* test.report(attempt.threadId!, {
          ...completed,
          clientRetryKey: `visit-${visit}`,
          data: { again: repeat },
        });
        test.settle(attempt.threadId!);
      }
      yield* test.reconcile;
      const read = (input: { historyOffset?: number; attemptId?: string; traceOffset?: number }) =>
        test
          .invoke("get", {
            environmentId: test.environmentId,
            projectId: test.projectId,
            runId: started.id,
            ...input,
          })
          .pipe(Effect.flatMap(decodeRun));
      const newest = yield* test.wait(started.id, (run) => run.overview!.visits === 57);
      expect(newest.history!.trace).toBeGreaterThan(newest.history!.attempts);
      for (const page of [
        yield* read({ historyOffset: 0 }),
        yield* read({ historyOffset: 50 }),
        newest,
      ]) {
        const routing = [...page.trace, ...(page.relatedTrace ?? [])];
        for (const attempt of page.attempts.filter((item) => item.phase === "completed")) {
          // Its own outgoing edge and the decision that consumed its report are both present.
          expect(routing.some((item) => item.attemptId === attempt.id)).toBe(true);
          expect(
            routing.some(
              (item) =>
                item.sourceIds.includes(`${attempt.id}:report`) && item.nodeId !== attempt.nodeId,
            ),
          ).toBe(true);
        }
      }
      // Route history pages independently and its oldest entries are reachable.
      const firstRoutes = yield* read({ traceOffset: 0 });
      expect(firstRoutes.history).toMatchObject({ traceOffset: 0, traceTail: false });
      expect(firstRoutes.trace[0]).toMatchObject({ nodeId: "work1", chosen: "d1" });
      // A deep-linked visit opens the page that contains it, not the newest page.
      const oldest = (yield* read({ historyOffset: 0 })).attempts[3]!;
      const located = yield* read({ attemptId: oldest.id });
      expect(located.history).toMatchObject({ offset: 0, tail: false });
      expect(located.attempts.some((item) => item.id === oldest.id)).toBe(true);
      const latest = yield* read({ attemptId: newest.attempts.at(-1)!.id });
      expect(latest.history).toMatchObject({ tail: true });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("updates a thread's link as its run commits, ignoring other runs' commits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { test, scope, startSaved } = yield* harness;
      const started = yield* startSaved("intent").pipe(Effect.flatMap(decodeRun));
      yield* test.reconcile;
      const threadId = (yield* test.wait(started.id, (run) => run.attempts[0]?.phase === "running"))
        .attempts[0]!.threadId!;
      const links = yield* Queue.unbounded<typeof ThreadLink.Type | null>();
      yield* test.stream("thread", { ...scope, threadId }).pipe(
        Stream.mapEffect((value) => decodeLink(value)),
        Stream.runForEach((link) => Queue.offer(links, link)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(links)).toMatchObject({ phase: "running", reportAccepted: false });
      // Another run's commits do not re-send this thread's link.
      yield* startSaved("other");
      yield* test.report(threadId, completed);
      expect(yield* Queue.take(links)).toMatchObject({ phase: "reported", reportAccepted: true });
      test.settle(threadId);
      yield* test.reconcile;
      let next = yield* Queue.take(links);
      while (next?.phase !== "completed") next = yield* Queue.take(links);
      expect(next).toMatchObject({ runState: "awaiting-review", reportAccepted: true });
      // An unowned thread answers once with no link.
      const unowned = yield* Queue.unbounded<unknown>();
      yield* test.stream("thread", { ...scope, threadId: "plain-thread" }).pipe(
        Stream.runForEach((value) => Queue.offer(unowned, value)),
        Effect.forkScoped,
      );
      expect(yield* Queue.take(unowned)).toBeNull();
      yield* startSaved("third");
      yield* test.reconcile;
      expect(yield* Queue.size(unowned)).toBe(0);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

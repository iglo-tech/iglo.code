import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each([
  "unchanged",
  "changed",
  "changed-explicit-binding",
  "unchanged-after-outage",
  "changed-after-outage",
  "unchanged-decision-source",
  "changed-decision-source",
  "changed-decision-binding",
] as const)("retains review authority through a deterministic check: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const outage = scenario.endsWith("after-outage");
      const changed = !scenario.startsWith("unchanged");
      const decision = scenario.includes("decision");
      const test = yield* makeCoreWorkflowFixture;
      const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
      let head = frozen;
      const checkRan = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const launchBlocked = yield* Deferred.make<void>();
      let launchUnavailable = outage;
      const host = Host.of({
        ...test.core,
        verifyPullRequestHead: () => Effect.sync(() => ({ head, branch: "feature" })),
        launch: (input) =>
          Effect.gen(function* () {
            if (input.title === "Apply reviewed work" && launchUnavailable) {
              yield* Deferred.succeed(launchBlocked, undefined);
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Transient launch outage",
              });
            }
            return yield* test.core.launch(input);
          }),
        execute: (input) =>
          Effect.gen(function* () {
            const result = yield* test.core.execute(input);
            if (input.args.includes("HEAD")) {
              yield* Deferred.succeed(checkRan, undefined);
              yield* Deferred.await(releaseCheck);
            }
            return result;
          }),
      });
      let runtime = yield* test.boot(host);
      const get = (runId: string) =>
        runtime.invoke("get", { ...test.scope, runId }).pipe(Effect.flatMap(decodeRun));
      const definition = yield* decodeDefinition({
        ...parallel,
        entry: decision ? "baseline" : parallel.entry,
        nodes: [
          ...(decision
            ? [
                {
                  id: "baseline",
                  title: "Baseline",
                  kind: "check",
                  command: "git",
                  args: ["status", "--porcelain"],
                  next: { to: parallel.entry },
                },
              ]
            : []),
          ...parallel.nodes.map((node) =>
            node.kind === "parallel"
              ? {
                  ...node,
                  branches: node.branches.map((branch) => ({ ...branch, skill: undefined })),
                }
              : node.kind === "join"
                ? {
                    ...node,
                    rules: [
                      {
                        when: { op: "eq", path: "result", value: "all_completed" },
                        route: { to: "precheck" },
                      },
                    ],
                  }
                : node,
          ),
          {
            id: "precheck",
            title: "Preflight",
            kind: "check",
            command: "git",
            args: ["rev-parse", "HEAD"],
            next: { to: decision ? "baseline-decision" : "change" },
          },
          ...(decision
            ? [
                {
                  id: "baseline-decision",
                  title: "Route using baseline",
                  kind: "decision",
                  source: "baseline",
                  rules: [],
                  otherwise: { to: "change" },
                },
              ]
            : []),
          {
            id: "change",
            title: "Apply reviewed work",
            kind: "agent",
            modelSelection: { instanceId: "codex", model: "fixture" },
            runtimeMode: "approval-required",
            instruction: "Apply the change authorized by the review",
            ...(scenario.endsWith("binding")
              ? {
                  bindings: [
                    {
                      name: "reviewResult",
                      node: "join",
                      path: "result",
                      field: {
                        name: "reviewResult",
                        type: "enum",
                        required: true,
                        values: ["all_completed", "failed", "unresolved", "canceled", "stale"],
                      },
                    },
                  ],
                }
              : {}),
            report: { fields: [] },
            next: { to: "done" },
          },
        ],
      });
      const started = yield* runtime
        .invoke("start", {
          ...test.scope,
          clientRequestId: "start",
          definition,
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      const forkApi = yield* runtime.registry.api("plugins.workflows.subscribe");
      const forkUpdates = forkApi.invoke(test.scope);
      if (!Stream.isStream(forkUpdates)) return yield* Effect.die("Expected subscription");
      yield* forkUpdates.pipe(
        Stream.mapEffect(() => get(started.id)),
        Stream.filter(
          (run) =>
            run.attempts.filter(
              (attempt) => attempt.branchId !== null && attempt.phase === "running",
            ).length === 3,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const forked = yield* get(started.id);
      const tool = (yield* runtime.registry.tools).find(
        (item) => item.tool.id === "plugin_workflows_report",
      )!.tool;
      for (const [index, attempt] of forked.attempts
        .filter((attempt) => attempt.branchId !== null)
        .entries()) {
        yield* tool.invoke(
          {
            version: 1,
            clientRetryKey: "report",
            outcome: "completed",
            summary: "Reviewed frozen input",
            data: { verdict: "pass" },
            evidence: [{ kind: "commit", reference: frozen }],
          },
          {
            ...test.scope,
            threadId: attempt.threadId!,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "replayed",
            runtimeMode: "approval-required",
          },
        );
        const now = DateTime.nowUnsafe();
        const runId = RunId.make(`review-${index}`);
        yield* test.sink.write({
          events: [
            {
              id: EventId.make(`completed-${index}`),
              type: "run.created",
              threadId: attempt.threadId!,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: attempt.threadId!,
                ordinal: 1,
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "fixture",
                },
                providerThreadId: null,
                userMessageId: MessageId.make(`message-${index}`),
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
      }
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      yield* Deferred.await(checkRan);
      const advanceHead = Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        expect(
          yield* spawner.exitCode(
            ChildProcess.make("git", [
              "-C",
              test.config.baseDir,
              "-c",
              "user.name=Test",
              "-c",
              "user.email=test@example.com",
              "commit",
              "--allow-empty",
              "-m",
              "new head",
            ]),
          ),
        ).toBe(0);
        head = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
        expect(head).not.toBe(frozen);
      });
      if (changed && !outage) yield* advanceHead;
      yield* Deferred.succeed(releaseCheck, undefined);
      if (outage) {
        yield* Deferred.await(launchBlocked);
        yield* runtime.close;
        if (changed) yield* advanceHead;
        launchUnavailable = false;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
      }
      const api = yield* runtime.registry.api("plugins.workflows.subscribe");
      const updates = api.invoke(test.scope);
      if (!Stream.isStream(updates)) return yield* Effect.die("Expected subscription");
      const states = yield* updates.pipe(
        Stream.mapEffect(() => get(started.id)),
        Stream.filter(
          (run) =>
            run.state === "unresolved" ||
            run.attempts.some(
              (attempt) => attempt.nodeId === "change" && attempt.phase === "running",
            ),
        ),
        Stream.take(1),
        Stream.runCollect,
      );
      const observed = states[0]!;
      expect(observed.reviews[0]!.result).toBe("all_completed");
      expect(
        observed.attempts.find((attempt) => attempt.nodeId === "precheck")!.check!.stdout.trim(),
      ).toBe(frozen);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const retained = yield* get(started.id);
      expect(retained.state).toBe(changed ? "unresolved" : "running");
      const downstream = retained.attempts.find((attempt) => attempt.nodeId === "change")!;
      const native = yield* test.threads.getThreadShell(downstream.threadId!);
      if (changed) {
        expect(downstream.phase).toBe("stale");
        expect(native).toBeNull();
      } else expect(native).not.toBeNull();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

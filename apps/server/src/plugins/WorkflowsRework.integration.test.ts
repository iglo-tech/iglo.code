import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Host } from "@t3tools/plugin-host-contract/server";
import { EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each(["changed-rework", "unchanged-rework", "changed-direct-refork"] as const)(
  "runs checks after authored rework before refork: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const changed = scenario !== "unchanged-rework";
        let checkCalls = 0;
        const test = yield* makeCoreWorkflowFixture;
        const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
        let head = frozen;
        const host = Host.of({
          ...test.core,
          verifyPullRequestHead: () => Effect.sync(() => ({ head, branch: "feature" })),
          execute: (input) =>
            Effect.gen(function* () {
              const result = yield* test.core.execute(input);
              checkCalls++;
              return result;
            }),
        });
        let runtime = yield* test.boot(host);
        const get = (runId: string) =>
          runtime.invoke("get", { ...test.scope, runId }).pipe(Effect.flatMap(decodeRun));
        const definition = yield* decodeDefinition({
          ...parallel,
          nodes: [
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
                          when: {
                            op: "all",
                            terms: [
                              { op: "eq", path: "result", value: "all_completed" },
                              { op: "eq", path: "branches.code.data.verdict", value: "changes" },
                            ],
                          },
                          route: { to: "change" },
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
              next: { to: "reviews", repeat: { max: 1, atLimit: "review" } },
            },
            {
              id: "change",
              title: "Apply reviewed work",
              kind: "agent",
              modelSelection: { instanceId: "codex", model: "fixture" },
              runtimeMode: "approval-required",
              instruction: "Apply the change authorized by the review",
              report: { fields: [] },
              next:
                scenario === "changed-direct-refork"
                  ? { to: "reviews", repeat: { max: 1, atLimit: "review" } }
                  : { to: "precheck" },
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
        const forked = yield* get(started.id);
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        for (const [index, attempt] of forked.attempts.entries()) {
          yield* tool.invoke(
            {
              version: 1,
              clientRetryKey: "report",
              outcome: "completed",
              summary: "Reviewed frozen input",
              data: { verdict: "changes" },
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
        const downstream = (yield* get(started.id)).attempts.find(
          (attempt) => attempt.nodeId === "change",
        )!;
        expect(downstream.phase).toBe("running");
        expect(downstream.reviewId).toBe((yield* get(started.id)).reviews[0]!.id);
        if (changed) {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            `${test.config.baseDir}/implementation.ts`,
            "export const repaired = true;\n",
          );
          expect(
            yield* spawner.exitCode(
              ChildProcess.make("git", ["-C", test.config.baseDir, "add", "implementation.ts"]),
            ),
          ).toBe(0);
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
                "-m",
                "implementation rework",
              ]),
            ),
          ).toBe(0);
          head = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
          expect(head).not.toBe(frozen);
        }
        yield* tool.invoke(
          {
            version: 1,
            clientRetryKey: "implementation-result",
            outcome: "completed",
            summary: "Implemented requested changes",
            data: {},
            evidence: [{ kind: "commit", reference: head }],
          },
          {
            ...test.scope,
            threadId: downstream.threadId!,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "replayed",
            runtimeMode: "approval-required",
          },
        );
        const settledAt = DateTime.nowUnsafe();
        const nativeId = RunId.make("implementation-result");
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("implementation-result"),
              type: "run.created",
              threadId: downstream.threadId!,
              runId: nativeId,
              occurredAt: settledAt,
              payload: {
                id: nativeId,
                threadId: downstream.threadId!,
                ordinal: 1,
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
                providerThreadId: null,
                userMessageId: MessageId.make("implementation-message"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt: settledAt,
                startedAt: settledAt,
                completedAt: settledAt,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        const current = yield* get(started.id);
        if (current.state === "running") {
          const api = yield* runtime.registry.api("plugins.workflows.subscribe");
          const updates = api.invoke(test.scope);
          if (!Stream.isStream(updates)) return yield* Effect.die("Expected subscription");
          yield* updates.pipe(
            Stream.mapEffect(() => get(started.id)),
            Stream.filter(
              (run) =>
                run.state === "unresolved" ||
                (run.reviews.length === 2 &&
                  run.attempts.filter(
                    (attempt) => attempt.generation === 2 && attempt.phase === "running",
                  ).length === 3),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        }
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* get(started.id);
        expect(retained.reviews).toHaveLength(2);
        expect(retained.reviews[1]!.head).toBe(head);
        expect(retained.state).toBe("running");
        expect(checkCalls).toBe(scenario === "changed-direct-refork" ? 0 : 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

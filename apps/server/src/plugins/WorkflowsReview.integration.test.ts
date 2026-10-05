import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Host } from "@t3tools/plugin-host-contract/server";
import { CommandId, EventId, MessageId, ProviderInstanceId, RunId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each(["unchanged", "redirected-same-head", "redirected-new-head"] as const)(
  "joins only the retained reviewer checkout: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
        const host = Host.of({
          ...test.core,
          verifyPullRequestHead: () => Effect.succeed({ head: frozen, branch: "feature" }),
        });
        const runtime = yield* test.boot(host);
        const definition = yield* decodeDefinition({
          ...parallel,
          nodes: parallel.nodes.map((node) =>
            node.kind === "parallel"
              ? {
                  ...node,
                  branches: node.branches.map((branch) => ({ ...branch, skill: undefined })),
                }
              : node,
          ),
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
        const forked = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(forked.attempts.every((attempt) => attempt.phase === "running")).toBe(true);
        if (scenario === "redirected-new-head") {
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
                "different review input",
              ]),
            ),
          ).toBe(0);
        }
        if (scenario !== "unchanged")
          yield* test.threads.dispatch({
            type: "thread.metadata.update",
            threadId: forked.attempts[0]!.threadId!,
            commandId: CommandId.make("redirect"),
            worktreePath: null,
            branch: "main",
          });
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
        const actual = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        const native = yield* host.inspect({
          ...test.scope,
          threadId: forked.attempts[0]!.threadId!,
        });
        const actualWorkspace = yield* host.verifyWorkspace({
          projectId: test.scope.projectId,
          path: native.workspacePath!,
        });
        expect(actualWorkspace.head === frozen).toBe(scenario !== "redirected-new-head");
        expect(actual.reviews[0]!.result).toBe(
          scenario === "unchanged" ? "all_completed" : "stale",
        );
        if (scenario === "unchanged") {
          yield* runtime.invoke("gate", {
            ...test.scope,
            runId: actual.id,
            expectedRevision: actual.revision,
            clientRequestId: "approval",
            decision: "approve",
          });
        } else {
          expect(actual.attempts[0]!.phase).toBe("stale");
          expect(actual.allowedActions).not.toContain("approve");
          expect(actual.state).toBe("unresolved");
          expect(
            yield* runtime
              .invoke("gate", {
                ...test.scope,
                runId: actual.id,
                expectedRevision: actual.revision,
                clientRequestId: "approval",
                decision: "approve",
              })
              .pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
        }
        yield* runtime.close;
        const restarted = yield* test.boot(host);
        const retained = yield* restarted
          .invoke("get", { ...test.scope, runId: actual.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(retained.state).toBe(scenario === "unchanged" ? "completed" : "unresolved");
        expect(retained.reviews[0]!.result).toBe(actual.reviews[0]!.result);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

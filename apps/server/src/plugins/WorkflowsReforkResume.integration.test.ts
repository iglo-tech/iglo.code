import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
it.live.each(["retry-unavailable", "retry-valid", "initial-unavailable"] as const)(
  "does not revive a consumed review after failed refork: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
        let available = mode !== "initial-unavailable";
        const sends: string[] = [];
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          verifyPullRequestHead: () =>
            available
              ? Effect.succeed({ head: frozen, branch: "feature" })
              : Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    operation: "head",
                    code: "service",
                    message: "Head unavailable",
                  }),
                ),
          send: (input) =>
            Effect.gen(function* () {
              const prior = yield* test.core.receipt(input.commandId);
              if (prior) return prior;
              sends.push(input.threadId);
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
                        message: "Core admission failed",
                        cause,
                      }),
                  ),
                );
              return (yield* test.core.receipt(input.commandId))!;
            }),
        });
        let runtime = yield* test.boot(host);
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
        const start = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition,
            clientRequestId: "start",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const get = () =>
          runtime.invoke("get", { ...test.scope, runId: start.id }).pipe(Effect.flatMap(decodeRun));
        let state = yield* get();
        if (mode === "initial-unavailable") {
          expect(state.state).toBe("unresolved");
          expect(state.attempts).toEqual([]);
          expect(state.allowedActions).not.toContain("resume");
          return;
        }
        expect(state.attempts).toHaveLength(3);
        const old = state.attempts.slice();
        for (const [index, attempt] of old.entries()) {
          const now = DateTime.nowUnsafe(),
            id = RunId.make(`interrupted-${index}`),
            provider = ProviderThreadId.make(`provider-${index}`),
            driver = ProviderDriverKind.make("codex"),
            instanceId = ProviderInstanceId.make("codex");
          yield* test.sink.write({
            events: [
              {
                id: EventId.make(`run-${index}`),
                type: "run.created",
                threadId: attempt.threadId!,
                runId: id,
                occurredAt: now,
                payload: {
                  id,
                  threadId: attempt.threadId!,
                  ordinal: 1,
                  providerInstanceId: instanceId,
                  modelSelection: { instanceId, model: "fixture" },
                  providerThreadId: provider,
                  userMessageId: MessageId.make(`message-${index}`),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "interrupted",
                  requestedAt: now,
                  startedAt: now,
                  completedAt: now,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
              {
                id: EventId.make(`session-${index}`),
                type: "provider-thread.updated",
                threadId: attempt.threadId!,
                occurredAt: now,
                payload: {
                  id: provider,
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: null,
                  appThreadId: attempt.threadId!,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: `native-${index}`, strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: 1,
                  lastRunOrdinal: 1,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
        }
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        state = yield* get();
        expect(state.state).toBe("unresolved");
        expect(state.reviews[0]!.consumed).toBe(true);
        expect(state.reviews[0]!.result).toBe("unresolved");
        expect(state.attempts.at(-1)!.resumable).toBe(true);
        expect(state.allowedActions).toContain("retry");
        expect(state.allowedActions).not.toContain("resume");
        available = mode === "retry-valid";
        yield* runtime.invoke("retry", {
          ...test.scope,
          runId: start.id,
          expectedRevision: state.revision,
          clientRequestId: "retry",
        });
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        state = yield* get();
        if (mode === "retry-valid") {
          expect(state.reviews).toHaveLength(2);
          expect(state.attempts).toHaveLength(6);
          expect(state.allowedActions).not.toContain("resume");
          expect(sends).toEqual([]);
          return;
        }
        expect(state.state).toBe("unresolved");
        expect(state.currentNode).toBe("reviews");
        expect(state.reviews).toHaveLength(1);
        expect(state.attempts).toHaveLength(3);
        const oldPayload = {
          version: 1 as const,
          clientRetryKey: "old-generation",
          outcome: "completed" as const,
          summary: "Old generation",
          data: { verdict: "pass" },
          evidence: [],
        };
        const staleTool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        const caller = {
          ...test.scope,
          threadId: old.at(-1)!.threadId!,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerSessionId: "fixture",
          runtimeMode: "approval-required" as const,
        };
        expect((yield* staleTool.invoke(oldPayload, caller).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const resumeOffered = state.allowedActions.includes("resume");
        const resumed = yield* runtime
          .invoke("resume", {
            ...test.scope,
            runId: start.id,
            expectedRevision: state.revision,
            clientRequestId: "resume",
          })
          .pipe(Effect.result);
        yield* runtime.invoke("reconcile", test.scope);
        const oldReport = yield* staleTool.invoke(oldPayload, caller).pipe(Effect.result);
        const native = yield* test.threads.getProjectThreadRecords(
          { ...test.scope, threadId: old.at(-1)!.threadId! },
          ["runs", "nodes", "turnItems"],
        );
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* get();

        expect(resumeOffered).toBe(false);
        expect(resumed._tag).toBe("Failure");
        expect(sends).toEqual([]);
        expect(oldReport._tag).toBe("Failure");
        expect(native.runs).toHaveLength(1);
        expect(retained.state).toBe("unresolved");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

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
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence, completed } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
it.live.each([
  "retry-blocked",
  "retry-failed-native",
  "retry-interrupted-current",
  "original-resume",
] as const)("limits Resume to the current node attempt: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const sends: string[] = [];
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        send: (input) =>
          Effect.gen(function* () {
            const previous = yield* test.core.receipt(input.commandId);
            if (previous) return previous;
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
                      message: "Could not commit execution",
                      cause,
                    }),
                ),
              );
            return (yield* test.core.receipt(input.commandId))!;
          }),
      });
      let runtime = yield* test.boot(host);
      const start = yield* runtime
        .invoke("start", {
          ...test.scope,
          definition: sequence,
          clientRequestId: "start",
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      const first = start.attempts[0]!;
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const settleExternal = Effect.fnUntraced(function* (
        threadId: typeof first.threadId & {},
        suffix: string,
        status: "interrupted" | "failed" | "completed",
        withSession: boolean,
      ) {
        const now = DateTime.nowUnsafe();
        const runId = RunId.make(`external-${suffix}`);
        const providerThreadId = ProviderThreadId.make(`provider-${suffix}`);
        yield* test.sink.write({
          events: [
            {
              id: EventId.make(`run-${suffix}`),
              type: "run.created",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection: { instanceId, model: "fixture" },
                providerThreadId: withSession ? providerThreadId : null,
                userMessageId: MessageId.make(`message-${suffix}`),
                rootNodeId: null,
                activeAttemptId: null,
                status,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            ...(withSession
              ? [
                  {
                    id: EventId.make(`session-${suffix}`),
                    type: "provider-thread.updated" as const,
                    threadId,
                    occurredAt: now,
                    payload: {
                      id: providerThreadId,
                      driver,
                      providerInstanceId: instanceId,
                      providerSessionId: null,
                      appThreadId: threadId,
                      ownerNodeId: null,
                      nativeThreadRef: {
                        driver,
                        nativeId: `native-${suffix}`,
                        strength: "strong" as const,
                      },
                      nativeConversationHeadRef: null,
                      status: "idle" as const,
                      firstRunOrdinal: 1,
                      lastRunOrdinal: 1,
                      handoffIds: [],
                      forkedFrom: null,
                      createdAt: now,
                      updatedAt: now,
                    },
                  },
                ]
              : []),
          ],
        });
        return runId;
      });
      yield* settleExternal(first.threadId!, "first", "interrupted", true);
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      let state = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(state.state).toBe("unresolved");
      expect(state.attempts[0]!.resumable).toBe(true);
      expect(state.allowedActions).toContain("resume");
      let selected = first;
      if (scenario !== "original-resume") {
        yield* runtime.invoke("retry", {
          ...test.scope,
          runId: start.id,
          expectedRevision: state.revision,
          clientRequestId: "retry",
        });
        yield* runtime.invoke("reconcile", test.scope);
        state = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        selected = state.attempts.at(-1)!;
        expect(selected.id).not.toBe(first.id);
        expect(selected.threadId).not.toBe(first.threadId);
        expect(selected.phase).toBe("running");
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        if (scenario === "retry-blocked")
          yield* tool.invoke(
            { ...completed, outcome: "blocked" },
            {
              ...test.scope,
              threadId: selected.threadId!,
              providerInstanceId: instanceId,
              providerSessionId: "fixture-new",
              runtimeMode: "approval-required",
            },
          );
        yield* settleExternal(
          selected.threadId!,
          "second",
          scenario === "retry-interrupted-current"
            ? "interrupted"
            : scenario === "retry-failed-native"
              ? "failed"
              : "completed",
          scenario === "retry-interrupted-current",
        );
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        state = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(state.state).toBe("unresolved");
        expect(state.attempts).toHaveLength(2);
        expect(state.attempts[0]!.phase).toBe("interrupted");
        expect(state.attempts.at(-1)!.phase).toBe(
          scenario === "retry-blocked"
            ? "unresolved"
            : scenario === "retry-failed-native"
              ? "failed"
              : "interrupted",
        );
        const latestNative = yield* test.core.inspect({
          ...test.scope,
          threadId: selected.threadId!,
        });
        expect(latestNative.outstandingWork).toEqual([]);
        expect(state.attempts.at(-1)!.resumable).toBe(scenario === "retry-interrupted-current");
        const oldReport = yield* tool
          .invoke(completed, {
            ...test.scope,
            threadId: first.threadId!,
            providerInstanceId: instanceId,
            providerSessionId: "fixture-old",
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        expect(oldReport._tag).toBe("Failure");
      }
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      state = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      const eligible = scenario === "original-resume" || scenario === "retry-interrupted-current";
      const resumed = yield* runtime
        .invoke("resume", {
          ...test.scope,
          runId: start.id,
          expectedRevision: state.revision,
          clientRequestId: "resume",
        })
        .pipe(Effect.result);
      yield* runtime.invoke("reconcile", test.scope);
      const after = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      const oldNative = yield* test.threads.getProjectThreadRecords(
        { ...test.scope, threadId: first.threadId! },
        ["runs"],
      );
      const selectedNative = yield* test.threads.getProjectThreadRecords(
        { ...test.scope, threadId: selected.threadId! },
        ["runs"],
      );
      expect(oldNative.runs).toHaveLength(scenario === "original-resume" ? 2 : 1);
      expect(selectedNative.runs).toHaveLength(eligible ? 2 : 1);
      expect(resumed._tag).toBe(eligible ? "Success" : "Failure");
      expect(state.allowedActions.includes("resume")).toBe(eligible);
      expect(sends).toEqual(eligible ? [selected.threadId] : []);
      expect(after.attempts[0]!.resumeCount).toBe(scenario === "original-resume" ? 1 : 0);
      if (scenario !== "original-resume")
        expect(after.attempts.at(-1)!.resumeCount).toBe(
          scenario === "retry-interrupted-current" ? 1 : 0,
        );
      const tool = (yield* runtime.registry.tools).find(
        (item) => item.tool.id === "plugin_workflows_report",
      )!.tool;
      if (!eligible) {
        const oldReport = yield* tool
          .invoke(completed, {
            ...test.scope,
            threadId: first.threadId!,
            providerInstanceId: instanceId,
            providerSessionId: "fixture-old",
            runtimeMode: "approval-required",
          })
          .pipe(Effect.result);
        expect(oldReport._tag).toBe("Failure");
        expect(after.state).toBe("unresolved");
        expect(after.allowedActions).not.toContain("approve");
        expect(after.attempts.at(-1)!.id).toBe(selected.id);
      } else {
        const receipt = yield* tool.invoke(completed, {
          ...test.scope,
          threadId: selected.threadId!,
          providerInstanceId: instanceId,
          providerSessionId: "fixture-current",
          runtimeMode: "approval-required",
        });
        const records = yield* test.threads.getProjectThreadRecords(
          { ...test.scope, threadId: selected.threadId! },
          ["runs", "nodes", "turnItems"],
        );
        const admitted = records.runs.find((run) => run.ordinal === 2)!;
        expect(admitted.status).toBe("preparing");
        const now = DateTime.nowUnsafe();
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("resumed-complete"),
              type: "run.updated",
              threadId: selected.threadId!,
              runId: admitted.id,
              occurredAt: now,
              payload: { ...admitted, status: "completed", startedAt: now, completedAt: now },
            },
            ...records.nodes
              .filter((node) => node.runId === admitted.id)
              .map((node) => ({
                id: EventId.make(`resumed-node:${node.id}`),
                type: "node.updated" as const,
                threadId: selected.threadId!,
                runId: admitted.id,
                occurredAt: now,
                payload: {
                  ...node,
                  status: "completed" as const,
                  startedAt: now,
                  completedAt: now,
                },
              })),
            ...records.turnItems
              .filter((item) => item.runId === admitted.id)
              .map((item) => ({
                id: EventId.make(`resumed-item:${item.id}`),
                type: "turn-item.updated" as const,
                threadId: selected.threadId!,
                runId: admitted.id,
                occurredAt: now,
                payload: {
                  ...item,
                  status: "completed" as const,
                  completedAt: now,
                  updatedAt: now,
                },
              })),
          ],
        });
        expect(
          (yield* test.core.inspect({ ...test.scope, threadId: selected.threadId! }))
            .outstandingWork,
        ).toEqual([]);
        yield* runtime.invoke("reconcile", test.scope);
        const settled = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(settled.state).toBe("awaiting-review");
        expect(settled.attempts.at(-1)!.report?.receipt).toEqual(receipt);
        expect(settled.attempts.at(-1)!.phase).toBe("completed");
      }
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const retained = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(retained.state).toBe(eligible ? "awaiting-review" : "unresolved");
      expect(retained.attempts[0]!.resumeCount).toBe(scenario === "original-resume" ? 1 : 0);
      expect(sends).toEqual(eligible ? [selected.threadId] : []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

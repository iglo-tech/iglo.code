import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import {
  CommandId,
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
  "unchanged",
  "alias",
  "redirected",
  "redirected-replay",
  "unchanged-replay",
] as const)("Resume respects immutable workflow workspace: %s", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const blocked = yield* Deferred.make<void>();
      const admitted = yield* Deferred.make<void>();
      const replay = mode.endsWith("replay");
      const redirected = mode.startsWith("redirected");
      let sendUnavailable = replay;
      const destinations: string[] = [];
      const head = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
      const alternate = yield* test.core.prepareWorkspace({
        projectId: test.scope.projectId,
        key: "alternate",
        ref: head,
      });
      expect(alternate.path).not.toBe(test.config.baseDir);
      expect(
        (yield* test.core.verifyWorkspace({
          projectId: test.scope.projectId,
          path: alternate.path,
        })).head,
      ).toBe(head);
      const fs = yield* FileSystem.FileSystem;
      const aliasDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "workflow-workspace-alias-",
      });
      const alias = `${aliasDirectory}/checkout`;
      yield* fs.symlink(test.config.baseDir, alias);
      const sends: string[] = [];
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        send: (input) =>
          Effect.gen(function* () {
            const previous = yield* test.core.receipt(input.commandId);
            if (previous) return previous;
            if (sendUnavailable) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* new PluginError({
                pluginId: "host",
                operation: "send",
                code: "service",
                message: "Transient send outage",
              });
            }
            destinations.push((yield* test.core.inspect(input)).workspacePath!);
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
            yield* Deferred.succeed(admitted, undefined);
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
      const selected = first;
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      state = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      if (mode === "redirected" || mode === "alias")
        yield* test.threads.dispatch({
          type: "thread.metadata.update",
          threadId: first.threadId!,
          commandId: CommandId.make("redirect"),
          worktreePath: mode === "alias" ? alias : alternate.path,
          branch: alternate.branch,
        });
      const resumed = yield* runtime
        .invoke("resume", {
          ...test.scope,
          runId: start.id,
          expectedRevision: state.revision,
          clientRequestId: "resume",
        })
        .pipe(Effect.result);
      yield* runtime.invoke("reconcile", test.scope);
      if (replay) {
        yield* Deferred.await(blocked);
        const waiting = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(waiting.attempts[0]!.phase).toBe("resuming");
        yield* runtime.close;
        if (redirected)
          yield* test.threads.dispatch({
            type: "thread.metadata.update",
            threadId: first.threadId!,
            commandId: CommandId.make("redirect"),
            worktreePath: alternate.path,
            branch: alternate.branch,
          });
        sendUnavailable = false;
        runtime = yield* test.boot(host);
        if (!redirected) yield* Deferred.await(admitted);
        yield* runtime.invoke("reconcile", test.scope);
      }
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
      expect(resumed._tag).toBe("Success");
      expect(after.attempts[0]!.resumeCount).toBe(1);
      expect(oldNative.runs).toHaveLength(redirected ? 1 : 2);
      expect(selectedNative.runs).toHaveLength(redirected ? 1 : 2);
      expect(sends).toEqual(redirected ? [] : [selected.threadId]);
      if (redirected) {
        expect(after.state).toBe("unresolved");
        expect(after.reason).toContain("workspace");
        expect(after.attempts[0]!.phase).toBe("unresolved");
        const tool = (yield* runtime.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!.tool;
        expect(
          (yield* tool
            .invoke(completed, {
              ...test.scope,
              threadId: first.threadId!,
              providerInstanceId: instanceId,
              providerSessionId: "fixture",
              runtimeMode: "approval-required",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        const native = yield* test.core.inspect({ ...test.scope, threadId: first.threadId! });
        expect(native.nativeSession?.id).toBe("native-first");
        expect(native.workspacePath).toBe(alternate.path);
        expect(native.runs).toHaveLength(1);
        expect(retained.workspacePath).toBe(test.config.baseDir);
        expect(retained.attempts[0]!.launch?.workspace).toEqual(
          after.attempts[0]!.launch?.workspace,
        );
        expect(retained.state).toBe("unresolved");
        expect(retained.allowedActions).not.toContain("approve");
        expect(sends).toEqual([]);
        return;
      }
      if (replay) {
        yield* runtime.close;
        runtime = yield* test.boot(host);
        const retained = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        const native = yield* test.core.inspect({ ...test.scope, threadId: first.threadId! });
        expect(native.workspacePath).toBe(test.config.baseDir);
        expect(native.runs).toHaveLength(2);
        expect(retained.workspacePath).toBe(test.config.baseDir);
        expect(sends).toEqual([selected.threadId]);
        return;
      }
      const tool = (yield* runtime.registry.tools).find(
        (item) => item.tool.id === "plugin_workflows_report",
      )!.tool;
      {
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
      expect(retained.state).toBe("awaiting-review");
      expect(retained.attempts[0]!.resumeCount).toBe(1);
      expect(sends).toEqual([selected.threadId]);
      const native = yield* test.core.inspect({ ...test.scope, threadId: first.threadId! });
      expect(native.nativeSession?.id).toBe("native-first");
      expect(retained.workspacePath).toBe(test.config.baseDir);
      expect(retained.attempts[0]!.launch?.workspace.type).toBe("existing");
      if (retained.attempts[0]!.launch?.workspace.type === "existing")
        expect(retained.attempts[0]!.launch.workspace.path).toBe(test.config.baseDir);
      expect(native.workspacePath).toBe(mode === "alias" ? alias : test.config.baseDir);
      expect(destinations).toEqual([mode === "alias" ? alias : test.config.baseDir]);
      expect(retained.allowedActions).toContain("approve");
      yield* runtime.invoke("gate", {
        ...test.scope,
        runId: start.id,
        expectedRevision: retained.revision,
        clientRequestId: "approve",
        decision: "approve",
      });
      yield* runtime.close;
      runtime = yield* test.boot(host);
      const approved = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(approved.state).toBe("completed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

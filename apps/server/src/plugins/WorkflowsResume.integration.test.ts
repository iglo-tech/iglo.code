import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each([
  "unchanged-resume",
  "changed-resume",
  "unchanged-resume-outage",
  "changed-resume-outage",
  "unchanged-resume-ack-loss",
  "unchanged-cancel-outage",
  "unchanged-expired-outage",
  "unchanged-expired-live-outage",
  "unchanged-legacy-outage",
  "skill-unchanged-outage",
  "skill-changed-outage",
  "provider-unsupported-outage",
  "provider-unavailable-outage",
  "provider-mode-outage",
] as const)("retains Resume admission and review authority: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const changed = scenario.startsWith("changed");
      const outage = scenario.endsWith("outage");
      const lostAck = scenario.endsWith("ack-loss");
      const canceled = scenario.includes("cancel");
      const expired = scenario.includes("expired");
      const legacy = scenario.includes("legacy");
      const live = scenario.includes("live");
      const skillCase = scenario.startsWith("skill-");
      const skillChanged = scenario === "skill-changed-outage";
      const providerCase = scenario.startsWith("provider-");
      const admitted = !changed && !canceled && !expired && !skillChanged && !providerCase;
      let providerValid = true;
      const test = yield* makeCoreWorkflowFixture;
      const fs = yield* FileSystem.FileSystem;
      const skillPath = `${test.config.baseDir}/SKILL.md`;
      if (skillCase) yield* fs.writeFileString(skillPath, "# Skill\nOriginal work");
      const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
      let head = frozen;
      let sends = 0;
      let sendUnavailable = outage;
      const sendBlocked = yield* Deferred.make<void>();
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        providers: () =>
          test.core.providers().pipe(
            Effect.map((providers) =>
              providers.map((provider) => ({
                ...provider,
                toolsSupported: scenario !== "provider-unsupported-outage" || providerValid,
                available:
                  provider.available === true &&
                  (scenario !== "provider-unavailable-outage" || providerValid),
                runtimeModes:
                  scenario === "provider-mode-outage" && !providerValid
                    ? []
                    : provider.runtimeModes,
              })),
            ),
          ),
        skills: () => Effect.succeed([{ name: "authored-skill", path: skillPath, enabled: true }]),
        verifyPullRequestHead: () => Effect.sync(() => ({ head, branch: "feature" })),
        send: (input) =>
          Effect.gen(function* () {
            const retained = yield* test.core.receipt(input.commandId);
            if (retained) return retained;
            if (sendUnavailable) {
              yield* Deferred.succeed(sendBlocked, undefined);
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "send",
                message: "Transient send outage",
              });
            }
            sends++;
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
                      code: "service",
                      operation: "send",
                      message: "Could not commit deferred fixture execution",
                      cause,
                    }),
                ),
              );
            if (lostAck) {
              yield* Deferred.succeed(sendBlocked, undefined);
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "send",
                message: "Committed resume acknowledgment lost",
              });
            }
            return (yield* test.core.receipt(input.commandId))!;
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
                        when: { op: "eq", path: "result", value: "all_completed" },
                        route: { to: "change" },
                      },
                    ],
                  }
                : node,
          ),
          {
            id: "change",
            title: "Apply reviewed work",
            kind: "agent",
            modelSelection: { instanceId: "codex", model: "fixture" },
            runtimeMode: "approval-required",
            instruction: "Apply the change authorized by the review",
            skill: skillCase ? "authored-skill" : undefined,
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
      const current = yield* get(started.id);
      const downstream = current.attempts.find((attempt) => attempt.nodeId === "change")!;
      expect(downstream.phase).toBe("running");
      expect(downstream.reviewId).toBe(current.reviews[0]!.id);
      const threadId = downstream.threadId!;
      const now = DateTime.nowUnsafe();
      const runId = RunId.make("downstream-run");
      const driver = ProviderDriverKind.make("codex");
      const providerThreadId = ProviderThreadId.make("downstream-provider");
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("downstream-lifecycle"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              providerThreadId,
              userMessageId: MessageId.make("downstream-message"),
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
            id: EventId.make("downstream-native"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: null,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-retained", strength: "strong" },
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
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      expect((yield* get(started.id)).allowedActions).toContain("resume");
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
      const interrupted = yield* get(started.id);
      yield* runtime.invoke("resume", {
        ...test.scope,
        runId: started.id,
        expectedRevision: interrupted.revision,
        clientRequestId: "resume",
      });
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      if (outage || lostAck) {
        yield* Deferred.await(sendBlocked);
        const pending = yield* get(started.id);
        expect(pending.state).toBe("running");
        expect(pending.allowedActions).not.toContain("resume");
        expect(lostAck ? ["resuming", "running"] : ["resuming"]).toContain(
          pending.attempts.find((attempt) => attempt.id === downstream.id)!.phase,
        );
        expect((yield* test.core.inspect({ ...test.scope, threadId })).runs).toHaveLength(
          lostAck ? 2 : 1,
        );
        if (canceled)
          yield* runtime.invoke("cancel", {
            ...test.scope,
            runId: started.id,
            expectedRevision: pending.revision,
            clientRequestId: "cancel",
          });
        if (!live) yield* runtime.close;
        if (expired || legacy) {
          const db = new NodeSqlite.DatabaseSync(test.databasePath);
          try {
            const index = pending.attempts.findIndex((attempt) => attempt.id === downstream.id);
            db.prepare("UPDATE workflow_runs SET data=json_set(data,?,?) WHERE id=?").run(
              `$.attempts[${index}].${expired ? "lastActiveAt" : "phase"}`,
              expired ? 0 : "running",
              started.id,
            );
          } finally {
            db.close();
          }
        }
        if (changed) yield* advanceHead;
        if (skillChanged) yield* fs.writeFileString(skillPath, "# Skill\nDifferent work");
        providerValid = false;
        sendUnavailable = false;
        if (!live) runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
      }
      const observed = yield* get(started.id);
      expect(observed.state).toBe(canceled ? "canceled" : admitted ? "running" : "unresolved");
      if (skillChanged) expect(observed.reason).toContain("skill");
      const native = yield* test.core.inspect({ ...test.scope, threadId });
      expect(sends).toBe(admitted ? 1 : 0);
      expect(native.runs).toHaveLength(admitted ? 2 : 1);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      expect((yield* test.core.inspect({ ...test.scope, threadId })).runs).toHaveLength(
        admitted ? 2 : 1,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

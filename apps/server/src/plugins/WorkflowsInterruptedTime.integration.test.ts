import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import {
  EventId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderDriverKind,
  RunId,
} from "@t3tools/contracts";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
it.live.each(["interrupted-offline", "interrupted-online", "interrupted-late"] as const)(
  "retains execution budget after native interruption: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        let observing = true;
        let sends = 0;
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          inspect: (input) =>
            observing
              ? test.core.inspect(input)
              : Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    operation: "inspect",
                    code: "service",
                    message: "Observation outage",
                  }),
                ),
          send: (input) =>
            Effect.gen(function* () {
              const receipt = yield* test.core.receipt(input.commandId);
              if (receipt) return receipt;
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
                        operation: "send",
                        code: "service",
                        message: "Fixture send could not commit",
                        cause,
                      }),
                  ),
                );
              return (yield* test.core.receipt(input.commandId))!;
            }),
        });
        let runtime = yield* test.boot(host);
        const definition = yield* decodeDefinition({
          ...sequence,
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent" ? { ...node, timeoutMs: 60000 } : node,
          ),
        });
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition,
            clientRequestId: "start",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const threadId = started.attempts[0]!.threadId!;
        observing = false;
        yield* runtime.close;
        const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
        const began = now - (scenario === "interrupted-online" ? 1000 : 3600000);
        const finishedAt = DateTime.makeUnsafe(
          began + (scenario === "interrupted-late" ? 65000 : 1000),
        );
        const nativeId = RunId.make("actual-settled-work");
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("actual-result"),
              type: "run.created",
              threadId,
              runId: nativeId,
              occurredAt: finishedAt,
              payload: {
                id: nativeId,
                threadId,
                ordinal: 1,
                providerInstanceId: ProviderInstanceId.make("codex"),
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
                providerThreadId: ProviderThreadId.make("retained-provider"),
                userMessageId: MessageId.make("initial"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "interrupted",
                requestedAt: DateTime.makeUnsafe(began),
                startedAt: DateTime.makeUnsafe(began),
                completedAt: finishedAt,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make("retained-session"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: finishedAt,
              payload: {
                id: ProviderThreadId.make("retained-provider"),
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: null,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("codex"),
                  nativeId: "native-retained",
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: 1,
                lastRunOrdinal: 1,
                handoffIds: [],
                forkedFrom: null,
                createdAt: finishedAt,
                updatedAt: finishedAt,
              },
            },
          ],
        });
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          db.prepare(
            "UPDATE workflow_runs SET data=json_set(data,'$.createdAt',?,'$.attempts[0].lastActiveAt',?,'$.attempts[0].remainingMs',60000) WHERE id=?",
          ).run(began, began, started.id);
        } finally {
          db.close();
        }
        observing = true;
        const aggregate = yield* test.core.inspect({ ...test.scope, threadId });
        expect(aggregate.outstandingWork).toEqual([]);
        expect(aggregate.requests).toEqual([]);
        expect(aggregate.checkpoints).toEqual([]);
        expect(aggregate.settledAt).toBe(DateTime.toEpochMillis(finishedAt));
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        const run = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));

        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        const resumed = yield* runtime
          .invoke("resume", {
            ...test.scope,
            runId: started.id,
            expectedRevision: retained.revision,
            clientRequestId: "resume-after-recovery",
          })
          .pipe(Effect.result);
        yield* runtime.invoke("reconcile", test.scope);
        expect(sends).toBe(scenario === "interrupted-late" ? 0 : 1);
        expect(run.state).toBe("unresolved");
        if (scenario === "interrupted-late") {
          expect(run.reason).toContain("timeout");
          expect(run.allowedActions).not.toContain("resume");
        } else {
          expect(run.attempts[0]!.phase).toBe("interrupted");
          expect(retained.allowedActions).toContain("resume");
          expect(resumed._tag).toBe("Success");
          expect(run.attempts[0]!.remainingMs).toBeGreaterThan(58000);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

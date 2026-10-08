import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
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
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
it.live.each(["cancel-inflight", "no-cancel", "cancel-committed"] as const)(
  "stops Resume committing after cancellation: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        let outage = true;
        let sends = 0;
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          send: (input) =>
            Effect.gen(function* () {
              const retained = yield* test.core.receipt(input.commandId);
              if (retained) return retained;
              if (outage) {
                yield* Deferred.succeed(failed, undefined);
                return yield* new PluginError({
                  pluginId: "host",
                  operation: "send",
                  code: "service",
                  message: "Deterministic send outage",
                });
              }
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(released);
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
                        message: "Could not commit fixture execution",
                        cause,
                      }),
                  ),
                );
              sends++;
              yield* Deferred.succeed(finished, undefined);
              return (yield* test.core.receipt(input.commandId))!;
            }),
        });
        let runtime = yield* test.boot(host);
        const get = (id: string) =>
          runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.flatMap(decodeRun));
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
        const threadId = start.attempts[0]!.threadId!;
        const now = DateTime.nowUnsafe();
        const runId = RunId.make("retained-interrupted");
        const driver = ProviderDriverKind.make("codex");
        const providerThreadId = ProviderThreadId.make("retained-provider");
        yield* test.sink.write({
          events: [
            {
              id: EventId.make("interrupted-run"),
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
                userMessageId: MessageId.make("initial-message"),
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
              id: EventId.make("native-session"),
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
        const interrupted = yield* get(start.id);
        expect(interrupted.allowedActions).toContain("resume");
        yield* runtime.invoke("resume", {
          ...test.scope,
          runId: start.id,
          expectedRevision: interrupted.revision,
          clientRequestId: "resume",
        });
        yield* runtime.invoke("reconcile", test.scope);
        yield* Deferred.await(failed);
        yield* runtime.close;
        outage = false;
        runtime = yield* test.boot(host);
        yield* Deferred.await(entered);
        const cancel = Effect.gen(function* () {
          const pending = yield* get(start.id);
          yield* runtime.invoke("cancel", {
            ...test.scope,
            runId: start.id,
            expectedRevision: pending.revision,
            clientRequestId: "cancel",
          });
          yield* runtime.invoke("reconcile", test.scope);
        });
        if (scenario === "cancel-inflight") {
          yield* cancel;
          expect(
            (yield* test.core.inspect({ ...test.scope, threadId })).runs.map((run) => run.status),
          ).toEqual(["interrupted"]);
        }
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(finished);
        yield* runtime.invoke("reconcile", test.scope);
        if (scenario === "cancel-committed") yield* cancel;
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* get(start.id);
        const native = yield* test.core.inspect({ ...test.scope, threadId });
        expect(sends).toBe(1);
        expect(retained.state).toBe(scenario === "no-cancel" ? "running" : "canceled");
        expect(native.runs.map((run) => run.status)).toEqual(
          scenario === "no-cancel" ? ["interrupted", "preparing"] : ["interrupted", "interrupted"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

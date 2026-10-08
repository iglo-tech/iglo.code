import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, MessageId } from "@t3tools/contracts";
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
it.live.each(["cancel-inflight", "no-cancel", "cancel-committed"] as const)(
  "stops core launch committing after owner cancellation: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const entered = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        let unavailable = true;
        let hold = true;
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          launch: (input) =>
            Effect.gen(function* () {
              if (unavailable)
                return yield* new PluginError({
                  pluginId: "host",
                  code: "service",
                  operation: "launch",
                  message: "Transient launch outage",
                });
              if (hold) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(released);
              }
              const result = yield* test.core.launch(input);
              yield* test.threads
                .dispatch({
                  type: "message.dispatch",
                  threadId: input.threadId!,
                  commandId: CommandId.make(`${input.commandId}:deferred`),
                  messageId: MessageId.make(`${input.commandId}:message`),
                  text: "Launch-owned provider execution",
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
                        operation: "launch",
                        message: "Could not commit deferred fixture execution",
                        cause,
                      }),
                  ),
                );

              yield* Deferred.succeed(finished, undefined);
              return result;
            }),
        });
        let runtime = yield* test.boot(host);
        const get = (id: string) =>
          runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.flatMap(decodeRun));
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition: sequence,
            clientRequestId: "start",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const threadId = started.attempts[0]!.threadId!;
        expect(yield* test.threads.getThreadShell(threadId)).toBeNull();
        yield* runtime.close;
        unavailable = false;
        runtime = yield* test.boot(host);
        yield* Deferred.await(entered);
        const cancel = Effect.gen(function* () {
          const pending = yield* get(started.id);
          yield* runtime.invoke("cancel", {
            ...test.scope,
            runId: started.id,
            expectedRevision: pending.revision,
            clientRequestId: "cancel",
          });
          yield* runtime.invoke("reconcile", test.scope);
        });
        if (scenario === "cancel-inflight") {
          yield* cancel;
          expect(yield* test.threads.getThreadShell(threadId)).toBeNull();
        }
        yield* Deferred.succeed(released, undefined);
        yield* Deferred.await(finished);
        hold = false;
        yield* runtime.invoke("reconcile", test.scope);
        if (scenario === "cancel-committed") yield* cancel;
        yield* runtime.close;
        runtime = yield* test.boot(host);
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* get(started.id);
        const native = yield* test.core.inspect({ ...test.scope, threadId });
        expect(retained.state).toBe(scenario === "no-cancel" ? "running" : "canceled");
        expect(native.runs.map((run) => run.status)).toEqual(
          scenario === "no-cancel" ? ["preparing"] : ["interrupted"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

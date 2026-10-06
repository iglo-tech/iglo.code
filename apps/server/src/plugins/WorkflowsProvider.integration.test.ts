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
import { plugin } from "@t3tools/plugin-workflows/server";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
it.live.each([
  "unchanged",
  "unsupported-startup",
  "unavailable-startup",
  "unsupported-direct",
  "runtime-mode-startup",
  "unsupported-committed",
] as const)("validates reporting provider before admission: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const admitted = yield* Deferred.make<void>();
      const lostAck = scenario === "unsupported-committed";
      let outage = true;
      let supported = true;
      let available = true;
      let commits = 0;
      let modeAllowed = true;
      let bound: Host["Service"] = test.core;
      const selected = {
        ...plugin,
        acquire: Effect.gen(function* () {
          bound = yield* Host;
          return yield* plugin.acquire;
        }),
      };
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        providers: () =>
          test.core.providers().pipe(
            Effect.map((providers) =>
              providers.map((provider) => ({
                ...provider,
                runtimeModes: modeAllowed ? provider.runtimeModes : [],
                toolsSupported: supported,
                available: provider.instanceId === "codex" && available,
              })),
            ),
          ),
        launch: (input) =>
          Effect.gen(function* () {
            const retained = yield* test.core.receipt(input.commandId);
            if (retained) {
              if (outage && lostAck)
                return yield* new PluginError({
                  pluginId: "host",
                  code: "service",
                  operation: "launch",
                  message: "Committed launch acknowledgement lost",
                });
              return retained;
            }
            if (outage && !lostAck)
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Deterministic transport outage",
              });
            const receipt = yield* test.core.launch(input);
            yield* test.threads
              .dispatch({
                type: "message.dispatch",
                threadId: input.threadId!,
                commandId: CommandId.make(`${input.commandId}:deferred`),
                messageId: MessageId.make(`${input.commandId}:message`),
                text: input.instruction!,
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
            commits++;
            yield* Deferred.succeed(admitted, undefined);
            if (outage && lostAck)
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Committed launch acknowledgement lost",
              });
            return receipt;
          }),
      });
      let runtime = yield* test.boot(host, selected);
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
      const pending = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(pending.attempts[0]!.launch).not.toBeNull();
      if (lostAck) expect(yield* test.threads.getThreadShell(threadId)).not.toBeNull();
      else expect(yield* test.threads.getThreadShell(threadId)).toBeNull();
      if (!scenario.endsWith("direct")) yield* runtime.close;
      supported = !scenario.startsWith("unsupported");
      available = !scenario.startsWith("unavailable");
      modeAllowed = scenario !== "runtime-mode-startup";
      outage = false;
      if (!scenario.endsWith("direct")) {
        runtime = yield* test.boot(host, selected);
        const recovered = yield* runtime
          .invoke("get", { ...test.scope, runId: started.id })
          .pipe(Effect.flatMap(decodeRun));
        // A valid retained admission must finish replay before explicit reconciliation.
        // An invalid one must already have lost authority during plugin acquisition.
        if (recovered.state === "running") yield* Deferred.await(admitted);
      }
      yield* runtime.invoke("reconcile", test.scope);
      // Await the retained command's admission/rejection, including asynchronous startup replay.
      const receipt = yield* bound.launch(pending.attempts[0]!.launch!);
      const run = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      const thread = yield* test.threads.getThreadShell(threadId);
      if (scenario === "unchanged" || lostAck) {
        expect(thread).not.toBeNull();
        expect(receipt.status).toBe("accepted");
        expect(commits).toBe(1);
        expect((yield* test.core.inspect({ ...test.scope, threadId })).runs).toHaveLength(1);
      } else {
        expect(thread).toBeNull();
        expect(run.state).toBe("unresolved");
        expect(commits).toBe(0);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

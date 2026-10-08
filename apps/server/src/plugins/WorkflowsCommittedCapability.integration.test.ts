import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { EventId, RunId, MessageId, ProviderInstanceId, CommandId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import { sequence, completed } from "./Workflows.testkit.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const pair = Schema.encodeSync(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])));
it.live.each([
  "unchanged",
  "changed-skill",
  "disabled-provider",
  "changed-skill-acknowledged",
  "disabled-provider-acknowledged",
] as const)("reconciles accepted launch before revalidating changed capabilities: %s", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const fs = yield* FileSystem.FileSystem;
      const path = `${test.config.baseDir}/SKILL.md`;
      yield* fs.writeFileString(path, "# Native fixture skill\noriginal");
      let loseAck = !mode.endsWith("acknowledged"),
        observing = true,
        providerAvailable = true,
        creates = 0;
      let receiptUnavailable = false;
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        receipt: (id) =>
          receiptUnavailable
            ? Effect.fail(
                new PluginError({
                  pluginId: "host",
                  operation: "receipt",
                  code: "service",
                  message: "Receipt observation unavailable after lost acknowledgement",
                }),
              )
            : test.core.receipt(id),
        skills: () => Effect.succeed([{ name: "fixture-skill", path, enabled: true }]),
        providers: () =>
          test.core
            .providers()
            .pipe(
              Effect.map((ps) =>
                ps.map((p) => ({ ...p, available: providerAvailable && p.available === true })),
              ),
            ),
        launch: (input) =>
          Effect.gen(function* () {
            const previous = yield* test.core.receipt(input.commandId);
            const receipt = previous ?? (yield* test.core.launch(input));
            if (!previous) creates++;
            if (loseAck) {
              receiptUnavailable = true;
              return yield* new PluginError({
                pluginId: "host",
                operation: "launch",
                code: "service",
                message: "Lost accepted ACK",
              });
            }
            return receipt;
          }),
        inspect: (input) =>
          observing
            ? test.core.inspect(input)
            : Effect.fail(
                new PluginError({
                  pluginId: "host",
                  operation: "inspect",
                  code: "service",
                  message: "External observation unavailable",
                }),
              ),
      });
      let runtime = yield* test.boot(host);
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((n) =>
          n.kind === "agent" ? { ...n, skill: "fixture-skill" } : n,
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
      const threadId = started.attempts[0]!.threadId!;
      expect(yield* test.threads.getThreadShell(threadId)).not.toBeNull();
      const waiting = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(waiting.attempts[0]!.phase).toBe(
        mode.endsWith("acknowledged") ? "running" : "launching",
      );
      const commandId = CommandId.make(
        `plugin:${pair(["workflows", `${started.attempts[0]!.id}:launch:0`])}`,
      );
      expect((yield* test.core.receipt(commandId))?.status).toBe("accepted");
      observing = false;
      const tool = (yield* runtime.registry.tools).find(
        (t) => t.tool.id === "plugin_workflows_report",
      )!.tool;
      const receipt = yield* tool.invoke(completed, {
        ...test.scope,
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "external-fixture",
        runtimeMode: "approval-required",
      });
      yield* runtime.close;
      const at = DateTime.nowUnsafe(),
        runId = RunId.make("actual-external-completion");
      yield* test.sink.write({
        events: [
          {
            id: EventId.make("complete"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: at,
            payload: {
              id: runId,
              threadId,
              ordinal: 1,
              providerInstanceId: ProviderInstanceId.make("codex"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
              providerThreadId: null,
              userMessageId: MessageId.make("initial"),
              rootNodeId: null,
              activeAttemptId: null,
              status: "completed",
              requestedAt: at,
              startedAt: at,
              completedAt: at,
              checkpointId: null,
              contextHandoffId: null,
            },
          },
        ],
      });
      if (mode.startsWith("changed-skill"))
        yield* fs.writeFileString(
          path,
          "# Native fixture skill\nchanged after committed execution",
        );
      if (mode.startsWith("disabled-provider")) providerAvailable = false;
      loseAck = false;
      receiptUnavailable = false;
      observing = true;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const after = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      const native = yield* test.core.inspect({ ...test.scope, threadId });
      expect(native.outstandingWork).toEqual([]);
      expect(native.runs).toHaveLength(1);
      expect(after.attempts[0]!.report?.receipt).toEqual(receipt);
      expect(creates).toBe(1);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      const retained = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      const committed = yield* test.core.receipt(commandId);
      expect(committed?.status).toBe("accepted");
      expect(retained.state).toBe(after.state);
      expect(after.state).toBe("awaiting-review");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

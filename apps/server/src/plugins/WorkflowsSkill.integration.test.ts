import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, MessageId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
it.live.each([
  "unchanged",
  "changed-source",
  "changed-registration",
  "changed-source-direct",
  "disabled",
  "changed-source-ack-loss",
] as const)("validates skill before replaying retained launch: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const fs = yield* FileSystem.FileSystem;
      const original = `${test.config.baseDir}/SKILL.md`;
      let path = original;
      let enabled = true;
      yield* fs.writeFileString(original, "# Skill\nOriginal work");
      const launched = yield* Deferred.make<void>();
      const lostAck = scenario === "changed-source-ack-loss";
      let unavailable = true;
      let commits = 0;
      let committedId: CommandId | null = null;
      const acknowledgementLost = new PluginError({
        pluginId: "host",
        code: "service",
        operation: "launch",
        message: "Committed launch acknowledgment lost",
      });
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        receipt: (id) =>
          unavailable && lostAck && commits > 0
            ? Effect.fail(
                new PluginError({
                  pluginId: "host",
                  operation: "receipt",
                  code: "service",
                  message: "Receipt observation unavailable after lost acknowledgement",
                }),
              )
            : test.core.receipt(id),
        skills: () => Effect.sync(() => [{ name: "authored-skill", path, enabled }]),
        launch: (input) =>
          Effect.gen(function* () {
            const retained = yield* test.core.receipt(input.commandId);
            if (retained)
              return yield* unavailable && lostAck ? acknowledgementLost : Effect.succeed(retained);
            if (unavailable && !lostAck)
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Transient launch outage",
              });

            const receipt = yield* test.core.launch(input);
            committedId = input.commandId;
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
                      code: "service",
                      operation: "launch",
                      message: "Could not commit deferred fixture execution",
                      cause,
                    }),
                ),
              );
            commits++;
            yield* Deferred.succeed(launched, undefined);
            if (unavailable && lostAck) return yield* acknowledgementLost;
            return receipt;
          }),
      });
      let runtime = yield* test.boot(host);
      const definition = yield* decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent" ? { ...node, skill: "authored-skill" } : node,
        ),
      });
      const start = yield* runtime
        .invoke("start", {
          ...test.scope,
          clientRequestId: "start",
          definition,
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      if (lostAck) {
        yield* Deferred.await(launched);
        expect(yield* test.threads.getThreadShell(start.attempts[0]!.threadId!)).not.toBeNull();
        const pending = yield* runtime
          .invoke("get", { ...test.scope, runId: start.id })
          .pipe(Effect.flatMap(decodeRun));
        expect(pending.attempts[0]!.phase).toBe("launching");
      } else expect(yield* test.threads.getThreadShell(start.attempts[0]!.threadId!)).toBeNull();
      if (scenario !== "changed-source-direct") yield* runtime.close;
      if (scenario.startsWith("changed-source"))
        yield* fs.writeFileString(original, "# Skill\nDifferent work");
      if (scenario === "changed-registration") {
        path = `${test.config.baseDir}/NEW-SKILL.md`;
        yield* fs.writeFileString(path, "# Skill\nOriginal work");
      }
      if (scenario === "disabled") enabled = false;
      unavailable = false;
      if (scenario !== "changed-source-direct") {
        runtime = yield* test.boot(host);
        if (scenario === "unchanged") yield* Deferred.await(launched);
      }
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const run = yield* runtime
        .invoke("get", { ...test.scope, runId: start.id })
        .pipe(Effect.flatMap(decodeRun));
      const thread = yield* test.threads.getThreadShell(start.attempts[0]!.threadId!);
      if (scenario === "unchanged" || lostAck) {
        expect(thread).not.toBeNull();
        expect(commits).toBe(1);
        expect((yield* test.core.receipt(committedId!))?.status).toBe("accepted");
        expect(
          (yield* test.core.inspect({ ...test.scope, threadId: thread!.id })).runs,
        ).toHaveLength(1);
      } else {
        expect(thread).toBeNull();
        expect(run.state).toBe("unresolved");
        expect(run.reason).toContain("skill");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { Definition, Run } from "@t3tools/plugin-workflows/contracts";
import { parallel } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const gateFirst = {
  version: 1,
  id: "entry-gate",
  revision: 1,
  title: "Confirm before work",
  entry: "confirm",
  atLimit: "failed",
  nodes: [
    {
      id: "confirm",
      title: "Confirm",
      kind: "human",
      approve: { to: "work" },
      changes: { to: "failed" },
    },
    {
      id: "work",
      title: "Work",
      kind: "agent",
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "approval-required",
      instruction: "Work",
      report: { fields: [] },
      next: { to: "done" },
    },
    { id: "done", title: "Done", kind: "end", outcome: "completed" },
    { id: "failed", title: "Failed", kind: "end", outcome: "failed" },
  ],
};

it.live.each(["default-gate", "current-gate", "default-agent"] as const)(
  "retains the primary workspace through entry approval: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        let runtime = yield* test.boot();
        const get = (runId: string) =>
          runtime.invoke("get", { ...test.scope, runId }).pipe(Effect.flatMap(decodeRun));
        const definition = yield* decodeDefinition({
          ...gateFirst,
          entry: mode === "default-agent" ? "work" : "confirm",
        });
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            clientRequestId: "start",
            definition,
            input: {},
            ...(mode === "current-gate" ? { workspace: { type: "current" } } : {}),
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", test.scope);
        const before = yield* get(started.id);
        if (mode !== "default-agent") {
          expect(before.state).toBe("awaiting-review");
          yield* runtime.invoke("gate", {
            ...test.scope,
            runId: started.id,
            expectedRevision: before.revision,
            clientRequestId: "approve",
            decision: "approve",
          });
          yield* runtime.invoke("reconcile", test.scope);
        }
        yield* runtime.close;
        runtime = yield* test.boot();
        yield* runtime.invoke("reconcile", test.scope);
        const retained = yield* get(started.id);
        expect(retained.workspacePath).not.toBeNull();
        expect(retained.attempts[0]!.phase).toBe("running");
        const native = yield* test.core.inspect({
          ...test.scope,
          threadId: retained.attempts[0]!.threadId!,
        });
        expect(native.workspacePath).toBe(retained.workspacePath);
        if (mode !== "current-gate") expect(native.workspacePath).not.toBe(test.config.baseDir);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([
  "unchanged",
  "dirty-direct",
  "dirty-restart",
  "new-head-restart",
  "committed-dirty-restart",
] as const)("validates retained frozen reviewer input before execution: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        spawner.exitCode(ChildProcess.make("git", ["-C", cwd, ...args]));
      yield* fs.writeFileString(`${test.config.baseDir}/review-input.txt`, "frozen input\n");
      expect(yield* git(test.config.baseDir, ["add", "review-input.txt"])).toBe(0);
      expect(
        yield* git(test.config.baseDir, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "review input",
        ]),
      ).toBe(0);
      const frozen = yield* test.core.resolveRef(test.scope.projectId, "HEAD");
      const committed = scenario === "committed-dirty-restart";
      let unavailable = !committed;
      let loseAck = committed;
      let receiptUnavailable = false;
      const host = Host.of({
        ...test.core,
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
        verifyPullRequestHead: () => Effect.succeed({ head: frozen, branch: "feature" }),
        launch: (input) =>
          Effect.gen(function* () {
            if (unavailable)
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Transient launch outage",
              });
            const receipt = yield* test.core.launch(input);
            if (loseAck) {
              receiptUnavailable = true;
              return yield* new PluginError({
                pluginId: "host",
                code: "service",
                operation: "launch",
                message: "Lost core acknowledgement",
              });
            }
            return receipt;
          }),
      });
      let runtime = yield* test.boot(host);
      const get = (runId: string) =>
        runtime.invoke("get", { ...test.scope, runId }).pipe(Effect.flatMap(decodeRun));
      const definition = yield* decodeDefinition({
        ...parallel,
        nodes: parallel.nodes.map((node) =>
          node.kind === "parallel"
            ? { ...node, branches: [{ ...node.branches[0], skill: undefined }] }
            : node,
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
      const pending = (yield* get(started.id)).attempts[0]!;
      expect(pending.phase).toBe("launching");
      expect(pending.launch?.workspace.type).toBe("existing");
      if (pending.launch?.workspace.type !== "existing")
        return yield* Effect.die("Missing reviewer workspace");
      const workspace = pending.launch.workspace;
      const initialThread = yield* test.threads.getThreadShell(pending.threadId!);
      if (committed) expect(initialThread).not.toBeNull();
      else expect(initialThread).toBeNull();
      if (scenario !== "unchanged")
        yield* fs.writeFileString(
          `${workspace.path}/review-input.txt`,
          "changed before execution\n",
        );
      if (scenario === "new-head-restart") {
        expect(yield* git(workspace.path, ["add", "review-input.txt"])).toBe(0);
        expect(
          yield* git(workspace.path, [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "changed input",
          ]),
        ).toBe(0);
      }
      const evidence = yield* test.core.verifyWorkspace({
        projectId: test.scope.projectId,
        path: workspace.path,
      });
      expect(evidence.head === frozen && evidence.clean).toBe(scenario === "unchanged");
      if (scenario.endsWith("restart")) {
        yield* runtime.close;
        unavailable = false;
        loseAck = false;
        receiptUnavailable = false;
        runtime = yield* test.boot(host);
      } else unavailable = false;
      yield* runtime.invoke("reconcile", test.scope);
      const actual = yield* get(started.id);
      const runnable = scenario === "unchanged" || committed;
      expect(actual.attempts[0]!.phase).toBe(runnable ? "running" : "unresolved");
      const thread = yield* test.threads.getThreadShell(pending.threadId!);
      if (runnable) expect(thread?.worktreePath).toBe(workspace.path);
      else expect(thread).toBeNull();
      yield* runtime.close;
      runtime = yield* test.boot(host);
      yield* runtime.invoke("reconcile", test.scope);
      expect((yield* get(started.id)).attempts[0]!.phase).toBe(actual.attempts[0]!.phase);
      if (!runnable) expect(yield* test.threads.getThreadShell(pending.threadId!)).toBeNull();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

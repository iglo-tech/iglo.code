import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import { Run, Definition } from "@t3tools/plugin-workflows/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);

it.live.each([
  "expired-crash",
  "legacy-expired",
  "expired-before-restart",
  "expired-live",
  "expired-cleanup",
  "committed-crash",
  "pending-control",
] as const)("retains launch timeout authority across restart: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const committed = yield* Deferred.make<void>();
      let unavailable = true;
      let hold = ["expired-crash", "legacy-expired", "committed-crash"].includes(scenario);
      const coreCommitted = scenario === "committed-crash";
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        launch: (input) =>
          Effect.gen(function* () {
            if (!unavailable) return yield* test.core.launch(input);
            if (coreCommitted) yield* test.core.launch(input);
            return yield* new PluginError({
              pluginId: "host",
              code: "service",
              operation: "launch",
              message: "Transient launch outage",
            });
          }),
      });
      // Stop immediately after the durable timeout, before its cleanup effect can run.
      const crashBoundary: ServerPlugin = {
        ...plugin,
        acquire: Effect.gen(function* () {
          const storage = yield* Storage;
          const transaction = storage.sql.withTransaction;
          Object.assign(storage.sql, {
            withTransaction: <A, E, R>(action: Effect.Effect<A, E, R>) =>
              transaction(action).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (!hold) return;
                    const [row] = yield* storage.sql<{
                      data: string;
                    }>`SELECT data FROM workflow_runs WHERE state='unresolved' LIMIT 1`;
                    if (row && row.data.includes("The execution launch deadline expired.")) {
                      yield* Deferred.succeed(committed, undefined);
                      return yield* Effect.never;
                    }
                  }),
                ),
              ),
          });
          return yield* plugin.acquire;
        }),
      };
      let runtime = yield* test.boot(host, crashBoundary);
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
      if (coreCommitted) expect(yield* test.threads.getThreadShell(threadId)).not.toBeNull();
      else expect(yield* test.threads.getThreadShell(threadId)).toBeNull();
      if (scenario !== "pending-control") {
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          db.prepare(
            "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].lastActiveAt',0,'$.attempts[0].remainingMs',60000) WHERE id=?",
          ).run(started.id);
        } finally {
          db.close();
        }
        if (hold) {
          const running = yield* runtime.invoke("reconcile", test.scope).pipe(Effect.forkScoped);
          yield* Deferred.await(committed);
          yield* Fiber.interrupt(running);
        } else if (!["expired-before-restart", "expired-live"].includes(scenario)) {
          yield* runtime.invoke("reconcile", test.scope);
          yield* runtime.invoke("reconcile", test.scope);
        }
      }
      if (scenario !== "expired-live") yield* runtime.close;
      if (scenario === "legacy-expired") {
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          db.exec("DELETE FROM host_canceled_commands");
        } finally {
          db.close();
        }
      }
      hold = false;
      unavailable = false;
      if (scenario === "expired-live") yield* runtime.invoke("reconcile", test.scope);
      else runtime = yield* test.boot(host);
      const checkThread = Effect.gen(function* () {
        const thread = yield* test.threads.getThreadShell(threadId);
        if (scenario === "pending-control" || coreCommitted) expect(thread).not.toBeNull();
        else expect(thread).toBeNull();
      });
      yield* checkThread;
      yield* runtime.invoke("reconcile", test.scope);
      const state = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(state.state).toBe(scenario === "pending-control" ? "running" : "unresolved");
      yield* checkThread;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["healthy-stop", "outage-stop", "human-gate", "stopped-control"] as const)(
  "stops timed-out owned work before sequential continuation: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        let originalThread: ThreadId | null = null;
        const predecessorAtLaunch: string[] = [];
        let failed = scenario === "outage-stop";
        const host = Host.of({
          ...test.core,
          lifecycle: () => Stream.never,
          launch: (input) =>
            Effect.gen(function* () {
              if (input.title === "Recovery work") {
                const old = yield* test.core.inspect({ ...test.scope, threadId: originalThread! });
                predecessorAtLaunch.push(old.runs.at(-1)!.status);
              }
              const receipt = yield* test.core.launch(input);
              if (input.title === "Recovery work")
                yield* test.threads
                  .dispatch({
                    type: "message.dispatch",
                    threadId: input.threadId!,
                    commandId: CommandId.make("recovery-work"),
                    messageId: MessageId.make("recovery-message"),
                    text: "Recovery execution",
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
              return receipt;
            }),
          interrupt: (input) =>
            failed
              ? Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    code: "service",
                    operation: "interrupt",
                    message: "Transient interrupt outage",
                  }),
                )
              : test.core.interrupt(input),
        });
        let runtime = yield* test.boot(host);
        const get = (id: string) =>
          runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.flatMap(decodeRun));
        const definition = yield* decodeDefinition({
          ...sequence,
          nodes: [
            {
              ...sequence.nodes[0],
              timeoutMs: 60000,
              onUnresolved: { to: scenario === "human-gate" ? "review" : "recovery" },
            },
            { ...sequence.nodes[0], id: "recovery", title: "Recovery work" },
            ...sequence.nodes.slice(1),
          ],
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
        originalThread = started.attempts[0]!.threadId!;
        const target = { ...test.scope, threadId: originalThread };
        yield* test.threads.dispatch({
          type: "message.dispatch",
          threadId: originalThread,
          commandId: CommandId.make("work"),
          messageId: MessageId.make("message"),
          text: "Retained execution",
          attachments: [],
          dispatchMode: { type: "defer_start" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        expect((yield* test.core.inspect(target)).runs.at(-1)!.status).toBe("preparing");
        if (scenario === "stopped-control") {
          const old = yield* test.core.inspect(target);
          yield* test.core.interrupt({
            ...target,
            commandId: CommandId.make("pre-stopped"),
            runId: old.runs[0]!.id,
          });
        }
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          db.prepare(
            "UPDATE workflow_runs SET data=json_set(data,'$.attempts[0].lastActiveAt',0,'$.attempts[0].remainingMs',60000) WHERE id=?",
          ).run(started.id);
        } finally {
          db.close();
        }
        yield* runtime.invoke("reconcile", test.scope);
        yield* runtime.invoke("reconcile", test.scope);
        const current = yield* get(started.id);
        if (scenario === "human-gate") {
          expect(current.state).toBe("awaiting-review");
          expect(predecessorAtLaunch).toEqual([]);
        } else {
          const successor = current.attempts.find((attempt) => attempt.nodeId === "recovery")!;
          if (failed) {
            expect(predecessorAtLaunch).toEqual([]);
            expect(yield* test.threads.getThreadShell(successor.threadId!)).toBeNull();
            yield* runtime.close;
            runtime = yield* test.boot(host);
            yield* runtime.invoke("reconcile", test.scope);
            expect((yield* test.core.inspect(target)).runs.at(-1)!.status).toBe("preparing");
            expect(yield* test.threads.getThreadShell(successor.threadId!)).toBeNull();
            failed = false;
            yield* runtime.invoke("reconcile", test.scope);
            yield* runtime.invoke("reconcile", test.scope);
          }
          const api = yield* runtime.registry.api("plugins.workflows.subscribe");
          const updates = api.invoke(test.scope);
          if (!Stream.isStream(updates)) return yield* Effect.die("Expected subscription");
          yield* updates.pipe(
            Stream.mapEffect(() => get(started.id)),
            Stream.filter((run) =>
              run.attempts.some(
                (attempt) => attempt.id === successor.id && attempt.phase === "running",
              ),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          expect(predecessorAtLaunch).toEqual(["interrupted"]);
          const next = yield* test.core.inspect({ ...test.scope, threadId: successor.threadId! });
          expect(next.workspacePath).toBe((yield* test.core.inspect(target)).workspacePath);
          expect(next.runs.at(-1)!.status).toBe("preparing");
        }
        expect((yield* test.core.inspect(target)).runs.at(-1)!.status).toBe("interrupted");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

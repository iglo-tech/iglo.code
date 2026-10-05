import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, MessageId } from "@t3tools/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { Run } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeRun = Schema.decodeUnknownEffect(Run);

it.live.each([false, true])("retains failed interruption across cancel=%s and restart", (cancel) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      let failed = true;
      let interrupts = 0;
      const host = Host.of({
        ...test.core,
        interrupt: (input) =>
          Effect.suspend(() => {
            interrupts++;
            return failed
              ? Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    operation: "interrupt",
                    code: "service",
                    message: "Transient transport failure",
                  }),
                )
              : test.core.interrupt(input);
          }),
      });
      let runtime = yield* test.boot(host);
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
      yield* test.threads.dispatch({
        type: "message.dispatch",
        threadId,
        commandId: CommandId.make("retained-work"),
        messageId: MessageId.make("retained-input"),
        text: "Deferred execution",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const target = { ...test.scope, threadId };
      expect((yield* test.core.inspect(target)).runs.at(-1)!.status).toBe("preparing");
      const database = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        database
          .prepare(
            "UPDATE workflow_runs SET data = json_set(data, '$.attempts[0].lastActiveAt', 0, '$.attempts[0].remainingMs', 60000) WHERE id = ?",
          )
          .run(started.id);
      } finally {
        database.close();
      }
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const unresolved = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(unresolved.state).toBe("unresolved");
      expect(interrupts).toBeGreaterThan(0);
      if (cancel)
        yield* runtime.invoke("cancel", {
          ...test.scope,
          runId: started.id,
          expectedRevision: unresolved.revision,
          clientRequestId: "cancel",
        });
      yield* runtime.close;
      runtime = yield* test.boot(host);
      failed = false;
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      expect((yield* test.core.inspect(target)).runs.map((run) => run.status)).not.toContain(
        "preparing",
      );
      const retained = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(retained.state).toBe(cancel ? "canceled" : "unresolved");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])("recovers native ownership after restart, deleted=%s", (deleted) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      let runtime = yield* test.boot();
      const started = yield* runtime
        .invoke("start", {
          ...test.scope,
          clientRequestId: "start",
          definition: sequence,
          input: {},
          workspace: { type: "current" },
        })
        .pipe(Effect.flatMap(decodeRun));
      yield* runtime.invoke("reconcile", test.scope);
      const threadId = started.attempts[0]!.threadId!;
      const target = { ...test.scope, threadId };
      expect(yield* test.core.inspect(target)).toMatchObject({ threadId });
      if (deleted)
        yield* test.threads.dispatch({
          type: "thread.delete",
          threadId,
          commandId: CommandId.make("delete"),
        });
      const inspected = yield* test.core.inspect(target).pipe(Effect.result);
      yield* runtime.close;
      const database = new NodeSqlite.DatabaseSync(test.databasePath);
      try {
        database
          .prepare(
            "UPDATE workflow_runs SET data = json_set(data, '$.attempts[0].lastActiveAt', 0, '$.attempts[0].remainingMs', 60000) WHERE id = ?",
          )
          .run(started.id);
      } finally {
        database.close();
      }
      runtime = yield* test.boot();
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const actual = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(actual.state).toBe("unresolved");
      expect(actual.allowedActions).toContain("retry");
      if (deleted && inspected._tag === "Failure")
        expect(inspected.failure.code).toBe("unavailable");
      yield* runtime.invoke("retry", {
        ...test.scope,
        runId: actual.id,
        expectedRevision: actual.revision,
        clientRequestId: "fresh-thread",
      });
      yield* runtime.invoke("reconcile", test.scope);
      const api = yield* runtime.registry.api("plugins.workflows.subscribe");
      const updates = api.invoke(test.scope);
      if (!Stream.isStream(updates)) return yield* Effect.die("Expected subscription");
      const [retried] = yield* updates.pipe(
        Stream.mapEffect(() =>
          runtime
            .invoke("get", { ...test.scope, runId: actual.id })
            .pipe(Effect.flatMap(decodeRun)),
        ),
        Stream.filter((run) => run.attempts.at(-1)?.phase === "running"),
        Stream.take(1),
        Stream.runCollect,
      );
      if (!retried) return yield* Effect.die("Expected fresh running attempt");
      expect(retried.state).toBe("running");
      expect(retried.attempts.at(-1)!.threadId).not.toBe(threadId);
      expect(yield* test.threads.getThreadShell(retried.attempts.at(-1)!.threadId!)).not.toBeNull();
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each([false, true])("retains check settlement or ambiguity after SQL failure=%s", (fail) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const startedExecution = yield* Deferred.make<void>();
      const releasedExecution = yield* Deferred.make<void>();
      const failedSettlement = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      let executions = 0;
      const host = Host.of({
        ...test.core,
        execute: (input) =>
          Effect.gen(function* () {
            executions++;
            yield* Deferred.succeed(startedExecution, undefined);
            yield* Deferred.await(releasedExecution);
            const result = yield* test.core.execute(input);
            expect(result).toMatchObject({ exitCode: 0, timedOut: false });
            expect(result.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
            return result;
          }),
      });
      const observed: ServerPlugin = {
        ...plugin,
        acquire: Effect.gen(function* () {
          const storage = yield* Storage;
          const transaction = storage.sql.withTransaction;
          Object.assign(storage.sql, {
            withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              transaction(effect).pipe(
                Effect.onExit((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.withFiber((fiber) => Deferred.succeed(failedSettlement, fiber))
                    : Effect.void,
                ),
              ),
          });
          return yield* plugin.acquire;
        }),
      };
      const runtime = yield* test.boot(host, observed);
      const definition = {
        ...sequence,
        nodes: [
          {
            id: "implement",
            kind: "check",
            title: "Check",
            command: "git",
            args: ["rev-parse", "HEAD"],
            timeoutMs: 60_000,
            next: { to: "review" },
          },
          ...sequence.nodes.slice(1),
        ],
      };
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
      yield* Deferred.await(startedExecution);
      if (fail) {
        const database = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          database.exec(
            "CREATE TRIGGER fail_check_result BEFORE UPDATE ON workflow_runs WHEN json_extract(NEW.data, '$.attempts[0].check') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'lost check result'); END",
          );
        } finally {
          database.close();
        }
      }
      yield* Deferred.succeed(releasedExecution, undefined);
      if (fail) {
        const failedWorker = yield* Deferred.await(failedSettlement);
        yield* Fiber.await(failedWorker);
        const database = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          database.exec("DROP TRIGGER fail_check_result");
          database
            .prepare(
              "UPDATE workflow_runs SET data = json_set(data, '$.attempts[0].lastActiveAt', 0, '$.attempts[0].remainingMs', 60000) WHERE id = ?",
            )
            .run(started.id);
        } finally {
          database.close();
        }
      } else {
        const api = yield* runtime.registry.api("plugins.workflows.subscribe");
        const stream = api.invoke(test.scope);
        if (!Stream.isStream(stream)) return yield* Effect.die("Expected subscription");
        yield* stream.pipe(
          Stream.filter(
            (value) =>
              Array.isArray(value) &&
              value.some((run) => run.id === started.id && run.state === "awaiting-review"),
          ),
          Stream.take(1),
          Stream.runDrain,
        );
      }
      yield* runtime.invoke("reconcile", test.scope);
      yield* runtime.invoke("reconcile", test.scope);
      const actual = yield* runtime
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(actual.state).toBe(fail ? "unresolved" : "awaiting-review");
      if (fail) expect(actual.attempts[0]!.check).toMatchObject({ outcome: "unresolved" });
      else expect(actual.attempts[0]!.check).toMatchObject({ outcome: "completed", exitCode: 0 });
      expect(executions).toBe(1);
      yield* runtime.close;
      const restarted = yield* test.boot(host);
      yield* restarted.invoke("reconcile", test.scope);
      const retained = yield* restarted
        .invoke("get", { ...test.scope, runId: started.id })
        .pipe(Effect.flatMap(decodeRun));
      expect(retained.state).toBe(actual.state);
      expect(executions).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "canceled pending workflow host intent must not create a core thread on plugin restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const { core, scope, threads } = test;
        let blocked = true;
        const host = Host.of({
          ...core,
          launch: (input) =>
            blocked
              ? Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    operation: "launch",
                    code: "service",
                    message: "Crash before core launch commit",
                  }),
                )
              : core.launch({ ...input, instruction: undefined }),
        });
        const boot = () => test.boot(host);
        let runtime = yield* boot();
        const run = yield* runtime
          .invoke("start", {
            ...scope,
            clientRequestId: "cancel-recovery",
            definition: sequence,
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", scope);
        const query = () =>
          runtime.invoke("get", { ...scope, runId: run.id }).pipe(Effect.flatMap(decodeRun));
        const control = yield* runtime
          .invoke("start", {
            ...scope,
            clientRequestId: "recover-without-cancel",
            definition: sequence,
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.invoke("reconcile", scope);
        const current = yield* query();
        const threadId = current.attempts[0]!.threadId!;
        expect(yield* threads.getThreadShell(threadId)).toBeNull();
        yield* runtime.invoke("cancel", {
          ...scope,
          runId: run.id,
          expectedRevision: current.revision,
          clientRequestId: "cancel",
        });
        yield* runtime.invoke("reconcile", scope);
        yield* runtime.close;
        blocked = false;
        runtime = yield* boot();
        yield* runtime.invoke("reconcile", scope);
        const after = yield* query();
        const coreThread = yield* threads.getThreadShell(threadId);
        expect(after.state).toBe("canceled");
        expect(coreThread).toBeNull();
        const controlThread = control.attempts[0]!.threadId!;
        expect(yield* threads.getThreadShell(controlThread)).not.toBeNull();
        yield* runtime.close;
        runtime = yield* boot();
        yield* runtime.invoke("reconcile", scope);
        const shell = yield* threads.getShellSnapshot();
        expect(shell.threads.filter((thread) => thread.projectId === scope.projectId)).toHaveLength(
          1,
        );
        expect(yield* threads.getThreadShell(threadId)).toBeNull();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

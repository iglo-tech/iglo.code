import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  PluginError,
  type PluginCommandReceipt,
} from "@t3tools/plugin-host-contract/schema";
import { Host, Storage } from "@t3tools/plugin-host-contract/server";
import * as BoundHost from "./BoundHost.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const target = {
    environmentId: EnvironmentId.make("test"),
    projectId: ProjectId.make("project"),
    threadId: ThreadId.make("thread"),
  };
  const receipts = new Map<CommandId, PluginCommandReceipt>();
  const sent: CommandId[] = [];
  let blocked = true;
  let holdSend = false;
  const sendStarted = yield* Deferred.make<void>();
  const sendReleased = yield* Deferred.make<void>();
  const core = Layer.mock(Host)({
    environmentId: target.environmentId,
    receipt: (id) => Effect.succeed(receipts.get(id) ?? null),
    send: (input) =>
      Effect.gen(function* () {
        if (blocked)
          return yield* new PluginError({
            pluginId: "host",
            operation: "send",
            code: "service",
            message: "Core unavailable before commit",
          });
        const previous = receipts.get(input.commandId);
        if (previous) return previous;
        if (holdSend) {
          yield* Deferred.succeed(sendStarted, undefined);
          yield* Deferred.await(sendReleased);
        }
        const receipt: PluginCommandReceipt = {
          commandId: input.commandId,
          threadId: input.threadId,
          status: "accepted",
          cursor: sent.push(input.commandId),
          error: null,
        };
        receipts.set(input.commandId, receipt);
        return receipt;
      }),
  });
  const boot = BoundHost.make("owner").pipe(
    Effect.provide(core),
    Effect.provideService(Storage, { directory: ":memory:", sql }),
  );
  const input = (id: string) => ({
    ...target,
    commandId: CommandId.make(id),
    instruction: "Continue",
    mode: "auto" as const,
  });
  return {
    sql,
    target,
    sent,
    boot,
    input,
    unblock: () => (blocked = false),
    holdSend: () => (holdSend = true),
    sendStarted: Deferred.await(sendStarted),
    releaseSend: Deferred.succeed(sendReleased, undefined),
  };
});

it.effect(
  "cancels old pending sends while permitting a new resume identity on the same thread",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const first = yield* test.boot;
        expect((yield* first.service.send(test.input("old-send")).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* first.service.cancelPending(test.target);
        test.unblock();
        const restarted = yield* test.boot;
        yield* restarted.recover;
        expect(test.sent).toHaveLength(0);
        expect(yield* restarted.service.send(test.input("old-send"))).toMatchObject({
          status: "rejected",
        });
        expect(test.sent).toHaveLength(0);
        expect(yield* restarted.service.send(test.input("resume"))).toMatchObject({
          status: "accepted",
        });
        expect(test.sent).toEqual([CommandId.make('plugin:["owner","resume"]')]);
      }),
    ).pipe(Effect.provide(NodeSqlite.layer({ filename: ":memory:" }))),
);

it.effect("retains a core commit from a send already dispatched when its owner cancels", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const bound = yield* test.boot;
      yield* bound.service.send(test.input("pending")).pipe(Effect.result);
      test.unblock();
      test.holdSend();
      yield* test.sql`CREATE TRIGGER fail_ack BEFORE UPDATE OF result ON host_commands BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
      const recovery = yield* bound.recover.pipe(Effect.forkScoped);
      yield* test.sendStarted;
      yield* test.sql.withTransaction(bound.service.cancelPending(test.target));
      yield* test.releaseSend;
      yield* Fiber.join(recovery);
      yield* test.sql`DROP TRIGGER fail_ack`;
      const committed = yield* bound.service.receipt(CommandId.make("pending"));
      expect(committed).toMatchObject({ status: "accepted", threadId: test.target.threadId });
      expect(yield* bound.service.send(test.input("pending"))).toEqual(committed);
      yield* bound.recover;
      expect(test.sent).toEqual([CommandId.make('plugin:["owner","pending"]')]);
    }),
  ).pipe(Effect.provide(NodeSqlite.layer({ filename: ":memory:" }))),
);

it.effect("rolls back host cancellation together with its owner's failed transaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const first = yield* test.boot;
      yield* first.service.send(test.input("pending")).pipe(Effect.result);
      const rolledBack = yield* test.sql
        .withTransaction(
          first.service.cancelPending(test.target).pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.result);
      expect(rolledBack._tag).toBe("Failure");
      test.unblock();
      const restarted = yield* test.boot;
      yield* restarted.recover;
      expect(test.sent).toEqual([CommandId.make('plugin:["owner","pending"]')]);
      yield* restarted.recover;
      expect(test.sent).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeSqlite.layer({ filename: ":memory:" }))),
);

it.effect(
  "commits owner cancellation while background recovery waits for the private transaction",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const bound = yield* test.boot;
        yield* bound.service.send(test.input("pending")).pipe(Effect.result);
        test.unblock();
        const recoveryContext = yield* Effect.context();
        const recovery = yield* test.sql.withTransaction(
          Effect.gen(function* () {
            // Start recovery until it suspends on the connection held by this transaction.
            const fiber = yield* bound.recover.pipe(
              Effect.updateContext<never, never>(() => recoveryContext),
              Effect.forkChild({ startImmediately: true }),
            );
            yield* bound.service.cancelPending(test.target);
            return fiber;
          }),
        );
        yield* Fiber.join(recovery);
        expect(test.sent).toHaveLength(0);
        expect(yield* bound.service.send(test.input("pending"))).toMatchObject({
          status: "rejected",
        });
        expect(yield* bound.service.send(test.input("resume"))).toMatchObject({
          status: "accepted",
        });
        expect(test.sent).toEqual([CommandId.make('plugin:["owner","resume"]')]);
      }),
    ).pipe(Effect.provide(NodeSqlite.layer({ filename: ":memory:" }))),
);

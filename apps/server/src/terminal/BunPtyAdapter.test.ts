import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as BunPtyAdapter from "./BunPtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

const input = { shell: "/bin/sh", cwd: "/workspace", cols: 80, rows: 24, env: {} };

it.effect("retains startup output, decodes split UTF-8 and replays a settled exit", () =>
  Effect.gen(function* () {
    const exited = Promise.withResolvers<number>();
    const terminal = { write: () => 0, resize: () => {}, close: () => {} };
    let emit: ((data: Uint8Array) => void) | undefined;
    const runtime = {
      spawn: (
        _command: string[],
        options: {
          terminal: { data: (_terminal: typeof terminal, data: Uint8Array) => void };
        },
      ) => {
        emit = (data) => options.terminal.data(terminal, data);
        emit(new Uint8Array([115, 116, 97, 114, 116, 10, 0xe2]));
        return { pid: 42, terminal, exited: exited.promise, signalCode: null, kill: () => {} };
      },
    };
    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(BunPtyAdapter.BunPtyRuntime, runtime),
    );
    const child = yield* adapter.spawn(input);
    const output: string[] = [];
    const stop = child.onData((data) => output.push(data));
    emit?.(new Uint8Array([0x82, 0xac, 10]));
    assert.deepEqual(output, ["start\n", "€\n"]);
    stop();
    emit?.(new Uint8Array([65]));
    assert.deepEqual(output, ["start\n", "€\n"]);
    const done = Promise.withResolvers<PtyAdapter.PtyExitEvent>();
    child.onExit(done.resolve);
    exited.resolve(7);
    assert.deepEqual(yield* Effect.promise(() => done.promise), { exitCode: 7, signal: null });
    const late: PtyAdapter.PtyExitEvent[] = [];
    child.onExit((event) => late.push(event));
    assert.deepEqual(late, [{ exitCode: 7, signal: null }]);
  }),
);

it.effect("reports a native spawn failure through the PTY contract", () =>
  Effect.gen(function* () {
    const cause = new Error("No such executable");
    const adapter = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(BunPtyAdapter.BunPtyRuntime, {
        spawn: () => {
          throw cause;
        },
      }),
    );
    const result = yield* adapter.spawn(input).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, PtyAdapter.PtySpawnError);
      assert.equal(result.failure.shell, "/bin/sh");
      assert.equal(result.failure.cause, cause);
    }
  }),
);

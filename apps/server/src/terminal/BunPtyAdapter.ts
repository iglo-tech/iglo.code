// @effect-diagnostics nodeBuiltinImport:off -- POSIX signal numbers belong to the native PTY boundary.
import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PtyAdapter from "./PtyAdapter.ts";

interface BunTerminal {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunPtyRuntime {
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      terminal: {
        cols: number;
        rows: number;
        data(terminal: BunTerminal, data: Uint8Array): void;
      };
    },
  ): {
    pid: number;
    terminal: BunTerminal;
    exited: Promise<number>;
    signalCode: NodeJS.Signals | null;
    kill(signal: string): void;
  };
}

// Keep Bun's native API local instead of adding ambient Bun types to all server code.
declare const Bun: BunPtyRuntime;

export const BunPtyRuntime = Context.Reference<BunPtyRuntime>("server/terminal/BunPtyRuntime", {
  defaultValue: () => Bun,
});

/** node-pty's tty.ReadStream(fd) does not deliver PTY data under Bun 1.4.0. */
export const make = Effect.fn("BunPtyAdapter.make")(function* () {
  const bun = yield* BunPtyRuntime;
  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("BunPtyAdapter.spawn")((input) =>
      Effect.try({
        try: (): PtyAdapter.PtyProcess => {
          const decoder = new TextDecoder();
          const dataListeners = new Set<(data: string) => void>();
          const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
          let exitEvent: PtyAdapter.PtyExitEvent | undefined;
          let pending: string[] = [];
          let subscribed = false;
          const emit = (data: string) => {
            if (!data) return;
            if (!subscribed) pending.push(data);
            else for (const listener of dataListeners) listener(data);
          };
          const child = bun.spawn([input.shell, ...(input.args ?? [])], {
            cwd: input.cwd,
            env: { ...input.env, TERM: input.env.TERM ?? "xterm-256color" },
            terminal: {
              cols: input.cols,
              rows: input.rows,
              data: (_terminal, data) => emit(decoder.decode(data, { stream: true })),
            },
          });
          void child.exited.then((exitCode) => {
            emit(decoder.decode());
            child.terminal.close();
            const signal =
              child.signalCode === null ? null : NodeOS.constants.signals[child.signalCode];
            exitEvent = { exitCode: signal === null ? exitCode : 0, signal };
            for (const listener of exitListeners) listener(exitEvent);
            exitListeners.clear();
            dataListeners.clear();
          });
          return {
            pid: child.pid,
            write: (data) => {
              child.terminal.write(data);
            },
            resize: (cols, rows) => child.terminal.resize(cols, rows),
            kill: (signal = "SIGHUP") => child.kill(signal),
            onData: (callback) => {
              dataListeners.add(callback);
              subscribed = true;
              for (const data of pending) callback(data);
              pending = [];
              return () => {
                dataListeners.delete(callback);
              };
            },
            onExit: (callback) => {
              if (exitEvent) {
                callback(exitEvent);
                return () => {};
              }
              exitListeners.add(callback);
              return () => {
                exitListeners.delete(callback);
              };
            },
          };
        },
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({ adapter: "bun", shell: input.shell, cause }),
      }),
    ),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());

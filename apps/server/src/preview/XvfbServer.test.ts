// @effect-diagnostics nodeBuiltinImport:off - Stands in for the real Xvfb process.
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vite-plus/test";

import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { XvfbServer } from "./XvfbServer.ts";

interface FakeChild extends NodeChildProcess.ChildProcess {
  readonly killedSignals: Array<string>;
  readonly exit: (code: number) => void;
  readonly fail: (cause: Error) => void;
}

const fakeChild = (options: {
  readonly display?: string;
  readonly error?: Error;
  readonly exitCode?: number;
  readonly stderr?: string;
}): FakeChild => {
  const killedSignals: Array<string> = [];
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const on = (event: string, listener: (value?: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener]);
  };
  const emit = (event: string, value?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const stderr = options.stderr;
  const exitCode = options.exitCode;
  const error = options.error;
  const display = options.display;
  const child = {
    stdio: [
      null,
      null,
      null,
      {
        resume: () => undefined,
        pause: () => undefined,
        unref: () => undefined,
        once: (event: string, listener: (chunk: Buffer | string) => void) => {
          // The display pipe answers before any exit, as a healthy Xvfb does.
          if (event === "data" && display !== undefined) {
            queueMicrotask(() => listener(display));
          }
        },
      },
    ],
    stderr: {
      on: (event: "data", listener: (chunk: Uint8Array) => void) => {
        if (event === "data" && stderr !== undefined) listener(Buffer.from(stderr));
      },
      pause: () => undefined,
      unref: () => undefined,
    },
    once: on,
    on,
    kill: vi.fn((signal: string) => {
      killedSignals.push(signal);
      queueMicrotask(() => emit("exit", 0));
    }),
    unref: vi.fn(),
    exit: (code: number) => emit("exit", code),
    fail: (cause: Error) => emit("error", cause),
    killedSignals,
  } as unknown as FakeChild;
  if (error !== undefined) queueMicrotask(() => child.fail(error));
  else if (exitCode !== undefined) queueMicrotask(() => child.exit(exitCode));
  return child;
};

const makeServer = (options: {
  readonly display?: string;
  readonly error?: Error;
  readonly exitCode?: number;
  readonly stderr?: string;
}) => {
  const children: Array<FakeChild> = [];
  const spawn = vi.fn(() => {
    const child = fakeChild(options);
    children.push(child);
    return child as unknown as NodeChildProcess.ChildProcess;
  });
  const server = new XvfbServer({ setupCommand: "sudo iglo.code browser setup", spawn });
  return { server, children, spawn };
};

const displayError = async (promise: Promise<string>) => {
  const error = await promise.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PreviewBrowserHost.PreviewBrowserDisplayError);
  return error as PreviewBrowserHost.PreviewBrowserDisplayError;
};

describe("XvfbServer", () => {
  it("acquires one display for every caller", async () => {
    const { server, spawn } = makeServer({ display: "42\n" });
    expect(await Promise.all([server.acquire(), server.acquire()])).toEqual([":42", ":42"]);
    expect(spawn).toHaveBeenCalledOnce();
    await server.close();
  });

  it("names host setup when Xvfb is missing, and retries on the next caller", async () => {
    const { server, children, spawn } = makeServer({
      error: Object.assign(new Error("spawn Xvfb ENOENT"), { code: "ENOENT" }),
    });
    const missing = await displayError(server.acquire());
    expect(missing.message).toContain("no Xvfb");
    expect(missing.message).toContain("sudo iglo.code browser setup");
    // A failed start is not cached: the next caller tries again.
    await displayError(server.acquire());
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0]?.killedSignals).toContain("SIGKILL");
  });

  it("reports a failing Xvfb with its own output", async () => {
    const { server } = makeServer({ exitCode: 1, stderr: "cannot open display" });
    const failure = await displayError(server.acquire());
    expect(failure.message).toContain("cannot open display");
    expect(failure.message).toContain("sudo iglo.code browser setup");
  });

  it("closes the Xvfb it started", async () => {
    const { server, children } = makeServer({ display: "7\n" });
    await server.acquire();
    await server.close();
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(server.acquire()).rejects.toThrow("closed");
  });

  it("kills an Xvfb whose start finishes during shutdown", async () => {
    const { server, children } = makeServer({ display: "42\n" });
    const pending = server.acquire();
    await server.close();
    await expect(pending).rejects.toThrow("closed during startup");
    expect(children[0]?.killedSignals).toContain("SIGKILL");
  });

  it("starts a fresh Xvfb after one dies", async () => {
    const { server, children } = makeServer({ display: "42\n" });
    expect(await server.acquire()).toBe(":42");
    children[0]?.exit(1);
    expect(await server.acquire()).toBe(":42");
    expect(children).toHaveLength(2);
    await server.close();
  });
});

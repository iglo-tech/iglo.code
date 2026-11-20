// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns a host Xvfb outside the Effect runtime, like ServerBrowserContexts owns Playwright.
import * as NodeChildProcess from "node:child_process";

import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";

// The pane viewport is 1280x800 at scale 2; the window adds browser chrome around it.
const XVFB_ARGS = [
  "-displayfd",
  "3",
  "-noreset",
  "-nolisten",
  "tcp",
  "-screen",
  "0",
  "1920x1080x24",
] as const;

interface XvfbOptions {
  readonly setupCommand: string;
  /** Spawns `Xvfb`; a test seam, defaulting to `node:child_process` with a display pipe on fd 3. */
  readonly spawn?: (args: ReadonlyArray<string>) => NodeChildProcess.ChildProcess;
}

/**
 * One shared Xvfb for every browser launch, since one display serves all of them.
 * A failed start is not cached, so the next tab retries after host setup runs.
 */
export class XvfbServer {
  private readonly options: XvfbOptions;
  private display: Promise<string> | undefined;
  private child: NodeChildProcess.ChildProcess | undefined;
  private closed = false;

  constructor(options: XvfbOptions) {
    this.options = options;
  }

  acquire(): Promise<string> {
    if (this.closed) return Promise.reject(new Error("The Xvfb server is closed."));
    if (!this.display) {
      const started = this.start();
      this.display = started;
      started.catch(() => {
        if (this.display === started) this.display = undefined;
      });
    }
    return this.display;
  }

  close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.display = undefined;
    if (child === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => resolve();
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 2_000).unref();
    });
  }

  private async start(): Promise<string> {
    const spawn =
      this.options.spawn ??
      ((args: ReadonlyArray<string>) =>
        NodeChildProcess.spawn("Xvfb", args, { stdio: ["ignore", "ignore", "pipe", "pipe"] }));
    let child: NodeChildProcess.ChildProcess;
    try {
      child = spawn(XVFB_ARGS);
    } catch (cause) {
      throw displayError(this.options.setupCommand, cause);
    }
    const displayFd = child.stdio[3];
    if (!isReadable(displayFd)) {
      child.kill("SIGKILL");
      throw displayError(this.options.setupCommand, undefined);
    }
    const stderr: Array<Uint8Array> = [];
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (stderr.length < 16) stderr.push(chunk);
    });
    const failure = new Promise<never>((_, reject) => {
      child.once("error", (cause) => reject(cause));
      child.once("exit", (code) =>
        reject(new Error(`Xvfb exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`)),
      );
    });
    const number = await Promise.race([readDisplayNumber(displayFd), failure]).catch(
      (cause: unknown) => {
        child.kill("SIGKILL");
        throw displayError(this.options.setupCommand, cause);
      },
    );
    // The loser of the race rejects on a later Xvfb death; nobody waits on it anymore.
    failure.catch(() => undefined);
    if (this.closed) {
      // A close during startup has already forgotten this child; it must not outlive the server.
      child.kill("SIGKILL");
      throw new Error("The Xvfb server closed during startup.");
    }
    // The next Xvfb death frees the next launch to start it again.
    child.once("exit", () => {
      if (this.child === child) this.child = undefined;
      if (this.display !== undefined && !this.closed) this.display = undefined;
    });
    // Flowing pipes keep the server's loop alive; only the exit signal is wanted now.
    displayFd.pause();
    child.stderr?.pause();
    (displayFd as unknown as { unref(): void }).unref();
    child.unref();
    this.child = child;
    return `:${number}`;
  }
}

const displayError = (setupCommand: string, cause: unknown) => {
  const code = (cause as { readonly code?: unknown })?.code;
  const detail =
    code === "ENOENT"
      ? undefined
      : cause instanceof Error && cause.message.length > 0
        ? cause.message
        : cause !== undefined
          ? String(cause)
          : undefined;
  return new PreviewBrowserHost.PreviewBrowserDisplayError({ setupCommand, detail });
};

const readDisplayNumber = (fd: NodeJS.ReadableStream): Promise<number> =>
  new Promise((resolve, reject) => {
    fd.resume();
    fd.once("data", (chunk: Buffer | string) => {
      const number = Number.parseInt(String(chunk), 10);
      if (Number.isInteger(number) && number >= 0 && number < 1000) resolve(number);
      else reject(new Error("Xvfb reported no display number."));
    });
    fd.once("error", (cause: unknown) => reject(cause));
    fd.once("end", () => reject(new Error("Xvfb closed its display pipe.")));
  });

const isReadable = (fd: unknown): fd is NodeJS.ReadableStream =>
  typeof (fd as { readonly resume?: unknown })?.resume === "function";

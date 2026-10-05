// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Synchronous validation runs in an IPC child; the parent owns its watchdog.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

const decodeMessage = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("begin") }),
    Schema.Struct({
      type: Schema.Literal("result"),
      runnable: Schema.Boolean,
      reasons: Schema.Array(Schema.String),
    }),
  ]),
);

const validate = (count: number, valid: boolean) =>
  new Promise<{ timedOut: boolean; runnable: boolean | undefined }>((resolve, reject) => {
    const child = NodeChildProcess.fork(
      NodeURL.fileURLToPath(new URL("./WorkflowsValidation.worker.ts", import.meta.url)),
      [String(count), valid ? "valid" : "invalid"],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let runnable: boolean | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("message", (value: unknown) => {
      const message = decodeMessage(value);
      if (message.type === "begin") {
        // Bound synchronous validation in the process whose event loop it can block.
        deadline = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 3000);
      } else runnable = message.runnable;
    });
    child.on("error", reject);
    child.on("close", () => {
      if (deadline) clearTimeout(deadline);
      if (!timedOut && runnable === undefined) reject(new Error(stderr));
      else resolve({ timedOut, runnable });
    });
  });

it.each([
  { count: 10, valid: false },
  { count: 40, valid: true },
  { count: 40, valid: false },
])(
  "catalog validation returns for $count decisions, valid=$valid",
  async ({ count, valid }) => {
    const result = await validate(count, valid);
    expect(result.timedOut).toBe(false);
    expect(result.runnable).toBe(valid);
  },
  30_000,
);

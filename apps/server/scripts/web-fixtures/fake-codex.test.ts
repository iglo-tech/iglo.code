// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- External process deadline, never a domain polling delay.
// These fixtures are external subprocesses, rather than mocks of server services.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, test } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ServerNotification } from "effect-codex-app-server/schema";

const decodeNotification = Schema.decodeUnknownSync(ServerNotification);

test("the controlled provider streams until released and acknowledges cancellation", async () => {
  const control = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fake-codex-"));
  const child = NodeChildProcess.spawn(
    process.env.BUN_EXECUTABLE ?? "bun",
    [NodeURL.fileURLToPath(new URL("fake-codex.mjs", import.meta.url))],
    {
      env: { ...process.env, T3_FAKE_CONTROL: control, T3_FAKE_OWNER: "environment-a" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const messages: Array<Record<string, unknown>> = [];
  const waiting = new Set<() => void>();
  lines.on("line", (line) => {
    messages.push(JSON.parse(line));
    for (const notify of waiting) notify();
  });
  const until = (predicate: (message: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Missing protocol milestone: ${JSON.stringify(messages)}`)),
        5000,
      );
      const inspect = () => {
        const found = messages.find(predicate);
        if (!found) return;
        clearTimeout(timeout);
        waiting.delete(inspect);
        resolve(found);
      };
      waiting.add(inspect);
      inspect();
    });
  const send = (id: number, method: string, params = {}) =>
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  try {
    send(1, "initialize");
    expect((await until((message) => message.id === 1)).result).toMatchObject({
      userAgent: "t3-web-regression/1.0",
    });
    send(2, "thread/start");
    await until((message) => message.id === 2);
    send(3, "turn/start");
    expect(
      (await until((message) => message.method === "item/agentMessage/delta")).params,
    ).toMatchObject({ delta: "Streaming from environment-a\n\n" });
    expect(messages.some((message) => message.method === "turn/completed")).toBe(false);
    child.kill("SIGUSR1");
    expect((await until((message) => message.method === "turn/completed")).params).toMatchObject({
      turn: { status: "completed" },
    });
    for (const message of messages.filter((message) => message.method !== undefined)) {
      expect(() => decodeNotification(message)).not.toThrow();
    }
    messages.length = 0;
    send(4, "turn/start");
    await until((message) => message.method === "item/agentMessage/delta");
    send(5, "turn/interrupt");
    expect((await until((message) => message.method === "turn/completed")).params).toMatchObject({
      turn: { status: "interrupted" },
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
    lines.close();
    await NodeFSP.rm(control, { recursive: true, force: true });
  }
});

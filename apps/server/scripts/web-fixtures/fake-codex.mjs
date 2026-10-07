// External Codex app-server fixture. No credentials, network calls or server internals.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeCrypto from "node:crypto";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.145.0");
  process.exit(0);
}
if (process.argv.includes("--help")) process.exit(0);
const control = process.env.T3_FAKE_CONTROL;
const owner = process.env.T3_FAKE_OWNER ?? "fixture";
const captured = JSON.parse(
  NodeFS.readFileSync(
    process.env.T3_FAKE_CAPTURE ??
      new URL("../../src/provider/testFixtures/codexMultiAgentWire.json", import.meta.url),
    "utf8",
  ),
);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let threadId = NodeCrypto.randomUUID();
let cwd = process.cwd();
let active;
let sequence = 0;
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const turnEvent = (method, extra) =>
  notify(method, {
    threadId,
    turnId: active.turn.id,
    ...(method === "item/started" ? { startedAtMs: Date.now() } : {}),
    ...(method === "item/completed" ? { completedAtMs: Date.now() } : {}),
    ...extra,
  });
const complete = (status) => {
  if (!active) return;
  if (status === "completed") {
    turnEvent("item/agentMessage/delta", {
      itemId: active.message.id,
      delta: `Finished from ${owner}.`,
    });
    turnEvent("item/completed", {
      item: { ...active.message, text: `Streaming from ${owner}\n\nFinished from ${owner}.` },
    });
  }
  notify("turn/completed", {
    threadId,
    turn: { ...active.turn, status, completedAt: Math.floor(Date.now() / 1000) },
  });
  active = undefined;
};
process.on("SIGUSR1", () => complete("completed"));
const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  const reply = (result) => send({ id, result });
  if (method === "initialize")
    return reply({
      userAgent: "t3-web-regression/1.0",
      codexHome: control,
      platformFamily: "unix",
      platformOs: process.env.T3_FAKE_PLATFORM ?? "linux",
    });
  if (method === "account/read")
    return reply({
      account: process.env.T3_FAKE_AUTH === "signin" ? null : { type: "apiKey" },
      requiresOpenaiAuth: process.env.T3_FAKE_AUTH === "signin",
    });
  if (method === "account/login/start") {
    if (NodeFS.existsSync(`${control}/auth-error`))
      return send({ id, error: { code: -32000, message: "Controlled sign-in failure" } });
    return reply({
      type: "chatgpt",
      authUrl: "https://auth.fixture.invalid/authorize?fixture=web-regression",
      loginId: NodeCrypto.randomUUID(),
    });
  }
  if (method === "account/rateLimits/read")
    return send({ id, error: { code: -32000, message: "Fixture has no billing" } });
  if (method === "skills/list" || method === "model/list") return reply({ data: [] });
  if (method === "thread/start" || method === "thread/resume") {
    threadId = params.threadId ?? threadId;
    cwd = params.cwd ?? cwd;
    const template = captured.responses.threadStart;
    return reply({
      ...template,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      thread: { ...template.thread, id: threadId, sessionId: threadId, cwd },
    });
  }
  if (method === "turn/start") {
    sequence += 1;
    const turn = { ...captured.responses.turnStart.turn, id: NodeCrypto.randomUUID() };
    const message = {
      type: "agentMessage",
      id: `message-${sequence}`,
      text: "",
      phase: "final_answer",
      memoryCitation: null,
    };
    active = { turn, message };
    if (control)
      NodeFS.writeFileSync(
        `${control}/active-provider.json`,
        JSON.stringify({ pid: process.pid, owner }),
      );
    reply({ turn });
    notify("turn/started", { threadId, turn });
    turnEvent("item/started", { item: message });
    turnEvent("item/agentMessage/delta", {
      itemId: message.id,
      delta: `Streaming from ${owner}\n\n`,
    });
    const tool = {
      type: "commandExecution",
      id: `tool-${sequence}`,
      command: "printf fixture-tool",
      cwd,
      processId: "fixture-process",
      status: "completed",
      commandActions: [],
      aggregatedOutput: `fixture-tool in ${owner}`,
      exitCode: 0,
      durationMs: 1,
    };
    turnEvent("item/started", {
      item: {
        ...tool,
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    turnEvent("item/commandExecution/outputDelta", {
      itemId: tool.id,
      delta: `fixture-tool in ${owner}`,
    });
    turnEvent("item/completed", { item: tool });
    return;
  }
  if (method === "turn/interrupt") {
    reply({});
    complete("interrupted");
    return;
  }
  if (id !== undefined) reply({});
});
rl.on("close", () => {
  process.exit(0);
});

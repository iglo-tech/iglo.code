// External ACP authentication fixture. No credentials, browser launch or network calls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fixture-acp 1.0.0\n");
  process.exit(0);
}
const controlFlag = process.argv.indexOf("--control");
const control = controlFlag === -1 ? process.env.T3_FAKE_CONTROL : process.argv[controlFlag + 1];
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const lines = NodeReadline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  // The browser consent reply is deliberately not a completed sign-in. The test
  // cancels the pending login and the production runtime disposes this process.
  if (method === undefined || id === undefined) return;
  const reply = (result) => send({ id, result });
  const fail = (code, message) => send({ id, error: { code, message } });
  if (method === "initialize") {
    return reply({
      protocolVersion: 2,
      info: { name: "web-auth-fixture", version: "1.0.0" },
      capabilities: {},
      authMethods: [{ type: "agent", methodId: "browser", name: "Browser sign-in" }],
    });
  }
  if (method === "session/new") return fail(-32000, "Authentication required");
  if (method === "authenticate" || method === "auth/login") {
    if (params.methodId !== "browser") return fail(-32602, "Unknown authentication method");
    if (control && NodeFS.existsSync(NodePath.join(control, "auth-error"))) {
      return fail(-32603, "Controlled sign-in failure");
    }
    return send({
      id: "fixture-browser-consent",
      method: "elicitation/create",
      params: {
        requestId: String(id),
        mode: "url",
        elicitationId: "fixture-browser",
        message: "Sign in to the controlled provider",
        url: "https://auth.fixture.invalid/authorize?fixture=web-regression",
      },
    });
  }
  if (method === "logout" || method === "auth/logout") return reply({});
  return fail(-32601, `Unsupported fixture method: ${method}`);
});
lines.on("close", () => process.exit(0));

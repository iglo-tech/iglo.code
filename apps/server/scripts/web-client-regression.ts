// @effect-diagnostics nodeBuiltinImport:off
// Acceptance entry point: isolated processes and a real web client, outside Effect services.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { chromium, type Locator, type Page } from "playwright-core";
import {
  AuthPairingCredentialResult,
  AuthGrantScope,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2Command,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type TerminalAttachStreamEvent,
} from "@t3tools/contracts";
import {
  createEnvironmentFixture,
  redactEnvironmentLog,
  type EnvironmentFixture,
  type EnvironmentSmokeInput,
} from "../../../scripts/lib/environment-smoke.ts";
import {
  installBrowser,
  prepareWebDependencies,
  releaseProvider,
  type WebDependencies,
} from "./web-fixtures/prepare.ts";
import { requestRpc, withRegressionRpc, type RegressionRpcClient } from "./web-fixtures/rpc.ts";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
const visible = (locator: Locator) => locator.waitFor({ state: "visible", timeout: 30_000 });
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodePairingCredential = Schema.decodeUnknownSync(AuthPairingCredentialResult);
const providerId = ProviderInstanceId.make("codex");
const authProviderId = ProviderInstanceId.make("fixture_signin");

async function milestone(name: string, run: () => Promise<void>) {
  process.stdout.write(`${JSON.stringify({ case: name, status: "started" })}\n`);
  await run();
  process.stdout.write(`${JSON.stringify({ case: name, status: "passed" })}\n`);
}

async function pairingUrl(fixture: EnvironmentFixture) {
  const credential = decodePairingCredential(
    await (
      await fixture.request("/api/auth/pairing-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "web regression", scopes: AuthGrantScope.literals }),
      })
    ).json(),
  );
  const url = new URL("/pair", fixture.origin);
  url.searchParams.set("token", credential.credential);
  return url.href;
}

async function configure(fixture: EnvironmentFixture, dependencies: WebDependencies) {
  await fixture.pair();
  const descriptor = decodeDescriptor(
    await (await fixture.request("/.well-known/t3/environment")).json(),
  );
  const projectId = NodeCrypto.randomUUID();
  await fixture.request("/api/projects/mutate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: `Project ${dependencies.owner}`,
      workspaceRoot: fixture.workspace,
    }),
  });
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  await withRegressionRpc(fixture, async (client) => {
    const provider = (signin: boolean) => ({
      driver: ProviderDriverKind.make("codex"),
      displayName: signin ? "Fixture sign-in" : "Fixture Codex",
      enabled: true,
      config: {
        setupMode: "existing",
        enabled: true,
        binaryPath: dependencies.provider,
        customModels: ["gpt-5.6-sol"],
      },
      environment: [
        { name: "T3_FAKE_CONTROL", value: dependencies.control, sensitive: false },
        { name: "T3_FAKE_OWNER", value: dependencies.owner, sensitive: false },
        { name: "T3_FAKE_AUTH", value: signin ? "signin" : "ready", sensitive: false },
      ],
    });
    await requestRpc(
      client[WS_METHODS.serverUpdateSettings]({
        patch: {
          enableProviderUpdateChecks: false,
          defaultModelSelection: { instanceId: providerId, model: "gpt-5.6-sol" },
          providerInstances: { [providerId]: provider(false), [authProviderId]: provider(true) },
          responseStreamingMode: "paragraph",
          enableDeviceSupport: false,
          enableAgentDeviceAccess: false,
          deviceOnboardingCompleted: false,
        },
      }),
    );
    await requestRpc(
      client[WS_METHODS.serverRefreshProviders]({
        instanceId: providerId,
        cwd: fixture.workspace,
        fresh: true,
      }),
    );
    await requestRpc(
      client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
        decodeCommand({
          type: "thread.create",
          commandId: NodeCrypto.randomUUID(),
          threadId,
          projectId,
          title: `Thread ${dependencies.owner}`,
          modelSelection: { instanceId: providerId, model: "gpt-5.6-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        }),
      ),
    );
  });
  return { descriptor, threadId, projectId, route: `/${descriptor.environmentId}/${threadId}` };
}

async function sendMessage(page: Page, text: string) {
  const editor = page.getByTestId("composer-editor");
  await visible(editor);
  await editor.fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}

async function addSurface(page: Page, name: "Terminal" | "Browser" | "Device") {
  const add = page.getByRole("button", { name: "Add panel surface", exact: true });
  const launcher = page.getByLabel("Open a surface", { exact: true });
  if (!(await add.isVisible()) && !(await launcher.isVisible())) {
    await page.getByRole("button", { name: "Toggle right panel", exact: true }).click();
  }
  if (await add.isVisible()) {
    await add.click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  } else {
    await launcher.getByRole("button", { name, exact: true }).click();
  }
}

async function terminalMilestone(
  client: RegressionRpcClient,
  threadId: ThreadId,
  predicate: (event: TerminalAttachStreamEvent) => boolean,
) {
  const result = await requestRpc(
    client[WS_METHODS.terminalObserve]({ threadId, terminalId: "term-1" }).pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runHead,
    ),
  );
  NodeAssert.ok(Option.isSome(result), "The terminal stream must expose the requested milestone.");
  return result.value;
}

function terminalText(event: TerminalAttachStreamEvent) {
  return event.type === "snapshot"
    ? event.snapshot.history
    : event.type === "output"
      ? event.data
      : "";
}

/** Required behavior is asserted in every run; missing dependencies fail explicitly. */
export async function runWebClientRegression(
  input: EnvironmentSmokeInput,
  browserExecutable: string,
) {
  NodeAssert.ok(
    browserExecutable,
    "Set T3_WEB_REGRESSION_BROWSER to the pinned chrome-headless-shell executable before running the web regression suite.",
  );
  const artifacts =
    process.env.T3_WEB_REGRESSION_ARTIFACTS ??
    (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-web-regression-evidence-")));
  await NodeFSP.mkdir(artifacts, { recursive: true });
  const fixtures: Array<EnvironmentFixture> = [];
  let primaryDependencies: WebDependencies | undefined;
  let secondaryDependencies: WebDependencies | undefined;
  const website = NodeHttp.createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><title>Browser fixture ready</title><body style="margin:0;background:rgb(220,20,60);color:white"><h1>Browser fixture ready</h1><input aria-label="Fixture input"></body>',
    );
  });
  await new Promise<void>((resolve, reject) => {
    website.once("error", reject);
    website.listen(0, "127.0.0.1", resolve);
  });
  const address = website.address();
  NodeAssert.ok(address && typeof address !== "string");
  const websiteUrl = `http://127.0.0.1:${address.port}/`;
  const browser = await chromium
    .launch({
      executablePath: browserExecutable,
      headless: true,
      chromiumSandbox: false,
    })
    .catch(async (error: unknown) => {
      await new Promise<void>((resolve) => website.close(() => resolve()));
      throw error;
    });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // Network snapshots contain cookies and socket tickets. Keep only rendered
  // screenshots and action metadata, and pause even those around pairing input.
  let tracing = false;
  let traceIndex = 0;
  const startTrace = async () => {
    await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
    tracing = true;
  };
  const stopTrace = async () => {
    if (!tracing) return;
    await context.tracing.stop({ path: NodePath.join(artifacts, `trace-${++traceIndex}.zip`) });
    tracing = false;
  };
  const page = await context.newPage();
  const browserErrors: Array<string> = [];
  const consoleMessages: Array<string> = [];
  let failure: Error | undefined;
  let pairingActive = false;
  const redact = (text: string) =>
    redactEnvironmentLog(text).replace(/(wsTicket=)[^\s"'<>]+/g, "$1<redacted>");
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) =>
    consoleMessages.push(redact(`${message.type()}: ${message.text()}`)),
  );
  try {
    const primary = await createEnvironmentFixture(input, {
      prepare: async (paths) => {
        primaryDependencies = await prepareWebDependencies(
          paths,
          "environment-a",
          input.kind === "source"
            ? `${NodePath.join(input.repoRoot, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`
            : "",
        );
        return primaryDependencies.env;
      },
    });
    fixtures.push(primary);
    NodeAssert.ok(primaryDependencies);
    const dependencies = primaryDependencies;
    const seeded = await configure(primary, dependencies);
    const primaryPairing = await pairingUrl(primary);
    const secondary = await createEnvironmentFixture(input, {
      prepare: async (paths) => {
        secondaryDependencies = await prepareWebDependencies(
          paths,
          "environment-b",
          input.kind === "source"
            ? `${NodePath.join(input.repoRoot, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH ?? ""}`
            : "",
        );
        return { ...secondaryDependencies.env, T3CODE_DEV_ALLOWED_ORIGINS: primary.origin };
      },
    });
    fixtures.push(secondary);
    NodeAssert.ok(secondaryDependencies);
    const remoteDependencies = secondaryDependencies;
    const remote = await configure(secondary, remoteDependencies);
    NodeAssert.notEqual(primary.origin, secondary.origin);
    NodeAssert.notEqual(seeded.descriptor.environmentId, remote.descriptor.environmentId);

    await milestone("fresh browser pairing and reload persistence", async () => {
      pairingActive = true;
      const paired = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/auth/browser-session" &&
          response.request().method() === "POST",
      );
      await page.goto(primaryPairing);
      NodeAssert.equal((await paired).status(), 200);
      await page.goto(new URL(seeded.route, primary.origin).href);
      await visible(page.getByTestId("composer-editor"));
      pairingActive = false;
      NodeAssert.equal(
        new URL(page.url()).searchParams.has("token"),
        false,
        "Pairing credentials must leave the visible URL.",
      );
      await page.reload();
      await visible(page.getByTestId("composer-editor"));
      await visible(page.getByText("Project environment-a", { exact: true }).first());
      await visible(page.getByText("Thread environment-a", { exact: true }).first());
    });
    await startTrace();

    await milestone("streamed text, tool activity, completion and cancellation", async () => {
      await sendMessage(page, "Run the controlled streaming turn");
      await visible(page.getByText("Streaming from environment-a", { exact: true }));
      await visible(page.getByText("printf fixture-tool", { exact: false }).first());
      await visible(page.getByRole("button", { name: "Stop generation", exact: true }));
      await releaseProvider(dependencies);
      await visible(page.getByText("Finished from environment-a.", { exact: true }));
      await page
        .getByRole("button", { name: "Stop generation", exact: true })
        .waitFor({ state: "hidden" });
      await sendMessage(page, "Cancel this controlled turn");
      await visible(page.getByText("Streaming from environment-a", { exact: true }).nth(1));
      await visible(page.getByRole("button", { name: "Stop generation", exact: true }));
      await page.getByRole("button", { name: "Stop generation", exact: true }).click();
      await page
        .getByRole("button", { name: "Stop generation", exact: true })
        .waitFor({ state: "hidden" });
      const row = page.getByTestId("sidebar-row-card").filter({ hasText: "Thread environment-a" });
      await row.hover();
      await row.getByRole("button", { name: "Settle thread", exact: true }).click();
      await visible(page.getByRole("button", { name: "Un-settle thread", exact: true }).first());
      await page.getByRole("button", { name: "Un-settle thread", exact: true }).first().click();
    });

    await milestone("terminal input, output, resize, error and exit", async () => {
      await addSurface(page, "Terminal");
      const inputField = page.getByLabel("Terminal input").first();
      await visible(inputField);
      await withRegressionRpc(primary, async (client) => {
        await inputField.pressSequentially("printf 'terminal-io-fixture\\n'");
        await inputField.press("Enter");
        await terminalMilestone(client, seeded.threadId, (event) =>
          /\r?\nterminal-io-fixture\r?\n/.test(terminalText(event)),
        );
        await page.setViewportSize({ width: 1280, height: 900 });
        await requestRpc(
          client[WS_METHODS.terminalResize]({
            threadId: seeded.threadId,
            terminalId: "term-1",
            cols: 91,
            rows: 27,
          }),
        );
        await inputField.pressSequentially("/bin/stty size");
        await inputField.press("Enter");
        await terminalMilestone(client, seeded.threadId, (event) =>
          /27\s+91/.test(terminalText(event)),
        );
        await inputField.pressSequentially("printf 'terminal-error-fixture\\n' >&2; exit 7");
        await inputField.press("Enter");
        const exited = await terminalMilestone(
          client,
          seeded.threadId,
          (event) =>
            event.type === "exited" ||
            (event.type === "snapshot" && event.snapshot.status === "exited"),
        );
        NodeAssert.equal(
          exited.type === "snapshot"
            ? exited.snapshot.exitCode
            : exited.type === "exited"
              ? exited.exitCode
              : null,
          7,
        );
        const snapshot = await terminalMilestone(
          client,
          seeded.threadId,
          (event) => event.type === "snapshot",
        );
        NodeAssert.match(terminalText(snapshot), /\r?\nterminal-error-fixture\r?\n/);
        const writeAfterExit = await Effect.runPromiseExit(
          client[WS_METHODS.terminalWrite]({
            threadId: seeded.threadId,
            terminalId: "term-1",
            data: "should fail\r",
          }),
        );
        NodeAssert.equal(
          writeAfterExit._tag,
          "Failure",
          "A write to an exited terminal must report an error.",
        );
      });
      await page.screenshot({ path: NodePath.join(artifacts, "terminal-exited.png") });
    });

    await milestone("settings persist and controlled provider sign-in URL/error", async () => {
      await page.goto(new URL("/settings/general", primary.origin).href);
      const updateChecks = page.getByRole("switch", {
        name: "Check provider versions",
        exact: true,
      });
      await visible(updateChecks);
      await updateChecks.click();
      await page.reload();
      NodeAssert.equal(await updateChecks.getAttribute("aria-checked"), "true");
      await updateChecks.click();
      await page.goto(new URL("/settings/providers", primary.origin).href);
      await visible(page.getByText("Fixture sign-in", { exact: true }));
      await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
      await visible(page.getByRole("button", { name: "Copy sign-in link", exact: true }));
      await page.getByRole("button", { name: "Copy sign-in link", exact: true }).click();
      NodeAssert.match(
        await page.evaluate<string>("navigator.clipboard.readText()"),
        /^https:\/\/auth\.fixture\.invalid\/authorize\?/,
      );
      await withRegressionRpc(primary, async (client) => {
        const state = await requestRpc(
          client[WS_METHODS.providerAuthStart]({ instanceId: authProviderId }),
        );
        NodeAssert.ok(state.flowId);
        await requestRpc(
          client[WS_METHODS.providerAuthCancel]({
            instanceId: authProviderId,
            flowId: state.flowId,
          }),
        );
      });
      await NodeFSP.writeFile(NodePath.join(dependencies.control, "auth-error"), "fail");
      await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
      await visible(page.getByText("Controlled sign-in failure", { exact: false }).first());
      await NodeFSP.rm(NodePath.join(dependencies.control, "auth-error"));
    });

    await milestone("Browser unavailable state", async () => {
      await page.goto(new URL(seeded.route, primary.origin).href);
      await addSurface(page, "Browser");
      const url = page.getByPlaceholder("Search or enter URL").first();
      await url.fill(websiteUrl);
      await url.press("Enter");
      await visible(page.getByRole("button", { name: "Try again", exact: true }).first());
      await page.screenshot({ path: NodePath.join(artifacts, "browser-unavailable.png") });
    });

    await installBrowser(dependencies, browserExecutable);
    await milestone("disconnect, server restart, reconnect and history deduplication", async () => {
      await primary.stop();
      await visible(page.getByText(/Disconnected|Reconnecting|Connecting|offline/i).first());
      await primary.restart();
      await visible(page.getByTestId("composer-editor"));
      NodeAssert.equal(
        await page.getByText("Finished from environment-a.", { exact: true }).count(),
        1,
      );
      NodeAssert.equal(
        await page.getByText("Run the controlled streaming turn", { exact: true }).count(),
        1,
      );
      await page.reload();
      await visible(page.getByTestId("composer-editor"));
      NodeAssert.equal(
        await page.getByText("Finished from environment-a.", { exact: true }).count(),
        1,
      );
    });

    await milestone("Browser ready frame and navigation error", async () => {
      const url = page.getByPlaceholder("Search or enter URL").first();
      await visible(url);
      await url.fill(websiteUrl);
      await url.press("Enter");
      await visible(page.getByLabel("Browser page", { exact: true }));
      // Inspect the rendered public canvas: the fixture site has a known red background.
      await page.waitForFunction(`() => {
        const canvas = document.querySelector('canvas[aria-label="Browser page"]');
        if (!canvas || !canvas.width || !canvas.height) return false;
        const rgba = canvas
          .getContext("2d")
          ?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return rgba?.[0] === 220 && rgba[1] === 20 && rgba[2] === 60;
      }`);
      await page.screenshot({ path: NodePath.join(artifacts, "browser-ready.png") });
      await url.fill("http://127.0.0.1:1/");
      await url.press("Enter");
      await visible(page.getByText("This site can't be reached", { exact: true }));
    });

    await milestone("Device unavailable, ready inventory and controlled error", async () => {
      await addSurface(page, "Device");
      await visible(page.getByRole("switch", { name: "Enable device hub", exact: true }));
      NodeAssert.equal(
        await page
          .getByRole("switch", { name: "Enable device hub", exact: true })
          .getAttribute("aria-checked"),
        "false",
      );
      await page.getByRole("switch", { name: "Enable device hub", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await visible(page.getByRole("button", { name: "Start Fixture Android", exact: true }));
      await page.getByRole("button", { name: "Start Fixture Android", exact: true }).click();
      await visible(
        page.getByRole("alert").filter({ hasText: "Device fixture-emulator failed to boot" }),
      );
      await page.getByRole("button", { name: "Dismiss device error", exact: true }).click();
      await withRegressionRpc(primary, async (client) => {
        const state = await requestRpc(client[WS_METHODS.deviceList]({}));
        NodeAssert.equal(
          state.agentAccessEnabled,
          false,
          "Manual device testing must leave agent access disabled.",
        );
      });
      await page.screenshot({ path: NodePath.join(artifacts, "device-ready.png") });
    });

    await milestone("distinct origin and multiple environment destination ownership", async () => {
      await stopTrace();
      pairingActive = true;
      const remotePairing = await pairingUrl(secondary);
      await page.goto(new URL("/settings/connections", primary.origin).href);
      await page.getByRole("button", { name: "Add environment", exact: true }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Host", { exact: true }).fill(remotePairing);
      await dialog.getByRole("button", { name: "Add environment", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      pairingActive = false;
      await startTrace();
      await page.goto(new URL(remote.route, primary.origin).href);
      await visible(page.getByText("Project environment-b", { exact: true }).first());
      await sendMessage(page, "Execute only in environment-b");
      await visible(page.getByText("Streaming from environment-b", { exact: true }));
      await releaseProvider(remoteDependencies);
      await visible(page.getByText("Finished from environment-b.", { exact: true }));
      const localHistory = await (
        await primary.request(`/api/orchestration/threads/${seeded.threadId}`)
      ).text();
      NodeAssert.doesNotMatch(
        localHistory,
        /Execute only in environment-b|Streaming from environment-b/,
      );
      const remoteHistory = await (
        await secondary.request(`/api/orchestration/threads/${remote.threadId}`)
      ).text();
      NodeAssert.match(remoteHistory, /Execute only in environment-b/);
      const remoteContext = await browser.newContext();
      try {
        const remotePage = await remoteContext.newPage();
        const paired = remotePage.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/auth/browser-session" &&
            response.request().method() === "POST",
        );
        await remotePage.goto(await pairingUrl(secondary));
        NodeAssert.equal((await paired).status(), 200);
        await remotePage.goto(new URL(remote.route, secondary.origin).href);
        await visible(remotePage.getByText("Finished from environment-b.", { exact: true }));
        NodeAssert.equal(new URL(remotePage.url()).origin, secondary.origin);
      } finally {
        await remoteContext.close();
      }
    });
    NodeAssert.deepEqual(
      browserErrors,
      [],
      "The real client must not throw unhandled page errors.",
    );
  } catch (error) {
    if (!pairingActive)
      await page
        .screenshot({ path: NodePath.join(artifacts, "failure.png") })
        .catch(() => undefined);
    await NodeFSP.writeFile(NodePath.join(artifacts, "browser.log"), consoleMessages.join("\n"));
    await NodeFSP.writeFile(
      NodePath.join(artifacts, "server.log"),
      fixtures.map((fixture) => fixture.log).join("\n"),
    );
    process.stderr.write(`Web regression failed; evidence: ${artifacts}\n`);
    failure = new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    const cleanup = await Promise.allSettled([
      (async () => {
        try {
          await stopTrace();
        } finally {
          await browser.close();
        }
      })(),
      new Promise<void>((resolve, reject) =>
        website.close((error) => (error ? reject(error) : resolve())),
      ),
      ...fixtures.map((fixture) => fixture.dispose()),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected" && failure === undefined) {
        failure = new Error(`Acceptance fixture cleanup failed: ${redact(String(result.reason))}`);
      }
    }
  }
  if (failure !== undefined) throw failure;
  process.stdout.write(`${JSON.stringify({ status: "passed", artifacts })}\n`);
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [mode, archive, expectVersion] = process.argv.slice(2);
  NodeAssert.ok(
    mode === "source" || (mode === "archive" && archive && expectVersion),
    "Usage: bun apps/server/scripts/web-client-regression.ts source | archive <tar.gz> <version>",
  );
  const input: EnvironmentSmokeInput =
    mode === "source"
      ? { kind: "source", repoRoot, bun: process.execPath }
      : { kind: "archive", archive: NodePath.resolve(archive!), expectVersion: expectVersion! };
  await runWebClientRegression(input, process.env.T3_WEB_REGRESSION_BROWSER ?? "");
}

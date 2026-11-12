/**
 * Every ACP agent spawns `iglo.code acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `iglo.code acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * They and Codex's managed-token helper dispatch before the full CLI module graph (seconds
 * of evaluation) loads; everything else defers to the real CLI in ./binCli.ts.
 */
import { BUN_VERSION, isSupportedBunVersion } from "@t3tools/shared/bunRuntime";
import { isEntrypoint } from "./entrypoint.ts";

function ignoreOutputError(): void {}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  if (!isSupportedBunVersion(process.versions.bun)) {
    process.stderr.write(
      `iglo.code requires Bun ${BUN_VERSION} or newer. Run this CLI with Bun.\n`,
    );
    process.exit(1);
  }
  // Logs go to stdout and stderr, which may be a closed launcher pipe or a log file on a full
  // disk. A failed write surfaces as an unhandled stream error that crashes the process and
  // skips shutdown, so drop the line instead.
  process.stdout.on("error", ignoreOutputError);
  process.stderr.on("error", ignoreOutputError);

  const command = process.argv[2];
  // The launcher owns shutdown until its child exits, so it bypasses the Effect CLI runtime.
  // A service unit passes nothing or the launcher's own flags; help and anything else go
  // through the full CLI.
  const launcher =
    command === "__service-launcher" ? await import("./cli/serviceLauncher.ts") : undefined;
  const launcherOptions = launcher?.parseServiceLauncherArgs(process.argv.slice(3));
  if (launcher !== undefined && launcherOptions !== undefined) {
    await launcher.runServiceLauncherCli(launcherOptions);
  } else {
    await runCliCommand(command);
  }
}

async function runCliCommand(command: string | undefined) {
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else if (command === "__speech-worker") {
    const mode = process.argv[3];
    if (mode !== "discover" && mode !== "model") throw new Error("Unknown speech worker mode.");
    const { runNativeSpeechWorker } = await import("./speech/native.ts");
    await runNativeSpeechWorker(mode, process.argv[4]);
  } else {
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.IGLO_CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}

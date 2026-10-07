// @effect-diagnostics nodeBuiltinImport:off
// Disposable dependency installations are an external acceptance fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { previewBrowserRelease } from "../../src/preview/PreviewBrowser.ts";
import { DEVICE_HUB_VERSION } from "../../src/device/DeviceToolchain.ts";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function prepareWebDependencies(
  paths: {
    scratch: string;
    home: string;
    workspace: string;
    interpreter: string;
  },
  owner: string,
  inheritedPath: string,
) {
  const control = NodePath.join(paths.scratch, "provider-control");
  const bin = NodePath.join(paths.scratch, "bin");
  await NodeFSP.mkdir(control);
  await NodeFSP.mkdir(bin);
  const provider = NodePath.join(bin, "codex");
  await NodeFSP.writeFile(
    provider,
    `#!/bin/sh\nexec ${shellQuote(paths.interpreter)} ${shellQuote(NodePath.join(here, "fake-codex.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  // Never inspect the operator's actual Apple devices during an acceptance run.
  await NodeFSP.writeFile(NodePath.join(bin, "xcrun"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // Git is an independently documented prerequisite, not a JavaScript runtime.
  const git = process.env.T3_WEB_REGRESSION_GIT ?? "/usr/bin/git";
  await NodeFSP.symlink(git, NodePath.join(bin, "git"));
  const sdk = NodePath.join(paths.scratch, "android-sdk");
  await NodeFSP.mkdir(NodePath.join(sdk, "platform-tools"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(sdk, "emulator"));
  await NodeFSP.writeFile(
    NodePath.join(sdk, "platform-tools", "adb"),
    "#!/bin/sh\nprintf 'List of devices attached\\n'\n",
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(
    NodePath.join(sdk, "emulator", "emulator"),
    "#!/bin/sh\nprintf 'fixture-emulator\\n'\n",
    { mode: 0o755 },
  );
  const hub = NodePath.join(paths.home, "tools", "expo-device-hub", DEVICE_HUB_VERSION);
  const entry = NodePath.join(hub, "node_modules", "expo-device-hub", "dist", "server", "cli.mjs");
  await NodeFSP.mkdir(NodePath.dirname(entry), { recursive: true });
  await NodeFSP.copyFile(NodePath.join(here, "device-hub.mjs"), entry);
  await NodeFSP.writeFile(NodePath.join(hub, ".install-complete"), `${DEVICE_HUB_VERSION}\n`);
  const deviceMode = NodePath.join(paths.scratch, "device-mode");
  await NodeFSP.writeFile(deviceMode, "ready");
  const platform = HostProcessPlatform.defaultValue();
  const release = previewBrowserRelease(platform, HostProcessArchitecture.defaultValue());
  NodeAssert.ok(release, "This acceptance runner needs a supported Chromium platform.");
  const browserRoot = NodePath.join(
    paths.home,
    "tools",
    "chrome-headless-shell",
    release.platform,
    release.version,
  );
  await NodeFSP.mkdir(browserRoot, { recursive: true });
  const browserExecutable = NodePath.join(
    browserRoot,
    platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
  );
  // A complete but failing local installation exercises the real unavailable UI,
  // without relying on internet access or a download failure.
  await NodeFSP.writeFile(
    browserExecutable,
    "#!/bin/sh\nprintf 'No usable sandbox! Controlled browser launch failure\\n' >&2\nexit 70\n",
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(NodePath.join(paths.workspace, "environment-owner.txt"), owner);
  NodeChildProcess.execFileSync(git, ["init", "--initial-branch=main", paths.workspace], {
    stdio: "pipe",
  });
  NodeChildProcess.execFileSync(git, [
    "-C",
    paths.workspace,
    "config",
    "user.name",
    "Web regression fixture",
  ]);
  NodeChildProcess.execFileSync(git, [
    "-C",
    paths.workspace,
    "config",
    "user.email",
    "fixture@example.invalid",
  ]);
  NodeChildProcess.execFileSync(git, ["-C", paths.workspace, "add", "environment-owner.txt"]);
  NodeChildProcess.execFileSync(
    git,
    ["-C", paths.workspace, "commit", "--message=Initialize regression workspace"],
    { stdio: "pipe" },
  );
  return {
    env: {
      PATH: `${bin}${inheritedPath ? `${NodePath.delimiter}${inheritedPath}` : ""}`,
      SHELL: "/bin/sh",
      T3_BUN_EXECUTABLE: paths.interpreter,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      T3_FAKE_DEVICE_MODE: deviceMode,
      T3CODE_SERVER_BROWSER_SANDBOX: "0",
      // This is solely the fixture's provider configuration, not application state.
      T3_WEB_FIXTURE_BIN: bin,
    },
    provider,
    control,
    owner,
    bin,
    browserRoot,
    browserExecutable,
    deviceMode,
  };
}

export type WebDependencies = Awaited<ReturnType<typeof prepareWebDependencies>>;

export async function releaseProvider(dependencies: WebDependencies) {
  const record: unknown = JSON.parse(
    await NodeFSP.readFile(NodePath.join(dependencies.control, "active-provider.json"), "utf8"),
  );
  NodeAssert.ok(
    typeof record === "object" &&
      record !== null &&
      "owner" in record &&
      record.owner === dependencies.owner &&
      "pid" in record &&
      typeof record.pid === "number",
  );
  // The PID was recorded by the fixture child at its stream-start milestone.
  process.kill(record.pid, "SIGUSR1");
}

export async function installBrowser(dependencies: WebDependencies, executable: string) {
  NodeAssert.ok(
    NodePath.isAbsolute(executable),
    "T3_WEB_REGRESSION_BROWSER must be an absolute chrome-headless-shell NodePath.",
  );
  await NodeFSP.rm(dependencies.browserRoot, { recursive: true, force: true });
  await NodeFSP.cp(NodePath.dirname(executable), dependencies.browserRoot, { recursive: true });
  NodeAssert.ok((await NodeFSP.stat(dependencies.browserExecutable)).isFile());
}

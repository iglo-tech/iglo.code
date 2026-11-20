import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export const SETUP_SUBCOMMAND = "browser setup";

export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.IGLO_CODE_SERVER_BROWSER_SANDBOX === "0";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome";
/** The pre-full-Chrome profile; setup unloads and removes it. */
export const LEGACY_APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome-headless-shell";

/** Attaches to the Chrome binaries under `tools/chrome/<platform>/<version>/`; covers the crashpad helper too. */
export const APPARMOR_PROFILE = `# Written by \`iglo.code browser setup\`: lets T3 Code's browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome /**/tools/chrome/*/*/chrome* flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome>
}
`;

/** Ubuntu 24.04 and Debian 13 use some t64 library names; choose names available through apt. */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libnspr4"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libcups2t64", "libcups2"],
  ["libdrm2"],
  ["libx11-6"],
  ["libx11-xcb1"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libxshmfence1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
  ["libgtk-3-0t64", "libgtk-3-0"],
  ["libpango-1.0-0t64", "libpango-1.0-0"],
  ["libcairo2"],
];

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries T3's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

/** The browser runs headed, so a Linux host without a display needs Xvfb, which setup installs. */
export class PreviewBrowserDisplayError extends Schema.TaggedError<PreviewBrowserDisplayError>()(
  "PreviewBrowserDisplayError",
  { setupCommand: Schema.String, detail: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.detail === undefined
      ? `This Linux host has no display for T3's browser and no Xvfb to make one. Run \`${this.setupCommand}\` on the host to install Xvfb, then try again.`
      : `This Linux host has no display for T3's browser (${this.detail}). Run \`${this.setupCommand}\` on the host to install Xvfb, then try again.`;
  }
}

/** Chrome will not start its sandbox as root (crbug.com/638180), which no host setup fixes. */
export class PreviewBrowserRootError extends Schema.TaggedError<PreviewBrowserRootError>()(
  "PreviewBrowserRootError",
  {},
) {
  override get message(): string {
    return "T3 server is running as root; Chrome's sandbox cannot start. Run T3 as a nonroot user. Otherwise set `IGLO_CODE_SERVER_BROWSER_SANDBOX=0` in the T3 server's environment and restart the server; this disables Chrome's sandbox. Manual: `IGLO_CODE_SERVER_BROWSER_SANDBOX=0 iglo.code serve`. Systemd: add `Environment=IGLO_CODE_SERVER_BROWSER_SANDBOX=0` under `[Service]`, reload systemd, then restart the service. `iglo.code browser setup` cannot fix root sandboxing.";
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserRootError
  | PreviewBrowserDisplayError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      // Playwright reports Chrome's refusal to sandbox as root as a sandbox failure too.
      return (yield* HostProcess.UserId) === 0
        ? new PreviewBrowserRootError()
        : new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);

/** Detect missing libraries with --version; ldd can report misses that NixOS nix-ld provides. */
export const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore" }), { includeStderr: true })
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => ""),
      );
  const loaderError = LOADER_ERROR.exec(yield* run(executable, ["--version"]))?.[1];
  if (loaderError === undefined) return [];
  const listed = [...(yield* run("ldd", [executable])).matchAll(MISSING_LIBRARY)].map(
    (match) => match[1]!,
  );
  return listed.length > 0 ? listed : [loaderError];
});

export const usernsRestricted = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
}).pipe(Effect.withSpan("PreviewBrowserHost.usernsRestricted"));

/** A profile on disk can still be unloaded; only a failed launch shows that without root. */
export const sandboxBlocked = Effect.gen(function* () {
  if (!(yield* usernsRestricted)) return false;
  const fs = yield* FileSystem.FileSystem;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));

/** The first `PATH` entry holding `name`, as setup reports whether a host tool is installed. */
export const commandOnPath = Effect.fnUntraced(function* (name: string) {
  const env = yield* HostProcess.Environment;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Node's path module alone knows the separator; Windows uses ";".
  const delimiter = path.sep === "\\" ? ";" : ":";
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, name);
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return candidate;
  }
  return null;
});

/** A Linux host runs the browser on the first of an inherited display or Xvfb it starts itself. */
export type BrowserDisplayPlan =
  | { readonly kind: "host" }
  | { readonly kind: "xvfb" }
  | { readonly kind: "missing-xvfb" };

export const browserDisplayPlan = (input: {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly xvfbInstalled: boolean;
}): BrowserDisplayPlan => {
  if (input.platform !== "linux") return { kind: "host" };
  const hasDisplay = (input.env.DISPLAY ?? "") !== "" || (input.env.WAYLAND_DISPLAY ?? "") !== "";
  if (hasDisplay) return { kind: "host" };
  return input.xvfbInstalled ? { kind: "xvfb" } : { kind: "missing-xvfb" };
};

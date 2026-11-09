#!/usr/bin/env bun
/**
 * Packages the Bun-compiled CLI with `runtime/bun`, the web client, the resource monitor, and the
 * runtime externals it keeps on disk. Archives must run without host Node, npm, or compilers.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { BUN_VERSION } from "@t3tools/shared/bunRuntime";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import {
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  resolveFffNativeDependencies,
  STAGE_INSTALL_ARGS,
} from "./lib/cli-stage.ts";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

const BuildPlatform = Schema.Literals(["mac", "linux"]);
const BuildArch = Schema.Literals(["arm64", "x64"]);
type BuildPlatform = typeof BuildPlatform.Type;
type BuildArch = typeof BuildArch.Type;

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});
const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class CliArchiveCommandFailedError extends Schema.TaggedError<CliArchiveCommandFailedError>()(
  "CliArchiveCommandFailedError",
  { command: Schema.String, exitCode: Schema.Int },
) {
  override get message(): string {
    return `${this.command} exited with code ${this.exitCode}.`;
  }
}

export class CliArchiveInputMissingError extends Schema.TaggedError<CliArchiveInputMissingError>()(
  "CliArchiveInputMissingError",
  { inputPath: Schema.String, hint: Schema.String },
) {
  override get message(): string {
    return `Missing ${this.inputPath}. ${this.hint}`;
  }
}

export function cliArchivePlatformKey(platform: BuildPlatform, arch: BuildArch): string {
  const hostPlatform = platform === "mac" ? "darwin" : "linux";
  return `${hostPlatform}-${arch}`;
}

export function cliArchiveStem(version: string, platform: BuildPlatform, arch: BuildArch): string {
  return `iglo.code-${version}-${cliArchivePlatformKey(platform, arch)}`;
}

export function cliArchiveFileName(version: string, platform: BuildPlatform, arch: BuildArch) {
  // Minimal hosts may lack xz, but every supported tar handles gzip without it.
  return `${cliArchiveStem(version, platform, arch)}.tar.gz`;
}

const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.isStandardCommand(command)
      ? ChildProcess.make(command.command, command.args, {
          ...command.options,
          stdout: "inherit",
          stderr: "inherit",
        })
      : command,
  );
  const exitCode = Number(yield* child.exitCode);
  if (exitCode !== 0) {
    return yield* new CliArchiveCommandFailedError({ command: label, exitCode });
  }
});

const requireInput = Effect.fn("requireInput")(function* (inputPath: string, hint: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(inputPath))) {
    return yield* new CliArchiveInputMissingError({ inputPath, hint });
  }
});

/** Installed runtimes cannot rely on pnpm's store layout surviving archival. */
const stageRuntimeExternals = Effect.fn("stageRuntimeExternals")(function* (input: {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* decodeWorkspaceConfig(
    yield* fs.readFileString(path.join(input.repoRoot, "pnpm-workspace.yaml")),
  );
  const catalog = workspace.catalog ?? {};
  const serverDependencies = resolveCatalogDependencies(
    serverPackageJson.dependencies,
    catalog,
    "apps/server",
  );
  const fffNodeVersion = serverDependencies["@ff-labs/fff-node"];
  if (fffNodeVersion === undefined) {
    return yield* new CliArchiveInputMissingError({
      inputPath: "apps/server/package.json#dependencies['@ff-labs/fff-node']",
      hint: "The archive stages fff's platform binary from this version.",
    });
  }
  const dependencies = {
    ...selectCliRuntimeExternalDependencies(serverDependencies),
    ...resolveFffNativeDependencies(input.platform, input.arch, fffNodeVersion),
  };
  const patchedDependencies = createStagePatchedDependencies(
    workspace.patchedDependencies ?? {},
    dependencies,
  );

  yield* fs.writeFileString(
    path.join(input.stageDir, "package.json"),
    `${yield* encodeJsonString({
      name: "t3-runtime",
      version: input.version,
      private: true,
      packageManager: rootPackageJson.packageManager,
      dependencies,
    })}\n`,
  );
  yield* fs.writeFileString(
    path.join(input.stageDir, "pnpm-workspace.yaml"),
    yield* encodeStageWorkspaceConfig({
      ...createStageWorkspaceConfig({
        platform: input.platform,
        arch: input.arch,
        ...(workspace.allowBuilds ? { allowBuilds: workspace.allowBuilds } : {}),
        patchedDependencies,
        overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
      }),
      nodeLinker: "hoisted",
    }),
  );
  if (Object.keys(patchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(input.stageDir, "patches"));
  }

  const install = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(install.command, install.args, {
      cwd: input.stageDir,
      shell: install.shell,
      stdout: "inherit",
      stderr: "inherit",
    }),
    "vp install --prod (cli archive runtime externals)",
  );

  // pnpm's bookkeeping and the manifest only matter to pnpm; the runtime
  // resolves packages by directory.
  for (const entry of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "patches",
    "node_modules/.pnpm",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm-workspace-state-v1.json",
    "node_modules/.bin",
  ]) {
    yield* fs.remove(path.join(input.stageDir, entry), { recursive: true, force: true });
  }
  // Nested .bin shims are unused symlinks, which the npm registry rejects in tarballs.
  yield* removeNestedBinDirectories(fs, path, path.join(input.stageDir, "node_modules"));
});

const removeNestedBinDirectories = Effect.fn("build-cli-archive.removeNestedBinDirectories")(
  function* (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
  ): Effect.fn.Return<void, PlatformError.PlatformError> {
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const child = path.join(root, entry);
      if (entry === ".bin") {
        yield* fs.remove(child, { recursive: true, force: true });
        continue;
      }
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") {
        yield* removeNestedBinDirectories(fs, path, child);
      }
    }
  },
);

const stageWebClient = Effect.fn("stageWebClient")(function* (source: string, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.copy(source, target);
  const maps = (yield* fs.readDirectory(target, { recursive: true })).filter((entry) =>
    entry.endsWith(".map"),
  );
  for (const entry of maps) {
    yield* fs.remove(path.join(target, entry), { force: true });
  }
});

const MacSigningConfig = Config.all({
  identity: Config.String("IGLO_CODE_CLI_MAC_SIGN_IDENTITY").pipe(Config.option),
  appleApiKey: Config.String("APPLE_API_KEY").pipe(Config.option),
  appleApiKeyId: Config.String("APPLE_API_KEY_ID").pipe(Config.option),
  appleApiIssuer: Config.String("APPLE_API_ISSUER").pipe(Config.option),
});

export class CliArchiveNotarizationRejectedError extends Schema.TaggedError<CliArchiveNotarizationRejectedError>()(
  "CliArchiveNotarizationRejectedError",
  { submissionId: Schema.String, status: Schema.String },
) {
  override get message(): string {
    return `Apple notarization ${this.submissionId} is ${this.status}, not Accepted.`;
  }
}

const NotarySubmission = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.optional(Schema.String),
});
// Final failures from Apple's Notary API. "In Progress" is pending and has no log yet.
const rejectedNotaryStatuses: ReadonlySet<string> = new Set(["Invalid", "Rejected"]);
const decodeNotarySubmission = Schema.decodeEffect(Schema.fromJsonString(NotarySubmission));

/** Notarization runs only for a Developer ID identity with all three App Store Connect key values. */
const resolveNotaryCredentials = Effect.fn("resolveNotaryCredentials")(function* () {
  const signing = yield* MacSigningConfig;
  const identity = Option.getOrUndefined(signing.identity)?.trim() || "-";
  const key = Option.getOrUndefined(signing.appleApiKey);
  const keyId = Option.getOrUndefined(signing.appleApiKeyId);
  const issuer = Option.getOrUndefined(signing.appleApiIssuer);
  const credentials =
    identity !== "-" && key && keyId && issuer
      ? Option.some(["--key", key, "--key-id", keyId, "--issuer", issuer])
      : Option.none<ReadonlyArray<string>>();
  return { identity, credentials };
});

const notarytool = Effect.fn("notarytool")(function* (
  args: ReadonlyArray<string>,
  credentials: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("xcrun", ["notarytool", ...args, ...credentials, "--output-format", "json"], {
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const [stdout, exitCode] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: "unbounded" },
  );
  const submission = yield* decodeNotarySubmission(stdout).pipe(Effect.option);
  const status = Option.getOrUndefined(submission)?.status;
  // A finished submission reports its status even when notarytool exits non-zero for it.
  if (Option.isSome(submission) && status !== undefined && rejectedNotaryStatuses.has(status)) {
    yield* runCommand(
      ChildProcess.make("xcrun", ["notarytool", "log", submission.value.id, ...credentials]),
      "notarytool log",
    ).pipe(Effect.ignore);
    return yield* new CliArchiveNotarizationRejectedError({
      submissionId: submission.value.id,
      status,
    });
  }
  if (Number(exitCode) !== 0 || Option.isNone(submission)) {
    return yield* new CliArchiveCommandFailedError({
      command: `notarytool ${args[0]}`,
      exitCode: Number(exitCode),
    });
  }
  return submission.value;
}, Effect.scoped);

const requireAccepted = Effect.fn("requireAccepted")(function* (
  submission: typeof NotarySubmission.Type,
) {
  if (submission.status !== "Accepted") {
    return yield* new CliArchiveNotarizationRejectedError({
      submissionId: submission.id,
      status: submission.status ?? "without a status",
    });
  }
  yield* Effect.log(`[cli-archive] Notarized t3 (${submission.id}).`);
});

/** Apple Silicon requires signed binaries; notarization's hardened runtime also requires every native addon signed. */
export const signMacArchiveContents = Effect.fn("signMacArchiveContents")(function* (input: {
  readonly repoRoot: string;
  readonly contentDir: string;
  readonly executablePath: string;
  readonly notarySubmissionFile: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { identity, credentials } = yield* resolveNotaryCredentials();
  const deferred = Option.getOrUndefined(input.notarySubmissionFile);
  // A stale id would let await-notarization approve bytes from an earlier build.
  if (deferred !== undefined) yield* fs.remove(deferred, { force: true });

  const entitlements = path.join(input.repoRoot, "apps/server/resources/cli-entitlements.plist");
  const libraries = (yield* fs.readDirectory(input.contentDir, { recursive: true }))
    .filter(
      (entry) =>
        entry.endsWith(".node") ||
        entry.endsWith(".dylib") ||
        entry.endsWith("spawn-helper") ||
        entry.endsWith("iglo-code-resource-monitor"),
    )
    .map((entry) => path.join(input.contentDir, entry));

  for (const target of [
    ...libraries,
    path.join(input.contentDir, "runtime/bun"),
    input.executablePath,
  ]) {
    yield* runCommand(
      ChildProcess.make("codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
        ...(target === input.executablePath || target.endsWith("/runtime/bun")
          ? ["--entitlements", entitlements]
          : []),
        target,
      ]),
      `codesign ${path.relative(input.contentDir, target)}`,
    );
  }
  if (identity === "-") {
    yield* Effect.log("[cli-archive] Signed ad hoc (no IGLO_CODE_CLI_MAC_SIGN_IDENTITY).");
    return;
  }
  if (Option.isNone(credentials)) {
    yield* Effect.logWarning(
      "[cli-archive] Developer ID signed but not notarized (missing APPLE_API_KEY*).",
    );
    return;
  }
  // notarytool requires an archive; bare executables rely on online tickets because they cannot be stapled.
  const notarizeZip = path.join(path.dirname(input.contentDir), ".notarize-t3.zip");
  yield* runCommand(
    ChildProcess.make("ditto", ["-c", "-k", "--keepParent", input.contentDir, notarizeZip]),
    "ditto (notarization zip)",
  );
  const submission = yield* notarytool(
    ["submit", notarizeZip, ...(deferred === undefined ? ["--wait"] : [])],
    credentials.value,
  ).pipe(Effect.ensuring(fs.remove(notarizeZip, { force: true }).pipe(Effect.ignore)));
  if (deferred === undefined) {
    yield* requireAccepted(submission);
    return;
  }
  // The ticket lives with Apple, not in the archive, so the archive bytes are final before approval.
  yield* fs.writeFileString(deferred, submission.id);
  yield* Effect.log(
    `[cli-archive] Submitted iglo.code for notarization (${submission.id}). Run await-notarization before publishing.`,
  );
});

/** Publication gate for a deferred submission: fails unless Apple accepted it. */
export const awaitCliNotarization = Effect.fn("awaitCliNotarization")(function* (
  submissionFile: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { credentials } = yield* resolveNotaryCredentials();
  const submitted = yield* fs.exists(submissionFile);
  if (Option.isNone(credentials)) {
    if (submitted) {
      return yield* new CliArchiveInputMissingError({
        inputPath: "IGLO_CODE_CLI_MAC_SIGN_IDENTITY and APPLE_API_KEY*",
        hint: `${submissionFile} names a submission, but its credentials are not set.`,
      });
    }
    yield* Effect.log("[cli-archive] No notarization to await (signing or APPLE_API_KEY* unset).");
    return;
  }
  if (!submitted) {
    return yield* new CliArchiveInputMissingError({
      inputPath: submissionFile,
      hint: "Notarization is configured, but build-cli-archive recorded no submission.",
    });
  }
  const id = (yield* fs.readFileString(submissionFile)).trim();
  yield* requireAccepted(yield* notarytool(["wait", id], credentials.value));
});

const buildCliArchive = Effect.fn("buildCliArchive")(function* (input: {
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly resourceMonitorDir: Option.Option<string>;
  readonly notarySubmissionFile: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const serverDir = path.join(repoRoot, "apps/server");
  const executableName = "iglo.code";
  const targetKey = cliArchivePlatformKey(input.platform, input.arch);
  const hostKey = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  if (targetKey !== hostKey) {
    return yield* new CliArchiveInputMissingError({
      inputPath: targetKey,
      hint: "Build native archives on the corresponding supported host: darwin-arm64, darwin-x64, linux-x64, or linux-arm64.",
    });
  }
  if (process.versions.bun !== BUN_VERSION) {
    return yield* new CliArchiveInputMissingError({
      inputPath: process.execPath,
      hint: `Run archive packaging with Bun ${BUN_VERSION}; its interpreter is shipped for JavaScript helpers.`,
    });
  }
  const builtExecutable = path.join(serverDir, "dist-exe", `t3-${targetKey}`);
  const webClient = path.join(serverDir, "dist/client");
  const resourceMonitorDir = Option.getOrElse(input.resourceMonitorDir, () =>
    path.join(serverDir, "dist/resource-monitor"),
  );

  yield* requireInput(
    builtExecutable,
    `Run \`bun apps/server/scripts/cli.ts build-exe --target ${targetKey}\` first.`,
  );
  yield* requireInput(path.join(webClient, "index.html"), "Run `vp run --filter t3 build` first.");
  yield* requireInput(
    resourceMonitorDir,
    "Build the resource monitor or pass --resource-monitor-dir.",
  );

  const stem = cliArchiveStem(input.version, input.platform, input.arch);
  const stageRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-archive-" });
  const contentDir = path.join(stageRoot, stem);
  yield* fs.makeDirectory(contentDir, { recursive: true });

  yield* Effect.log(`[cli-archive] Staging ${stem}...`);
  yield* fs.copyFile(builtExecutable, path.join(contentDir, executableName));
  const runtimeDir = path.join(contentDir, "runtime");
  yield* fs.makeDirectory(runtimeDir);
  yield* fs.copyFile(process.execPath, path.join(runtimeDir, "bun"));
  yield* fs.chmod(path.join(runtimeDir, "bun"), 0o755);
  yield* stageWebClient(webClient, path.join(contentDir, "client"));
  yield* fs.copy(resourceMonitorDir, path.join(contentDir, "resource-monitor"));
  yield* stageRuntimeExternals({
    repoRoot,
    stageDir: contentDir,
    platform: input.platform,
    arch: input.arch,
    version: input.version,
  });

  const executablePath = path.join(contentDir, executableName);
  if (input.platform === "mac") {
    yield* signMacArchiveContents({
      repoRoot,
      contentDir,
      executablePath,
      notarySubmissionFile: input.notarySubmissionFile,
    });
  }
  yield* fs.chmod(executablePath, 0o755);

  yield* fs.makeDirectory(input.outputDir, { recursive: true });
  const archivePath = path.join(
    input.outputDir,
    cliArchiveFileName(input.version, input.platform, input.arch),
  );
  yield* fs.remove(archivePath, { force: true });
  // npm rejects Linux hardlink entries; macOS pnpm clones and bsdtar lacks this flag.
  yield* runCommand(
    ChildProcess.make("tar", [
      ...(input.platform === "linux" ? ["--hard-dereference"] : []),
      "-czf",
      archivePath,
      "-C",
      stageRoot,
      stem,
    ]),
    "tar (gzip)",
  );
  const stat = yield* fs.stat(archivePath);
  yield* Effect.log(`[cli-archive] Wrote ${archivePath} (${String(stat.size)} bytes).`);
  return archivePath;
});

const command = Command.make(
  "build-cli-archive",
  {
    platform: Flag.Literals("platform", BuildPlatform.literals),
    arch: Flag.Literals("arch", BuildArch.literals),
    version: Flag.String("version").pipe(
      Flag.withDescription("Release version for the archive name."),
    ),
    outputDir: Flag.String("output-dir").pipe(Flag.withDefault("release-cli")),
    resourceMonitorDir: Flag.String("resource-monitor-dir").pipe(
      Flag.withDescription(
        "Directory laid out like dist/resource-monitor (defaults to apps/server/dist/resource-monitor).",
      ),
      Flag.optional,
    ),
    notarySubmissionFile: Flag.String("notary-submission-file").pipe(
      Flag.withDescription(
        "macOS: submit for notarization without waiting and write the submission id here. Publish only after await-notarization succeeds.",
      ),
      Flag.optional,
    ),
  },
  (input) => buildCliArchive(input).pipe(Effect.scoped),
).pipe(
  Command.withDescription("Package the iglo.code single-executable into a per-platform archive."),
  Command.withSubcommands([
    Command.make(
      "await-notarization",
      { submissionFile: Flag.String("submission-file") },
      (input) => awaitCliNotarization(input.submissionFile),
    ).pipe(
      Command.withDescription(
        "Wait for a --notary-submission-file submission; fail unless Accepted.",
      ),
    ),
  ]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
    NodeRuntime.runMain,
  );
}

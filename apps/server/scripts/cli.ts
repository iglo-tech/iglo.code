#!/usr/bin/env bun
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEVELOPMENT_ICON_OVERRIDES } from "../../../scripts/lib/brand-assets.ts";
import { findEsmImportsOfExternalPackages } from "../../../scripts/lib/cli-executable-imports.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { BUN_VERSION } from "@t3tools/shared/bunRuntime";
import { CLI_ARCHIVE_PLATFORM_KEYS, CLI_RELEASE_MANIFEST_FILE } from "@t3tools/shared/cliRelease";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliExecutableImportError,
  ServerCliExecutableBuildConfigurationError,
} from "./cliErrors.ts";
import { ReleaseManifest } from "../src/cloud/releaseLookup.ts";
import { BUILD_MIGRATION_HEAD } from "../src/persistence/databaseMigrationHead.ts";

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args.map(String),
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      const bundleCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(bundleCommand.command, bundleCommand.args, {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: bundleCommand.shell,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found. Skipping client bundle.");
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

const buildExeCmd = Command.make(
  "build-exe",
  {
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
    target: Flag.String("target").pipe(
      Flag.withDescription(
        `Compile for ${CLI_ARCHIVE_PLATFORM_KEYS.join(", ")}; defaults to the host.`,
      ),
      Flag.optional,
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      const hostPlatform = yield* HostProcess.Platform;
      const hostArch = yield* HostProcess.Architecture;
      const target = Option.getOrElse(config.target, () => `${hostPlatform}-${hostArch}`);
      if (!CLI_ARCHIVE_PLATFORM_KEYS.some((supported) => supported === target)) {
        return yield* new ServerCliExecutableBuildConfigurationError({
          message: `Unsupported CLI target "${target}". Supported targets: ${CLI_ARCHIVE_PLATFORM_KEYS.join(", ")}.`,
        });
      }
      if (process.versions.bun !== BUN_VERSION) {
        return yield* new ServerCliExecutableBuildConfigurationError({
          message: `Build the CLI with Bun ${BUN_VERSION}.`,
        });
      }
      yield* Effect.log("[cli] Building Bun executable...");
      const spawnCommand = yield* resolveSpawnCommand("vp", ["pack"]);
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: serverDir,
          env: {
            ...process.env,
            IGLO_CODE_PACK_EXE: "1",
          },
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: spawnCommand.shell,
        }),
      );

      // Disk-backed packages must resolve beside the executable, not as another embedded graph.
      const bundlePath = path.join(serverDir, "dist-exe/bin.mjs");
      const specifiers = findEsmImportsOfExternalPackages(yield* fs.readFileString(bundlePath));
      if (specifiers.length > 0) {
        return yield* new ServerCliExecutableImportError({ bundlePath, specifiers });
      }
      const executablePath = path.join(serverDir, "dist-exe", `t3-${target}`);
      // Bun disables package.json loading in executables by default, including
      // the exports and dependency resolution needed by disk-backed packages.
      yield* runCommand(
        ChildProcess.make(
          process.execPath,
          [
            "build",
            "--compile",
            "--compile-autoload-package-json",
            `--target=bun-${target}`,
            "--outfile",
            executablePath,
            bundlePath,
          ],
          {
            cwd: serverDir,
            stdout: config.verbose ? "inherit" : "ignore",
            stderr: "inherit",
          },
        ),
      );
      if (target.startsWith("darwin-") && hostPlatform === "darwin") {
        yield* runCommand(
          ChildProcess.make("codesign", ["--force", "--sign", "-", executablePath]),
        );
      }
      yield* Effect.log(
        `[cli] Built ${executablePath} (archive adds client/, runtime/bun, resource-monitor/, and runtime-external node_modules).`,
      );
    }),
).pipe(
  Command.withDescription(
    "Build the server as a Bun executable. Native packages resolve from node_modules beside it.",
  ),
);

const encodeReleaseManifest = Schema.encodeEffect(Schema.fromJsonString(ReleaseManifest));

const releaseManifestCmd = Command.make(
  "release-manifest",
  {
    version: Flag.String("version"),
    outputDir: Flag.String("output-dir"),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const manifestPath = path.join(config.outputDir, CLI_RELEASE_MANIFEST_FILE);
      yield* fs.makeDirectory(config.outputDir, { recursive: true });
      const manifest = yield* encodeReleaseManifest({
        version: config.version,
        databaseMigration: BUILD_MIGRATION_HEAD,
      });
      yield* fs.writeFileString(manifestPath, `${manifest}\n`);
      yield* Effect.log(
        `[cli] Wrote ${manifestPath} (database migration ${BUILD_MIGRATION_HEAD}).`,
      );
    }),
).pipe(
  Command.withDescription(
    `Write ${CLI_RELEASE_MANIFEST_FILE}, which track switches read to check database compatibility.`,
  ),
);

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build CLI."),
  Command.withSubcommands([buildCmd, buildExeCmd, releaseManifestCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);

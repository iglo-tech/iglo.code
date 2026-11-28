import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { awaitServiceLauncherStop } from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import { stopOnLauncherLoss } from "../launcherWatch.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AutomaticPort from "./automaticPort.ts";
import {
  type CliServerFlags,
  normalizeServerCwdArgument,
  resolveServerConfig,
  sharedServerCommandFlags,
} from "./config.ts";
import { maybeOfferFirstRunImport } from "./importT3.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

// Untraced: a span that lasts the whole process would parent everything the server does.
const runServerCommand = Effect.fnUntraced(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) {
  // Before config resolution, which claims a port and creates directories.
  const { runServer } = yield* Effect.promise(() => import("../server.ts"));
  const logLevel = yield* GlobalFlag.LogLevel;
  const selectAutomaticPort = yield* AutomaticPort.make.pipe(Effect.provide(ProcessRunner.layer));
  const config = yield* resolveServerConfig(flags, logLevel, { ...options, selectAutomaticPort });
  // The destination database appears during boot, so this is the last moment it is clean enough
  // to offer the one-time T3 Code import. A dev home (devUrl) or a desktop bootstrap start never
  // offers (throwaway sandbox; one-shot --bootstrap-fd pipe). Headless and non-TTY starts print
  // the one-line hint instead.
  const offer = yield* maybeOfferFirstRunImport({
    destinationHome: config.baseDir,
    destinationDatabasePath: config.dbPath,
    presentation:
      config.devUrl !== undefined || config.desktopBootstrapToken !== undefined
        ? "dev"
        : config.startupPresentation === "headless"
          ? "headless"
          : "interactive",
  });
  // Ctrl+C at the prompt exits without booting, so the ask-once offer survives to the next start.
  if (offer === "quit") return;
  // A successful import filled the home this config was resolved against; re-resolve so the
  // chosen port and the loaded settings come from the imported home, not the empty one. A hinted
  // (headless/non-TTY) start changes nothing on disk: do NOT re-resolve (the one-shot bootstrap fd
  // is already drained), just skip the cwd auto-bootstrap so the home stays importable.
  const activeConfig =
    offer === "imported"
      ? yield* resolveServerConfig(flags, logLevel, { ...options, selectAutomaticPort })
      : offer === "hinted"
        ? { ...config, autoBootstrapProjectFromCwd: false }
        : config;
  const run = Effect.raceFirst(
    runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, activeConfig)),
    awaitServiceLauncherStop().pipe(Effect.andThen(Effect.interrupt)),
  ).pipe(
    // Settings' Reclaim stops the server; repair once the database is closed, before the restart.
    Effect.ensuring(
      DatabaseMaintenance.runRequestedReclaim(activeConfig.dbPath).pipe(
        Effect.provide(DatabaseMaintenance.layer),
      ),
    ),
  );
  if (activeConfig.mode !== "desktop" || activeConfig.desktopBootstrapToken === undefined) {
    return yield* run;
  }
  return yield* stopOnLauncherLoss(run);
});

export const runDefaultServerCommand = Effect.fnUntraced(function* (flags: CliServerFlags) {
  if (Option.isSome(flags.cwd)) {
    const cwd = yield* normalizeServerCwdArgument(flags.cwd.value);
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const explicitPath =
      cwd === "." ||
      cwd === ".." ||
      cwd === "~" ||
      /[/\\]/.test(cwd) ||
      (platform === "win32" && /^[a-z]:/i.test(cwd));
    if (!explicitPath && (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")) {
      return yield* new CliError.UserError({
        cause: cwd,
        userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "iglo.code --help" for commands or an explicit path such as "iglo.code ./my-project" for a new directory.`,
      });
    }
  }
  return yield* runServerCommand(flags, { rejectRunningServer: true });
});

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Same as `iglo.code`."),
  Command.unlisted,
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

// Serve never bootstraps a project, so it does not offer the flag that asks for one.
const { autoBootstrapProjectFromCwd: _, ...serveCommandFlags } = sharedServerCommandFlags;

export const serveCommand = Command.make("serve", serveCommandFlags).pipe(
  Command.withShortDescription("Run iglo.code in this terminal, with no browser."),
  Command.withDescription(
    "Run iglo.code in this terminal without opening a browser, and print pairing details. The background service runs this too, without printing them: pair with `iglo.code pair`. To set up access from your other devices, run `iglo.code up`.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(
      { ...flags, autoBootstrapProjectFromCwd: Option.none() },
      {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      },
    ),
  ),
);

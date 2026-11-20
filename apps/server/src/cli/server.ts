import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { awaitServiceLauncherStop } from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import * as DatabaseMaintenance from "../persistence/DatabaseMaintenance.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AutomaticPort from "./automaticPort.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import { maybeOfferFirstRunImport } from "./importT3.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const runServerCommand = Effect.fn("server.runServerCommand")(function* (
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
  return yield* Effect.raceFirst(
    run,
    awaitLauncherLoss().pipe(
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
});

export const runDefaultServerCommand = Effect.fn("server.runDefaultServerCommand")(function* (
  flags: CliServerFlags,
) {
  if (Option.isSome(flags.cwd)) {
    const cwd = flags.cwd.value.trim();
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
        userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
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
  Command.withShortDescription("Run T3 Code in this terminal, with no browser."),
  Command.withDescription(
    "Run T3 Code in this terminal without opening a browser, and print pairing details. The background service runs this. To set up access from your other devices, run `iglo.code up`.",
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

import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Terminal from "effect/Terminal";
import { Command, Flag, Prompt } from "effect/cli";

import * as NodeTty from "node:tty";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";

import {
  legacyOwnerStartedBeforeRecord,
  legacyOwnerStartTimeCommand,
} from "../legacyServerOwner.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  planUpstreamLedger,
  reconcileUpstreamMigrationLedger,
  UpstreamLedgerError,
  type UpstreamMigrationRow,
} from "../persistence/reconcileUpstreamMigrationLedger.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { projectLocationFlags } from "./config.ts";
import { resolveHostCliHint } from "./invocation.ts";

const DEFAULT_SOURCE_HOME = "~/.t3";

// The migrated snapshot lands under this name and is renamed onto statev2.sqlite only after it
// is fully migrated, so a failed import never leaves a database behind.
const SNAPSHOT_FILE_NAME = "statev2.sqlite.import-snapshot";

const DATABASE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

const fromFlag = Flag.String("from").pipe(
  Flag.withDescription(`T3 Code home directory to import from (default: ${DEFAULT_SOURCE_HOME}).`),
  Flag.optional,
);

export class ImportSourceMissingError extends Schema.TaggedError<ImportSourceMissingError>()(
  "ImportSourceMissingError",
  { sourceDatabasePath: Schema.String },
) {
  override get message(): string {
    return `No T3 Code database at '${this.sourceDatabasePath}'. Start T3 Code at least once before importing, or pass --from with its home directory.`;
  }
}

export class ImportSourceIsDestinationError extends Schema.TaggedError<ImportSourceIsDestinationError>()(
  "ImportSourceIsDestinationError",
  { sourceHome: Schema.String },
) {
  override get message(): string {
    return `Refusing to import '${this.sourceHome}' into itself. Pass a different --from or --base-dir.`;
  }
}

export class ImportHomesOverlapError extends Schema.TaggedError<ImportHomesOverlapError>()(
  "ImportHomesOverlapError",
  { sourceHome: Schema.String, destinationHome: Schema.String },
) {
  override get message(): string {
    return `Refusing to import: the destination '${this.destinationHome}' overlaps the T3 Code home '${this.sourceHome}'. Pick a destination that is neither inside nor above the T3 Code home.`;
  }
}

const pathSegments = (value: string) => value.split(/[\\/]/).filter((part) => part.length > 0);

/** True when child sits strictly inside parent; equality is not containment. */
const isInside = (parent: string, child: string, caseInsensitive: boolean): boolean => {
  const [base, target] = caseInsensitive
    ? [parent.toLowerCase(), child.toLowerCase()]
    : [parent, child];
  const parentSegments = pathSegments(base);
  const childSegments = pathSegments(target);
  return (
    parentSegments.length < childSegments.length &&
    parentSegments.every((part, index) => part === childSegments[index])
  );
};

/** True when either home sits strictly inside the other; equality is refused by the caller. The
 * lexical pair catches plain spellings; the canonical pair catches the same homes reached through
 * symlinks or spelled with different case on case-insensitive platforms (darwin, win32), where
 * either spelling would write into the other. */
export const homesOverlap = (
  sourceHome: string,
  destinationHome: string,
  canonicalSource: string,
  canonicalDestination: string,
  caseInsensitive: boolean,
): boolean =>
  isInside(sourceHome, destinationHome, caseInsensitive) ||
  isInside(destinationHome, sourceHome, caseInsensitive) ||
  isInside(canonicalSource, canonicalDestination, caseInsensitive) ||
  isInside(canonicalDestination, canonicalSource, caseInsensitive);

export class ImportSourceInUseError extends Schema.TaggedError<ImportSourceInUseError>()(
  "ImportSourceInUseError",
  { sourceHome: Schema.String, pid: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.pid === undefined
      ? `A T3 Code server still holds the ownership lock of '${this.sourceHome}'. Stop it before importing.`
      : `A T3 Code server (pid ${this.pid}) is still running from '${this.sourceHome}'. Stop it before importing.`;
  }
}

export class ImportSourceIncompatibleError extends Schema.TaggedError<ImportSourceIncompatibleError>()(
  "ImportSourceIncompatibleError",
  { sourceDatabasePath: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Cannot import the T3 Code database at '${this.sourceDatabasePath}': ${this.detail}.`;
  }
}

export class ImportDestinationInUseError extends Schema.TaggedError<ImportDestinationInUseError>()(
  "ImportDestinationInUseError",
  { destinationHome: Schema.String, pid: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return this.pid === undefined
      ? `An iglo.code server still holds the ownership lock of '${this.destinationHome}'. Stop it (and its background service), then run the import again.`
      : `An iglo.code server (pid ${this.pid}) is still running from '${this.destinationHome}'. Stop it (and its background service), then run the import again.`;
  }
}

export class ImportDestinationNotCleanError extends Schema.TaggedError<ImportDestinationNotCleanError>()(
  "ImportDestinationNotCleanError",
  { destinationHome: Schema.String },
) {
  override get message(): string {
    return `'${this.destinationHome}' already holds iglo.code state. Import needs a clean home; move the whole home aside, or pass --base-dir with a fresh directory. A home with no projects or threads yet is still importable.`;
  }
}

export class ImportLegacyThreadsError extends Schema.TaggedError<ImportLegacyThreadsError>()(
  "ImportLegacyThreadsError",
  { sourceDatabasePath: Schema.String, legacyThreads: Schema.Number },
) {
  override get message(): string {
    return `'${this.sourceDatabasePath}' holds ${this.legacyThreads} legacy threads T3 Code has not imported into its current schema yet. Start T3 Code once on that home so it finishes the import, then retry.`;
  }
}

export class ImportError extends Schema.TaggedError<ImportError>()("ImportError", {
  phase: Schema.Literals(["stage", "copy", "snapshot", "migrate"]),
  destinationDatabasePath: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Import failed during ${this.phase} on '${this.destinationDatabasePath}'. The destination holds no database yet; fix the cause and run the import again.`;
  }
}

// Runtime files, caches and downloaded tools regenerate; worktrees and "New project" repos stay
// in the T3 home (the database points at them there) and scratch is symlinked to it; logs, the
// ownership lock and the live databases stay with T3 Code; clerk/cloud/relay/desktop never cross.
const EXCLUDED_HOME_ENTRIES = new Set([
  "bin",
  "caches",
  "projects",
  "runtime",
  "service.env",
  "worktrees",
  "worktree-backups",
  "scratch",
  "source",
  "tools",
  "userdata/clerk",
  "userdata/cloud-auth-token.json",
  "userdata/host-metrics.sqlite",
  "userdata/host-metrics.sqlite-wal",
  "userdata/host-metrics.sqlite-shm",
  "userdata/host-metrics.sqlite-journal",
  "userdata/provider-processes",
  "userdata/relay-clients",
  "userdata/shell-environment-cache.json",
  "userdata/logs",
  "userdata/server-runtime.json",
  "userdata/server-owner.sqlite",
  "userdata/server-owner.sqlite-journal",
  "userdata/state.sqlite",
  "userdata/state.sqlite-wal",
  "userdata/state.sqlite-shm",
  "userdata/state.sqlite-journal",
  "userdata/statev2.sqlite",
  "userdata/statev2.sqlite-wal",
  "userdata/statev2.sqlite-shm",
  "userdata/statev2.sqlite-journal",
]);

const EXCLUDED_ENTRY_PREFIXES = ["desktop-"];

// desktop-* files live at the home root or directly under userdata/; a deeper match is a user file.
const isExcludedHomeEntry = (relative: string): boolean => {
  const parts = relative.split("/");
  return (
    EXCLUDED_HOME_ENTRIES.has(relative) ||
    ((parts.length === 1 || (parts.length === 2 && parts[0] === "userdata")) &&
      EXCLUDED_ENTRY_PREFIXES.some((prefix) => parts.at(-1)!.startsWith(prefix)))
  );
};

// Canonicalize through the nearest existing ancestor and rejoin the remainder, so a home that
// does not exist yet still compares on the same basis as one that does; symlinks above either
// home resolve identically for both.
const resolveThroughSymlinks = Effect.fn("runImportT3.resolveThroughSymlinks")(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let ancestor = target;
  const remainder: Array<string> = [];
  while (true) {
    const real = yield* fs.realPath(ancestor).pipe(Effect.option);
    if (Option.isSome(real)) {
      return remainder.length === 0 ? real.value : path.join(real.value, ...remainder.reverse());
    }
    if (ancestor === path.dirname(ancestor)) return target;
    remainder.push(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
});

const copyHomeTree = Effect.fn("runImportT3.copyHomeTree")(function* (
  source: string,
  destination: string,
  canonicalSource: string,
  caseInsensitive: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending: Array<string> = [""];
  const directoryModes: Array<[relativeDir: string, mode: number]> = [];
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const sourceDir = relativeDir === "" ? source : path.join(source, relativeDir);
    const destinationDir = relativeDir === "" ? destination : path.join(destination, relativeDir);
    const entries = yield* fs.readDirectory(sourceDir).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed([] as ReadonlyArray<string>),
      ),
    );
    for (const entry of entries) {
      const relative = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
      if (isExcludedHomeEntry(relative)) continue;
      const sourceEntry = path.join(sourceDir, entry);
      const destinationEntry = path.join(destinationDir, entry);
      const stat = yield* fs.lstat(sourceEntry).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(null),
        ),
      );
      if (stat === null) {
        yield* Console.log(`Skipping '${relative}': it vanished during the import.`);
        continue;
      }
      if (stat.type === "SymbolicLink") {
        // Recreate links verbatim, never follow them: following would copy outside files in and
        // chmod would write through into them; linked directories would deep-copy or loop.
        // Absolute links into the source home are re-pointed at the copy, so iglo.code never
        // reads T3 Code state at runtime.
        const target = yield* fs.readLink(sourceEntry);
        const canonicalTarget = yield* resolveThroughSymlinks(
          path.resolve(path.dirname(sourceEntry), target),
        );
        let linkTarget = target;
        if (isInside(canonicalSource, canonicalTarget, caseInsensitive)) {
          const relativeTarget = path.relative(canonicalSource, canonicalTarget);
          if (isExcludedHomeEntry(relativeTarget)) {
            yield* Console.log(
              `Skipping '${relative}': it points at excluded '${relativeTarget}'.`,
            );
            continue;
          }
          if (path.isAbsolute(target)) {
            linkTarget = path.join(destination, relativeTarget);
          }
        }
        yield* fs.remove(destinationEntry, { force: true });
        yield* fs.symlink(linkTarget, destinationEntry);
        continue;
      }
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(destinationEntry, { recursive: true });
        directoryModes.push([relative, stat.mode]);
        pending.push(relative);
      } else if (stat.type === "File") {
        yield* fs.copy(sourceEntry, destinationEntry, { overwrite: true });
        yield* fs.chmod(destinationEntry, stat.mode);
      } else {
        yield* Console.log(`Skipping '${relative}': special file (${stat.type}).`);
      }
    }
  }
  // Directory modes apply after their children are in place: a read-only source directory must
  // not block the copy into it.
  directoryModes.sort((a, b) => b[0].split("/").length - a[0].split("/").length);
  for (const [relative, mode] of directoryModes) {
    yield* fs.chmod(path.join(destination, relative), mode);
  }
});

const measureHomeTree = Effect.fn("runImportT3.measureHomeTree")(function* (source: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let files = 0;
  let bytes = 0;
  const pending: Array<string> = [""];
  while (pending.length > 0) {
    const relativeDir = pending.pop()!;
    const sourceDir = relativeDir === "" ? source : path.join(source, relativeDir);
    // Measuring is only for the progress message; unreadable entries are counted at the copy.
    const entries = yield* fs
      .readDirectory(sourceDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    for (const entry of entries) {
      const relative = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
      if (isExcludedHomeEntry(relative)) continue;
      const stat = yield* fs
        .lstat(path.join(sourceDir, entry))
        .pipe(Effect.orElseSucceed(() => null));
      if (stat === null) continue;
      if (stat.type === "Directory") pending.push(relative);
      else if (stat.type === "File" || stat.type === "SymbolicLink") {
        files += 1;
        bytes += Number(stat.size);
      }
    }
  }
  return { files, bytes };
});

const formatDataSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.max(1, Math.ceil(bytes / 1024 ** 2))} MiB`;

// One provision site for every sqlite connection in this file; a service pulled out of its
// provided effect dies with "database is not open" by the first query. Connections here are
// always opened read-write: the staging copy is ours, and Bun refuses a read-only open of a WAL
// database left by a clean stop while VACUUM INTO needs a writable connection anyway.
const withSqliteDatabase = <A, E, R>(
  options: NodeSqliteClient.SqliteClientConfig,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer(options)));

const readRecordedMigrations = Effect.fn("runImportT3.readRecordedMigrations")(function* (
  databasePath: string,
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const hasLedger = yield* sql`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
    if (hasLedger.length === 0) return [] as ReadonlyArray<UpstreamMigrationRow>;
    const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
    return rows.map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
  }).pipe((effect) => withSqliteDatabase({ filename: databasePath }, effect));
});

const countUnimportedLegacyThreads = Effect.fn("runImportT3.countUnimportedLegacyThreads")(
  function* (databasePath: string) {
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const legacyTables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'`;
      if (legacyTables.length === 0) return 0;
      const [pending] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads AS thread
        WHERE NOT EXISTS (
          SELECT 1
          FROM orchestration_events AS event
            INDEXED BY orchestration_events_v2_created_threads_idx
          WHERE event.application_event_version = 2
            AND event.aggregate_kind = 'thread'
            AND event.stream_id = thread.thread_id
            AND event.event_type = 'thread.created'
        )`;
      return Number(pending?.count ?? 0);
    }).pipe((effect) => withSqliteDatabase({ filename: databasePath }, effect));
  },
);

const snapshotStagedDatabase = Effect.fn("runImportT3.snapshotStagedDatabase")(function* (
  stagedDatabasePath: string,
  snapshotPath: string,
  destinationDatabasePath: string,
) {
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Setting auto_vacuum before the vacuum makes the snapshot incremental, like a fresh
    // iglo.code database, so the server can return freed pages later.
    yield* sql.unsafe("PRAGMA auto_vacuum = INCREMENTAL").unprepared;
    yield* sql`VACUUM INTO ${snapshotPath}`;
  }).pipe(
    (effect) => withSqliteDatabase({ filename: stagedDatabasePath }, effect),
    Effect.mapError(
      (cause) => new ImportError({ phase: "snapshot", destinationDatabasePath, cause }),
    ),
  );
});

const AUTH_TABLES = ["auth_sessions", "auth_pairing_links", "auth_connect_devices"] as const;

const isUpstreamLedgerError = Schema.is(UpstreamLedgerError);

const migrateSnapshotDatabase = Effect.fn("runImportT3.migrateSnapshotDatabase")(function* (
  snapshotPath: string,
  destinationDatabasePath: string,
) {
  const migrate = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
    yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
    const reconciled = yield* reconcileUpstreamMigrationLedger();
    const migrations = yield* runMigrations();
    for (const table of AUTH_TABLES) {
      yield* sql`DELETE FROM ${sql(table)}`;
    }
    const [projects] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_projects WHERE deleted_at IS NULL`;
    const [threads] = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.deletedAt') IS NULL
          AND json_extract(payload_json, '$.archivedAt') IS NULL`;
    return {
      reconciled,
      migrations,
      projects: Number(projects?.count ?? 0),
      threads: Number(threads?.count ?? 0),
    };
  }).pipe(
    (effect) => withSqliteDatabase({ filename: snapshotPath }, effect),
    Effect.mapError((cause) =>
      isUpstreamLedgerError(cause)
        ? cause
        : new ImportError({ phase: "migrate", destinationDatabasePath, cause }),
    ),
  );
  return yield* migrate;
});

// Plain helper: Effect's compiler rejects global JSON use inside Effect code.
const formatSettingsJson = (value: Record<string, unknown>): string =>
  `${JSON.stringify(value, null, 2)}\n`;

// The server reads settings.json leniently (comments and trailing commas allowed) and writes it
// atomically; the import must not silently drop a commented file or write non-atomically.
const recordImportedWorktreesDir = Effect.fn("runImportT3.recordImportedWorktreesDir")(function* (
  settingsPath: string,
  worktreesDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(worktreesDir))) return false;
  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  const decoded = Schema.decodeOption(
    fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
  )(raw.trim().length === 0 ? "{}" : raw);
  if (Option.isNone(decoded)) {
    yield* Console.log(
      `Could not read '${settingsPath}' to record the imported worktrees directory; leaving it unchanged.`,
    );
    return false;
  }
  const settings = decoded.value;
  const previous = Array.isArray(settings.previousWorktreesDirectories)
    ? settings.previousWorktreesDirectories.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (!previous.includes(worktreesDir)) previous.push(worktreesDir);
  yield* writeFileStringAtomically({
    filePath: settingsPath,
    contents: formatSettingsJson({ ...settings, previousWorktreesDirectories: previous }),
  });
  return true;
});

// A database the first boot created but never used (no projects, no threads) may be replaced;
// anything else is data and refuses. Unreadable or schema-less files count as data.
const destinationDatabaseIsEmpty = Effect.fn("runImportT3.destinationDatabaseIsEmpty")(function* (
  databasePath: string,
) {
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('projection_projects', 'orchestration_v2_projection_threads')`;
    if (tables.length !== 2) return false;
    const [projects] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_projects WHERE deleted_at IS NULL`;
    const [threads] = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.deletedAt') IS NULL
        AND json_extract(payload_json, '$.archivedAt') IS NULL`;
    return Number(projects?.count ?? 0) === 0 && Number(threads?.count ?? 0) === 0;
  }).pipe(
    (effect) => withSqliteDatabase({ filename: databasePath }, effect),
    Effect.option,
    Effect.map(Option.getOrElse(() => false)),
  );
});

// A recorded pid can belong to a reused process; require start-time proof before calling it live,
// the same rule the server applies to pre-lock owners.
const ownerIsLive = Effect.fn("runImportT3.ownerIsLive")(function* (
  state: PersistedServerRuntimeState,
) {
  if (!isProcessAlive(state.pid)) return false;
  const recordedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(recordedAt)) return true;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      ...legacyOwnerStartTimeCommand(state.pid, platform, hostEnv),
      timeout: Duration.seconds(2),
      maxOutputBytes: 16_384,
    })
    .pipe(Effect.option);
  return legacyOwnerStartedBeforeRecord(
    Option.isSome(result) && result.value.code === 0 ? result.value.stdout : undefined,
    recordedAt,
    platform,
  );
});

export const runImportT3 = Effect.fn("runImportT3")(function* (input: {
  readonly sourceHome: string;
  readonly destinationHome: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceHome = path.resolve(input.sourceHome);
  const destinationHome = path.resolve(input.destinationHome);
  const sourceStateDir = path.join(sourceHome, "userdata");
  const sourceDatabasePath = path.join(sourceStateDir, "statev2.sqlite");
  const sourceRuntimeStatePath = path.join(sourceStateDir, "server-runtime.json");
  const sourceOwnerLockPath = path.join(sourceStateDir, "server-owner.sqlite");
  const destinationStateDir = path.join(destinationHome, "userdata");
  const destinationDatabasePath = path.join(destinationStateDir, "statev2.sqlite");
  const destinationSettingsPath = path.join(destinationStateDir, "settings.json");
  const destinationRuntimeStatePath = path.join(destinationStateDir, "server-runtime.json");
  const destinationOwnerLockPath = path.join(destinationStateDir, "server-owner.sqlite");
  const snapshotPath = path.join(destinationStateDir, SNAPSHOT_FILE_NAME);

  if (!(yield* fs.exists(sourceDatabasePath))) {
    return yield* new ImportSourceMissingError({ sourceDatabasePath });
  }
  const canonicalSource = yield* resolveThroughSymlinks(sourceHome);
  const canonicalDestination = yield* resolveThroughSymlinks(destinationHome);
  if (sourceHome === destinationHome || canonicalSource === canonicalDestination) {
    return yield* new ImportSourceIsDestinationError({ sourceHome });
  }
  // A destination inside the source nests the copy into itself forever; the reverse writes into
  // the destination's ancestors. Both are refusals, not cleanups. The canonical pair matters when
  // either spelling goes through a symlink, which the lexical pair cannot see through.
  const platform = yield* HostProcess.Platform;
  const caseInsensitive = platform === "darwin" || platform === "win32";
  if (
    homesOverlap(
      sourceHome,
      destinationHome,
      canonicalSource,
      canonicalDestination,
      caseInsensitive,
    )
  ) {
    return yield* new ImportHomesOverlapError({ sourceHome, destinationHome });
  }
  // A running iglo.code on the destination (the headless hint's audience) gets its own refusal,
  // ahead of the cleanliness checks, so the message says to stop it instead of moving a live home.
  const destinationOwner = yield* readPersistedServerRuntimeState(destinationRuntimeStatePath).pipe(
    Effect.map(Option.filter((state) => isProcessAlive(state.pid))),
    Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
  );
  const destinationOwnerLive = yield* Option.match(destinationOwner, {
    onNone: () => Effect.succeed(Option.none<PersistedServerRuntimeState>()),
    onSome: (state) =>
      ownerIsLive(state).pipe(
        Effect.provide(ProcessRunner.layer),
        Effect.map((alive) => (alive ? Option.some(state) : Option.none())),
      ),
  });
  if (Option.isSome(destinationOwnerLive)) {
    return yield* new ImportDestinationInUseError({
      destinationHome,
      pid: destinationOwnerLive.value.pid,
    });
  }
  if (yield* fs.exists(destinationOwnerLockPath)) {
    const destinationLockHeld = yield* ServerOwnership.holdServerOwnershipLock(
      destinationRuntimeStatePath,
    ).pipe(
      Effect.scoped,
      Effect.as(false),
      Effect.catchTags({
        ServerAlreadyRunningError: () => Effect.succeed(true),
        ServerOwnershipError: () => Effect.succeed(false),
      }),
    );
    if (destinationLockHeld) {
      return yield* new ImportDestinationInUseError({ destinationHome });
    }
  }
  // An orphan sidecar (user moved only statev2.sqlite) corrupts the imported DB when SQLite
  // replays it. When statev2.sqlite itself exists (possibly with its own -wal/-shm from a stopped
  // first boot), emptiness is checked under the lock below and its sidecars are removed with it.
  const destinationHasOrphanSidecarsOrLegacy = Effect.gen(function* () {
    if (yield* fs.exists(path.join(destinationStateDir, "state.sqlite"))) return true;
    if (yield* fs.exists(destinationDatabasePath)) return false;
    for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
      if (yield* fs.exists(`${destinationDatabasePath}${suffix}`)) return true;
    }
    return false;
  });
  if (yield* destinationHasOrphanSidecarsOrLegacy) {
    return yield* new ImportDestinationNotCleanError({ destinationHome });
  }
  const liveOwner = yield* readPersistedServerRuntimeState(sourceRuntimeStatePath).pipe(
    Effect.map(Option.filter((state) => isProcessAlive(state.pid))),
    Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
  );
  const liveOwnerWithProof = yield* Option.match(liveOwner, {
    onNone: () => Effect.succeed(Option.none<PersistedServerRuntimeState>()),
    onSome: (state) =>
      ownerIsLive(state).pipe(
        Effect.provide(ProcessRunner.layer),
        Effect.map((alive) => (alive ? Option.some(state) : Option.none())),
      ),
  });
  if (Option.isSome(liveOwnerWithProof)) {
    return yield* new ImportSourceInUseError({ sourceHome, pid: liveOwnerWithProof.value.pid });
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      // Hold the source ownership lock for the whole import when it exists, so T3 Code cannot
      // start mid-copy and tear the staged database pair. An unreadable lock is not proof of life.
      if (yield* fs.exists(sourceOwnerLockPath)) {
        yield* ServerOwnership.holdServerOwnershipLock(sourceRuntimeStatePath).pipe(
          Effect.catchTags({
            ServerAlreadyRunningError: () =>
              Effect.fail(new ImportSourceInUseError({ sourceHome })),
            ServerOwnershipError: () => Effect.void,
          }),
        );
      }
      // Stage a private copy of the source database on the destination's filesystem (never in
      // /tmp, which may be RAM-backed): the source itself is never opened (Bun refuses a
      // read-only open of a cleanly stopped WAL database), so nothing is written back to T3 Code.
      // A leftover -wal is staged too and replayed when the copy is opened.
      yield* fs.makeDirectory(destinationStateDir, { recursive: true });
      // A killed import can leak a full staged database copy; sweep those before staging again.
      for (const entry of yield* fs.readDirectory(destinationStateDir)) {
        if (entry.startsWith(".import-source-")) {
          yield* fs.remove(path.join(destinationStateDir, entry), { force: true, recursive: true });
        }
      }
      const stagingDir = yield* fs.makeTempDirectoryScoped({
        directory: destinationStateDir,
        prefix: ".import-source-",
      });
      const stagedDatabasePath = path.join(stagingDir, "statev2.sqlite");
      const stageCopy = (from: string, to: string) =>
        fs
          .copy(from, to, { overwrite: true })
          .pipe(
            Effect.mapError(
              (cause) => new ImportError({ phase: "stage", destinationDatabasePath, cause }),
            ),
          );
      yield* stageCopy(sourceDatabasePath, stagedDatabasePath);
      const sourceWalPath = `${sourceDatabasePath}-wal`;
      if (yield* fs.exists(sourceWalPath)) {
        yield* stageCopy(sourceWalPath, `${stagedDatabasePath}-wal`);
      }
      // Preflight reads against the staged copy; a refusal here leaves no database behind.
      const recorded = yield* readRecordedMigrations(stagedDatabasePath).pipe(Effect.option);
      if (Option.isNone(recorded)) {
        return yield* new ImportSourceIncompatibleError({
          sourceDatabasePath,
          detail: "the database exists but cannot be read",
        });
      }
      const plan = planUpstreamLedger(recorded.value);
      if (plan.kind === "already-current") {
        return yield* new ImportSourceIncompatibleError({
          sourceDatabasePath,
          detail:
            "its migration history matches this build exactly, so it is either already an iglo.code database or a T3 Code database from before the two builds diverged; only current T3 Code releases are importable",
        });
      }
      if (plan.kind === "refused") {
        return yield* new ImportSourceIncompatibleError({
          sourceDatabasePath,
          detail: plan.detail,
        });
      }
      const legacyThreads = yield* countUnimportedLegacyThreads(stagedDatabasePath);
      if (legacyThreads > 0) {
        return yield* new ImportLegacyThreadsError({ sourceDatabasePath, legacyThreads });
      }

      yield* Console.log(`Importing from ${sourceHome} into ${destinationHome}...`);
      yield* ServerOwnership.holdServerOwnershipLock(
        path.join(destinationStateDir, "server-runtime.json"),
      );
      // Re-check under the lock: another process could have created state while preflight ran.
      if (yield* destinationHasOrphanSidecarsOrLegacy) {
        return yield* new ImportDestinationNotCleanError({ destinationHome });
      }
      // A database the first boot created but never used (no projects, no threads) may be
      // replaced; anything else is data and refuses.
      let destinationDatabaseExisted = false;
      if (yield* fs.exists(destinationDatabasePath)) {
        destinationDatabaseExisted = true;
        if (!(yield* destinationDatabaseIsEmpty(destinationDatabasePath))) {
          return yield* new ImportDestinationNotCleanError({ destinationHome });
        }
      }
      const measured = yield* measureHomeTree(sourceHome);
      yield* Console.log(
        `Copying ${measured.files} files (${formatDataSize(measured.bytes)}) from ${sourceHome}; this can take a while on a large home...`,
      );
      yield* copyHomeTree(sourceHome, destinationHome, canonicalSource, caseInsensitive).pipe(
        Effect.mapError(
          (cause) => new ImportError({ phase: "copy", destinationDatabasePath, cause }),
        ),
      );
      // The scratch folder stays in the T3 home and is linked, so imported "No project" threads
      // keep their scratch identity (scratchProjectRoot resolves the link to its target).
      const sourceScratchDir = path.join(sourceHome, "scratch");
      if (yield* fs.exists(sourceScratchDir)) {
        yield* fs.remove(path.join(destinationHome, "scratch"), { force: true });
        yield* fs.symlink(sourceScratchDir, path.join(destinationHome, "scratch"));
      }
      yield* Console.log("Snapshotting the T3 Code database...");
      yield* fs.remove(snapshotPath, { force: true, recursive: true });
      yield* snapshotStagedDatabase(stagedDatabasePath, snapshotPath, destinationDatabasePath);
      const result = yield* migrateSnapshotDatabase(snapshotPath, destinationDatabasePath);
      // Fold the snapshot's WAL back in before promoting, so exactly one file moves.
      yield* withSqliteDatabase(
        { filename: snapshotPath },
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
        }),
      );
      yield* fs.remove(`${snapshotPath}-wal`, { force: true });
      yield* fs.remove(`${snapshotPath}-shm`, { force: true });
      yield* fs.chmod(snapshotPath, 0o600);
      yield* fs.chmod(destinationStateDir, 0o700);
      yield* Console.log(
        `Reconciled the T3 Code migration history and applied the fork-only migrations ${result.reconciled
          .map(([id, name]) => `${id}_${name}`)
          .join(", ")}.`,
      );
      yield* Console.log(
        result.migrations.length === 0
          ? "Database schema is already current."
          : `Migrations applied: ${result.migrations.map(([id, name]) => `${id}_${name}`).join(", ")}.`,
      );
      yield* Console.log(
        "Cleared T3 Code browser sessions; pair your devices again after iglo.code starts.",
      );
      const recordedWorktrees = yield* recordImportedWorktreesDir(
        destinationSettingsPath,
        path.join(sourceHome, "worktrees"),
      );
      if (recordedWorktrees) {
        yield* Console.log(
          `Worktree sandboxes stay at ${path.join(sourceHome, "worktrees")} and keep working there, managed by this server.`,
        );
      }
      // The destination database appears only now, fully migrated and with settings in place: a
      // failed import leaves no database behind, so the ask-once offer survives and retries work.
      if (destinationDatabaseExisted) {
        yield* fs.remove(destinationDatabasePath, { force: true });
        for (const suffix of DATABASE_SIDECAR_SUFFIXES) {
          yield* fs.remove(`${destinationDatabasePath}${suffix}`, { force: true });
        }
      }
      yield* fs.rename(snapshotPath, destinationDatabasePath);
      const size = Number((yield* fs.stat(destinationDatabasePath)).size);
      yield* Console.log(
        `Imported ${result.projects} projects, ${result.threads} threads (${(size / 1024 / 1024).toFixed(1)} MB database).`,
      );
      yield* Console.log("Done. Start iglo.code to pick up where T3 Code left off.");
    }).pipe(
      Effect.ensuring(
        fs.remove(snapshotPath, { force: true, recursive: true }).pipe(Effect.ignore),
      ),
    ),
  );
});

export type FirstRunOfferOutcome = "imported" | "not-imported" | "hinted" | "quit";

/** First-run offer, asked by `runServerCommand` before the server boot creates the destination
 * database. Silent whenever no one can answer or the destination is no longer clean: headless
 * startup and non-TTY starts print the one-line hint instead, dev homes (devUrl) stay fully
 * silent because their state dir is a throwaway sandbox. */
export const maybeOfferFirstRunImport = Effect.fn("maybeOfferFirstRunImport")(function* (input: {
  readonly destinationHome: string;
  readonly destinationDatabasePath: string;
  readonly presentation: "dev" | "headless" | "interactive";
  /** Test seams; defaults are the user's ~/.t3 home, the real TTY check and a real prompt. */
  readonly sourceHome?: string | undefined;
  readonly stdinIsTty?: boolean | undefined;
  readonly confirm?: (() => Effect.Effect<boolean, Terminal.QuitError>) | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const legacyDatabasePath = path.join(path.dirname(input.destinationDatabasePath), "state.sqlite");
  if (
    (yield* fs.exists(input.destinationDatabasePath)) ||
    (yield* fs.exists(legacyDatabasePath)) ||
    (yield* fs.exists(`${input.destinationDatabasePath}-wal`)) ||
    (yield* fs.exists(`${input.destinationDatabasePath}-shm`)) ||
    (yield* fs.exists(`${input.destinationDatabasePath}-journal`))
  ) {
    return "not-imported" as const;
  }
  const sourceHome = input.sourceHome ?? (yield* expandHomePath(DEFAULT_SOURCE_HOME));
  const sourceDatabasePath = path.join(sourceHome, "userdata", "statev2.sqlite");
  if (!(yield* fs.exists(sourceDatabasePath))) return "not-imported" as const;
  if (input.presentation === "dev") return "not-imported" as const;
  // A redirected stdout would hide the prompt while it still blocks, so require both fds. Saying
  // what to run instead of prompting covers serve and piped starts, once per clean home; the
  // caller treats "hinted" as "leave the home empty so the import stays possible".
  if (
    input.presentation === "headless" ||
    !(input.stdinIsTty ?? (NodeTty.isatty(0) && NodeTty.isatty(1)))
  ) {
    // Spell out --base-dir for any non-default home (including one set via IGLO_CODE_HOME, which
    // the user's shell may not have); resolveHostCliHint quotes the path for the host shell.
    const defaultHome = yield* resolveBaseDir(undefined);
    const baseDir =
      path.resolve(input.destinationHome) === path.resolve(defaultHome)
        ? Option.none<string>()
        : Option.some(input.destinationHome);
    const importCommand = yield* resolveHostCliHint("import", baseDir);
    yield* Console.log(
      `Found a T3 Code installation at ${sourceHome}. Stop this iglo.code server first, then run \`${importCommand}\` to bring its data over.`,
    );
    return "hinted" as const;
  }
  const confirm =
    input.confirm ??
    (() =>
      Prompt.run(
        Prompt.Confirm({
          message: `Found a T3 Code installation at ${sourceHome}. Import its projects, threads and settings into this empty iglo.code home?`,
          initial: true,
        }),
      ));
  const confirmed = yield* confirm().pipe(
    Effect.catchTags({ QuitError: () => Effect.succeed(null) }),
  );
  // Ctrl+C aborts the start without booting, so the offer is still there next time.
  if (confirmed === null) return "quit" as const;
  if (!confirmed) {
    yield* Console.log("Skipping the T3 Code import.");
    return "not-imported" as const;
  }
  yield* runImportT3({ sourceHome, destinationHome: input.destinationHome });
  return "imported" as const;
});

export const importT3Command = Command.make("import", {
  ...projectLocationFlags,
  from: fromFlag,
}).pipe(
  Command.withDescription(
    "One-time import of an existing T3 Code installation (threads, projects, waiting states, settings and secrets) into this iglo.code home. The destination must be clean; T3 Code must be stopped.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Like every sibling command, the flag beats IGLO_CODE_HOME, which beats the default home.
      const configuredHome = yield* Config.String("IGLO_CODE_HOME").pipe(Config.option);
      const destinationHome = yield* resolveBaseDir(
        Option.getOrUndefined(flags.baseDir) ?? Option.getOrUndefined(configuredHome),
      );
      const sourceHome = yield* expandHomePath(
        Option.isSome(flags.from) ? flags.from.value : DEFAULT_SOURCE_HOME,
      );
      yield* runImportT3({ sourceHome, destinationHome });
    }),
  ),
);

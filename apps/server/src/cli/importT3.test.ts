import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Terminal from "effect/Terminal";

// @effect-diagnostics nodeBuiltinImport:off - the lock probe needs a raw handle in-process.
import * as NodeSqlite from "node:sqlite";

import { migrationEntries, migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import {
  ImportDestinationInUseError,
  ImportDestinationNotCleanError,
  ImportError,
  ImportHomesOverlapError,
  ImportLegacyThreadsError,
  ImportSourceIncompatibleError,
  ImportSourceIsDestinationError,
  ImportSourceInUseError,
  ImportSourceMissingError,
  homesOverlap,
  maybeOfferFirstRunImport,
  runImportT3,
} from "./importT3.ts";

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const WAITING_THREAD_PAYLOAD = JSON.stringify({
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: "2099-11-18T09:00:00.000Z",
  limitRecovery: {
    runId: "run:1",
    resetAt: "2099-11-18T09:00:00.000Z",
    autoResume: true,
    snooze: false,
  },
});

/** A T3 Code home as a current release leaves it: a WAL-mode database at the upstream migration
 * ids plus the surrounding home files. throughForkId seeds a mid-stream upstream release. */
const seedSourceHome = Effect.fn("seedImportT3SourceHome")(function* (
  sourceHome: string,
  throughForkId = 100,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(sourceHome, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(stateDir, "settings.json"),
    `${JSON.stringify({ worktreesDirectory: "", autoResumeLimitedThreads: true }, null, 2)}\n`,
  );
  yield* fs.makeDirectory(path.join(stateDir, "secrets"), { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "secrets", "peer-link-token"), "token");
  yield* fs.makeDirectory(path.join(stateDir, "logs"), { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "logs", "server.trace.ndjson"), "{}\n");
  yield* fs.writeFileString(path.join(stateDir, "server-owner.sqlite"), "");
  yield* fs.makeDirectory(path.join(sourceHome, "worktrees", "sandbox-a"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "worktrees", "sandbox-a", "notes.txt"), "wip");
  yield* fs.makeDirectory(path.join(sourceHome, "caches"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "caches", "provider-status.json"), "{}");
  yield* fs.makeDirectory(path.join(sourceHome, "scratch", "no-project"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "scratch", "no-project", "wip.txt"), "wip");
  yield* fs.makeDirectory(path.join(sourceHome, "projects", "my-app"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "projects", "my-app", "index.ts"), "export {}");
  yield* fs.writeFileString(path.join(stateDir, "desktop-settings.json"), "{}");
  yield* fs.makeDirectory(path.join(sourceHome, "themes"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "themes", "desktop-wallpaper.json"), "{}");
  yield* fs.makeDirectory(path.join(sourceHome, "tools", "bin"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "tools", "bin", "tool"), "binary");
  yield* fs.makeDirectory(path.join(sourceHome, "source"), { recursive: true });
  yield* fs.writeFileString(path.join(sourceHome, "source", "clone"), "clone");
  yield* fs.makeDirectory(path.join(stateDir, "clerk"), { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "clerk", "session.json"), "{}");
  yield* fs.writeFileString(path.join(stateDir, "cloud-auth-token.json"), "credential");

  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Production databases run in WAL mode; a clean stop removes -wal/-shm.
      yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const [forkId, name, migration] of migrationEntries.filter(
        ([id]) => id > 60 && id <= throughForkId,
      )) {
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${forkId - 2}, ${name})`;
      }
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session:imported', 'owner', '[]', 'pairing', '2026-11-01', '2027-11-01')`;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES ('project:imported', 'Imported', ${path.join(sourceHome, "project")}, '[]', '2026-11-01', '2026-11-01', NULL)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES ('thread:waiting-limits', 'project:imported', 'Waiting on limits', 'claude', 'auto',
          'default', 'provider-thread:claude-waiting', '2026-11-01', '2026-11-01', NULL, NULL,
          ${WAITING_THREAD_PAYLOAD})`;
    }),
  );
  return { stateDir, databasePath };
});

describe("homesOverlap", () => {
  const overlap = (
    source: string,
    destination: string,
    canonicalSource = source,
    canonicalDestination = destination,
    caseInsensitive = false,
  ) => homesOverlap(source, destination, canonicalSource, canonicalDestination, caseInsensitive);

  it("catches plain nesting in either direction", () => {
    assert.isTrue(overlap("/homes/t3", "/homes/t3/imported"));
    assert.isTrue(overlap("/homes/t3", "/homes"));
    assert.isFalse(overlap("/homes/t3", "/homes/iglo"));
  });

  it("catches a symlinked source through the canonical pair", () => {
    // Lexically the alias and the real home are siblings; only the canonical pair sees it.
    assert.isTrue(
      overlap("/homes/alias", "/homes/real-t3/iglo", "/homes/real-t3", "/homes/real-t3/iglo"),
    );
  });

  it("catches a symlinked destination through the canonical pair", () => {
    assert.isTrue(
      overlap("/homes/real-t3", "/homes/shortcut", "/homes/real-t3", "/homes/real-t3/iglo"),
    );
  });

  it("catches case variants only on case-insensitive platforms", () => {
    assert.isTrue(
      overlap(
        "/homes/real-t3",
        "/homes/REAL-T3/iglo",
        "/homes/real-t3",
        "/homes/real-t3/iglo",
        true,
      ),
    );
    assert.isFalse(overlap("/homes/real-t3", "/homes/REAL-T3/iglo"));
  });
});

it.layer(NodeServices.layer)("importT3", (it) => {
  it.effect("imports a current T3 Code home into a clean destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      const { stateDir } = yield* seedSourceHome(sourceHome);

      yield* runImportT3({ sourceHome, destinationHome });

      const destinationStateDir = path.join(destinationHome, "userdata");
      const destinationDatabase = path.join(destinationStateDir, "statev2.sqlite");
      yield* withDatabase(
        destinationDatabase,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // The import ran the remaining migrations to completion.
          assert.deepStrictEqual(yield* runMigrations(), []);
          const sessions = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM auth_sessions`;
          assert.strictEqual(Number(sessions[0]?.count), 0);
          // The waiting-for-limits thread crossed with its recovery state intact.
          const [waiting] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = 'thread:waiting-limits'`;
          const payload = JSON.parse(waiting?.payload_json ?? "{}") as {
            readonly limitRecovery?: { readonly resetAt?: string };
          };
          assert.strictEqual(payload.limitRecovery?.resetAt, "2099-11-18T09:00:00.000Z");
        }),
      );

      const settings = JSON.parse(
        yield* fs.readFileString(path.join(destinationStateDir, "settings.json")),
      ) as {
        readonly autoResumeLimitedThreads?: boolean;
        readonly worktreesDirectory?: string;
        readonly previousWorktreesDirectories?: ReadonlyArray<string>;
      };
      assert.strictEqual(settings.autoResumeLimitedThreads, true);
      assert.strictEqual(settings.worktreesDirectory, "");
      assert.deepStrictEqual(settings.previousWorktreesDirectories, [
        path.join(sourceHome, "worktrees"),
      ]);
      assert.isTrue(yield* fs.exists(path.join(destinationStateDir, "secrets", "peer-link-token")));
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "caches")));
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "worktrees")));
      // The scratch folder stays in the T3 home and is linked, keeping "No project" identity.
      assert.strictEqual(
        yield* Effect.map(fs.lstat(path.join(destinationHome, "scratch")), (stat) => stat.type),
        "SymbolicLink",
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(destinationHome, "scratch")),
        path.join(sourceHome, "scratch"),
      );
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "tools")));
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "source")));
      // "New project" repos stay in the T3 home; the database keeps pointing there.
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "projects")));
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "clerk")));
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "cloud-auth-token.json")));
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "desktop-settings.json")));
      // The desktop-* prefix only applies at the home root and userdata/, not deeper.
      assert.isTrue(
        yield* fs.exists(path.join(destinationHome, "themes", "desktop-wallpaper.json")),
      );
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "logs")));
      assert.isFalse(
        yield* fs.exists(path.join(destinationStateDir, "statev2.sqlite.import-snapshot")),
      );

      // The source home is untouched: its ledger still ends at the upstream id.
      const sourceLedger = yield* withDatabase(
        path.join(stateDir, "statev2.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        }),
      );
      assert.strictEqual(
        sourceLedger[sourceLedger.length - 1]?.name,
        migrationManifest.at(-1)?.[1],
      );
      assert.strictEqual(sourceLedger[sourceLedger.length - 1]?.migration_id, 98);
    }),
  );

  it.effect("recreates symlinks verbatim and never follows them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-links-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outsideFile = path.join(root, "outside.txt");
      yield* fs.writeFileString(outsideFile, "outside");
      const stateDir = path.join(sourceHome, "userdata");
      // A link outside the source home is recreated verbatim.
      yield* fs.symlink(outsideFile, path.join(sourceHome, "link-outside"));
      // An absolute link into the source home is re-pointed at the copy.
      yield* fs.symlink(
        path.join(stateDir, "secrets", "peer-link-token"),
        path.join(sourceHome, "link-abs-inside"),
      );
      // A relative link into the source home already lands inside the destination.
      yield* fs.symlink("secrets/peer-link-token", path.join(stateDir, "link-rel-inside"));
      // A link to an excluded entry is skipped.
      yield* fs.symlink(path.join(stateDir, "logs"), path.join(sourceHome, "link-logs"));
      // A directory link is recreated as a link, never descended into; a cycle cannot loop.
      yield* fs.symlink(stateDir, path.join(sourceHome, "dirlink"));
      yield* fs.symlink("..", path.join(sourceHome, "cycle"));

      yield* runImportT3({ sourceHome, destinationHome });

      const destinationStateDir = path.join(destinationHome, "userdata");
      const linkType = (p: string) => Effect.map(fs.lstat(p), (stat) => stat.type);
      assert.strictEqual(
        yield* linkType(path.join(destinationHome, "link-outside")),
        "SymbolicLink",
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(destinationHome, "link-outside")),
        outsideFile,
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(destinationHome, "link-abs-inside")),
        path.join(destinationHome, "userdata", "secrets", "peer-link-token"),
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(destinationStateDir, "link-rel-inside")),
        "secrets/peer-link-token",
      );
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "link-logs")));
      assert.strictEqual(yield* linkType(path.join(destinationHome, "dirlink")), "SymbolicLink");
      assert.strictEqual(
        yield* fs.readLink(path.join(destinationHome, "dirlink")),
        destinationStateDir,
      );
      assert.strictEqual(yield* linkType(path.join(destinationHome, "cycle")), "SymbolicLink");
      // The regular file behind the links was copied; the outside file was not read through.
      assert.strictEqual(
        yield* fs.readFileString(path.join(destinationStateDir, "secrets", "peer-link-token")),
        "token",
      );
      assert.strictEqual(yield* fs.readFileString(outsideFile), "outside");
    }),
  );

  it.effect("imports a source whose write-ahead log was left behind by a crash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-wal-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      const { databasePath } = yield* seedSourceHome(sourceHome);
      // Simulate a crash: commit a marker row, then copy the database plus its live -wal aside
      // while the connection is still open, and install the pair as the source database.
      const crashDir = path.join(root, "crash");
      yield* fs.makeDirectory(crashDir, { recursive: true });
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES ('project:crash', 'Crash', ${path.join(sourceHome, "p")}, '[]', '2026-11-02', '2026-11-02', NULL)`;
          yield* fs.copy(databasePath, path.join(crashDir, "statev2.sqlite"), { overwrite: true });
          yield* fs.copy(`${databasePath}-wal`, path.join(crashDir, "statev2.sqlite-wal"), {
            overwrite: true,
          });
        }),
      );
      yield* fs.remove(databasePath);
      yield* fs.copy(path.join(crashDir, "statev2.sqlite"), databasePath, { overwrite: true });
      yield* fs.copy(path.join(crashDir, "statev2.sqlite-wal"), `${databasePath}-wal`, {
        overwrite: true,
      });

      yield* runImportT3({ sourceHome, destinationHome });

      yield* withDatabase(
        path.join(destinationHome, "userdata", "statev2.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly project_id: string }>`
            SELECT project_id FROM projection_projects WHERE project_id = 'project:crash'`;
          assert.lengthOf(rows, 1);
        }),
      );
    }),
  );

  it.effect("retries cleanly over a snapshot left by a failed import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-retry-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const destinationStateDir = path.join(destinationHome, "userdata");
      yield* fs.makeDirectory(destinationStateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(destinationStateDir, "statev2.sqlite.import-snapshot"),
        "garbage",
      );

      yield* runImportT3({ sourceHome, destinationHome });

      assert.isTrue(yield* fs.exists(path.join(destinationStateDir, "statev2.sqlite")));
      assert.isFalse(
        yield* fs.exists(path.join(destinationStateDir, "statev2.sqlite.import-snapshot")),
      );
      yield* withDatabase(
        path.join(destinationStateDir, "statev2.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [waiting] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = 'thread:waiting-limits'`;
          assert.isString(waiting?.payload_json);
        }),
      );
    }),
  );

  it.effect("refuses a destination that already holds a database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-dirty-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const destinationHome = path.join(root, "iglo-home");
      yield* fs.makeDirectory(path.join(destinationHome, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(destinationHome, "userdata", "statev2.sqlite"), "");
      const error = yield* Effect.flip(runImportT3({ sourceHome, destinationHome }));
      assert.instanceOf(error, ImportDestinationNotCleanError);
    }),
  );

  it.effect("refuses a source already written by iglo.code", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-fork-" });
      const sourceHome = path.join(root, "t3-home");
      const stateDir = path.join(sourceHome, "userdata");
      const databasePath = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(databasePath, runMigrations());
      const error = yield* Effect.flip(
        runImportT3({ sourceHome, destinationHome: path.join(root, "iglo-home") }),
      );
      assert.instanceOf(error, ImportSourceIncompatibleError);
      assert.include(error.detail, "iglo.code");
    }),
  );

  it.effect("refuses while the source server is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-live-" });
      const sourceHome = path.join(root, "t3-home");
      const stateDir = path.join(sourceHome, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(path.join(stateDir, "statev2.sqlite"), "");
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          // Far future: this process started before the record, so the pid is provably live.
          startedAt: "2099-11-18T00:00:00.000Z",
        }),
      );
      const error = yield* Effect.flip(
        runImportT3({ sourceHome, destinationHome: path.join(root, "iglo-home") }),
      );
      assert.instanceOf(error, ImportSourceInUseError);
      assert.strictEqual(error.pid, process.pid);
    }),
  );

  it.effect("refuses a source with unimported legacy threads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-legacy-" });
      const sourceHome = path.join(root, "t3-home");
      const { databasePath } = yield* seedSourceHome(sourceHome);
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO projection_threads
            (thread_id, project_id, title, created_at, updated_at)
            VALUES ('thread:legacy-v1', 'project:imported', 'Legacy', '2026-10-01', '2026-10-01')`;
        }),
      );
      const error = yield* Effect.flip(
        runImportT3({ sourceHome, destinationHome: path.join(root, "iglo-home") }),
      );
      assert.instanceOf(error, ImportLegacyThreadsError);
      assert.strictEqual(error.legacyThreads, 1);
      // The refusal runs in the preflight, so no database lands in the destination and a retry works.
      const destinationHome = path.join(root, "iglo-home");
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "userdata", "statev2.sqlite")));
    }),
  );

  it.effect("refuses while an iglo.code server runs from the destination home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-destlive-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const destinationHome = path.join(root, "iglo-home");
      const destinationStateDir = path.join(destinationHome, "userdata");
      yield* fs.makeDirectory(destinationStateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(destinationStateDir, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 4773,
          origin: "http://127.0.0.1:4773",
          startedAt: "2099-11-18T00:00:00.000Z",
        }),
      );
      const error = yield* Effect.flip(runImportT3({ sourceHome, destinationHome }));
      assert.instanceOf(error, ImportDestinationInUseError);
      assert.strictEqual(error.pid, process.pid);
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "statev2.sqlite")));
    }),
  );

  it.effect("refuses a destination with a stale database sidecar", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-sidecar-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const destinationHome = path.join(root, "iglo-home");
      const destinationStateDir = path.join(destinationHome, "userdata");
      yield* fs.makeDirectory(destinationStateDir, { recursive: true });
      // The user moved only statev2.sqlite aside; the -wal stayed behind.
      yield* fs.writeFileString(path.join(destinationStateDir, "statev2.sqlite-wal"), "stale");
      const error = yield* Effect.flip(runImportT3({ sourceHome, destinationHome }));
      assert.instanceOf(error, ImportDestinationNotCleanError);
      assert.isFalse(yield* fs.exists(path.join(destinationStateDir, "statev2.sqlite")));
    }),
  );

  it.effect("replaces a destination database that has no projects or threads yet", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-empty-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      // A first boot created a valid, empty iglo.code database (WAL mode, like the server).
      const destinationDatabase = path.join(destinationHome, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(destinationDatabase), { recursive: true });
      yield* withDatabase(
        destinationDatabase,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
          yield* runMigrations();
        }),
      );

      yield* runImportT3({ sourceHome, destinationHome });

      yield* withDatabase(
        destinationDatabase,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* runMigrations(), []);
          const [waiting] = yield* sql<{ readonly payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = 'thread:waiting-limits'`;
          assert.isString(waiting?.payload_json);
        }),
      );
    }),
  );

  it.effect("a failed copy leaves no database behind and a retry succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-copyfail-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      const { stateDir } = yield* seedSourceHome(sourceHome);
      const secretsDir = path.join(stateDir, "secrets");
      yield* fs.chmod(secretsDir, 0o000);
      const error = yield* Effect.flip(runImportT3({ sourceHome, destinationHome }));
      assert.instanceOf(error, ImportError);
      assert.strictEqual(error.phase, "copy");
      assert.isFalse(yield* fs.exists(path.join(destinationHome, "userdata", "statev2.sqlite")));
      yield* fs.chmod(secretsDir, 0o700);
      yield* runImportT3({ sourceHome, destinationHome });
      assert.isTrue(yield* fs.exists(path.join(destinationHome, "userdata", "statev2.sqlite")));
    }),
  );

  it.effect("refuses while the source ownership lock is held, without a pid record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-lock-" });
      const sourceHome = path.join(root, "t3-home");
      const { stateDir } = yield* seedSourceHome(sourceHome);
      // Hold the source ownership lock from a raw handle, with no server-runtime.json at all.
      const lock = new NodeSqlite.DatabaseSync(path.join(stateDir, "server-owner.sqlite"));
      lock.exec("BEGIN EXCLUSIVE");
      try {
        const error = yield* Effect.flip(
          runImportT3({ sourceHome, destinationHome: path.join(root, "iglo-home") }),
        );
        assert.instanceOf(error, ImportSourceInUseError);
        assert.isUndefined(error.pid);
      } finally {
        lock.exec("ROLLBACK");
        lock.close();
      }
    }),
  );

  it.effect("records the worktrees directory in a commented settings.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-commented-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      const { stateDir } = yield* seedSourceHome(sourceHome);
      yield* fs.writeFileString(
        path.join(stateDir, "settings.json"),
        `{\n  // user comment\n  "autoResumeLimitedThreads": true,\n}\n`,
      );

      yield* runImportT3({ sourceHome, destinationHome });

      const settings = JSON.parse(
        yield* fs.readFileString(path.join(destinationHome, "userdata", "settings.json")),
      ) as { readonly previousWorktreesDirectories?: ReadonlyArray<string> };
      assert.deepStrictEqual(settings.previousWorktreesDirectories, [
        path.join(sourceHome, "worktrees"),
      ]);
    }),
  );

  it.effect("refuses a destination nested inside the source home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-inside-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const error = yield* Effect.flip(
        runImportT3({ sourceHome, destinationHome: path.join(sourceHome, "imported") }),
      );
      assert.instanceOf(error, ImportHomesOverlapError);
      assert.isFalse(yield* fs.exists(path.join(sourceHome, "imported")));
    }),
  );

  it.effect("refuses a destination that contains the source home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-ancestor-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const error = yield* Effect.flip(runImportT3({ sourceHome, destinationHome: root }));
      assert.instanceOf(error, ImportHomesOverlapError);
      assert.isFalse(yield* fs.exists(path.join(root, "userdata")));
    }),
  );

  it.effect("refuses a source spelled through a symlink when the destination nests in it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-symlink-" });
      const realSourceHome = path.join(root, "real-t3-home");
      yield* seedSourceHome(realSourceHome);
      yield* fs.symlink(realSourceHome, path.join(root, "alias"));
      const error = yield* Effect.flip(
        runImportT3({
          sourceHome: path.join(root, "alias"),
          destinationHome: path.join(realSourceHome, "iglo-home"),
        }),
      );
      assert.instanceOf(error, ImportHomesOverlapError);
      assert.isFalse(yield* fs.exists(path.join(realSourceHome, "iglo-home")));
    }),
  );

  it.effect("refuses a missing source and a source used as destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-missing-" });
      const sourceHome = path.join(root, "t3-home");
      yield* seedSourceHome(sourceHome);
      const missing = yield* Effect.flip(
        runImportT3({
          sourceHome: path.join(root, "no-such-t3-home"),
          destinationHome: path.join(root, "iglo-home"),
        }),
      );
      assert.instanceOf(missing, ImportSourceMissingError);
      const itself = yield* Effect.flip(runImportT3({ sourceHome, destinationHome: sourceHome }));
      assert.instanceOf(itself, ImportSourceIsDestinationError);
    }),
  );

  it.effect("imports a mid-stream upstream release by finishing its pending migrations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-t3-midstream-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome, 62);
      yield* runImportT3({ sourceHome, destinationHome });
      yield* withDatabase(
        path.join(destinationHome, "userdata", "statev2.sqlite"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // The reconcile renumbered the ledger and the import finished the pending migrations.
          assert.deepStrictEqual(yield* runMigrations(), []);
          const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
            SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          assert.strictEqual(
            Number(ledger[ledger.length - 1]?.migration_id),
            migrationManifest.at(-1)?.[0],
          );
        }),
      );
    }),
  );

  it.effect("first-run offer stays silent for a dev or desktop-bootstrap start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-dev-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "dev",
        sourceHome,
        stdinIsTty: true,
        confirm: () => Effect.die("must not prompt"),
      });
      assert.strictEqual(outcome, "not-imported");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );

  it.effect("first-run offer prints the hint and imports nothing for headless startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-headless-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "headless",
        sourceHome,
        stdinIsTty: true,
      });
      assert.strictEqual(outcome, "hinted");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );

  it.effect("first-run offer skips without a terminal and imports nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-nontty-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "interactive",
        sourceHome,
        stdinIsTty: false,
      });
      assert.strictEqual(outcome, "hinted");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );

  it.effect("first-run offer skips a destination that already holds a database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-dirty-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      const destinationDatabasePath = path.join(destinationHome, "userdata", "statev2.sqlite");
      yield* seedSourceHome(sourceHome);
      yield* fs.makeDirectory(path.dirname(destinationDatabasePath), { recursive: true });
      yield* fs.writeFileString(destinationDatabasePath, "");
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath,
        presentation: "interactive",
        sourceHome,
        stdinIsTty: true,
      });
      assert.strictEqual(outcome, "not-imported");
      // Nothing changed: still the empty file the fixture wrote, no import ran.
      assert.strictEqual(
        yield* fs
          .readFileString(destinationDatabasePath)
          .pipe(Effect.orElseSucceed(() => "missing")),
        "",
      );
    }),
  );

  it.effect("first-run offer skips when no T3 Code home exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-nosrc-" });
      const destinationHome = path.join(root, "iglo-home");
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "interactive",
        sourceHome: path.join(root, "no-such-t3-home"),
        stdinIsTty: true,
      });
      assert.strictEqual(outcome, "not-imported");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );

  it.effect("first-run offer imports on confirmation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-yes-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "interactive",
        sourceHome,
        stdinIsTty: true,
        confirm: () => Effect.succeed(true),
      });
      assert.strictEqual(outcome, "imported");
      assert.isTrue(yield* fs.exists(path.join(destinationHome, "userdata", "statev2.sqlite")));
    }),
  );

  it.effect("first-run offer declines without writing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-no-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "interactive",
        sourceHome,
        stdinIsTty: true,
        confirm: () => Effect.succeed(false),
      });
      assert.strictEqual(outcome, "not-imported");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );

  it.effect("first-run offer quit leaves the offer available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "import-offer-quit-" });
      const sourceHome = path.join(root, "t3-home");
      const destinationHome = path.join(root, "iglo-home");
      yield* seedSourceHome(sourceHome);
      const outcome = yield* maybeOfferFirstRunImport({
        destinationHome,
        destinationDatabasePath: path.join(destinationHome, "userdata", "statev2.sqlite"),
        presentation: "interactive",
        sourceHome,
        stdinIsTty: true,
        confirm: () => new Terminal.QuitError({}),
      });
      assert.strictEqual(outcome, "quit");
      assert.isFalse(yield* fs.exists(destinationHome));
    }),
  );
});

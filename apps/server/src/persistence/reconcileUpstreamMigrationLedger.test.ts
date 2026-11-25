import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import {
  FIRST_UPSTREAM_DIVERGENT_ID,
  FORK_ONLY_MIGRATIONS,
  FORK_ONLY_MIGRATION_IDS,
  planUpstreamLedger,
  reconcileUpstreamMigrationLedger,
  UpstreamLedgerError,
  type UpstreamMigrationRow,
} from "./reconcileUpstreamMigrationLedger.ts";

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const forkRows = (): ReadonlyArray<UpstreamMigrationRow> =>
  migrationManifest.map(([id, name]) => ({ id, name }));

// Fork-only migrations are absent upstream; every later upstream migration sits densely numbered
// starting from 1 with those ids removed.
const upstreamRows = (throughForkId: number): ReadonlyArray<UpstreamMigrationRow> => {
  const rows: Array<UpstreamMigrationRow> = [];
  let upstreamId = 0;
  for (const [id, name] of migrationManifest) {
    if (FORK_ONLY_MIGRATION_IDS.has(id)) continue;
    upstreamId += 1;
    if (id <= throughForkId) rows.push({ id: upstreamId, name });
  }
  return rows;
};

/** A database as upstream T3 Code leaves it: every non-fork migration through `throughForkId`
 * applied and recorded at its dense upstream id, with all fork-only migrations absent. */
const seedUpstreamThrough = Effect.fn("seedUpstreamThrough")(function* (
  databasePath: string,
  throughForkId: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: FIRST_UPSTREAM_DIVERGENT_ID - 1 });
      let upstreamId = FIRST_UPSTREAM_DIVERGENT_ID - 1;
      for (const [forkId, name, migration] of migrationEntries) {
        if (forkId < FIRST_UPSTREAM_DIVERGENT_ID || FORK_ONLY_MIGRATION_IDS.has(forkId)) continue;
        upstreamId += 1;
        if (forkId > throughForkId) break;
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${upstreamId}, ${name})`;
      }
    }),
  );
});

describe("planUpstreamLedger", () => {
  it("keeps FORK_ONLY_MIGRATIONS aligned with migrationManifest", () => {
    const manifestById = new Map<number, string>(migrationManifest);
    for (const [id, name] of FORK_ONLY_MIGRATIONS) {
      assert.strictEqual(manifestById.get(id), name);
    }
  });

  it("refuses an empty history", () => {
    assert.strictEqual(planUpstreamLedger([]).kind, "refused");
  });

  it("recognizes a fork-shaped history", () => {
    assert.strictEqual(planUpstreamLedger(forkRows()).kind, "already-current");
  });

  it("renumbers an upstream history across every interleaved fork-only migration", () => {
    const head = migrationManifest.at(-1)?.[0] ?? 100;
    const plan = planUpstreamLedger(upstreamRows(head));
    assert.strictEqual(plan.kind, "upstream");
    if (plan.kind !== "upstream") return;
    assert.deepStrictEqual(
      plan.rows,
      migrationManifest
        .filter(([id]) => !FORK_ONLY_MIGRATION_IDS.has(id))
        .map(([id, name]) => ({ id, name })),
    );
    assert.deepStrictEqual(
      plan.missingForkMigrations,
      FORK_ONLY_MIGRATIONS.map(([id, name]) => [id, name]),
    );
    assert.strictEqual(plan.rows.at(-1)?.id, head);
    assert.strictEqual(plan.rows.at(-1)?.name, migrationManifest.at(-1)?.[1]);
    assert.isFalse(plan.rows.some((row) => FORK_ONLY_MIGRATION_IDS.has(row.id)));
  });

  it("plans only fork-only migrations below a pre-105 upstream head", () => {
    // Upstream 102_ThreadItemCounts maps to fork 104, right before fork-only 105_PeerLinkSessionBinding.
    const plan = planUpstreamLedger(upstreamRows(104));
    assert.strictEqual(plan.kind, "upstream");
    if (plan.kind !== "upstream") return;
    assert.deepStrictEqual(plan.missingForkMigrations, [
      [59, "ScheduledTaskDelivery"],
      [60, "ScheduleDispatchTargets"],
    ]);
    assert.strictEqual(plan.rows.at(-1)?.id, 104);
    assert.strictEqual(plan.rows.at(-1)?.name, "ThreadItemCounts");
  });

  it("refuses a migration name this build does not know", () => {
    const plan = planUpstreamLedger([
      ...upstreamRows(61),
      { id: 60, name: "UnknownFutureMigration" },
    ]);
    assert.strictEqual(plan.kind, "refused");
    assert.include(plan.kind === "refused" ? plan.detail : "", "UnknownFutureMigration");
  });

  it("refuses a fork plugin build's misplaced ledger entry", () => {
    const plan = planUpstreamLedger([
      ...upstreamRows(58),
      { id: 59, name: "ScheduleDispatchTargets" },
    ]);
    assert.strictEqual(plan.kind, "refused");
  });

  it("refuses a post-105 upstream migration at the wrong offset", () => {
    const plan = planUpstreamLedger([
      ...upstreamRows(104),
      { id: 104, name: "IssueTrackerAdditionalScopes" },
    ]);
    assert.strictEqual(plan.kind, "refused");
  });
});

it.layer(NodeServices.layer)("reconcileUpstreamMigrationLedger", (it) => {
  it.effect(
    "renumbers an upstream ledger, applies all fork-only migrations, and leaves nothing pending",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-ledger-" });
        const databasePath = path.join(directory, "statev2.sqlite");
        yield* seedUpstreamThrough(databasePath, migrationManifest.at(-1)?.[0] ?? 100);

        const applied = yield* withDatabase(
          databasePath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const applied = yield* reconcileUpstreamMigrationLedger();
            const ledger = yield* sql<{ readonly migration_id: number; readonly name: string }>`
              SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
            assert.deepStrictEqual(
              ledger.map((row) => [Number(row.migration_id), row.name]),
              migrationManifest.map(([id, name]) => [id, name]),
            );
            const scheduledTaskColumns = yield* sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info('scheduled_tasks')
              WHERE name IN ('last_delivery', 'dispatch_target_json')`;
            assert.lengthOf(scheduledTaskColumns, 2);
            const occurrences = yield* sql<{ readonly name: string }>`
              SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_task_occurrences'`;
            assert.lengthOf(occurrences, 1);
            const peerLinkColumns = yield* sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info('peer_environment_links')
              WHERE name = 'peer_session_id'`;
            assert.lengthOf(peerLinkColumns, 1);
            const authSessionColumns = yield* sql<{ readonly name: string }>`
              SELECT name FROM pragma_table_info('auth_sessions')
              WHERE name = 'pairing_grant_id'`;
            assert.lengthOf(authSessionColumns, 1);
            const timestamps = yield* sql<{ readonly created_at: string | null }>`
              SELECT created_at FROM effect_sql_migrations WHERE migration_id IN (61, 106)`;
            assert.lengthOf(timestamps, 2);
            for (const row of timestamps) assert.isNotNull(row.created_at);
            assert.deepStrictEqual(yield* runMigrations(), []);
            return applied;
          }),
        );

        assert.deepStrictEqual(
          applied,
          FORK_ONLY_MIGRATIONS.map(([id, name]) => [id, name]),
        );
      }),
  );

  it.effect(
    "reconciles a pre-105 upstream ledger and lets runMigrations apply 105 and later migrations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-pre105-" });
        const databasePath = path.join(directory, "statev2.sqlite");
        // Fork 104 = upstream 102_ThreadItemCounts (before fork-only 105_PeerLinkSessionBinding).
        yield* seedUpstreamThrough(databasePath, 104);

        const applied = yield* withDatabase(
          databasePath,
          Effect.gen(function* () {
            const applied = yield* reconcileUpstreamMigrationLedger();
            const pending = yield* runMigrations();
            assert.strictEqual(pending[0]?.[0], 105);
            assert.strictEqual(pending[0]?.[1], "PeerLinkSessionBinding");
            assert.deepStrictEqual(yield* runMigrations(), []);
            return applied;
          }),
        );

        assert.deepStrictEqual(applied, [
          [59, "ScheduledTaskDelivery"],
          [60, "ScheduleDispatchTargets"],
        ]);
      }),
  );

  it.effect(
    "reconciles a mid-stream post-105 upstream ledger (e.g. T3 0.1.12 at upstream 111)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-post105-" });
        const databasePath = path.join(directory, "statev2.sqlite");
        // Fork 114 = upstream 111_SupersededRunAttemptIndex; 115..head remain pending for runMigrations.
        yield* seedUpstreamThrough(databasePath, 114);

        const applied = yield* withDatabase(
          databasePath,
          Effect.gen(function* () {
            const applied = yield* reconcileUpstreamMigrationLedger();
            const pending = yield* runMigrations();
            assert.strictEqual(pending[0]?.[0], 115);
            assert.deepStrictEqual(yield* runMigrations(), []);
            return applied;
          }),
        );

        assert.deepStrictEqual(
          applied,
          FORK_ONLY_MIGRATIONS.map(([id, name]) => [id, name]),
        );
      }),
  );

  it.effect("refuses a ledger with an unknown migration", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-unknown-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      yield* seedUpstreamThrough(databasePath, 62);
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'UnknownFutureMigration')`;
        }),
      );
      const error = yield* withDatabase(
        databasePath,
        Effect.flip(reconcileUpstreamMigrationLedger()),
      );
      assert.instanceOf(error, UpstreamLedgerError);
      assert.include(error.detail, "UnknownFutureMigration");
    }),
  );

  it.effect("leaves a fork-shaped ledger untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-current-" });
      const databasePath = path.join(directory, "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* withDatabase(
        databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations();
          assert.deepStrictEqual(yield* reconcileUpstreamMigrationLedger(), []);
          const ledger = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM effect_sql_migrations`;
          assert.strictEqual(Number(ledger[0]?.count), migrationManifest.length);
        }),
      );
    }),
  );
});

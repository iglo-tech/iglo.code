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

// Fork ids 59/60 are fork-only and absent upstream; ids 61+ sit two lower there.
const upstreamRows = (throughForkId: number): ReadonlyArray<UpstreamMigrationRow> =>
  migrationManifest
    .filter(([id]) => id <= throughForkId && id !== 59 && id !== 60)
    .map(([id, name]) => ({
      id: id < FIRST_UPSTREAM_DIVERGENT_ID ? id : id - 2,
      name,
    }));

/** A database as upstream T3 Code leaves it: fork migrations 61+ applied and recorded two ids lower,
 * with the fork-only 59/60 absent. */
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
      yield* runMigrations({ toMigrationInclusive: 58 });
      for (const [forkId, name, migration] of migrationEntries.filter(
        ([id]) => id > 60 && id <= throughForkId,
      )) {
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${forkId - 2}, ${name})`;
      }
    }),
  );
});

describe("planUpstreamLedger", () => {
  it("refuses an empty history", () => {
    assert.strictEqual(planUpstreamLedger([]).kind, "refused");
  });

  it("recognizes a fork-shaped history", () => {
    assert.strictEqual(planUpstreamLedger(forkRows()).kind, "already-current");
  });

  it("renumbers an upstream history two ids up from the divergence", () => {
    const head = migrationManifest.at(-1)?.[0] ?? 100;
    const plan = planUpstreamLedger(upstreamRows(head));
    assert.strictEqual(plan.kind, "upstream");
    if (plan.kind !== "upstream") return;
    const renumbered = FIRST_UPSTREAM_DIVERGENT_ID + 2;
    assert.deepStrictEqual(
      plan.rows.filter((row) => row.id >= renumbered),
      migrationManifest.filter(([id]) => id >= renumbered).map(([id, name]) => ({ id, name })),
    );
    assert.strictEqual(plan.rows.at(-1)?.id, head);
    assert.strictEqual(plan.rows.at(-1)?.name, migrationManifest.at(-1)?.[1]);
    assert.isFalse(plan.rows.some((row) => row.id === 59 || row.id === 60));
  });

  it("refuses a migration name this build does not know", () => {
    const plan = planUpstreamLedger([
      ...upstreamRows(60),
      { id: 61, name: "UnknownFutureMigration" },
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
});

it.layer(NodeServices.layer)("reconcileUpstreamMigrationLedger", (it) => {
  it.effect(
    "renumbers an upstream ledger, applies the fork-only migrations, and leaves nothing pending",
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
            const timestamps = yield* sql<{ readonly created_at: string | null }>`
            SELECT created_at FROM effect_sql_migrations WHERE migration_id = 61`;
            assert.isNotNull(timestamps[0]?.created_at);
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

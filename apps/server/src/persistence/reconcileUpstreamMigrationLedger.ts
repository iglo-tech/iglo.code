import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "./Migrations.ts";
import Migration0059 from "./Migrations/059_ScheduledTaskDelivery.ts";
import Migration0060 from "./Migrations/060_ScheduleDispatchTargets.ts";

// The fork carries two extra migrations at 59/60, so every upstream T3 Code migration from 59 on
// sits two ids lower there. Renumber by name so later upstream releases stay importable after a sync.
export const FIRST_UPSTREAM_DIVERGENT_ID = 59;

export interface UpstreamMigrationRow {
  readonly id: number;
  readonly name: string;
}

export type UpstreamLedgerPlan =
  | { readonly kind: "already-current" }
  | { readonly kind: "upstream"; readonly rows: ReadonlyArray<UpstreamMigrationRow> }
  | { readonly kind: "refused"; readonly detail: string };

export function planUpstreamLedger(
  recorded: ReadonlyArray<UpstreamMigrationRow>,
  manifest: ReadonlyArray<readonly [id: number, name: string]> = migrationManifest,
): UpstreamLedgerPlan {
  if (recorded.length === 0) {
    return { kind: "refused", detail: "no migrations are recorded in this database" };
  }
  const forkNameById = new Map(manifest.map(([id, name]) => [id, name] as const));
  if (recorded.every((row) => forkNameById.get(row.id) === row.name)) {
    return { kind: "already-current" };
  }
  const forkIdByName = new Map(manifest.map(([id, name]) => [name, id] as const));
  const rows: Array<UpstreamMigrationRow> = [];
  for (const row of recorded) {
    const forkId = forkIdByName.get(row.name);
    if (forkId === undefined) {
      return {
        kind: "refused",
        detail: `migration ${row.id}_${row.name} is unknown to this iglo.code build`,
      };
    }
    const expectedId = row.id < FIRST_UPSTREAM_DIVERGENT_ID ? row.id : row.id + 2;
    if (forkId !== expectedId) {
      return {
        kind: "refused",
        detail: `migration ${row.id}_${row.name} would move to ${forkId}, not ${expectedId}; the history is neither upstream T3 Code nor this build`,
      };
    }
    rows.push(row.id < FIRST_UPSTREAM_DIVERGENT_ID ? row : { id: forkId, name: row.name });
  }
  return { kind: "upstream", rows };
}

export class UpstreamLedgerError extends Schema.TaggedError<UpstreamLedgerError>()(
  "UpstreamLedgerError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Cannot import this database: ${this.detail}. Update iglo.code, or import from a stock T3 Code installation.`;
  }
}

const APPLIED_UPSTREAM_GAP: ReadonlyArray<readonly [id: number, name: string]> = [
  [59, "ScheduledTaskDelivery"],
  [60, "ScheduleDispatchTargets"],
];

/** One-time import step: renumber an upstream T3 Code ledger to this build's ids and apply the
 * fork-only migrations the source never ran. A fork-shaped ledger is left untouched. */
export const reconcileUpstreamMigrationLedger = Effect.fn("reconcileUpstreamMigrationLedger")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const recorded = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id >= ${FIRST_UPSTREAM_DIVERGENT_ID}`;
    const plan = planUpstreamLedger(
      (yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `).map((row) => ({ id: Number(row.migration_id), name: row.name })),
    );
    if (plan.kind === "refused") return yield* new UpstreamLedgerError({ detail: plan.detail });
    if (plan.kind === "already-current") return [];
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* Migration0059;
        yield* Migration0060;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_UPSTREAM_DIVERGENT_ID}`;
        const createdAtByName = new Map(recorded.map((row) => [row.name, row.created_at] as const));
        const rewritten = plan.rows.filter((row) => row.id >= FIRST_UPSTREAM_DIVERGENT_ID + 2);
        for (const row of rewritten) {
          const createdAt = createdAtByName.get(row.name) ?? null;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (${row.id}, ${row.name}, ${createdAt})`;
        }
        for (const [id, name] of APPLIED_UPSTREAM_GAP) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
      }),
    );
    return APPLIED_UPSTREAM_GAP;
  },
);

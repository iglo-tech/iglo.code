import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest } from "./Migrations.ts";
import Migration0059 from "./Migrations/059_ScheduledTaskDelivery.ts";
import Migration0060 from "./Migrations/060_ScheduleDispatchTargets.ts";
import Migration0105 from "./Migrations/105_PeerLinkSessionBinding.ts";

// Fork-only migrations interleaved into upstream T3 Code's sequence. Every upstream migration
// after each insertion sits lower there by the count of preceding fork-only migrations.
// Keep ordered by id; when adding a new fork-only migration, append it here and run the
// reconcileUpstreamMigrationLedger and importT3 tests.
export const FORK_ONLY_MIGRATIONS = [
  [59, "ScheduledTaskDelivery", Migration0059],
  [60, "ScheduleDispatchTargets", Migration0060],
  [105, "PeerLinkSessionBinding", Migration0105],
] as const;

export const FORK_ONLY_MIGRATION_IDS: ReadonlySet<number> = new Set<number>(
  FORK_ONLY_MIGRATIONS.map(([id]) => id),
);

export const FIRST_UPSTREAM_DIVERGENT_ID = FORK_ONLY_MIGRATIONS[0][0];

export interface UpstreamMigrationRow {
  readonly id: number;
  readonly name: string;
}

export type UpstreamLedgerPlan =
  | { readonly kind: "already-current" }
  | {
      readonly kind: "upstream";
      readonly rows: ReadonlyArray<UpstreamMigrationRow>;
      readonly missingForkMigrations: ReadonlyArray<readonly [id: number, name: string]>;
    }
  | { readonly kind: "refused"; readonly detail: string };

export function planUpstreamLedger(
  recorded: ReadonlyArray<UpstreamMigrationRow>,
  manifest: ReadonlyArray<readonly [id: number, name: string]> = migrationManifest,
  forkOnlyIds: ReadonlySet<number> = FORK_ONLY_MIGRATION_IDS,
): UpstreamLedgerPlan {
  if (recorded.length === 0) {
    return { kind: "refused", detail: "no migrations are recorded in this database" };
  }
  const forkNameById = new Map(manifest.map(([id, name]) => [id, name] as const));
  if (recorded.every((row) => forkNameById.get(row.id) === row.name)) {
    return { kind: "already-current" };
  }
  // Every non-fork entry in `manifest` appears in upstream T3 Code in the same relative order,
  // numbered densely from 1. Each fork-only migration inserted earlier shifts later upstream ids.
  const expectedUpstreamByForkId = new Map<number, number>();
  let upstreamOrdinal = 0;
  for (const [id] of manifest) {
    if (forkOnlyIds.has(id)) continue;
    upstreamOrdinal += 1;
    expectedUpstreamByForkId.set(id, upstreamOrdinal);
  }
  const forkIdByName = new Map(manifest.map(([id, name]) => [name, id] as const));
  const rows: Array<UpstreamMigrationRow> = [];
  let maxMappedForkId = 0;
  for (const row of recorded) {
    const forkId = forkIdByName.get(row.name);
    if (forkId === undefined) {
      return {
        kind: "refused",
        detail: `migration ${row.id}_${row.name} is unknown to this iglo.code build`,
      };
    }
    const expectedUpstreamId = expectedUpstreamByForkId.get(forkId);
    if (expectedUpstreamId === undefined) {
      return {
        kind: "refused",
        detail: `migration ${row.id}_${row.name} is a fork-only migration; the history is neither upstream T3 Code nor this build`,
      };
    }
    if (row.id !== expectedUpstreamId) {
      return {
        kind: "refused",
        detail: `migration ${row.id}_${row.name} is at upstream id ${row.id}, expected ${expectedUpstreamId} (fork id ${forkId}); the history is neither upstream T3 Code nor this build`,
      };
    }
    if (forkId > maxMappedForkId) maxMappedForkId = forkId;
    rows.push({ id: forkId, name: row.name });
  }
  // Only apply fork-only migrations that sit below the highest recorded upstream migration;
  // any fork-only migration above maxMappedForkId will run in normal order via runMigrations().
  const missingForkMigrations = manifest.filter(
    ([id]) => forkOnlyIds.has(id) && id < maxMappedForkId,
  );
  return { kind: "upstream", rows, missingForkMigrations };
}

export class UpstreamLedgerError extends Schema.TaggedError<UpstreamLedgerError>()(
  "UpstreamLedgerError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `Cannot import this database: ${this.detail}. Update iglo.code, or import from a stock T3 Code installation.`;
  }
}

const forkOnlyMigrationById = new Map<
  number,
  {
    readonly name: string;
    readonly effect: (typeof FORK_ONLY_MIGRATIONS)[number][2];
  }
>(FORK_ONLY_MIGRATIONS.map(([id, name, effect]) => [id, { name, effect }] as const));

/** One-time import step: renumber an upstream T3 Code ledger to this build's ids and apply any
 * fork-only migrations sitting below the source's head. A fork-shaped ledger is left untouched. */
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
        for (const [id, name] of plan.missingForkMigrations) {
          const entry = forkOnlyMigrationById.get(id);
          if (entry === undefined || entry.name !== name) {
            return yield* new UpstreamLedgerError({
              detail: `missing fork-only migration ${id}_${name} has no registered handler`,
            });
          }
          yield* entry.effect;
        }
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= ${FIRST_UPSTREAM_DIVERGENT_ID}`;
        const createdAtByName = new Map(recorded.map((row) => [row.name, row.created_at] as const));
        const rewritten = plan.rows.filter((row) => row.id >= FIRST_UPSTREAM_DIVERGENT_ID);
        for (const row of rewritten) {
          const createdAt = createdAtByName.get(row.name) ?? null;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (${row.id}, ${row.name}, ${createdAt})`;
        }
        for (const [id, name] of plan.missingForkMigrations) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
      }),
    );
    return plan.missingForkMigrations;
  },
);

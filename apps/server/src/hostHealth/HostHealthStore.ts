import type {
  HostHealthHistory,
  HostHealthHistoryPoint,
  HostHealthRange,
  HostHealthSnapshot,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";

// Raw samples only answer the 1h range; longer ranges read the rollups.
const RAW_RETENTION_MS = 2 * 60 * 60_000;
const ROLLUP_1M_RETENTION_MS = 7 * 24 * 60 * 60_000;
const ROLLUP_15M_RETENTION_MS = 30 * 24 * 60 * 60_000;

const BUCKET_1M_MS = 60_000;
const BUCKET_15M_MS = 15 * 60_000;

export const RANGE_QUERY_CONFIG: Record<
  HostHealthRange,
  {
    readonly windowMs: number;
    readonly resolutionSeconds: number;
  }
> = {
  "1h": { windowMs: 60 * 60_000, resolutionSeconds: 10 },
  "24h": { windowMs: 24 * 60 * 60_000, resolutionSeconds: 120 },
  "7d": { windowMs: 7 * 24 * 60 * 60_000, resolutionSeconds: 900 },
  "30d": { windowMs: 30 * 24 * 60 * 60_000, resolutionSeconds: 3600 },
};

export class HostHealthStoreError extends Schema.TaggedError<HostHealthStoreError>()(
  "HostHealthStoreError",
  {
    operation: Schema.Literals(["init", "record", "prune", "query"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Host health store ${this.operation} failed.`;
  }
}

export class HostHealthStore extends Context.Service<
  HostHealthStore,
  {
    readonly record: (snapshot: HostHealthSnapshot) => Effect.Effect<void, HostHealthStoreError>;
    readonly prune: (nowMs: number) => Effect.Effect<void, HostHealthStoreError>;
    readonly readHistory: (
      range: HostHealthRange,
      nowMs: number,
    ) => Effect.Effect<HostHealthHistory, HostHealthStoreError>;
  }
>()("t3/hostHealth/HostHealthStore") {}

interface RawRow {
  readonly bucket_ms: number;
  readonly cpu_percent: number | null;
  readonly load_1m: number;
  readonly mem_used: number;
  readonly mem_total: number;
  readonly swap_used: number;
  readonly disk_read_bps: number | null;
  readonly disk_write_bps: number | null;
  readonly net_rx_bps: number | null;
  readonly net_tx_bps: number | null;
  readonly max_temp_c: number | null;
}

interface RollupAggRow {
  readonly bucket_ms: number;
  readonly sample_count: number;
  readonly cpu_sum: number;
  readonly cpu_count: number;
  readonly load_1m_sum: number;
  readonly mem_used_sum: number;
  readonly mem_total_last: number;
  readonly swap_used_sum: number;
  readonly disk_read_sum: number;
  readonly disk_read_count: number;
  readonly disk_write_sum: number;
  readonly disk_write_count: number;
  readonly net_rx_sum: number;
  readonly net_rx_count: number;
  readonly net_tx_sum: number;
  readonly net_tx_count: number;
  readonly max_temp_c: number | null;
}

function maxTemperatureOf(snapshot: HostHealthSnapshot): number | null {
  let max: number | null = null;
  for (const sensor of snapshot.sensors) {
    if (sensor.kind !== "temperature") continue;
    max = max === null ? sensor.value : Math.max(max, sensor.value);
  }
  return max;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mapRawRow(row: RawRow): HostHealthHistoryPoint {
  return {
    timestamp: row.bucket_ms,
    cpuPercent: row.cpu_percent === null ? null : round1(row.cpu_percent),
    load1m: Math.round(row.load_1m * 100) / 100,
    memoryUsedBytes: Math.max(0, Math.round(row.mem_used)),
    memoryTotalBytes: Math.max(0, Math.round(row.mem_total)),
    swapUsedBytes: Math.max(0, Math.round(row.swap_used)),
    diskReadBytesPerSec:
      row.disk_read_bps === null ? null : Math.max(0, Math.round(row.disk_read_bps)),
    diskWriteBytesPerSec:
      row.disk_write_bps === null ? null : Math.max(0, Math.round(row.disk_write_bps)),
    netRxBytesPerSec: row.net_rx_bps === null ? null : Math.max(0, Math.round(row.net_rx_bps)),
    netTxBytesPerSec: row.net_tx_bps === null ? null : Math.max(0, Math.round(row.net_tx_bps)),
    maxTempCelsius: row.max_temp_c === null ? null : round1(row.max_temp_c),
  };
}

function mapRollupRow(row: RollupAggRow): HostHealthHistoryPoint {
  const count = Math.max(1, row.sample_count);
  return {
    timestamp: row.bucket_ms,
    cpuPercent: row.cpu_count > 0 ? round1(row.cpu_sum / row.cpu_count) : null,
    load1m: Math.round((row.load_1m_sum / count) * 100) / 100,
    memoryUsedBytes: Math.max(0, Math.round(row.mem_used_sum / count)),
    memoryTotalBytes: Math.max(0, Math.round(row.mem_total_last)),
    swapUsedBytes: Math.max(0, Math.round(row.swap_used_sum / count)),
    diskReadBytesPerSec:
      row.disk_read_count > 0
        ? Math.max(0, Math.round(row.disk_read_sum / row.disk_read_count))
        : null,
    diskWriteBytesPerSec:
      row.disk_write_count > 0
        ? Math.max(0, Math.round(row.disk_write_sum / row.disk_write_count))
        : null,
    netRxBytesPerSec:
      row.net_rx_count > 0 ? Math.max(0, Math.round(row.net_rx_sum / row.net_rx_count)) : null,
    netTxBytesPerSec:
      row.net_tx_count > 0 ? Math.max(0, Math.round(row.net_tx_sum / row.net_tx_count)) : null,
    maxTempCelsius: row.max_temp_c === null ? null : round1(row.max_temp_c),
  };
}

const initSchema = Effect.fn("HostHealthStore.initSchema")(
  function* (sql: SqlClient.SqlClient) {
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* sql`PRAGMA temp_store = MEMORY;`;

    yield* sql`
      CREATE TABLE IF NOT EXISTS host_health_raw (
        bucket_ms INTEGER PRIMARY KEY,
        cpu_percent REAL,
        load_1m REAL NOT NULL,
        mem_used INTEGER NOT NULL,
        mem_total INTEGER NOT NULL,
        swap_used INTEGER NOT NULL,
        disk_read_bps REAL,
        disk_write_bps REAL,
        net_rx_bps REAL,
        net_tx_bps REAL,
        max_temp_c REAL
      )
    `;

    const createRollupTable = (table: "host_health_1m" | "host_health_15m") =>
      sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${table} (
          bucket_ms INTEGER PRIMARY KEY,
          sample_count INTEGER NOT NULL,
          cpu_sum REAL NOT NULL,
          cpu_count INTEGER NOT NULL,
          load_1m_sum REAL NOT NULL,
          mem_used_sum INTEGER NOT NULL,
          mem_total_last INTEGER NOT NULL,
          swap_used_sum INTEGER NOT NULL,
          disk_read_sum REAL NOT NULL,
          disk_read_count INTEGER NOT NULL,
          disk_write_sum REAL NOT NULL,
          disk_write_count INTEGER NOT NULL,
          net_rx_sum REAL NOT NULL,
          net_rx_count INTEGER NOT NULL,
          net_tx_sum REAL NOT NULL,
          net_tx_count INTEGER NOT NULL,
          max_temp_c REAL
        )
      `);

    yield* createRollupTable("host_health_1m");
    yield* createRollupTable("host_health_15m");
  },
  Effect.mapError((cause) => new HostHealthStoreError({ operation: "init", cause })),
);

const makeWithClient = Effect.fn("HostHealthStore.make")(function* (sql: SqlClient.SqlClient) {
  yield* initSchema(sql);

  const upsertRollup = (
    table: "host_health_1m" | "host_health_15m",
    bucketMs: number,
    snapshot: HostHealthSnapshot,
    maxTempC: number | null,
  ) => {
    const cpuVal = snapshot.cpu.utilizationPercent ?? 0;
    const cpuCount = snapshot.cpu.utilizationPercent === null ? 0 : 1;
    const diskReadVal = snapshot.diskIo.readBytesPerSec ?? 0;
    const diskReadCount = snapshot.diskIo.readBytesPerSec === null ? 0 : 1;
    const diskWriteVal = snapshot.diskIo.writeBytesPerSec ?? 0;
    const diskWriteCount = snapshot.diskIo.writeBytesPerSec === null ? 0 : 1;
    const netRxVal = snapshot.network.rxBytesPerSec ?? 0;
    const netRxCount = snapshot.network.rxBytesPerSec === null ? 0 : 1;
    const netTxVal = snapshot.network.txBytesPerSec ?? 0;
    const netTxCount = snapshot.network.txBytesPerSec === null ? 0 : 1;

    return sql.unsafe(
      `
      INSERT INTO ${table} (
        bucket_ms, sample_count,
        cpu_sum, cpu_count,
        load_1m_sum, mem_used_sum, mem_total_last, swap_used_sum,
        disk_read_sum, disk_read_count,
        disk_write_sum, disk_write_count,
        net_rx_sum, net_rx_count,
        net_tx_sum, net_tx_count,
        max_temp_c
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_ms) DO UPDATE SET
        sample_count = sample_count + 1,
        cpu_sum = cpu_sum + excluded.cpu_sum,
        cpu_count = cpu_count + excluded.cpu_count,
        load_1m_sum = load_1m_sum + excluded.load_1m_sum,
        mem_used_sum = mem_used_sum + excluded.mem_used_sum,
        mem_total_last = excluded.mem_total_last,
        swap_used_sum = swap_used_sum + excluded.swap_used_sum,
        disk_read_sum = disk_read_sum + excluded.disk_read_sum,
        disk_read_count = disk_read_count + excluded.disk_read_count,
        disk_write_sum = disk_write_sum + excluded.disk_write_sum,
        disk_write_count = disk_write_count + excluded.disk_write_count,
        net_rx_sum = net_rx_sum + excluded.net_rx_sum,
        net_rx_count = net_rx_count + excluded.net_rx_count,
        net_tx_sum = net_tx_sum + excluded.net_tx_sum,
        net_tx_count = net_tx_count + excluded.net_tx_count,
        max_temp_c = CASE
          WHEN max_temp_c IS NULL THEN excluded.max_temp_c
          WHEN excluded.max_temp_c IS NULL THEN max_temp_c
          ELSE MAX(max_temp_c, excluded.max_temp_c)
        END
      `,
      [
        bucketMs,
        cpuVal,
        cpuCount,
        snapshot.cpu.load1m,
        snapshot.memory.usedBytes,
        snapshot.memory.totalBytes,
        snapshot.memory.swapUsedBytes,
        diskReadVal,
        diskReadCount,
        diskWriteVal,
        diskWriteCount,
        netRxVal,
        netRxCount,
        netTxVal,
        netTxCount,
        maxTempC,
      ],
    );
  };

  const record: HostHealthStore["Service"]["record"] = Effect.fn("HostHealthStore.record")(
    function* (snapshot) {
      const maxTempC = maxTemperatureOf(snapshot);
      const bucket1m = Math.floor(snapshot.sampledAt / BUCKET_1M_MS) * BUCKET_1M_MS;
      const bucket15m = Math.floor(snapshot.sampledAt / BUCKET_15M_MS) * BUCKET_15M_MS;

      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT OR REPLACE INTO host_health_raw (
              bucket_ms, cpu_percent, load_1m, mem_used, mem_total, swap_used,
              disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps, max_temp_c
            ) VALUES (
              ${snapshot.sampledAt},
              ${snapshot.cpu.utilizationPercent},
              ${snapshot.cpu.load1m},
              ${snapshot.memory.usedBytes},
              ${snapshot.memory.totalBytes},
              ${snapshot.memory.swapUsedBytes},
              ${snapshot.diskIo.readBytesPerSec},
              ${snapshot.diskIo.writeBytesPerSec},
              ${snapshot.network.rxBytesPerSec},
              ${snapshot.network.txBytesPerSec},
              ${maxTempC}
            )
          `;
          yield* upsertRollup("host_health_1m", bucket1m, snapshot, maxTempC);
          yield* upsertRollup("host_health_15m", bucket15m, snapshot, maxTempC);
        }),
      );
    },
    Effect.mapError((cause) => new HostHealthStoreError({ operation: "record", cause })),
  );

  const prune: HostHealthStore["Service"]["prune"] = Effect.fn("HostHealthStore.prune")(
    function* (nowMs) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM host_health_raw WHERE bucket_ms < ${nowMs - RAW_RETENTION_MS}`;
          yield* sql`DELETE FROM host_health_1m WHERE bucket_ms < ${nowMs - ROLLUP_1M_RETENTION_MS}`;
          yield* sql`DELETE FROM host_health_15m WHERE bucket_ms < ${nowMs - ROLLUP_15M_RETENTION_MS}`;
        }),
      );
    },
    Effect.mapError((cause) => new HostHealthStoreError({ operation: "prune", cause })),
  );

  const queryGroupedRollup = (
    table: "host_health_1m" | "host_health_15m",
    sinceMs: number,
    groupBucketMs: number,
  ) =>
    sql.unsafe<RollupAggRow>(
      `
      SELECT
        bucket_ms - (bucket_ms % ?) AS bucket_ms,
        SUM(sample_count) AS sample_count,
        SUM(cpu_sum) AS cpu_sum,
        SUM(cpu_count) AS cpu_count,
        SUM(load_1m_sum) AS load_1m_sum,
        SUM(mem_used_sum) AS mem_used_sum,
        MAX(mem_total_last) AS mem_total_last,
        SUM(swap_used_sum) AS swap_used_sum,
        SUM(disk_read_sum) AS disk_read_sum,
        SUM(disk_read_count) AS disk_read_count,
        SUM(disk_write_sum) AS disk_write_sum,
        SUM(disk_write_count) AS disk_write_count,
        SUM(net_rx_sum) AS net_rx_sum,
        SUM(net_rx_count) AS net_rx_count,
        SUM(net_tx_sum) AS net_tx_sum,
        SUM(net_tx_count) AS net_tx_count,
        MAX(max_temp_c) AS max_temp_c
      FROM ${table}
      WHERE bucket_ms >= ?
      GROUP BY bucket_ms - (bucket_ms % ?)
      ORDER BY bucket_ms ASC
      `,
      // `%` works on integers, where `/` on a bound JS number would divide as REAL.
      [groupBucketMs, sinceMs, groupBucketMs],
    );

  const readHistory: HostHealthStore["Service"]["readHistory"] = Effect.fn(
    "HostHealthStore.readHistory",
  )(
    function* (range, nowMs) {
      const { windowMs, resolutionSeconds } = RANGE_QUERY_CONFIG[range];
      const sinceMs = Math.max(0, nowMs - windowMs);

      if (range === "1h") {
        const rows = yield* sql<RawRow>`
          SELECT
            bucket_ms, cpu_percent, load_1m, mem_used, mem_total, swap_used,
            disk_read_bps, disk_write_bps, net_rx_bps, net_tx_bps, max_temp_c
          FROM host_health_raw
          WHERE bucket_ms >= ${sinceMs}
          ORDER BY bucket_ms ASC
        `;
        return {
          range,
          resolutionSeconds,
          points: rows.map(mapRawRow),
        };
      }

      const table = range === "30d" ? "host_health_15m" : "host_health_1m";
      const rows = yield* queryGroupedRollup(table, sinceMs, resolutionSeconds * 1000);
      return {
        range,
        resolutionSeconds,
        points: rows.map(mapRollupRow),
      };
    },
    Effect.mapError((cause) => new HostHealthStoreError({ operation: "query", cause })),
  );

  return HostHealthStore.of({ record, prune, readHistory });
});

const layerFromPath = (dbPath: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      if (dbPath !== ":memory:") {
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      }
      // Its own file: a sample every few seconds would otherwise churn the main event store.
      const clientLayer = NodeSqliteClient.layer({ filename: dbPath });
      return Layer.effect(
        HostHealthStore,
        Effect.flatMap(SqlClient.SqlClient, makeWithClient),
      ).pipe(Layer.provide(clientLayer));
    }),
  );

export const layerMemory = Layer.effect(
  HostHealthStore,
  Effect.flatMap(SqlClient.SqlClient, makeWithClient),
).pipe(Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerFromPath(path.join(config.stateDir, "host-metrics.sqlite"));
  }),
);

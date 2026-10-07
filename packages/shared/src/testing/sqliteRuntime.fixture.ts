// @effect-diagnostics nodeBuiltinImport:off -- Exercises SQLite's actual runtime bindings.
import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "../nodeSqliteClient.ts";

const filename = process.argv[2]!;
const value = 9007199254740993n;

const write = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql`PRAGMA busy_timeout = 0`;
  yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT UNIQUE, large INTEGER)`;
  yield* sql`INSERT INTO entries VALUES (1, ${"kept"}, ${value})`;
  const duplicate = yield* sql`INSERT INTO entries VALUES (2, ${"kept"}, 0)`.pipe(Effect.flip);
  NodeAssert.equal(duplicate.reason._tag, "UniqueViolation");
  const rollback = yield* sql
    .withTransaction(
      sql`INSERT INTO entries VALUES (3, ${"rolled back"}, 0)`.pipe(
        Effect.andThen(Effect.fail("abort")),
      ),
    )
    .pipe(Effect.flip);
  NodeAssert.equal(rollback, "abort");
  NodeAssert.deepEqual(yield* sql`SELECT id, name FROM entries`.values, [[1, "kept"]]);
  NodeAssert.deepEqual(
    yield* sql`SELECT large FROM entries`.values.pipe(
      Effect.provideService(SqlClient.SafeIntegers, true),
    ),
    [[value]],
  );
  const rows = yield* sql<{ readonly large: bigint }>`SELECT large FROM entries`.pipe(
    Effect.provideService(SqlClient.SafeIntegers, true),
  );
  NodeAssert.equal(rows[0]?.large, value);

  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (db) => Effect.sync(() => db.close()),
  );
  yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
  const blocked = yield* sql
    .withTransaction(sql`UPDATE entries SET name = 'blocked'`)
    .pipe(Effect.flip);
  NodeAssert.equal(blocked.reason._tag, "LockTimeoutError");
  yield* Effect.sync(() => other.exec("ROLLBACK"));
  yield* sql.withTransaction(sql`UPDATE entries SET name = 'committed'`);
}).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped);

const read = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  NodeAssert.deepEqual(yield* sql`SELECT id, name FROM entries`.values, [[1, "committed"]]);
}).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped);

await Effect.runPromise(write);
await Effect.runPromise(read);
process.stdout.write("persisted, rolled back, and recovered from lock contention\n");

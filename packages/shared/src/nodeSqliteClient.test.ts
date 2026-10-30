// @effect-diagnostics nodeBuiltinImport:off -- Exercises actual Bun subprocesses outside the test runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scheduler from "effect/Scheduler";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const startedWorkers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const silentWorkers = vi.hoisted(() => ({ on: false, readyOnTerminate: false }));
const failingWorkers = vi.hoisted(() => ({ message: undefined as string | undefined }));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(
        ...((silentWorkers.on
          ? ["setInterval(() => {}, 1 << 30);", { eval: true }]
          : failingWorkers.message !== undefined
            ? [`throw new Error(${JSON.stringify(failingWorkers.message)});`, { eval: true }]
            : args) as ConstructorParameters<typeof actual.Worker>),
      );
      startedWorkers.push(this);
    }
    override terminate() {
      // A "ready" already queued when termination starts reaches the parent before "exit".
      if (silentWorkers.readyOnTerminate) this.emit("message", { type: "ready" });
      return super.terminate();
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const withReaderClient = <A, E>(
  use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('first')`;
      return yield* use(sql);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

const layer = it.layer(SqliteClient.layer({ filename: ":memory:" }));

layer("NodeSqliteClient", (it) => {
  it.effect("records the writer connection owner on a waiting query", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.withSpan("test.writerHolder"), Effect.forkChild);
      yield* Deferred.await(held);

      const waitingSpan = yield* Deferred.make<Tracer.Span>();
      const observeWaiter: Statement.Transformer = (statement, _sql, _fiber, span) =>
        Deferred.succeed(waitingSpan, span).pipe(Effect.as(statement));
      const waiter = yield* sql`SELECT 1`.pipe(
        Effect.provideService(Statement.CurrentTransformer, observeWaiter),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      );
      const span = yield* Deferred.await(waitingSpan);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(waiter);

      assert.equal(span.attributes.get("db.lock_owner_at_start.name"), "test.writerHolder");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.fiber_id"), "number");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.trace_id"), "string");
      assert.typeOf(span.attributes.get("db.lock_owner_at_start.span_id"), "string");
    }),
  );

  it.effect("retries preparing a query after the missing schema becomes available", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const select = sql<{ name: string }>`SELECT name FROM created_after_prepare_failure`;
      const error = yield* select.pipe(Effect.flip);
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason.operation, "prepare");

      yield* sql`CREATE TABLE created_after_prepare_failure(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO created_after_prepare_failure VALUES ('recovered')`;
      assert.deepEqual(yield* select, [{ name: "recovered" }]);
      assert.deepEqual(yield* select.values, [["recovered"]]);
    }),
  );

  it.effect("classifies constraint failures by their SQLite result code", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`INSERT INTO constrained VALUES (NULL)`.pipe(Effect.flip);
      assert.equal(missing.reason._tag, "ConstraintError");
    }),
  );
  it.effect("rolls back a failed deferred COMMIT before reusing the connection", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`CREATE TABLE transaction_parents(id INTEGER PRIMARY KEY)`;
      yield* sql`CREATE TABLE transaction_children(parent_id INTEGER REFERENCES transaction_parents(id) DEFERRABLE INITIALLY DEFERRED)`;
      const failed = yield* sql
        .withTransaction(sql`INSERT INTO transaction_children VALUES (99)`)
        .pipe(Effect.exit);
      assert.equal(failed._tag, "Failure");
      assert.deepEqual(yield* sql`SELECT * FROM transaction_children`, []);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO transaction_parents VALUES (1)`;
          yield* sql`INSERT INTO transaction_children VALUES (1)`;
        }),
      );
      assert.deepEqual(yield* sql`SELECT * FROM transaction_children`, [{ parent_id: 1 }]);
    }),
  );

  it.effect("preserves nested savepoint rollbacks across repeated transactions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE nested_entries(value INTEGER)`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO nested_entries VALUES (1)`;
          yield* sql.withTransaction(sql`INSERT INTO nested_entries VALUES (2)`);
          const failure = yield* sql
            .withTransaction(
              sql`INSERT INTO nested_entries VALUES (3)`.pipe(
                Effect.andThen(Effect.fail("nested")),
              ),
            )
            .pipe(Effect.flip);
          assert.equal(failure, "nested");
          yield* sql.withTransaction(sql`INSERT INTO nested_entries VALUES (4)`);
        }),
      );
      const failure = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO nested_entries VALUES (5)`;
            yield* sql.withTransaction(sql`INSERT INTO nested_entries VALUES (6)`);
            return yield* Effect.fail("outer");
          }),
        )
        .pipe(Effect.flip);
      assert.equal(failure, "outer");
      assert.deepEqual(yield* sql`SELECT value FROM nested_entries ORDER BY value`.values, [
        [1],
        [2],
        [4],
      ]);
    }),
  );
});

const largeText = "x".repeat(64 * 1024 + 1);

it.effect("keeps large text and blob parameters off cached statements", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const statements: Array<NodeSqlite.StatementSync> = [];
    const all = NodeSqlite.StatementSync.prototype.all;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
          this: NodeSqlite.StatementSync,
          ...params
        ) {
          statements.push(this);
          return all.apply(this, params);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

    const small = "small";
    const queries = [
      (value: string | Uint8Array | ArrayBuffer) => sql`SELECT length(${value}) AS size`,
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS size", [{ $value: value }]),
      (value: string | Uint8Array | ArrayBuffer) =>
        sql.unsafe("SELECT length($value) AS callable", [
          Object.assign(() => {}, { $value: value }),
        ]),
    ];
    const cached = new Set<NodeSqlite.StatementSync>();
    const large = new Set<NodeSqlite.StatementSync>();
    // Bun's node:sqlite binds buffer views but not raw ArrayBuffers.
    const largeBlobs: Array<Uint8Array | ArrayBuffer> = [new Uint8Array(64 * 1024 + 1)];
    if (!("Bun" in globalThis)) largeBlobs.push(new ArrayBuffer(64 * 1024 + 1));
    for (const value of [small, largeText, ...largeBlobs, small]) {
      const expected = typeof value === "string" ? value.length : value.byteLength;
      for (const query of queries) {
        assert.deepEqual((yield* query(value)).map(Object.values), [[expected]]);
        assert.deepEqual(yield* query(value).values, [[expected]]);
        for (const statement of statements.splice(0)) {
          (value === small ? cached : large).add(statement);
        }
      }
    }

    assert.equal(cached.size, queries.length);
    // Each large execution gets a statement that nothing holds on to afterwards.
    assert.equal(large.size, queries.length * 2 * (1 + largeBlobs.length));
    assert.isTrue(cached.isDisjointFrom(large));
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("reads integers on the values path as the caller asked, cached or not", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const value of ["small", largeText]) {
      const values = sql`SELECT 1 AS id, length(${value}) AS size`.values;
      assert.deepEqual(yield* values.pipe(Effect.provideService(SqlClient.SafeIntegers, true)), [
        [1n, BigInt(value.length)],
      ]);
      assert.deepEqual(yield* values, [[1, value.length]]);
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const makeTempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-transaction-" });
  const filename = path.join(directory, "state.sqlite");
  const other = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (database) => Effect.sync(() => database.close()),
  );
  yield* Effect.sync(() => {
    other.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO counters VALUES (1, 0);
    `);
  });
  return { filename, other };
});

it.effect("keeps another connection from committing between a transaction's read and write", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly value: number }>`
            SELECT value FROM counters WHERE id = 1
          `;
          // Deferred BEGIN permits a competing commit, causing SQLITE_BUSY_SNAPSHOT that no timeout can resolve.
          yield* Effect.sync(() =>
            assert.throws(
              () => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"),
              /database is locked/,
            ),
          );
          yield* sql`UPDATE counters SET value = ${(row?.value ?? 0) + 10} WHERE id = 1`;
        }),
      );
      yield* Effect.sync(() => other.exec("UPDATE counters SET value = value + 1 WHERE id = 1"));
      assert.deepEqual(yield* sql`SELECT value FROM counters WHERE id = 1`.values, [[11]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a transaction blocked by another writer as a lock timeout", () =>
  Effect.gen(function* () {
    const { filename, other } = yield* makeTempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 0`;
      const read = sql.withTransaction(sql`SELECT value FROM counters WHERE id = 1`.values);

      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const error = yield* read.pipe(Effect.flip);
      assert.equal(error.reason._tag, "LockTimeoutError");

      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* read, [[0]]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns a typed failure when the database cannot be opened", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Layer.build(SqliteClient.layer({ filename: "\0" })).pipe(Effect.scoped),
    );

    assert.equal(error._tag, "SqlError");
    assert.equal(error.reason.operation, "open");
  }),
);

it.effect(
  "recovers a prepared query immediately after an exclusive database lock is released",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-prepare-" });
      const filename = path.join(directory, "state.sqlite");
      const blocker = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => {
        blocker.exec("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('retained')");
      });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.sync(() => blocker.exec("BEGIN EXCLUSIVE"));
        const select = sql`SELECT value FROM entries`;
        const error = yield* select.values.pipe(Effect.flip);
        assert.equal(error._tag, "SqlError");
        assert.equal(error.reason.operation, "prepare");
        yield* Effect.sync(() => blocker.exec("ROLLBACK"));
        assert.deepEqual(yield* select.values, [["retained"]]);
        assert.deepEqual(yield* select, [{ value: "retained" }]);
      }).pipe(Effect.provide(SqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it("persists transactions and large integers under the actual Bun runtime", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bun-sqlite-"));
  try {
    const child = NodeChildProcess.spawnSync(
      process.env.T3_BUN_EXECUTABLE ?? "bun",
      [
        NodeURL.fileURLToPath(new URL("./testing/sqliteRuntime.fixture.ts", import.meta.url)),
        NodePath.join(directory, "state.sqlite"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "persisted, rolled back, and recovered from lock contention\n");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.effect("lets the writer commit while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const snapshotTaken = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        Deferred.await(snapshotTaken).pipe(
          Effect.andThen(sql`INSERT INTO entries VALUES ('second')`),
        ),
      );
      const counts = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const before = yield* countEntries(sql);
            yield* Deferred.succeed(snapshotTaken, undefined);
            // Holding the writer lock here would deadlock this join.
            yield* Fiber.join(writer);
            const after = yield* countEntries(sql);
            return { before, after };
          }),
        )
        .pipe(SqliteClient.readOnly);

      assert.deepEqual(counts, { before: 1, after: 1 });
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("serves another read while a read-only transaction is open", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const opened = yield* Deferred.make<void>();
      const other = yield* Effect.forkChild(
        Deferred.await(opened).pipe(Effect.andThen(countEntries(sql).pipe(SqliteClient.readOnly))),
      );
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Deferred.succeed(opened, undefined);
            // One shared reader would make this join wait on the transaction forever.
            assert.equal(yield* Fiber.join(other), 1);
          }),
        )
        .pipe(SqliteClient.readOnly);
    }),
  ),
);

// regression: #19226 read-only transactions run on the separate reader connection
it.effect("rejects a write in a read-only transaction", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('blocked')`)
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps the reader read-only even if a statement turns query_only off", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`PRAGMA query_only = OFF`;
            yield* sql`INSERT INTO entries VALUES ('blocked')`;
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "readonly database");
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
);

it.effect("keeps read-only work inside a write transaction on the writer", () =>
  withReaderClient((sql) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO entries VALUES ('uncommitted')`;
        const count = yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        assert.equal(count, 2);
      }),
    ),
  ),
);

it.effect("fails a read-only transaction whose reader stops, then starts a new reader", () =>
  withReaderClient((sql) =>
    Effect.gen(function* () {
      const startedBefore = startedWorkers.length;
      const error = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* countEntries(sql);
            yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
            return yield* countEntries(sql);
          }),
        )
        .pipe(SqliteClient.readOnly, Effect.flip);

      assert.equal(error._tag, "SqlError");
      assert.include(String(error.reason.cause), "Database reader exited");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 2);
    }),
  ),
);

const withFileClient = <A, E>(
  setup: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-reader-off-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      return yield* setup(yield* SqlClient.SqlClient, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readerWorker: true })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("uses the writer when the reader cannot open the database", () =>
  withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      // The writer keeps its open file; a read-only open of the path now fails.
      // Unlinking the file instead makes Bun's SQLite fail the writer's reads too.
      yield* (yield* FileSystem.FileSystem).chmod(filename, 0o000);
      const startedBefore = startedWorkers.length;

      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);

      // A read beside an open read transaction must not start a worker on the next slot.
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* sql
        .withTransaction(
          countEntries(sql).pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(SqliteClient.readOnly, Effect.forkChild);
      yield* Deferred.await(held);
      const other = yield* countEntries(sql).pipe(SqliteClient.readOnly, (effect) =>
        Effect.forkChild(effect, { startImmediately: true }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      assert.equal(yield* Fiber.join(other), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

it.effect("uses the writer for a database that is not in WAL mode", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      const startedBefore = startedWorkers.length;

      yield* sql
        .withTransaction(sql`INSERT INTO entries VALUES ('on the writer')`)
        .pipe(SqliteClient.readOnly);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.equal(startedWorkers.length, startedBefore + 1);
    }),
  ),
);

const captureWarnings = () => {
  const warnings: Array<unknown> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(message);
  });
  return { warnings, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const silently = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      silentWorkers.on = true;
    }),
    () => effect,
    () =>
      Effect.sync(() => {
        silentWorkers.on = false;
        silentWorkers.readyOnTerminate = false;
      }),
  );

it.effect("turns the reader off when its worker never opens the database", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("10 seconds");
          return yield* Fiber.join(fiber);
        }),
      );

      assert.equal(read, 1);
      assert.equal(yield* sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly), 1);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("lets a read be cancelled while its worker is still starting", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* silently(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          );
          yield* Effect.yieldNow;
          yield* Fiber.interrupt(fiber);
        }),
      );

      const next = yield* Effect.forkChild(
        sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Fiber.join(next), 0);
    }),
  ),
);

it.effect.each(["cold", "warm", "stalled"])(
  "completes an interrupted shutdown finalizer's read with a %s reader",
  (state) => {
    const { warnings, layer: logs } = captureWarnings();
    return withReaderClient((sql) => {
      const shutdown = Effect.gen(function* () {
        const read = sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
        if (state === "warm") yield* read;
        const registered = yield* Deferred.make<void>();
        const finalizing = yield* Deferred.make<void>();
        let observed: number | undefined;
        const fiber = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(finalizing, undefined);
                observed = yield* read;
              }).pipe(Effect.orDie),
            );
            yield* Deferred.succeed(registered, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(registered);
        const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber));
        yield* Deferred.await(finalizing);
        if (state === "stalled") yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interrupted);

        assert.equal(observed, 1);
        assert.lengthOf(warnings, state === "stalled" ? 1 : 0);
      });
      return state === "stalled" ? silently(shutdown) : shutdown;
    }).pipe(Effect.provide(logs));
  },
);

it.effect("logs one warning when concurrent first reads find the reader unavailable", () => {
  const { warnings, layer: logs } = captureWarnings();
  return withFileClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* (yield* FileSystem.FileSystem).chmod(filename, 0o000);
      const startedBefore = startedWorkers.length;

      const counts = yield* Effect.all(
        [
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
          sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepEqual(counts, [0, 0]);
      // Concurrent reads claim separate pool slots, but the pool turns off once.
      assert.equal(startedWorkers.length, startedBefore + 2);
      assert.lengthOf(warnings, 1);
    }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not hand out a worker that reports ready after another read timed it out", () =>
  withFileClient((sql) =>
    Effect.gen(function* () {
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE entries(name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES ('kept')`;
      const read = () => sql.withTransaction(countEntries(sql)).pipe(SqliteClient.readOnly);
      const counts = yield* silently(
        Effect.gen(function* () {
          const first = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          yield* TestClock.adjust("5 seconds");
          const second = yield* Effect.forkChild(read());
          yield* Effect.yieldNow;
          silentWorkers.readyOnTerminate = true;
          yield* TestClock.adjust("5 seconds");
          // The second read waits on its own pool slot's startup.
          yield* TestClock.adjust("5 seconds");
          return [yield* Fiber.join(first), yield* Fiber.join(second)];
        }),
      );

      assert.deepEqual(counts, [1, 1]);
    }),
  ),
);

const withCheckpointClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope>,
  options: { readonly readerWorker?: boolean } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-checkpoint-" });
    const filename = path.join(directory, "state.sqlite");
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(SqliteClient.layer({ filename, checkpointWorker: true, ...options })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// The client leaves the engine default alone: FULL in Node, while Bun's bundled
// SQLite defaults WAL connections to NORMAL.
const defaultWalSynchronous = "Bun" in globalThis ? 1 : 2;

const supportsNoopCheckpoint = (() => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.version);
  db.close();
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 3 || (major === 3 && minor >= 51);
})();

const checkpointWorkerReply = (worker: NodeWorkerThreads.Worker) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        let replies = 0;
        const onReply = (reply: unknown) => {
          if (reply !== "barrier") return;
          if (++replies < 2) {
            // One checkpoint response may queue a coalesced follow-up behind the first barrier.
            // A second barrier observes that follow-up and makes the helper deterministic.
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
            worker.postMessage("barrier");
            return;
          }
          worker.off("message", onReply);
          resolve();
        };
        worker.on("message", onReply);
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
        worker.postMessage("barrier");
      }),
  );

const waitForCheckpointMessage = (worker: NodeWorkerThreads.Worker, id: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "id" in message &&
        message.id === id
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const waitForTruncateCompletion = (worker: NodeWorkerThreads.Worker) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "checkpoint" &&
        "truncateId" in message &&
        typeof message.truncateId === "number"
      ) {
        worker.off("message", onMessage);
        resolve(message as Record<string, unknown>);
      }
    };
    worker.on("message", onMessage);
  });

const holdWorkerMessage = (worker: NodeWorkerThreads.Worker, type: string) => {
  const emit = worker.emit.bind(worker) as (
    eventName: string | symbol,
    ...args: unknown[]
  ) => boolean;
  let held: unknown;
  let resolve: (message: unknown) => void = () => {};
  const ready = new Promise<unknown>((done) => {
    resolve = done;
  });
  const spy = vi.spyOn(worker, "emit").mockImplementation((eventName, ...args) => {
    const message = args[0];
    if (
      eventName === "message" &&
      held === undefined &&
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === type
    ) {
      held = message;
      resolve(message);
      return true;
    }
    return emit(eventName, ...args);
  });
  return {
    ready,
    deliver() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
    release() {
      spy.mockRestore();
      if (held !== undefined) emit("message", held);
    },
  };
};

const schedulerHoldingDispatch = (afterResume = false) => {
  let resuming = false;
  let yielded = false;
  let resolveContinuation = () => {};
  const continuation = new Promise<void>((resolve) => {
    resolveContinuation = resolve;
  });
  let holdNext = false;
  let heldTask: (() => void) | undefined;
  let resolvePaused: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    resolvePaused = resolve;
  });
  const mixed = new Scheduler.MixedScheduler("async", (task) => {
    if (holdNext) {
      holdNext = false;
      heldTask = task;
      if (resuming) resolveContinuation();
      else resolvePaused();
      return () => {
        if (heldTask === task) heldTask = undefined;
      };
    }
    const immediate = setImmediate(task);
    return () => clearImmediate(immediate);
  });
  const scheduler: Scheduler.Scheduler = {
    executionMode: mixed.executionMode,
    makeDispatcher: () => mixed.makeDispatcher(),
    shouldYield: () => {
      if (resuming && afterResume && !yielded) {
        yielded = true;
        holdNext = true;
        return true;
      }
      return false;
    },
  };
  return {
    scheduler,
    paused,
    continuation,
    arm() {
      holdNext = true;
    },
    resume() {
      const task = heldTask;
      heldTask = undefined;
      if (task !== undefined)
        setImmediate(() => {
          resuming = true;
          task();
          resuming = false;
        });
    },
  };
};

const pauseCheckpointRequests = (worker: NodeWorkerThreads.Worker) => {
  const queued: Array<Parameters<typeof worker.postMessage>> = [];
  const send = worker.postMessage.bind(worker);
  const spy = vi.spyOn(worker, "postMessage").mockImplementation((...args) => {
    queued.push(args);
  });
  let restored = false;
  return {
    queued,
    sendNext() {
      const args = queued.shift();
      if (args !== undefined) send(...args);
      return args?.[0];
    },
    release() {
      if (restored) return;
      restored = true;
      spy.mockRestore();
      for (const args of queued.splice(0)) send(...args);
    },
  };
};

const blockCheckpointBehindReader = (
  sql: SqlClient.SqlClient,
  filename: string,
  worker: NodeWorkerThreads.Worker,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
    yield* sql.unsafe("CREATE TABLE entries(value INTEGER PRIMARY KEY)").unprepared;
    yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS count FROM entries").get();

    const checkpointRequests = pauseCheckpointRequests(worker);
    yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
    yield* sql.unsafe(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
      INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
    `).unprepared;

    const request = checkpointRequests.queued[0]?.[0];
    assert(typeof request === "object" && request !== null && "id" in request);
    const blocked = waitForCheckpointMessage(worker, (request as { readonly id: unknown }).id);
    checkpointRequests.sendNext();
    const state = yield* Effect.promise(() => blocked);
    assert.isTrue(state.blocked as boolean);
    assert.isAbove(state.log as number, 0);
    return { reader, checkpointRequests };
  });

const readCheckpointState = (db: NodeSqlite.DatabaseSync) => {
  const state = db.prepare("PRAGMA wal_checkpoint(NOOP)").get();
  if (typeof state?.log !== "number" || typeof state.checkpointed !== "number") {
    throw new Error("SQLite returned invalid WAL checkpoint frame counts");
  }
  return { log: state.log, checkpointed: state.checkpointed };
};

it.effect("checkpoints the WAL on the worker instead of the writer", () =>
  withCheckpointClient((sql, filename) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const walSize = Effect.map(fs.stat(`${filename}-wal`), (info) => Number(info.size));
      const worker = startedWorkers.at(-1)!;
      const checkpointRequests = pauseCheckpointRequests(worker);
      yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
      const limit = 1024 * 1024;
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`);
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 0);
      assert.deepEqual(yield* sql`PRAGMA synchronous`, [{ synchronous: defaultWalSynchronous }]);

      // About 1200 frames, past the 1000 that start a checkpoint.
      yield* sql`CREATE TABLE pages(payload BLOB)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
      `;
      const pending = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAbove(pending[0]!.log, 1000);
      assert.isBelow(pending[0]!.checkpointed, pending[0]!.log);
      checkpointRequests.release();
      yield* checkpointWorkerReply(worker);
      const wal = yield* sql<{
        readonly log: number;
        readonly checkpointed: number;
      }>`PRAGMA wal_checkpoint(NOOP)`;
      assert.isAtMost(wal[0]!.log - wal[0]!.checkpointed, 1000);

      assert.isAtMost(yield* walSize, limit);
      yield* sql`INSERT INTO pages(payload) VALUES (x'00')`;
      assert.isAtMost(yield* walSize, limit);
    }),
  ),
);

it.effect.skipIf(!supportsNoopCheckpoint)(
  "answers checks received while the worker waits for truncation acknowledgement",
  () =>
    withCheckpointClient((sql) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const send = worker.postMessage.bind(worker);
        const truncateRequest = holdWorkerMessage(worker, "truncate-request");
        yield* Effect.addFinalizer(() => Effect.sync(truncateRequest.release));
        const checkpointRequests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(checkpointRequests.release));
        const replies: Array<unknown> = [];
        const onMessage = (message: unknown) => replies.push(message);
        worker.on("message", onMessage);
        yield* Effect.addFinalizer(() => Effect.sync(() => worker.off("message", onMessage)));

        yield* sql.unsafe("PRAGMA journal_size_limit = 1").unprepared;
        yield* sql.unsafe("CREATE TABLE pages(payload BLOB)").unprepared;
        yield* sql.unsafe(`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO pages(payload) SELECT randomblob(4000) FROM n
        `).unprepared;
        checkpointRequests.sendNext();
        const pending = yield* Effect.promise(() => truncateRequest.ready);
        assert(typeof pending === "object" && pending !== null && "generation" in pending);
        assert.equal(typeof pending.generation, "number");

        // Queue a newer check before allowing the main thread to acknowledge truncation.
        send({ type: "check", id: "during-truncate", generation: Number(pending.generation) + 1 });
        truncateRequest.deliver();
        checkpointRequests.release();
        yield* checkpointWorkerReply(worker);
        const reply = replies.find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "id" in message &&
            message.id === "during-truncate",
        );
        assert.include(reply, {
          type: "checkpoint",
          id: "during-truncate",
          generation: pending.generation,
          blocked: true,
        });
        yield* sql.unsafe("INSERT INTO pages(payload) VALUES (x'00')").unprepared;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 1201 }]);
      }),
    ),
);

it.effect("hands checkpoints back to the writer when the worker stops", () =>
  withCheckpointClient((sql) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => startedWorkers.at(-1)!.terminate());
      const autocheckpoint = yield* sql<{
        readonly wal_autocheckpoint: number;
      }>`PRAGMA wal_autocheckpoint`;
      assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
    }),
  ),
);

it.effect("warns once and hands checkpoints back when the worker fails at startup", () => {
  const { warnings, layer: logs } = captureWarnings();
  const reason = "SQLite 3.50.4 has no NOOP checkpoint";
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      failingWorkers.message = reason;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          if (worker.threadId !== -1) {
            yield* Effect.promise(() => new Promise((resolve) => worker.once("exit", resolve)));
          }
          const autocheckpoint = yield* sql<{
            readonly wal_autocheckpoint: number;
          }>`PRAGMA wal_autocheckpoint`;
          assert.equal(autocheckpoint[0]?.wal_autocheckpoint, 1000);
          assert.deepEqual(warnings, [
            [
              "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
              { reason },
            ],
          ]);
        }),
      ),
    () =>
      Effect.sync(() => {
        failingWorkers.message = undefined;
      }),
  ).pipe(Effect.provide(logs));
});

it.effect("does not warn when the client stops its checkpoint worker", () => {
  const { warnings, layer: logs } = captureWarnings();
  return Effect.gen(function* () {
    yield* withCheckpointClient(() => Effect.void);
    assert.lengthOf(warnings, 0);
  }).pipe(Effect.provide(logs));
});
it.effect("finishes masked database cleanup after its caller is interrupted", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cleanup_writes(value INTEGER PRIMARY KEY)`;
    const entered = yield* Deferred.make<void>();
    const work = yield* Effect.forkChild(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO cleanup_writes VALUES (1)`;
            yield* sql.withTransaction(sql`INSERT INTO cleanup_writes VALUES (2)`);
          }),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(work);
    assert.deepEqual(yield* sql`SELECT value FROM cleanup_writes ORDER BY value`.values, [
      [1],
      [2],
    ]);
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets the worker's queued messages land, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect.each([
  { reservation: false, masked: false },
  { reservation: false, masked: true },
  { reservation: true, masked: false },
  { reservation: true, masked: true },
])(
  "preserves caller cancellation while waiting (reservation=$reservation, masked=$masked)",
  ({ reservation, masked }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER)`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(held);
      const entered = yield* Deferred.make<void>();
      const body = sql`INSERT INTO entries VALUES (1)`.pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
      );
      const acquire = reservation
        ? Effect.scoped(
            Effect.gen(function* () {
              const connection = yield* sql.reserve;
              yield* connection.executeUnprepared("INSERT INTO entries VALUES (1)", [], undefined);
              yield* Deferred.succeed(entered, undefined);
            }),
          )
        : sql.withTransaction(body);
      const waiter = yield* Effect.forkChild(masked ? Effect.uninterruptible(acquire) : acquire, {
        startImmediately: true,
      });
      const cancelled = yield* Effect.forkChild(Fiber.interrupt(waiter), {
        startImmediately: true,
      });
      yield* Effect.gen(function* () {
        yield* eventLoopTurn;
        assert.equal(cancelled.pollUnsafe() !== undefined, !masked);
        assert.isFalse(yield* Deferred.isDone(entered));
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      yield* Fiber.join(holder);
      yield* Fiber.join(cancelled);
      assert.equal(yield* Deferred.isDone(entered), masked);
      yield* sql.withTransaction(sql`INSERT INTO entries VALUES (2)`);
      assert.deepEqual(
        yield* sql`SELECT value FROM entries ORDER BY value`.values,
        masked ? [[1], [2]] : [[2]],
      );
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);

const openDatabase = (filename: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (db) => Effect.sync(() => db.close()),
  );

it.effect.each([false, true])(
  "bounds a busy truncate without gating a reset WAL (resetDuringHandoff=%s)",
  (resetDuringHandoff) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worker = startedWorkers.at(-1)!;
        const reader = yield* openDatabase(filename);
        const observer = yield* openDatabase(filename);
        const limit = 1024 * 1024;
        const requests = pauseCheckpointRequests(worker);
        yield* Effect.addFinalizer(() => Effect.sync(requests.release));
        const truncation = holdWorkerMessage(worker, "truncate-request");
        yield* Effect.addFinalizer(() => Effect.sync(truncation.release));
        yield* sql.unsafe(`PRAGMA journal_size_limit = ${limit}`).unprepared;
        yield* sql`CREATE TABLE pages(payload BLOB)`;
        yield* sql`
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
          INSERT INTO pages(payload) SELECT zeroblob(4000) FROM n
        `;
        // Reading before PASSIVE pins the last WAL frame even when every frame is copied.
        reader.exec("BEGIN");
        assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1200);
        requests.sendNext();
        yield* Effect.promise(() => truncation.ready);
        const copied = readCheckpointState(observer);
        assert.equal(copied.checkpointed, copied.log);
        assert.isAbove(copied.log, 1000);
        assert.isBelow(copied.log, 10_000);
        assert.isAbove(Number((yield* fs.stat(`${filename}-wal`)).size), limit);

        if (resetDuringHandoff) {
          // Another connection can reset the WAL before the main thread acknowledges truncation.
          reader.exec("ROLLBACK");
          assert.equal(observer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy, 0);
          observer.exec("INSERT INTO pages VALUES (x'01')");
          reader.exec("BEGIN");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1201);
          assert.isAbove(readCheckpointState(observer).log, 0);
          assert.isBelow(readCheckpointState(observer).log, 10_000);
          assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), limit);
        }

        const completed = waitForTruncateCompletion(worker);
        requests.release();
        // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- the bound on TRUNCATE returning is the property under test; SQLite's 5s busy wait is only distinguishable by elapsed time
        const started = performance.now();
        truncation.deliver();
        const write = yield* Effect.forkChild(sql`INSERT INTO pages VALUES (x'02')`, {
          startImmediately: true,
        });
        const reply = yield* Effect.promise(() => completed);
        // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- the bound on TRUNCATE returning is the property under test; SQLite's 5s busy wait is only distinguishable by elapsed time
        const elapsed = performance.now() - started;
        assert.equal(reply.log, reply.checkpointed);
        if (resetDuringHandoff) {
          yield* Fiber.join(write);
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [{ count: 1202 }]);
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1201);
        } else {
          yield* eventLoopTurn;
          assert.isUndefined(write.pollUnsafe(), "the physical size limit must still gate writes");
          assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM pages").get()?.count, 1200);
        }
        reader.exec("ROLLBACK");
        yield* checkpointWorkerReply(worker);
        yield* Fiber.join(write);
        yield* sql`INSERT INTO pages VALUES (x'03')`;
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
          { count: resetDuringHandoff ? 1203 : 1202 },
        ]);
        assert.isAtMost(Number((yield* fs.stat(`${filename}-wal`)).size), limit);
        assert.equal(reply.blocked, !resetDuringHandoff);
        // Both implementations eventually reply; only a bound distinguishes SQLite's 5s busy wait.
        assert.isBelow(elapsed, 1000, "TRUNCATE must return promptly while the reader stays open");
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each(["statement", "commit", "rollback", "partial failure", "worker failure"] as const)(
  "bounds a real WAL backlog and resumes writes (%s)",
  (mode) =>
    withCheckpointClient(
      (sql, filename) =>
        Effect.gen(function* () {
          const worker = startedWorkers.at(-1)!;
          yield* sql`PRAGMA journal_size_limit = 1048576`;
          yield* sql`CREATE TABLE pages(id INTEGER PRIMARY KEY, payload BLOB)`;
          yield* sql`INSERT INTO pages VALUES (12001, x'00')`;
          yield* checkpointWorkerReply(worker);
          const reader = yield* openDatabase(filename);
          const observer = yield* openDatabase(filename);
          reader.exec("BEGIN");
          reader.prepare("SELECT COUNT(*) FROM pages").get();
          const requests = pauseCheckpointRequests(worker);
          yield* Effect.addFinalizer(() => Effect.sync(requests.release));
          const insert = sql.unsafe(`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${mode === "partial failure" ? 12001 : 12000})
        INSERT OR FAIL INTO pages SELECT i, zeroblob(4000) FROM n ORDER BY i
      `).unprepared;
          if (mode === "commit" || mode === "rollback") {
            const result = yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  yield* insert;
                  // Admission must not prevent an active transaction from finishing.
                  yield* sql`INSERT INTO pages VALUES (12002, x'00')`;
                  assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
                    { count: 12002 },
                  ]);
                  if (mode === "rollback") return yield* Effect.fail("rollback");
                }),
              )
              .pipe(Effect.exit);
            assert.equal(result._tag, mode === "rollback" ? "Failure" : "Success");
          } else if (mode === "partial failure") {
            const error = yield* insert.pipe(Effect.flip);
            assert.equal(error.reason._tag, "ConstraintError");
          } else yield* insert;

          if (mode !== "rollback") {
            assert.isAbove(
              readCheckpointState(observer).log - readCheckpointState(observer).checkpointed,
              10_000,
            );
          }
          const finished = yield* Deferred.make<void>();
          const write = yield* Effect.forkChild(
            sql`INSERT INTO pages VALUES (12003, x'00')`.pipe(
              Effect.andThen(Deferred.succeed(finished, undefined)),
            ),
            { startImmediately: true },
          );
          yield* eventLoopTurn;
          const expected = mode === "rollback" ? 1 : mode === "commit" ? 12002 : 12001;
          if (mode !== "rollback") {
            assert.isFalse(yield* Deferred.isDone(finished));
            const before = Number(
              (yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size,
            );
            assert.deepEqual(
              yield* sql`SELECT COUNT(*) AS count FROM pages`.pipe(SqliteClient.readOnly),
              [{ count: expected }],
            );
            yield* eventLoopTurn;
            assert.isFalse(yield* Deferred.isDone(finished));
            assert.equal(
              Number((yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size),
              before,
            );
          }
          if (mode === "worker failure") {
            yield* Effect.promise(() => worker.terminate());
            yield* Fiber.join(write);
            assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
            reader.exec("ROLLBACK");
          } else {
            reader.exec("ROLLBACK");
            requests.release();
            yield* Fiber.join(write);
            yield* checkpointWorkerReply(worker);
            if (mode !== "rollback")
              assert.isAtMost(
                Number((yield* (yield* FileSystem.FileSystem).stat(`${filename}-wal`)).size),
                1048576,
              );
          }
          assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM pages`, [
            { count: expected + 1 },
          ]);
          yield* sql.withTransaction(sql`INSERT INTO pages VALUES (12004, x'00')`);
        }),
      { readerWorker: true },
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each([
  { reserved: false, stage: "queued" },
  { reserved: true, stage: "queued" },
  { reserved: false, stage: "elected" },
  { reserved: true, stage: "elected" },
  { reserved: false, stage: "resumed" },
  { reserved: true, stage: "resumed" },
] as const)(
  "hands cancellation to the next writer (reserved=$reserved, stage=$stage)",
  ({ reserved, stage }) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const connection = reserved ? yield* sql.reserve : undefined;
            const insert = (value: number) =>
              connection
                ? connection.executeUnprepared("INSERT INTO entries VALUES (?)", [value], undefined)
                : sql`INSERT INTO entries VALUES (${value})`;
            const scheduled = schedulerHoldingDispatch(stage === "resumed");
            yield* Effect.addFinalizer(() => Effect.sync(scheduled.resume));
            const first = yield* Effect.forkChild(
              insert(1).pipe(Effect.provideService(Scheduler.Scheduler, scheduled.scheduler)),
              { startImmediately: true },
            );
            const second = yield* Effect.forkChild(insert(2), { startImmediately: true });
            yield* eventLoopTurn;
            assert.isUndefined(first.pollUnsafe());
            assert.isUndefined(second.pollUnsafe());
            if (stage !== "queued") {
              scheduled.arm();
              const truncated = waitForTruncateCompletion(worker);
              checkpointRequests.release();
              reader.exec("ROLLBACK");
              yield* Effect.promise(() => truncated);
              yield* Effect.promise(() => scheduled.paused);
              if (stage === "resumed") {
                scheduled.resume();
                yield* Effect.promise(() => scheduled.continuation);
              }
            }
            yield* Fiber.interrupt(first);
            scheduled.resume();
            if (stage === "queued") {
              reader.exec("ROLLBACK");
              checkpointRequests.release();
              yield* checkpointWorkerReply(worker);
            }
            yield* eventLoopTurn;
            assert.isDefined(
              second.pollUnsafe(),
              "cancellation must hand off without waiting for a later checkpoint",
            );
            yield* Fiber.join(second);
          }),
        );
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (3)`);
        assert.deepEqual(yield* sql`SELECT value FROM entries ORDER BY value`.values, [[2], [3]]);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each([false, true])(
  "keeps masked cleanup waiting at the checkpoint gate (transaction=%s)",
  (transaction) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        const entered = yield* Deferred.make<void>();
        const cleanupEntered = yield* Deferred.make<void>();
        const work = yield* Effect.forkChild(
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(cleanupEntered, undefined);
                const insert = sql.unsafe("INSERT INTO entries VALUES (1)").unprepared;
                yield* transaction ? sql.withTransaction(insert) : insert;
              }),
            ),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(work), {
          startImmediately: true,
        });
        yield* Deferred.await(cleanupEntered);
        yield* Effect.yieldNow;
        assert.isUndefined(work.pollUnsafe());

        const truncateFinished = waitForTruncateCompletion(worker);
        checkpointRequests.release();
        reader.exec("ROLLBACK");
        yield* Effect.promise(() => truncateFinished);
        yield* Fiber.join(interrupt);
        assert.deepEqual(yield* sql.unsafe("SELECT value FROM entries").unprepared, [{ value: 1 }]);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect.each(["PRAGMA incremental_vacuum(1)", "PRAGMA user_version = 42"])(
  "admits maintenance mutations through the checkpoint gate (%s)",
  (operation) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`VACUUM`;
        yield* sql`CREATE TABLE reclaim(payload BLOB)`;
        yield* sql`INSERT INTO reclaim VALUES (zeroblob(8000000))`;
        yield* sql`DELETE FROM reclaim`;
        yield* checkpointWorkerReply(worker);
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        const before = (yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`)[0]!
          .freelist_count;
        assert.isAbove(before, 0);
        const mutation = yield* Effect.forkChild(sql.unsafe(operation).unprepared, {
          startImmediately: true,
        });
        yield* eventLoopTurn;
        assert.isUndefined(mutation.pollUnsafe());
        assert.equal(reader.prepare("PRAGMA user_version").get()?.user_version, 0);
        reader.exec("ROLLBACK");
        checkpointRequests.release();
        yield* Fiber.join(mutation);
        if (operation.includes("incremental_vacuum")) {
          assert.isBelow(
            (yield* sql<{ freelist_count: number }>`PRAGMA freelist_count`)[0]!.freelist_count,
            before,
          );
        } else assert.deepEqual(yield* sql`PRAGMA user_version`, [{ user_version: 42 }]);
        yield* sql.withTransaction(sql`INSERT INTO entries VALUES (1)`);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect("keeps automatic checkpoints when mutation classification is unavailable", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        NodeSqlite.DatabaseSync.prototype,
        "setAuthorizer",
      )!;
      Object.defineProperty(NodeSqlite.DatabaseSync.prototype, "setAuthorizer", {
        configurable: true,
        value: undefined,
      });
      return descriptor;
    }),
    () =>
      withCheckpointClient((sql) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`, [{ wal_autocheckpoint: 1000 }]);
          assert.deepEqual(yield* sql`PRAGMA synchronous`, [
            { synchronous: defaultWalSynchronous },
          ]);
          yield* sql`CREATE TABLE fallback(value INTEGER)`;
          yield* sql.withTransaction(sql`INSERT INTO fallback VALUES (1)`);
          assert.deepEqual(yield* sql`SELECT value FROM fallback`, [{ value: 1 }]);
        }),
      ),
    (descriptor) =>
      Effect.sync(() =>
        Object.defineProperty(NodeSqlite.DatabaseSync.prototype, "setAuthorizer", descriptor),
      ),
  ),
);

it.effect.each(["successful", "failed"] as const)(
  "lets the event loop run while draining queued writes (%s)",
  (outcome) =>
    withCheckpointClient((sql, filename) =>
      Effect.gen(function* () {
        const worker = startedWorkers.at(-1)!;
        const { reader, checkpointRequests } = yield* blockCheckpointBehindReader(
          sql,
          filename,
          worker,
        );
        let completed = 0;
        let resolveHeartbeat = (_completed: number) => {};
        const heartbeat = new Promise<number>((resolve) => {
          resolveHeartbeat = resolve;
        });
        const scheduler = new Scheduler.MixedScheduler("async", (task) => {
          const handle = setImmediate(task);
          return () => clearImmediate(handle);
        });
        const writeScheduler: Scheduler.Scheduler = {
          executionMode: scheduler.executionMode,
          makeDispatcher: () => scheduler.makeDispatcher(),
          shouldYield: () => false,
        };
        const writes = [];
        for (let value = 0; value < 20; value++) {
          writes.push(
            yield* Effect.forkChild(
              sql`INSERT INTO entries VALUES (${outcome === "failed" ? "invalid" : value})`.pipe(
                Effect.match({
                  onSuccess: () => assert.equal(outcome, "successful"),
                  onFailure: (error) => {
                    assert.equal(outcome, "failed");
                    assert.equal(error._tag, "SqlError");
                    assert.equal(error.reason.operation, "execute");
                    assert.include(String(error.reason.cause), "datatype mismatch");
                  },
                }),
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (++completed === 1) setImmediate(() => resolveHeartbeat(completed));
                  }),
                ),
                Effect.provideService(Scheduler.Scheduler, writeScheduler),
              ),
              { startImmediately: true },
            ),
          );
        }
        yield* eventLoopTurn;
        assert.equal(completed, 0);
        reader.exec("ROLLBACK");
        checkpointRequests.release();
        const completedAtHeartbeat = yield* Effect.promise(() => heartbeat);
        for (const write of writes) yield* Fiber.join(write);
        assert.equal(completed, writes.length);
        assert.deepEqual(
          yield* sql`SELECT value FROM entries ORDER BY value`,
          outcome === "failed"
            ? []
            : Array.from({ length: writes.length }, (_, value) => ({ value })),
        );
        assert.isBelow(completedAtHeartbeat, writes.length);
      }),
    ),
  { skip: !supportsNoopCheckpoint },
);

it.effect("releases the database file when a connection with cached statements closes", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-close-")),
    );
    const filename = NodePath.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE kept (value TEXT)`;
      yield* sql`INSERT INTO kept VALUES ('kept')`;
      yield* sql`SELECT value FROM kept`;
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));

    // Nothing else may hold the file once the writer has closed.
    const exclusive = new NodeSqlite.DatabaseSync(filename);
    exclusive.exec("PRAGMA busy_timeout = 0");
    exclusive.exec("PRAGMA locking_mode = EXCLUSIVE");
    exclusive.exec("BEGIN EXCLUSIVE");
    exclusive.exec("COMMIT");
    exclusive.close();

    // A cleanly closed WAL database has no -shm file, which a read-only open needs.
    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly value: string }>`SELECT value FROM kept`;
    }).pipe(Effect.provide(SqliteClient.layer({ filename, readonly: true })));
    assert.deepEqual(rows, [{ value: "kept" }]);
    yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  }),
);

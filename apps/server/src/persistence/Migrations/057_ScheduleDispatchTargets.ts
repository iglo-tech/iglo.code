import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN dispatch_target_json TEXT`;
  yield* sql`CREATE TABLE scheduled_task_occurrences (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, target_json TEXT NOT NULL, started_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT)`;
  yield* sql`CREATE INDEX scheduled_task_occurrences_pending ON scheduled_task_occurrences (status, task_id)`;
});

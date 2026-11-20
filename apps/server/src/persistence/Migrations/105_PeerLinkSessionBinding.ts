import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The peer-link session a link row is bound to: only that session may
  // forget the row, so a linked peer cannot act for another machine. (An
  // offer is checked against the row the accept path already holds, not
  // against this binding.) Null on rows from before.
  const linkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(peer_environment_links)
  `;
  if (!linkColumns.some((column) => column.name === "peer_session_id")) {
    yield* sql`
      ALTER TABLE peer_environment_links ADD COLUMN peer_session_id TEXT
    `;
  }

  // The one-time pairing grant a session was spent from, so the environment
  // that minted a reciprocal offer can bind its own link row to the session
  // the peer's link back created here.
  const sessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  if (!sessionColumns.some((column) => column.name === "pairing_grant_id")) {
    yield* sql`
      ALTER TABLE auth_sessions ADD COLUMN pairing_grant_id TEXT
    `;
  }
});

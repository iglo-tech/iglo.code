// @effect-diagnostics nodeBuiltinImport:off - Standalone Bun child probes the launcher's real filesystem and IPC boundary outside Effect.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { readServiceState } from "../serviceLauncher.ts";
import {
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_STOP_MARKER_FILE,
} from "../cloud/serviceProtocol.ts";

const home = process.env.T3CODE_HOME;
const context = decodeServiceLauncherContext(process.env[SERVICE_LAUNCHER_CONTEXT_ENV] ?? "");
if (!home || !context || !process.send || !process.versions["bun"]) {
  throw new Error("Service runtime fixture requires Bun and the launcher's real IPC channel");
}
const dbPath = NodePath.join(home, "userdata", "statev2.sqlite");
const db = new NodeSqlite.DatabaseSync(dbPath);
const statePath = NodePath.join(home, "runtime", "service-state.json");
const scenario = process.env.T3_SERVICE_TEST_SCENARIO ?? "lifecycle";
if (!["lifecycle", "commit", "rollback"].includes(scenario))
  throw new Error(`Unimplemented service fixture scenario: ${scenario}`);

async function emit(event: string) {
  const state = await readServiceState(statePath);
  const row = db.prepare("SELECT value FROM history").get();
  // @effect-diagnostics-next-line globalConsole:off - The parent parses these raw stdout records as service lifecycle milestones.
  console.log(
    `service-runtime:${JSON.stringify({
      event,
      pid: process.pid,
      version: context?.childVersion,
      bun: process.versions["bun"],
      dbValue: row?.value,
      activeVersion: state.activeVersion,
      status: state.update?.status ?? "none",
      stopMarker: NodeFS.existsSync(NodePath.join(home!, "runtime", SERVICE_STOP_MARKER_FILE)),
      wal: NodeFS.existsSync(`${dbPath}-wal`),
      backup: state.update
        ? NodeFS.existsSync(
            NodePath.join(home!, "runtime", "db-backup", state.update.id, "database"),
          )
        : false,
    })}`,
  );
}

process.once("SIGTERM", async () => {
  await emit("stopped");
  db.close();
  process.exit(0);
});
// The fixture represents a long-running server, stopped only by the launcher.
// @effect-diagnostics-next-line globalTimers:off - Native keepalive holds this standalone child open until launcher shutdown.
setInterval(() => undefined, 60_000);
process.on("message", async (value: unknown) => {
  const message = decodeServiceLauncherParentMessage(value);
  if (!message) throw new Error("Invalid launcher IPC message");
  if (message.type === "update-rejected") throw new Error(message.reason);
  if (message.type === "update-accepted") {
    await emit("accepted");
    db.close();
    process.exit(0);
  }
  if (context.update?.status !== "pending" || message.updateId !== context.update.id) {
    throw new Error("Commit does not match the pending update");
  }
  await emit("committed");
});
await emit("ready");
if (context.update?.status === "pending") {
  db.exec("PRAGMA journal_mode=WAL; UPDATE history SET value = 'migrated history'");
  if (scenario === "rollback") {
    // Change the main file and leave a new WAL behind, exercising both restore paths.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); UPDATE history SET value = 'failed migration'");
    await emit("failing");
    process.exit(23);
  }
  await emit("trial");
  process.send({ type: "prepared", updateId: context.update.id });
} else if (context.update?.status === "rolled-back") {
  await emit("rolled-back");
} else if (scenario !== "lifecycle" && !context.update) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath });
}

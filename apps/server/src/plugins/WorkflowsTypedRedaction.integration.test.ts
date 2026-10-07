import { expect, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { Run, RunSummary } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import * as Settings from "../serverSettings.ts";
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(RunSummary));

it.live.each([
  "approval-required",
  "agent",
  sequence.id,
  "e",
  "fixture-only-unrelated-token",
] as const)("preserves contract strings during configured-secret redaction: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const settings = Context.get(test.context, Settings.ServerSettingsService);
      const marker = scenario;
      yield* settings.updateSettings({ bitbucket: { accessToken: marker } });
      const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
      let runtime = yield* test.boot(host);
      const result = yield* runtime
        .invoke("start", {
          ...test.scope,
          definition: sequence,
          clientRequestId: "start",
          input: { note: marker, long: marker.repeat(Math.floor(4000 / marker.length)) },
          workspace: { type: "current" },
        })
        .pipe(Effect.result);
      const db = new NodeSqlite.DatabaseSync(test.databasePath);
      let id = "";
      try {
        const rows = db.prepare("SELECT id,data FROM workflow_runs").all();
        expect(rows).toHaveLength(1);
        id = String(rows[0]!.id);
        expect(JSON.parse(String(rows[0]!.data)).definition.nodes[0].runtimeMode).toBe(
          "approval-required",
        );
      } finally {
        db.close();
      }
      const read = yield* runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.result);
      yield* runtime.close;
      runtime = yield* test.boot(host);
      const retained = yield* runtime
        .invoke("get", { ...test.scope, runId: id })
        .pipe(Effect.result);
      const listed = yield* runtime
        .invoke("list", test.scope)
        .pipe(Effect.flatMap(decodeSummaries));
      expect(listed[0]?.definition.id).toBe(sequence.id);
      if (read._tag === "Success") {
        const projection = yield* decodeRun(read.success);
        expect(projection.definition.id).toBe(sequence.id);
        expect(projection.definition.nodes.map((node) => node.kind)).toEqual(
          sequence.nodes.map((node) => node.kind),
        );
        expect(String(projection.input.long).length).toBeLessThanOrEqual(4000);
      }
      yield* settings.updateSettings({ bitbucket: { accessToken: "" } });
      const recovered = yield* runtime
        .invoke("get", { ...test.scope, runId: id })
        .pipe(Effect.flatMap(decodeRun));
      expect(recovered.input.note).toBe(marker);
      expect(result._tag).toBe("Success");
      expect(read._tag).toBe("Success");
      expect(retained._tag).toBe("Success");
      if (read._tag === "Success")
        expect((yield* decodeRun(read.success)).input.note).toBe("[redacted]");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

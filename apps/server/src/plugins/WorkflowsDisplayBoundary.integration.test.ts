import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as NodeSqlite from "node:sqlite";
import { Host } from "@t3tools/plugin-host-contract/server";
import { Definition, Run, RunSummary } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import * as Settings from "../serverSettings.ts";

const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeSummaries = Schema.decodeUnknownEffect(Schema.Array(RunSummary));

it.live.each(["full-title", "summary-title", "unrelated-control"] as const)(
  "retains valid trimmed display at redaction length boundary: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const settings = Context.get(test.context, Settings.ServerSettingsService);
        yield* settings.updateSettings({
          bitbucket: {
            accessToken: scenario === "unrelated-control" ? "unused-fixture-marker" : "x",
          },
        });
        const title =
          scenario === "summary-title" ? `x${"a".repeat(229)} z` : `x${"a".repeat(3989)} z`;
        const definition = yield* decodeDefinition({
          ...sequence,
          title,
          entry: "review",
        });
        const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
        let runtime = yield* test.boot(host);
        const start = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition,
            clientRequestId: "boundary",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.result);
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        let id = "";
        try {
          const rows = db.prepare("SELECT id FROM workflow_runs").all();
          expect(rows).toHaveLength(1);
          id = String(rows[0]!.id);
        } finally {
          db.close();
        }
        const read = yield* runtime.invoke("get", { ...test.scope, runId: id }).pipe(Effect.result);
        const list = yield* runtime.invoke("list", test.scope).pipe(Effect.result);
        yield* runtime.close;
        runtime = yield* test.boot(host);
        const retained = yield* runtime
          .invoke("get", { ...test.scope, runId: id })
          .pipe(Effect.result);
        yield* settings.updateSettings({ bitbucket: { accessToken: "" } });
        const restored = yield* runtime
          .invoke("get", { ...test.scope, runId: id })
          .pipe(Effect.flatMap(decodeRun));
        expect(restored.definition.title).toBe(title);
        const restoredList = yield* runtime
          .invoke("list", test.scope)
          .pipe(Effect.flatMap(decodeSummaries));
        expect(restoredList).toHaveLength(1);
        for (const result of [start, read, retained]) {
          expect(result._tag).toBe("Success");
          if (result._tag === "Success") yield* decodeRun(result.success);
        }
        expect(list._tag).toBe("Success");
        if (list._tag === "Success") yield* decodeSummaries(list.success);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

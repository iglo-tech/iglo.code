import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { cases } from "./cases.ts";
import { failingCases, type Row } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model } = values;
const samples = Number(values.samples);
const ids = values.case?.split(",");
const fixtures = cases.filter((fixture) => !ids || ids.includes(fixture.id));
if (!out || !model || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> --model <configured model> [--case <ids>] [--samples <count>].",
  );
}
const decodeSettings = Schema.decodeEffect(CodexSettings);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-wait-eval-" });
    const service = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const rows: Array<Row> = [];
    for (const fixture of fixtures) {
      for (let sample = 1; sample <= samples; sample++) {
        const result = yield* service
          .classifyBackgroundTask({
            cwd,
            command: fixture.command,
            description: "description" in fixture ? fixture.description : undefined,
            agentText: fixture.agentText,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
          })
          .pipe(Effect.option);
        rows.push({
          id: fixture.id,
          sample,
          wait: result._tag === "Some" ? result.value.wait : null,
          expected: fixture.wait,
        });
      }
    }
    const failing = failingCases(rows);
    yield* fs.makeDirectory(out, { recursive: true });
    yield* fs.writeFileString(path.join(out, "results.json"), yield* encodeRows(rows));
    yield* fs.writeFileString(
      path.join(out, "summary.json"),
      yield* encodeRows({ model, samples, cases: fixtures.length, failing }),
    );
    yield* Effect.log(
      failing.length === 0 ? "All cases pass." : `Failing cases: ${failing.join(", ")}`,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-background-wait-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);

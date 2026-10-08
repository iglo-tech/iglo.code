import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { Definition, CatalogEntry } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";

const decodeDefinition = Schema.decodeUnknownSync(Definition);
const encodeDefinition = Schema.encodeSync(Schema.fromJsonString(Definition));
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));
it.live.each([
  "deleted-provider-skill",
  "deleted-provider-no-skill",
  "missing-skill-control",
] as const)("retains authored unavailable definitions: %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* makeCoreWorkflowFixture;
      const fs = yield* FileSystem.FileSystem;
      const host = Host.of({
        ...test.core,
        lifecycle: () => Stream.never,
        // Only the absent instance uses real discovery: it returns before invoking a provider.
        skills: (input) =>
          input.providerInstanceId === "deleted_fixture"
            ? test.core.skills(input)
            : Effect.succeed([]),
      });
      const runtime = yield* test.boot(host);
      const definition = decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent"
            ? {
                ...node,
                modelSelection: {
                  ...node.modelSelection,
                  instanceId: scenario === "missing-skill-control" ? "codex" : "deleted_fixture",
                },
                skill: scenario === "deleted-provider-no-skill" ? undefined : "authored-skill",
              }
            : node,
        ),
      });
      const directory = `${test.config.baseDir}/.t3code/workflows`;
      yield* fs.makeDirectory(directory, { recursive: true });
      const encoded = encodeDefinition(definition);
      yield* fs.writeFileString(`${directory}/sequence.yml`, encoded);
      const entries = yield* runtime
        .invoke("catalog", test.scope)
        .pipe(Effect.flatMap(decodeCatalog));
      const entry = entries.find((entry) => entry.source === ".t3code/workflows/sequence.yml")!;
      const validation = yield* runtime
        .invoke("validate", { ...test.scope, definition })
        .pipe(Effect.result);
      expect(yield* fs.readFileString(`${directory}/sequence.yml`)).toBe(encoded);
      const repaired = { ...sequence, revision: 2 };
      const saved =
        scenario === "deleted-provider-skill"
          ? yield* runtime
              .invoke("save", { ...test.scope, definition: repaired, expectedRevision: 1 })
              .pipe(Effect.result)
          : null;
      yield* runtime.close;
      const rebooted = yield* test.boot(host);
      const reloaded = yield* rebooted
        .invoke("catalog", test.scope)
        .pipe(Effect.flatMap(decodeCatalog));
      const retained = reloaded.find((entry) => entry.source === ".t3code/workflows/sequence.yml")!;
      expect(entry.runnable).toBe(false);
      expect(entry.definition?.id).toBe("sequence");
      expect(retained.definition?.id).toBe("sequence");
      expect(validation._tag).toBe("Success");
      if (scenario === "deleted-provider-skill") expect(saved?._tag).toBe("Success");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

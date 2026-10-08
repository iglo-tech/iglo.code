import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Yaml from "yaml";
import { Definition, CatalogEntry } from "@t3tools/plugin-workflows/contracts";
import { fixture, sequence } from "./Workflows.testkit.ts";

const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));

it.effect.each([
  { count: 3, fill: "x", oversized: false },
  { count: 5, fill: "x", oversized: true },
  { count: 1, fill: "界", oversized: false },
  { count: 2, fill: "界", oversized: true },
])("keeps saved YAML readable at the UTF-8 size limit: $count fields of $fill", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      const definition = yield* decodeDefinition({
        ...sequence,
        id: "large-enums",
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent"
            ? {
                ...node,
                report: {
                  fields: Array.from({ length: scenario.count }, (_, index) => ({
                    name: `field${index}`,
                    type: "enum",
                    required: true,
                    values: Array.from({ length: 32 }, (_, value) =>
                      `${index}_${value}_`.padEnd(4000, scenario.fill),
                    ),
                  })),
                },
              }
            : node,
        ),
      });
      const serialized = Yaml.stringify(definition);
      expect(new TextEncoder().encode(serialized).byteLength > 524_288).toBe(scenario.oversized);
      if (scenario.fill === "界") expect(serialized.length).toBeLessThan(524_288);
      const valid = yield* test
        .invoke("validate", { ...scope, definition })
        .pipe(Effect.flatMap(decodeEntry));
      expect(valid.runnable).toBe(!scenario.oversized);
      const filename = `${test.directory}/.t3code/workflows/large-enums.yaml`;
      const saved = yield* test
        .invoke("save", { ...scope, definition, expectedRevision: null })
        .pipe(Effect.result);
      const original = scenario.oversized ? { ...sequence, id: definition.id } : definition;
      if (scenario.oversized) {
        expect(valid.reasons).toContain("Workflow YAML exceeds 512 KiB.");
        expect(saved._tag).toBe("Failure");
        expect(yield* fs.exists(filename)).toBe(false);
        yield* test.invoke("save", { ...scope, definition: original, expectedRevision: null });
        const before = yield* fs.readFileString(filename);
        const replacement = yield* test
          .invoke("save", {
            ...scope,
            definition: { ...definition, revision: 2 },
            expectedRevision: 1,
          })
          .pipe(Effect.result);
        expect(replacement._tag).toBe("Failure");
        expect(yield* fs.readFileString(filename)).toBe(before);
      } else {
        expect(saved._tag).toBe("Success");
        if (saved._tag === "Success") {
          const entry = yield* decodeEntry(saved.success);
          expect(entry.runnable).toBe(true);
          expect(entry.definition).toEqual(definition);
        }
        expect(yield* fs.readFileString(filename)).toBe(serialized);
      }
      yield* test.restart;
      const entries = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
      const loaded = entries.find((entry) => entry.source.endsWith("large-enums.yaml"))!;
      expect(loaded.definition).toEqual(original);
      expect(loaded.runnable).toBe(true);
      const updated = yield* test
        .invoke("save", { ...scope, definition: { ...original, revision: 2 }, expectedRevision: 1 })
        .pipe(Effect.flatMap(decodeEntry));
      expect(updated.runnable).toBe(true);
      yield* test.restart;
      const edited = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
      expect(
        edited.find((entry) => entry.definition?.id === original.id)?.definition?.revision,
      ).toBe(2);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Yaml from "yaml";
import { CatalogEntry, Definition } from "@t3tools/plugin-workflows/contracts";
import { fixture, sequence } from "./Workflows.testkit.ts";

const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));

it.effect.each([
  "99-edit",
  "100-edit",
  "99-create-conflict",
  "100-create-conflict",
  "100-duplicate-conflict",
] as const)("resolves authored identities beyond the catalog display limit: %s", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      const packaged = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
      const directory = `${test.directory}/.t3code/workflows`;
      yield* fs.makeDirectory(directory, { recursive: true });
      const count = mode.startsWith("99") ? 99 : 100;
      const duplicated = mode === "100-duplicate-conflict";
      for (let index = 0; index < count; index++)
        yield* fs.writeFileString(
          `${directory}/aa${String(index).padStart(3, "0")}.yaml`,
          Yaml.stringify({ ...sequence, id: duplicated && index === 0 ? "target" : `aa${index}` }),
        );
      const definition = { ...sequence, id: "target", title: "Authored target" };
      const filename = `${directory}/zz-original.yml`;
      const original = Yaml.stringify(definition);
      yield* fs.writeFileString(filename, original);
      const earlier = yield* fs.readFileString(`${directory}/aa000.yaml`);
      expect(
        (yield* test.invoke("validate", { ...scope, definition }).pipe(Effect.flatMap(decodeEntry)))
          .runnable,
      ).toBe(true);
      const creating = mode.includes("create");
      const saved = yield* test
        .invoke("save", {
          ...scope,
          definition: creating ? definition : { ...definition, revision: 2 },
          expectedRevision: creating ? null : 1,
        })
        .pipe(Effect.result);
      yield* test.restart;
      const catalog = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
      expect(catalog.length).toBeLessThanOrEqual(100 + packaged.length);
      expect(yield* fs.exists(`${directory}/target.yaml`)).toBe(false);
      expect(yield* fs.readFileString(`${directory}/aa000.yaml`)).toBe(earlier);
      const contents = yield* fs.readFileString(filename);
      if (creating || duplicated) {
        expect(saved._tag).toBe("Failure");
        expect(contents).toBe(original);
        if (duplicated) {
          const visible = catalog.find((entry) => entry.definition?.id === "target")!;
          expect(visible.runnable).toBe(false);
          expect(visible.reasons).toContain(
            "This workflow identity is duplicated in the project catalog.",
          );
        }
      } else {
        expect(saved._tag).toBe("Success");
        if (saved._tag === "Success")
          expect((yield* decodeEntry(saved.success)).source).toBe(
            ".t3code/workflows/zz-original.yml",
          );
        const edited = yield* decodeDefinition(Yaml.parse(contents));
        expect(edited).toEqual({ ...definition, revision: 2 });
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

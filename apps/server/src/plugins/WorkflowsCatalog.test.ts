import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { CatalogEntry } from "@t3tools/plugin-workflows/contracts";
import { fixture, sequence } from "./Workflows.testkit.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));

it.effect.each(["sequence.yaml", "sequence.yml", "authored.yaml"])(
  "edits the discovered definition at its authored path: %s",
  (filename) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const directory = `${test.directory}/.t3code/workflows`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(`${directory}/${filename}`, encodeJson(sequence));
        const catalog = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
        expect(
          catalog.find((entry) => entry.source === `.t3code/workflows/${filename}`),
        ).toMatchObject({ runnable: true, definition: { revision: 1 } });
        const saved = yield* test.invoke("save", {
          ...scope,
          expectedRevision: 1,
          definition: { ...sequence, revision: 2, title: "Changed title" },
        });
        expect(saved).toMatchObject({
          source: `.t3code/workflows/${filename}`,
          definition: { revision: 2, title: "Changed title" },
        });
        const reloaded = yield* test.invoke("catalog", scope).pipe(Effect.flatMap(decodeCatalog));
        expect(reloaded.filter((entry) => entry.definition?.id === "sequence")).toMatchObject([
          {
            source: `.t3code/workflows/${filename}`,
            definition: { revision: 2, title: "Changed title" },
          },
        ]);
        if (filename !== "sequence.yaml")
          expect(yield* fs.exists(`${directory}/sequence.yaml`)).toBe(false);
        expect(
          yield* test
            .invoke("save", {
              ...scope,
              expectedRevision: 1,
              definition: { ...sequence, revision: 2, title: "Stale title" },
            })
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["duplicate", "other-identity", "invalid"])(
  "preserves conflicting authored files: %s",
  (conflict) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const scope = { environmentId: test.environmentId, projectId: test.projectId };
        const directory = `${test.directory}/.t3code/workflows`;
        yield* fs.makeDirectory(directory, { recursive: true });
        const contents =
          conflict === "invalid"
            ? "invalid: ["
            : encodeJson({
                ...sequence,
                id: conflict === "other-identity" ? "different" : "sequence",
              });
        yield* fs.writeFileString(`${directory}/sequence.yaml`, contents);
        if (conflict === "duplicate")
          yield* fs.writeFileString(`${directory}/sequence.yml`, encodeJson(sequence));
        const result = yield* test
          .invoke("save", {
            ...scope,
            expectedRevision: conflict === "invalid" ? null : 1,
            definition: { ...sequence, revision: conflict === "invalid" ? 1 : 2 },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(yield* fs.readFileString(`${directory}/sequence.yaml`)).toBe(contents);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

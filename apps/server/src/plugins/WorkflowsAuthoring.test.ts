import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Yaml from "yaml";
import {
  AuthoringEntry,
  CatalogEntry,
  Capabilities,
  Definition,
  LibraryPage,
} from "@t3tools/plugin-workflows/contracts";
import { fixture, sequence } from "./Workflows.testkit.ts";

const decodePage = Schema.decodeUnknownEffect(LibraryPage);
const decodeAuthoring = Schema.decodeUnknownEffect(AuthoringEntry);
const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeCapabilities = Schema.decodeUnknownEffect(Capabilities);
const decodeDefinition = Schema.decodeUnknownSync(Definition);

it.effect("pages and searches the entire catalog beyond the display cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      const directory = `${test.directory}/.t3code/workflows`;
      yield* fs.makeDirectory(directory, { recursive: true });
      for (let index = 0; index < 130; index++)
        yield* fs.writeFileString(
          `${directory}/w${String(index).padStart(3, "0")}.yaml`,
          Yaml.stringify({ ...sequence, id: `w${index}`, title: `Workflow ${index}` }),
        );
      yield* fs.writeFileString(`${directory}/zz-broken.yaml`, "version: [");
      yield* fs.writeFileString(`${directory}/zz-dupe.yaml`, Yaml.stringify(sequence));
      yield* fs.writeFileString(`${directory}/zz-dupe2.yaml`, Yaml.stringify(sequence));
      const sources: string[] = [];
      let offset: number | null = 0;
      let total = 0;
      while (offset !== null) {
        const page: LibraryPage = yield* test
          .invoke("library", { ...scope, offset, limit: 50 })
          .pipe(Effect.flatMap(decodePage));
        total = page.total;
        expect(page.entries.length).toBeLessThanOrEqual(50);
        sources.push(...page.entries.map((entry) => entry.source));
        offset = page.nextOffset;
      }
      // Two packaged examples plus every authored file, including invalid and duplicate ones.
      expect(total).toBe(2 + 133);
      expect(new Set(sources).size).toBe(total);
      const search = yield* test
        .invoke("library", { ...scope, query: "workflow 12" })
        .pipe(Effect.flatMap(decodePage));
      expect(search.entries.map((entry) => entry.definitionId)).toEqual([
        "w12",
        "w120",
        "w121",
        "w122",
        "w123",
        "w124",
        "w125",
        "w126",
        "w127",
        "w128",
        "w129",
      ]);
      expect(search.entries[0]).toMatchObject({
        packaged: false,
        revision: 1,
        runnable: true,
        summary: { steps: 3, agents: 1, humanGates: 1, ends: 1 },
      });
      const tail = yield* test
        .invoke("library", { ...scope, query: "zz-" })
        .pipe(Effect.flatMap(decodePage));
      expect(tail.entries.map((entry) => [entry.source, entry.runnable, entry.duplicate])).toEqual([
        [".t3code/workflows/zz-broken.yaml", false, false],
        [".t3code/workflows/zz-dupe.yaml", false, true],
        [".t3code/workflows/zz-dupe2.yaml", false, true],
      ]);
      expect(tail.entries[0]!.reasons).toEqual(["Invalid workflow YAML."]);
      expect(tail.entries[1]!.reasons).toContain(
        "This workflow identity is duplicated in the project catalog.",
      );
      const packaged = yield* test
        .invoke("library", { ...scope, query: "packaged:" })
        .pipe(Effect.flatMap(decodePage));
      expect(packaged.entries.every((entry) => entry.packaged)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("repairs an invalid file only through its observed fingerprint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      const directory = `${test.directory}/.t3code/workflows`;
      yield* fs.makeDirectory(directory, { recursive: true });
      const broken = `${directory}/broken.yaml`;
      const unrelated = `${directory}/other.yaml`;
      yield* fs.writeFileString(broken, Yaml.stringify({ ...sequence, id: "broken", entry: 3 }));
      const other = Yaml.stringify({ ...sequence, id: "other" });
      yield* fs.writeFileString(unrelated, other);
      const observed = yield* test
        .invoke("read", { ...scope, source: ".t3code/workflows/broken.yaml" })
        .pipe(Effect.flatMap(decodeAuthoring));
      expect(observed).toMatchObject({ definition: null, runnable: false, lossless: true });
      expect(observed.reasons[0]).toMatch(/^Invalid workflow schema/);
      expect(Yaml.parse(observed.text)).toMatchObject({ id: "broken", entry: 3 });
      const repaired = { ...sequence, id: "broken", title: "Repaired" };
      // A concurrent external edit invalidates the observed fingerprint.
      const external = Yaml.stringify({ ...sequence, id: "broken", entry: 4 });
      yield* fs.writeFileString(broken, external);
      const stale = yield* test
        .invoke("replace", {
          ...scope,
          source: observed.source,
          fingerprint: observed.fingerprint,
          definition: repaired,
        })
        .pipe(Effect.result);
      expect(stale).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
      expect(yield* fs.readFileString(broken)).toBe(external);
      const current = yield* test
        .invoke("read", { ...scope, source: observed.source })
        .pipe(Effect.flatMap(decodeAuthoring));
      // Validation runs before commit; a graph with a dangling route keeps the file.
      const invalid = yield* test
        .invoke("replace", {
          ...scope,
          source: current.source,
          fingerprint: current.fingerprint,
          definition: { ...repaired, entry: "missing" },
        })
        .pipe(Effect.result);
      expect(invalid).toMatchObject({ _tag: "Failure", failure: { code: "validation" } });
      expect(yield* fs.readFileString(broken)).toBe(external);
      const colliding = yield* test
        .invoke("replace", {
          ...scope,
          source: current.source,
          fingerprint: current.fingerprint,
          definition: { ...repaired, id: "other" },
        })
        .pipe(Effect.result);
      expect(colliding).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
      const replaced = yield* test
        .invoke("replace", {
          ...scope,
          source: current.source,
          fingerprint: current.fingerprint,
          definition: repaired,
        })
        .pipe(Effect.flatMap(decodeAuthoring));
      expect(replaced).toMatchObject({
        source: ".t3code/workflows/broken.yaml",
        runnable: true,
        definition: { id: "broken", title: "Repaired" },
      });
      expect(decodeDefinition(Yaml.parse(yield* fs.readFileString(broken)))).toEqual(repaired);
      expect(yield* fs.readFileString(unrelated)).toBe(other);
      const packaged = yield* test
        .invoke("replace", {
          ...scope,
          source: "packaged:implementation",
          fingerprint: replaced.fingerprint,
          definition: repaired,
        })
        .pipe(Effect.result);
      expect(packaged).toMatchObject({ _tag: "Failure", failure: { code: "unavailable" } });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("locates blocking errors and warnings while preserving their reasons", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* fixture;
      const scope = { environmentId: test.environmentId, projectId: test.projectId };
      const unreachable = decodeDefinition({
        ...sequence,
        nodes: [...sequence.nodes, { id: "spare", kind: "end", title: "Spare", outcome: "failed" }],
      });
      const warning = yield* test
        .invoke("validate", { ...scope, definition: unreachable })
        .pipe(Effect.flatMap(decodeEntry));
      expect(warning.runnable).toBe(true);
      expect(warning.problems).toEqual([
        {
          severity: "warning",
          message: "spare: this end is unreachable from the entry step.",
          nodeId: "spare",
        },
      ]);
      const blocked = decodeDefinition({
        ...sequence,
        nodes: sequence.nodes.map((node) =>
          node.kind === "agent"
            ? {
                ...node,
                runtimeMode: "auto-accept-edits",
                next: { to: "gone" },
                onUnresolved: { to: "loop" },
              }
            : node,
        ),
      });
      const withLoop = decodeDefinition({
        ...blocked,
        nodes: [
          ...blocked.nodes,
          {
            ...blocked.nodes[0]!,
            id: "loop",
            title: "Loop",
            next: { to: "loop" },
            onUnresolved: undefined,
          },
        ],
      });
      const errors = yield* test
        .invoke("validate", { ...scope, definition: withLoop })
        .pipe(Effect.flatMap(decodeEntry));
      expect(errors.runnable).toBe(false);
      expect(errors.problems).toEqual(
        expect.arrayContaining([
          {
            severity: "error",
            message: "implement: unknown route target gone.",
            nodeId: "implement",
            control: "next",
          },
          { severity: "error", message: "loop: no terminal path.", nodeId: "loop" },
          {
            severity: "error",
            message: "Provider codex cannot report in auto-accept-edits: unavailable.",
            nodeId: "implement",
            control: "runtimeMode",
          },
        ]),
      );
      expect(errors.reasons).toEqual(
        (errors.problems ?? [])
          .filter((item) => item.severity === "error")
          .map((item) => item.message),
      );
      const saved = yield* test
        .invoke("save", { ...scope, definition: withLoop, expectedRevision: null })
        .pipe(Effect.result);
      expect(saved).toMatchObject({ _tag: "Failure", failure: { code: "validation" } });
      const capabilities = yield* test
        .invoke("capabilities", scope)
        .pipe(Effect.flatMap(decodeCapabilities));
      expect(capabilities.nodeKinds).toContain("agent");
      expect(capabilities.providers).toMatchObject([
        { instanceId: "codex", reporting: true, available: true },
      ]);
      const skills = yield* test.invoke("skills", { ...scope, providerInstanceId: "codex" });
      expect(skills).toEqual([
        { name: "code-review", displayName: null, description: null, enabled: true },
      ]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

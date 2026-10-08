import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Yaml from "yaml";
import { Host } from "@t3tools/plugin-host-contract/server";
import { AuthoringEntry, Definition } from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import * as Settings from "../serverSettings.ts";

const decodeAuthoring = Schema.decodeUnknownEffect(AuthoringEntry);
const decodeDefinition = Schema.decodeUnknownSync(Definition);

it.live(
  "preserves protected values through authoring read, save and YAML round trips",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const marker = "fabricated-authoring-token";
        yield* Context.get(test.context, Settings.ServerSettingsService).updateSettings({
          bitbucket: { accessToken: marker },
        });
        const runtime = yield* test.boot(Host.of({ ...test.core, lifecycle: () => Stream.never }));
        const fs = yield* FileSystem.FileSystem;
        const filename = `${test.config.baseDir}/.t3code/workflows/protected.yaml`;
        const authored = decodeDefinition({
          ...sequence,
          id: "protected",
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent"
              ? {
                  ...node,
                  instruction: `Deploy with ${marker}`,
                  report: {
                    fields: [
                      { name: "ready", type: "boolean", required: true },
                      { name: "target", type: "enum", required: false, values: ["pass", marker] },
                    ],
                  },
                }
              : node,
          ),
        });
        const created = yield* runtime
          .invoke("save", { ...test.scope, definition: authored, expectedRevision: null })
          .pipe(Effect.flatMap(decodeAuthoring));
        expect(yield* fs.readFileString(filename)).toContain(marker);
        expect(created.text).not.toContain(marker);
        expect(created.protectedValues).toBe(2);
        const read = yield* runtime
          .invoke("read", { ...test.scope, source: created.source })
          .pipe(Effect.flatMap(decodeAuthoring));
        expect(JSON.stringify(read)).not.toContain(marker);
        const agent = read.definition!.nodes.find((node) => node.kind === "agent")!;
        if (agent.kind !== "agent") return yield* Effect.die("Expected agent");
        expect(agent.instruction).toMatch(/^⟦protected:[a-f0-9]{12}:0⟧$/);
        // The canonical export is the authoring view; importing it restores the same graph.
        expect(decodeDefinition(Yaml.parse(read.text))).toEqual(read.definition);
        const edited = {
          ...decodeDefinition(Yaml.parse(read.text)),
          revision: 2,
          title: "Renamed",
        };
        const tampered = {
          ...edited,
          nodes: edited.nodes.map((node) =>
            node.kind === "agent" ? { ...node, instruction: `${agent.instruction} extra` } : node,
          ),
        };
        const partial = yield* runtime
          .invoke("save", {
            ...test.scope,
            definition: tampered,
            expectedRevision: 1,
            fingerprint: read.fingerprint,
          })
          .pipe(Effect.result);
        expect(partial).toMatchObject({ _tag: "Failure", failure: { code: "validation" } });
        const saved = yield* runtime
          .invoke("save", {
            ...test.scope,
            definition: edited,
            expectedRevision: 1,
            fingerprint: read.fingerprint,
          })
          .pipe(Effect.flatMap(decodeAuthoring));
        expect(saved.definition?.title).toBe("Renamed");
        const persisted = decodeDefinition(Yaml.parse(yield* fs.readFileString(filename)));
        expect(persisted).toEqual({ ...authored, revision: 2, title: "Renamed" });
        // A placeholder issued for an older file cannot be restored after an external edit.
        yield* fs.writeFileString(filename, Yaml.stringify({ ...persisted, title: "External" }));
        const stale = yield* runtime
          .invoke("save", {
            ...test.scope,
            definition: { ...edited, revision: 3 },
            expectedRevision: 2,
            fingerprint: saved.fingerprint,
          })
          .pipe(Effect.result);
        expect(stale).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } });
        expect(decodeDefinition(Yaml.parse(yield* fs.readFileString(filename))).title).toBe(
          "External",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);

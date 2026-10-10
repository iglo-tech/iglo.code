import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as NodeSqlite from "node:sqlite";
import { Host, Schedules } from "@t3tools/plugin-host-contract/server";
import { type PluginError } from "@t3tools/plugin-host-contract/schema";
import { plugin } from "@t3tools/plugin-workflows/server";
import {
  Definition,
  Run,
  CatalogEntry,
  ScheduleHistory,
} from "@t3tools/plugin-workflows/contracts";
import { sequence } from "./Workflows.testkit.ts";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import * as Settings from "../serverSettings.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";

const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));
const decodeHistory = Schema.decodeUnknownEffect(ScheduleHistory);

it.live.each(["known-secret", "unrelated-control"] as const)(
  "redacts catalog display through registered APIs: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const marker = "fabricated-catalog-token";
        const settings = Context.get(test.context, Settings.ServerSettingsService);
        yield* settings.updateSettings({
          bitbucket: { accessToken: scenario === "known-secret" ? marker : "unrelated-fake-token" },
        });
        const definition = yield* decodeDefinition({
          ...sequence,
          id: "catalog-privacy",
          title: "Workflow " + marker,
          entry: "review",
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent"
              ? { ...node, instruction: "Authored instructions " + marker }
              : node,
          ),
        });
        const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
        let scheduledStart: Effect.Effect<unknown, PluginError> = Effect.void;
        let schedules: Schedules["Service"] | undefined;
        const selected = {
          ...plugin,
          acquire: Effect.gen(function* () {
            schedules = yield* Schedules;
            return yield* plugin.acquire;
          }).pipe(
            Effect.map((services) => {
              scheduledStart = services.scheduleTargets[0]!.invoke({
                projectId: test.scope.projectId,
                occurrenceId: "catalog-private-schedule",
                payload: { definitionId: definition.id, input: {} },
              });
              return services;
            }),
          ),
        };
        // Dispatch through the environment's own target registry, as its scheduler does.
        const targets = Context.get(test.context, ScheduleTargets.ScheduleTargets);
        let runtime = yield* test.boot(host, selected, targets);
        const validate = yield* runtime
          .invoke("validate", { ...test.scope, definition })
          .pipe(Effect.flatMap(decodeEntry));
        const saved = yield* runtime
          .invoke("save", { ...test.scope, definition, expectedRevision: null })
          .pipe(Effect.flatMap(decodeEntry));
        const fs = yield* FileSystem.FileSystem;
        const authored = yield* fs.readFileString(
          `${test.config.baseDir}/.t3code/workflows/catalog-privacy.yaml`,
        );
        expect(authored).toContain(marker);
        const started = yield* runtime
          .invoke("start", {
            ...test.scope,
            definition,
            clientRequestId: "catalog-control",
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(decodeRun));
        yield* runtime.close;
        runtime = yield* test.boot(host, selected, targets);
        yield* scheduledStart;
        // A schedule's history shows run and catalog titles only through the host's redaction.
        yield* runtime.invoke("schedule", {
          ...test.scope,
          id: "private-schedule",
          title: "Private schedule",
          definitionId: definition.id,
          task: "",
          workspace: "current",
          enabled: false,
          schedule: { type: "interval", everyMs: 3_600_000 },
        });
        yield* schedules!.runNow("private-schedule", "private-occurrence");
        const history = yield* runtime
          .invoke("schedule-history", { ...test.scope, scheduleId: "private-schedule" })
          .pipe(Effect.flatMap(decodeHistory));
        expect(history.occurrences[0]?.run?.definition.title).toBeDefined();
        expect(history.current?.title).toBeDefined();
        expect(JSON.stringify(history).includes(marker)).toBe(scenario === "unrelated-control");
        const entries = yield* runtime
          .invoke("catalog", test.scope)
          .pipe(Effect.flatMap(decodeCatalog));
        const loaded = entries.find((entry) => entry.definition?.id === definition.id)!;
        const plain = (entry: CatalogEntry) =>
          entry.definition?.nodes
            .find((node) => node.kind === "agent")
            ?.instruction?.includes(marker);
        const runPlain = started.definition.nodes
          .find((node) => node.kind === "agent")!
          .instruction.includes(marker);
        const expected = scenario === "unrelated-control";
        expect(runPlain).toBe(expected);
        expect([plain(validate), plain(saved), plain(loaded)]).toEqual([
          expected,
          expected,
          expected,
        ]);
        expect(
          yield* fs.readFileString(`${test.config.baseDir}/.t3code/workflows/catalog-privacy.yaml`),
        ).toBe(authored);
        const db = new NodeSqlite.DatabaseSync(test.databasePath);
        try {
          const snapshots = db.prepare("SELECT data FROM workflow_runs").all();
          expect(snapshots).toHaveLength(3);
          for (const snapshot of snapshots) {
            const privateRun = yield* decodeRun(JSON.parse(String(snapshot.data)));
            expect(
              privateRun.definition.nodes.find((node) => node.kind === "agent")!.instruction,
            ).toContain(marker);
          }
        } finally {
          db.close();
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

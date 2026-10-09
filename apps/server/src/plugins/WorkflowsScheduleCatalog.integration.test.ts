import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Yaml from "yaml";
import { CommandId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Schedules } from "@t3tools/plugin-host-contract/server";
import { CatalogEntry, Definition, Run, RunSummary } from "@t3tools/plugin-workflows/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { makeCoreWorkflowFixture } from "./WorkflowsCore.testkit.ts";
import { sequence } from "./Workflows.testkit.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";

const pair = Schema.encodeSync(Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])));
const decodeDefinition = Schema.decodeUnknownEffect(Definition);
const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));
const decodeEntry = Schema.decodeUnknownEffect(CatalogEntry);
const decodeCatalog = Schema.decodeUnknownEffect(Schema.Array(CatalogEntry));

it.live.each(["99-runnable", "100-runnable", "100-duplicate", "100-unavailable-provider"] as const)(
  "schedules from complete authored catalog authority: %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const test = yield* makeCoreWorkflowFixture;
        const fs = yield* FileSystem.FileSystem;
        let schedules: Schedules["Service"] | undefined;
        const selected = {
          ...plugin,
          acquire: Effect.gen(function* () {
            schedules = yield* Schedules;
            return yield* plugin.acquire;
          }),
        };
        const host = Host.of({ ...test.core, lifecycle: () => Stream.never });
        const targets = Context.get(test.context, ScheduleTargets.ScheduleTargets);
        let runtime = yield* test.boot(host, selected, targets);
        const directory = `${test.config.baseDir}/.t3code/workflows`;
        yield* fs.makeDirectory(directory, { recursive: true });
        const count = mode.startsWith("99") ? 99 : 100;
        const runnable = mode.endsWith("runnable");
        for (let index = 0; index < count; index++)
          yield* fs.writeFileString(
            `${directory}/aa${String(index).padStart(3, "0")}.yaml`,
            Yaml.stringify({
              ...sequence,
              id: mode === "100-duplicate" && index === 0 ? "target" : `aa${index}`,
            }),
          );
        const definition = yield* decodeDefinition({
          ...sequence,
          id: "target",
          nodes: sequence.nodes.map((node) =>
            node.kind === "agent" && mode === "100-unavailable-provider"
              ? {
                  ...node,
                  modelSelection: {
                    ...node.modelSelection,
                    instanceId: ProviderInstanceId.make("missing_fixture"),
                  },
                }
              : node,
          ),
        });
        const filename = `${directory}/zz-original.yml`;
        const bytes = Yaml.stringify(definition);
        yield* fs.writeFileString(filename, bytes);
        const validated = yield* runtime
          .invoke("validate", { ...test.scope, definition })
          .pipe(Effect.flatMap(decodeEntry));
        expect(validated.runnable).toBe(mode !== "100-unavailable-provider");
        let manualId: string | undefined;
        if (runnable) {
          const manual = yield* runtime
            .invoke("start", {
              ...test.scope,
              definition,
              input: {},
              clientRequestId: "manual",
              workspace: { type: "current" },
            })
            .pipe(Effect.flatMap(decodeRun));
          manualId = manual.id;
          yield* runtime.invoke("reconcile", test.scope);
          expect(yield* test.threads.getThreadShell(manual.attempts[0]!.threadId!)).not.toBeNull();
          expect(
            (yield* test.core.receipt(
              CommandId.make(`plugin:${pair(["workflows", `${manual.attempts[0]!.id}:launch:0`])}`),
            ))?.status,
          ).toBe("accepted");
        }
        yield* runtime.close;
        runtime = yield* test.boot(host, selected, targets);
        const visible = yield* runtime
          .invoke("catalog", test.scope)
          .pipe(Effect.flatMap(decodeCatalog));
        expect(visible).toHaveLength(102);
        if (runnable)
          expect(visible.some((entry) => entry.definition?.id === "target")).toBe(count === 99);
        const result = yield* runtime
          .invoke("schedule", {
            ...test.scope,
            id: "schedule-target",
            title: "Schedule target",
            definitionId: "target",
            task: "",
            workspace: "new-worktree",
            enabled: true,
            schedule: { type: "interval", everyMs: 60_000 },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe(runnable ? "Success" : "Failure");
        expect((yield* schedules!.list()).map((schedule) => schedule.id)).toEqual(
          runnable ? ["schedule-target"] : [],
        );
        yield* runtime.close;
        runtime = yield* test.boot(host, selected, targets);
        expect((yield* schedules!.list()).map((schedule) => schedule.id)).toEqual(
          runnable ? ["schedule-target"] : [],
        );
        expect(yield* fs.readFileString(filename)).toBe(bytes);
        if (!runnable) return;
        yield* schedules!.runNow("schedule-target", "scheduled-occurrence");
        const api = yield* runtime.registry.api("plugins.workflows.subscribe");
        const updates = api.invoke(test.scope);
        if (!Stream.isStream(updates)) return yield* Effect.die("Expected workflow subscription");
        const [scheduled] = yield* updates.pipe(
          Stream.mapEffect(() =>
            runtime.invoke("list", test.scope).pipe(Effect.flatMap(decodeRuns)),
          ),
          Stream.filter((runs) => runs.length === 2),
          Stream.mapEffect((runs) =>
            runtime
              .invoke("get", { ...test.scope, runId: runs.find((run) => run.id !== manualId)!.id })
              .pipe(Effect.flatMap(decodeRun)),
          ),
          Stream.filter((run) => run.attempts[0]?.phase === "running"),
          Stream.take(1),
          Stream.runCollect,
        );
        if (!scheduled) return yield* Effect.die("Expected scheduled workflow execution");
        expect(scheduled.definition).toEqual(definition);
        expect(yield* test.threads.getThreadShell(scheduled.attempts[0]!.threadId!)).not.toBeNull();
        expect(
          (yield* test.core.receipt(
            CommandId.make(
              `plugin:${pair(["workflows", `${scheduled.attempts[0]!.id}:launch:0`])}`,
            ),
          ))?.status,
        ).toBe("accepted");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

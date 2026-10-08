import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { Host, Schedules } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ScheduledTaskId } from "@t3tools/contracts";
import { RunSummary } from "@t3tools/plugin-workflows/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import { sequence } from "./Workflows.testkit.ts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Projects from "../project/ProjectService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { startEnvironment } from "./PluginHost.testkit.ts";

const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));

it.live.each(["short", "long-schedule", "long-scoped-manual", "legacy-receipt"] as const)(
  "starts a persisted workflow schedule with bounded internal identity: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("workflow-schedule-identity")),
          noBrowser: true,
        };
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(ChildProcess.make("git", ["init", config.baseDir]));
        yield* spawner.exitCode(
          ChildProcess.make("git", [
            "-C",
            config.baseDir,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
          ]),
        );
        const ready = yield* Deferred.make<Schedules["Service"]>();
        let replay: Effect.Effect<
          void,
          import("@t3tools/plugin-host-contract/schema").PluginError
        > = Effect.void;
        const server = yield* startEnvironment(config, [
          {
            ...plugin,
            acquire: Effect.gen(function* () {
              yield* Deferred.succeed(ready, yield* Schedules);
              const host = yield* Host;
              const services = yield* plugin.acquire.pipe(
                Effect.provideService(
                  Host,
                  Host.of({
                    ...host,
                    providers: () =>
                      host.providers().pipe(
                        Effect.map((providers) =>
                          providers.map((provider) => ({
                            ...provider,
                            available: provider.instanceId === "codex",
                          })),
                        ),
                      ),
                    launch: (input) => host.launch({ ...input, instruction: undefined }),
                  }),
                ),
              );
              return {
                ...services,
                scheduleTargets: services.scheduleTargets.map((target) => ({
                  ...target,
                  invoke: (input) => {
                    replay = target.invoke(input);
                    return replay;
                  },
                })),
              };
            }),
          },
        ]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const projectId = ProjectId.make("schedule-project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Schedule",
          workspaceRoot: config.baseDir,
        });
        const host = Context.get(server.context, Host);
        const scope = { environmentId: host.environmentId, projectId };
        const registry = Context.get(server.context, Registry.PluginRegistry);
        const runtime = {
          invoke: Effect.fnUntraced(function* (method: string, input: unknown) {
            const api = yield* registry.api(`plugins.workflows.${method}`);
            const effect = api.invoke(input);
            if (!Effect.isEffect(effect)) return yield* Effect.die("Expected request");
            return yield* effect;
          }),
        };
        yield* runtime.invoke("save", {
          ...scope,
          definition: sequence,
          expectedRevision: null,
        });
        const id = scenario === "long-schedule" ? "s".repeat(128) : "short";
        yield* runtime.invoke("schedule", {
          ...scope,
          id,
          title: "Schedule",
          definitionId: sequence.id,
          input: {},
          schedule: { type: "interval", everyMs: 60000 },
        });
        const schedules = yield* Deferred.await(ready);
        const tasks = Context.get(server.context, Tasks.ScheduledTaskService);
        if (scenario === "legacy-receipt") {
          yield* runtime.invoke("start", {
            ...scope,
            clientRequestId: "legacy-occurrence",
            definition: sequence,
            input: {},
          });
          yield* runtime.invoke("save", {
            ...scope,
            definition: { ...sequence, revision: sequence.revision + 1 },
            expectedRevision: sequence.revision,
          });
          yield* tasks.runNow({
            id: ScheduledTaskId.make(`plugin:workflows:${id}`),
            occurrenceId: "legacy-occurrence",
          });
        } else if (scenario === "long-scoped-manual") yield* schedules.runNow(id, "m".repeat(110));
        else yield* tasks.runNow({ id: ScheduledTaskId.make(`plugin:workflows:${id}`) });
        const runs = yield* runtime.invoke("list", scope).pipe(Effect.flatMap(decodeRuns));
        expect(runs).toHaveLength(1);
        const recorded = (yield* tasks.list()).tasks.find(
          (task) => task.id === `plugin:workflows:${id}`,
        )!;
        expect(recorded.lastRunStatus).toBe("succeeded");
        const occurrence = (yield* schedules.list())[0]!.lastOccurrenceId!;
        expect(occurrence.length).toBeGreaterThan(scenario.startsWith("long-") ? 128 : 0);
        if (scenario !== "legacy-receipt") {
          yield* runtime.invoke("save", {
            ...scope,
            definition: { ...sequence, revision: sequence.revision + 1 },
            expectedRevision: sequence.revision,
          });
        }
        yield* replay;
        expect(
          (yield* runtime.invoke("list", scope).pipe(Effect.flatMap(decodeRuns))).map(
            (run) => run.id,
          ),
        ).toEqual(runs.map((run) => run.id));
        if (scenario === "long-scoped-manual") {
          yield* schedules.runNow(id, "m".repeat(110));
          expect(
            yield* runtime.invoke("list", scope).pipe(Effect.flatMap(decodeRuns)),
          ).toHaveLength(1);
          expect((yield* schedules.list())[0]!.lastOccurrenceId).toBe(occurrence);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

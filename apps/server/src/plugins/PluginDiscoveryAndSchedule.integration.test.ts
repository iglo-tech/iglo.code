import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { Host, Schedules, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Spawner from "effect/unstable/process/ChildProcessSpawner";
import { startEnvironment } from "../plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live("returns path and null Git metadata for a non-Git project, with a Git control", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("review-nongit-workspace")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const server = yield* startEnvironment(config, []);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const core = Context.get(server.context, Host);
      const projectId = ProjectId.make("plain-project");
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Plain",
        workspaceRoot: config.baseDir,
      });
      const plain = yield* core.workspace(projectId).pipe(Effect.result);
      const spawner = yield* Spawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawner.string(ChildProcess.make("git", args, { cwd: config.baseDir }));
      yield* git("init", "-b", "main");
      const unborn = yield* core.workspace(projectId).pipe(Effect.result);
      expect(unborn._tag).toBe("Success");
      if (unborn._tag === "Success")
        expect(unborn.success).toEqual({ path: config.baseDir, branch: "main", head: null });
      yield* git(
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "control",
      );
      const control = yield* core.workspace(projectId);
      expect(control).toMatchObject({ path: config.baseDir, branch: "main" });
      expect(control.head).toMatch(/^[a-f0-9]{40}$/);
      yield* Fiber.interrupt(server.fiber);
      expect(plain._tag).toBe("Success");
      if (plain._tag === "Success")
        expect(plain.success).toEqual({ path: config.baseDir, branch: null, head: null });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("isolates manual schedule occurrence identities between plugins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const readyA = yield* Deferred.make<Schedules["Service"]>();
      const readyB = yield* Deferred.make<Schedules["Service"]>();
      const deliveries: { plugin: string; occurrenceId: string }[] = [];
      const plugin = (
        id: string,
        ready: Deferred.Deferred<Schedules["Service"]>,
      ): ServerPlugin => ({
        manifest: {
          id,
          displayName: id,
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["schedules"],
          server: { tools: [], api: [], scheduleTargets: [`${id}.dispatch`] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* Schedules);
          return {
            tools: [],
            api: [],
            attention: Stream.empty,
            scheduleTargets: [
              {
                id: `${id}.dispatch`,
                invoke: ({ occurrenceId }) =>
                  Effect.sync(() => {
                    deliveries.push({ plugin: id, occurrenceId });
                  }),
              },
            ],
          };
        }),
      });
      const config = {
        ...(yield* makeReplayServerConfig("review-occurrence-namespace")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const server = yield* startEnvironment(config, [
        plugin("alpha", readyA),
        plugin("beta", readyB),
      ]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const projectId = ProjectId.make("schedule-project");
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Schedules",
        workspaceRoot: config.baseDir,
      });
      const a = yield* Deferred.await(readyA);
      const b = yield* Deferred.await(readyB);
      const input = {
        id: "reminder",
        title: "Reminder",
        projectId,
        enabled: false,
        schedule: { type: "interval" as const, everyMs: 60000 },
        payload: {},
      };
      yield* a.upsert({ ...input, target: "alpha.dispatch" });
      yield* b.upsert({ ...input, target: "beta.dispatch" });
      yield* a.runNow("reminder", "manual-1");
      const second = yield* b.runNow("reminder", "manual-1").pipe(Effect.result);
      yield* b.runNow("reminder", "beta-manual-control");
      expect(deliveries.map((x) => x.plugin)).toEqual(["alpha", "beta", "beta"]);
      expect(deliveries[0]!.occurrenceId).not.toBe(deliveries[1]!.occurrenceId);
      yield* a.runNow("reminder", "manual-1");
      yield* b.runNow("reminder", "manual-1");
      expect(deliveries).toHaveLength(3);
      expect((yield* a.list())[0]?.lastOccurrenceId).toBe(deliveries[0]!.occurrenceId);
      yield* Fiber.interrupt(server.fiber);
      expect(second._tag).toBe("Success");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

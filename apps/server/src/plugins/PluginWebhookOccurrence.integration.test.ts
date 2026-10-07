import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { Storage, Schedules, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";

it.live.each([false, true])(
  "a new webhook retains its own occurrence; interrupted predecessor=%s",
  (interrupted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<{
          schedules: Schedules["Service"];
          storage: Storage["Service"];
        }>();
        const firstStarted = yield* Deferred.make<void>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "probe",
            displayName: "Probe",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["schedules", "persistence"],
            server: { tools: [], api: [], scheduleTargets: ["probe.run"] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [
            {
              id: 1,
              name: "results",
              run: Effect.gen(function* () {
                const { sql } = yield* Storage;
                yield* sql`CREATE TABLE results (id TEXT PRIMARY KEY)`.pipe(Effect.orDie);
              }),
            },
          ],
          acquire: Effect.gen(function* () {
            const storage = yield* Storage;
            yield* Deferred.succeed(ready, { schedules: yield* Schedules, storage });
            return {
              tools: [],
              api: [],
              attention: Stream.empty,
              scheduleTargets: [
                {
                  id: "probe.run",
                  invoke: ({ occurrenceId }) =>
                    Effect.gen(function* () {
                      seen.push(occurrenceId);
                      yield* storage.sql`INSERT OR IGNORE INTO results (id) VALUES (${occurrenceId})`.pipe(
                        Effect.orDie,
                      );
                      if (pause) {
                        yield* Deferred.succeed(firstStarted, undefined);
                        return yield* Effect.never;
                      }
                    }),
                },
              ],
            };
          }),
        };
        const seen: string[] = [];
        let pause = interrupted;
        const config = {
          ...(yield* makeReplayServerConfig("fresh-pr4-webhook")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        // External provider process probes are the only substituted I/O.
        yield* (yield* FileSystem.FileSystem).writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"enabled":false},"claudeAgent":{"enabled":false},"opencode":{"enabled":false},"cursor":{"enabled":false},"grok":{"enabled":false}}}',
        );
        const server = yield* startEnvironment(config, [plugin]);
        const { schedules, storage } = yield* Deferred.await(ready);
        const projectId = ProjectId.make("webhook-probe");
        yield* Context.get(server.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Probe",
          workspaceRoot: config.baseDir,
        });
        const schedule = {
          id: "one",
          target: "probe.run",
          title: "Probe",
          projectId,
          enabled: true,
          payload: {},
        };
        yield* schedules.upsert({
          ...schedule,
          schedule: interrupted ? { type: "interval", everyMs: 3600000 } : { type: "webhook" },
        });
        const tasks = Context.get(server.context, Tasks.ScheduledTaskService);
        if (interrupted) {
          const old = yield* schedules.runNow("one", "old-manual").pipe(Effect.forkScoped);
          yield* Deferred.await(firstStarted);
          yield* Fiber.interrupt(old);
          pause = false;
          yield* schedules.upsert({ ...schedule, schedule: { type: "webhook" } });
        }
        const task = (yield* tasks.list()).tasks[0]!;
        const sql = Context.get(server.context, SqlClient.SqlClient);
        const complete = yield* Deferred.make<void>();
        const watcher = yield* tasks.subscribeList().pipe(
          Stream.runForEach((list) =>
            list.tasks[0]?.lastRunStatus === "succeeded"
              ? Deferred.succeed(complete, undefined)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        const submitted = yield* tasks.triggerWebhook({
          hookId: task.id,
          token: task.webhook!.path.split("/").at(-1)!,
          method: "POST",
          path: "/api/hooks/probe",
          query: "",
          headers: {},
          body: new Uint8Array(),
          bodyText: "",
          relayDeliveryId: "new-webhook",
        });
        expect(submitted._tag).toBe("accepted");
        yield* Deferred.await(complete);
        const rows = yield* sql<{
          id: string;
          status: string;
        }>`SELECT id,status FROM scheduled_task_occurrences ORDER BY rowid`;
        const results = yield* storage.sql<{ id: string }>`SELECT id FROM results ORDER BY rowid`;
        yield* Fiber.interrupt(watcher);
        if (submitted._tag !== "accepted") throw new Error("Expected accepted delivery");
        const expected = `${task.id}:webhook:${submitted.deliveryId}`;
        expect(results.map((x) => x.id)).toContain(expected);
        expect(results).toHaveLength(interrupted ? 2 : 1);
        expect(rows).toContainEqual({ id: expected, status: "succeeded" });
        if (interrupted) {
          expect(rows.find((row) => row.id !== expected)?.status).toBe("pending");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

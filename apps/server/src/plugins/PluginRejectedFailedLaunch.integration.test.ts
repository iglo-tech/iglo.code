import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { PluginError, type PluginCommandReceipt } from "@t3tools/plugin-host-contract/schema";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Settings from "../serverSettings.ts";
import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";

it.live.each([
  {
    name: "rejected-without-cancel",
    rejectedInitially: true,
    acquireError: false,
    cancel: false,
    expectedRestart: false,
  },
  {
    name: "acquire-error",
    rejectedInitially: true,
    acquireError: true,
    cancel: false,
    expectedRestart: false,
  },
  {
    name: "rejected-explicitly-cancelled",
    rejectedInitially: true,
    acquireError: false,
    cancel: true,
    expectedRestart: false,
  },
  {
    name: "accepted-recovery-control",
    rejectedInitially: false,
    acquireError: false,
    cancel: false,
    expectedRestart: true,
  },
])(
  "preparation-only initialization recovery: $name",
  ({ rejectedInitially, acquireError, cancel, expectedRestart }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("gilfoyle-failed-init")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providers: Object.fromEntries(
              ["codex", "claudeAgent", "opencode", "cursor", "grok", "antigravity", "pi"].map(
                (id) => [
                  id,
                  { enabled: id === "codex", binaryPath: "/nonexistent/isolated-review-provider" },
                ],
              ),
            ),
          }),
        );
        let server = yield* startEnvironment(config, []);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const projectId = ProjectId.make("init-project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("create-project"),
          projectId,
          title: "Initialization",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: "exit 23",
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        yield* Fiber.interrupt(server.fiber);
        let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const initialReceipt = yield* Deferred.make<PluginCommandReceipt>();
        let rejected = rejectedInitially;
        let firstAcquire = true;
        const plugin: ServerPlugin = {
          manifest: {
            id: "init_probe",
            displayName: "Init probe",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution", "persistence"],
            server: { tools: [], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            const host = yield* Host,
              storage = yield* Storage;
            yield* Deferred.succeed(ready, { host, storage });
            if (firstAcquire) {
              const result = yield* host
                .launch({
                  environmentId: host.environmentId,
                  projectId,
                  commandId: CommandId.make("initial-launch"),
                  title: "Failed initialization work",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "fixture",
                  },
                  runtimeMode: "approval-required",
                  workspace: { type: "current" },
                })
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
              // Retain the first receipt before registry startup begins asynchronous replay.
              const created = yield* host.receipt(CommandId.make("initial-launch"));
              if (!created) return yield* Effect.die("Expected the initial launch receipt");
              yield* Deferred.succeed(initialReceipt, created);
              if (cancel) {
                yield* host.interrupt({
                  environmentId: host.environmentId,
                  projectId,
                  threadId: created.threadId,
                  commandId: CommandId.make("cancel-failed-launch"),
                });
              }
            }
            if (rejected && acquireError)
              return yield* new PluginError({
                pluginId: "init_probe",
                code: "service",
                operation: "acquire",
                message: "Acquisition failed after the native launch failed",
              });
            return {
              tools: [],
              api: [],
              scheduleTargets: rejected
                ? [{ id: "init_probe.undeclared", invoke: () => Effect.void }]
                : [],
              attention: Stream.empty,
            };
          }),
        };
        server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const bound = yield* Deferred.await(ready);
        expect(
          (yield* Context.get(server.context, Registry.PluginRegistry).catalog).plugins[0]?.status,
        ).toBe(rejectedInitially ? "unavailable" : "available");

        const cancelled = yield* bound.storage.sql`SELECT id FROM host_cancelled_launches`;
        expect(cancelled).toHaveLength(rejectedInitially ? 1 : 0);
        const createdBeforeRestart = yield* Deferred.await(initialReceipt);
        const marker = config.baseDir + "/unrequested-recovery";
        yield* Context.get(server.context, Projects.ProjectService).update({
          commandId: CommandId.make("repair-setup"),
          projectId,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf recovered > '${marker}'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        yield* Context.get(server.context, Settings.ServerSettingsService).updateSettings({
          projectSettingsOverrides: {
            [projectId]: {
              defaultProjectScripts: [
                {
                  id: "setup",
                  name: "Setup",
                  icon: "configure",
                  command: `printf recovered > '${marker}'`,
                  runOnWorktreeCreate: true,
                  async: false,
                },
              ],
            },
          },
        });
        yield* Fiber.interrupt(server.fiber);
        rejected = false;
        firstAcquire = false;
        ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const restored = yield* Deferred.await(ready);
        if (rejectedInitially) {
          const drain = yield* Bound.make("init_probe").pipe(
            Effect.provideService(Host, Context.get(server.context, Host)),
            Effect.provideService(Storage, restored.storage),
          );
          yield* drain.recover;
        } else {
          // Observe actual registry startup recovery; issue no launch or recovery call.
          yield* Context.get(server.context, Threads.ThreadManagementService)
            .streamStoredEventsFrom({
              threadId: createdBeforeRestart.threadId,
              afterSequence: 0,
              eventType: "thread.metadata-updated",
            })
            .pipe(
              Stream.filter(
                (e) => e.commandId === 'plugin:["init_probe","initial-launch"]:workspace-ready',
              ),
              Stream.runHead,
            );
        }
        const restarted = yield* fs.exists(marker);

        expect(restarted).toBe(expectedRestart);
        if (rejectedInitially) {
          const explicit = yield* restored.host.launch({
            environmentId: restored.host.environmentId,
            projectId,
            commandId: CommandId.make("initial-launch"),
            title: "Failed initialization work",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
            runtimeMode: "approval-required",
            workspace: { type: "current" },
          });
          expect(explicit.status).toBe("accepted");
          expect(yield* fs.exists(marker)).toBe(true);
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

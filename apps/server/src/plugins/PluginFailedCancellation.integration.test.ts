import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { startEnvironment } from "./PluginHost.testkit.ts";
import * as Startup from "../serverRuntimeStartup.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.gen(function* () {
  const config = {
    ...(yield* makeReplayServerConfig("clean-independent-pr4")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const fs = yield* FileSystem.FileSystem;
  // Block native execution; only external provider process I/O is replaced.
  const binary = config.baseDir + "/codex-fixture";
  yield* fs.writeFileString(
    binary,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
  );
  yield* fs.chmod(binary, 0o755);
  yield* fs.writeFileString(
    config.settingsPath,
    yield* encodeJson({
      providers: { codex: { binaryPath: binary } },
    }),
  );
  const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
  const plugin: ServerPlugin = {
    manifest: {
      id: "clean",
      displayName: "Clean",
      version: "1",
      hostVersion: 1,
      requiredCapabilities: ["execution", "lifecycle", "persistence"],
      server: { tools: [], api: [], scheduleTargets: [] },
      web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
    },
    migrations: [],
    acquire: Effect.gen(function* () {
      yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
      return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
    }),
  };
  const server = yield* startEnvironment(config, [plugin]);
  yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
  const bound = yield* Deferred.await(ready);
  const projectId = ProjectId.make("clean-project");
  const projects = Context.get(server.context, Projects.ProjectService);
  const threads = Context.get(server.context, Threads.ThreadManagementService);
  yield* projects.create({
    projectId,
    commandId: CommandId.make("project"),
    title: "Clean",
    workspaceRoot: config.baseDir,
  });
  return { config, server, bound, projects, threads, projectId };
});

it.live.each([
  { cancelled: false, expired: false },
  { cancelled: true, expired: false },
  { cancelled: true, expired: true },
])("failed launch cancellation: %o", ({ cancelled, expired }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("fail-script"),
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
      const input = {
        environmentId: s.bound.host.environmentId,
        projectId: s.projectId,
        commandId: CommandId.make("failed-current"),
        title: "Fail then stop",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "approval-required" as const,
        workspace: { type: "current" as const },
      };
      expect((yield* s.bound.host.launch(input).pipe(Effect.result))._tag).toBe("Failure");
      const target = (yield* s.bound.host.reconcile({
        environmentId: input.environmentId,
        projectId: input.projectId,
      })).threads[0]!;
      const stop = {
        environmentId: input.environmentId,
        projectId: input.projectId,
        threadId: target.threadId,
        commandId: CommandId.make("stop-failed"),
      };
      if (expired)
        yield* Context.get(s.server.context, Tracker.WorktreeSetupTracker)
          .stream(target.threadId)
          .pipe(
            Stream.filter((snapshot) => snapshot === null),
            Stream.runHead,
          );
      if (cancelled) {
        yield* s.bound.host.interrupt(stop);
        yield* s.bound.host.interrupt(stop);
      }
      const tombstones = yield* s.bound.storage.sql`SELECT id FROM host_cancelled_launches`;
      expect(tombstones).toHaveLength(cancelled ? 1 : 0);
      const marker = s.config.baseDir + "/resurrected-setup";
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("repair-script"),
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            command: `printf restarted > '${marker}'`,
            runOnWorktreeCreate: true,
            async: false,
          },
        ],
      });
      yield* Fiber.interrupt(s.server.fiber);
      const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "clean",
          displayName: "Clean",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "persistence"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const second = yield* startEnvironment(s.config, [plugin]);
      yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const restored = yield* Deferred.await(ready);
      // Drain the actual durable recovery service, using the same storage and core host.
      const replay = yield* Bound.make("clean").pipe(
        Effect.provideService(Host, Context.get(second.context, Host)),
        Effect.provideService(Storage, restored.storage),
      );
      yield* replay.recover;
      const fs = yield* FileSystem.FileSystem;
      const restarted = yield* fs.exists(marker);
      expect(restarted).toBe(!cancelled);
      if (cancelled) {
        yield* restored.host.launch(input);
        expect(yield* fs.exists(marker)).toBe(true);
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live("plugin inspection and reconciliation include a native PR monitor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<Host["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "probe",
          displayName: "Probe",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "lifecycle"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* Host);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const config = {
        ...(yield* makeReplayServerConfig("independent-watch")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      yield* (yield* FileSystem.FileSystem).writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-provider"}}}',
      );
      const server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const host = yield* Deferred.await(ready);
      const projectId = ProjectId.make("watch-project"),
        threadId = ThreadId.make("watch-thread");
      const threads = Context.get(server.context, Threads.ThreadManagementService);
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Watch",
        workspaceRoot: config.baseDir,
      });
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("thread"),
        threadId,
        projectId,
        title: "Watch",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const target = { environmentId: host.environmentId, projectId, threadId };
      expect((yield* host.inspect(target)).outstandingWork).toEqual([]);
      yield* threads.dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("watch"),
        threadId,
        host: "github.com",
        repository: "isolated/fixture",
        number: 987654321,
        watching: true,
        link: { url: "https://github.com/isolated/fixture/pull/987654321", source: "manual" },
      });
      const shell = yield* threads.getThreadShell(threadId);
      const observed = yield* host.inspect(target);
      const reconciled = yield* host.reconcile(target);
      yield* host.interrupt({ ...target, commandId: CommandId.make("stop") });
      const after = yield* threads.getThreadShell(threadId);
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("native-stop-control"),
        threadId,
      });
      const nativeStopped = yield* threads.getThreadShell(threadId);
      yield* Fiber.interrupt(server.fiber);
      expect(shell?.pendingBackgroundTasks).toHaveLength(1);
      expect(after?.pendingBackgroundTasks).toHaveLength(1);
      expect(nativeStopped?.pendingBackgroundTasks).toEqual([]);
      expect(reconciled.threads.find((t) => t.threadId === threadId)?.outstandingWork).toHaveLength(
        1,
      );
      expect(observed.outstandingWork).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

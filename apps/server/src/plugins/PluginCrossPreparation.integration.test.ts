import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live.each([
  { retained: true, failed: true },
  { retained: false, failed: true },
  { retained: true, failed: false },
  { retained: false, failed: false },
])("cross-plugin preparation recovery: %o", ({ retained, failed }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("pr4-fresh-cross-plugin")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/pr4-external-provider"},"claudeAgent":{"binaryPath":"/nonexistent/pr4-external-provider"}}}',
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawn
          .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
          .pipe(Effect.map((x) => x.trim()));
      yield* git("init", "-b", "main");
      const commit = (message: string) =>
        git(
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          message,
        );
      yield* commit("pinned");
      const pinned = yield* git("rev-parse", "HEAD");
      yield* commit("root advanced");
      const rootHead = yield* git("rev-parse", "HEAD");
      yield* git("branch", "collision");
      let aReady = yield* Deferred.make<Host["Service"]>();
      let bReady = yield* Deferred.make<Host["Service"]>();
      const plugin = (
        id: string,
        publish: () => Deferred.Deferred<Host["Service"]>,
      ): ServerPlugin => ({
        manifest: {
          id,
          displayName: id,
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(publish(), yield* Host);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      });
      const a = plugin("owner", () => aReady),
        b = plugin("sender", () => bReady);
      const first = yield* startEnvironment(config, [a, b]);
      yield* Context.get(first.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const owner = yield* Deferred.await(aReady),
        sender = yield* Deferred.await(bReady);
      const projectId = ProjectId.make("project");
      yield* Context.get(first.context, Projects.ProjectService).create({
        projectId,
        commandId: CommandId.make("project"),
        title: "Review",
        workspaceRoot: config.baseDir,
      });
      const input = {
        environmentId: owner.environmentId,
        projectId,
        commandId: CommandId.make("prepare"),
        title: "Pinned thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
        runtimeMode: "approval-required" as const,
        workspace: {
          type: "exact-ref" as const,
          ref: pinned,
          branch: failed ? "collision" : "prepared",
        },
      };
      const launch = yield* owner.launch(input).pipe(Effect.result);
      expect(launch._tag).toBe(failed ? "Failure" : "Success");
      const created = yield* owner.receipt(input.commandId);
      expect(created?.status).toBe("accepted");
      const target = { environmentId: owner.environmentId, projectId, threadId: created!.threadId };
      const sendInput = {
        ...target,
        commandId: CommandId.make("send"),
        instruction: "must use the pinned checkout",
        mode: "queue" as const,
      };
      if (failed) {
        expect(
          (yield* owner
            .send({ ...sendInput, commandId: CommandId.make("owner-send") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* sender.send(sendInput).pipe(Effect.result))._tag).toBe("Failure");
      }
      yield* Fiber.interrupt(first.fiber);
      aReady = yield* Deferred.make<Host["Service"]>();
      bReady = yield* Deferred.make<Host["Service"]>();
      const second = yield* startEnvironment(config, retained ? [a, b] : [b]);
      yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const restored = yield* Deferred.await(bReady);
      if (retained && failed)
        yield* Context.get(second.context, Tracker.WorktreeSetupTracker)
          .stream(target.threadId)
          .pipe(
            Stream.filter((s) => s?.phase === "failed"),
            Stream.runHead,
          );
      if (retained && failed)
        expect(
          (yield* (yield* Deferred.await(aReady))
            .send({ ...sendInput, commandId: CommandId.make("owner-send") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      const sent = yield* restored.send(sendInput).pipe(Effect.result);
      const records = yield* Context.get(
        second.context,
        Threads.ThreadManagementService,
      ).getThreadRecords(target.threadId, ["messages", "runs", "checkpointScopes"]);
      expect(sent._tag).toBe(failed ? "Failure" : "Success");
      expect(records.messages).toHaveLength(failed ? 0 : 1);
      if (failed) expect(records.checkpointScopes).toEqual([]);
      else {
        expect(records.checkpointScopes[0]?.cwd).toBe(records.thread.worktreePath);
        expect(
          yield* spawn
            .string(
              ChildProcess.make("git", ["rev-parse", "HEAD"], {
                cwd: records.thread.worktreePath!,
              }),
            )
            .pipe(Effect.map((s) => s.trim())),
        ).toBe(pinned);
      }
      if (failed) expect(records.thread.worktreePath).toBeNull();
      else expect(records.thread.worktreePath).not.toBeNull();
      expect(pinned).not.toBe(rootHead);
      yield* Fiber.interrupt(second.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

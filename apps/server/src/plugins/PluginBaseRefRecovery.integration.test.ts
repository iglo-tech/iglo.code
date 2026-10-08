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
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";

it.live.each([
  { baseAdvanced: false, proof: "stored" },
  { baseAdvanced: true, proof: "stored" },
  { baseAdvanced: true, proof: "reflog" },
  { baseAdvanced: true, proof: "expired" },
])("native preparation retry; identity proof=%j", ({ baseAdvanced, proof }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("independent-base-ref")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      // Replace only external provider I/O. No core service is mocked.
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-review-disabled"}}}',
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: string[]) =>
        spawn.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((s) => s.trim()));
      yield* git(config.baseDir, "init", "-b", "main");
      yield* git(
        config.baseDir,
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      );
      const pinned = yield* git(config.baseDir, "rev-parse", "HEAD");
      let ready = yield* Deferred.make<Host["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "rename_review",
          displayName: "Rename review",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "persistence"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(ready, yield* Host);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      let server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      let host = yield* Deferred.await(ready);
      const projectId = ProjectId.make("rename-review-project");
      let projects = Context.get(server.context, Projects.ProjectService);
      let threads = Context.get(server.context, Threads.ThreadManagementService);
      const script = (command: string) => [
        {
          id: "setup",
          name: "Setup",
          icon: "configure" as const,
          command,
          runOnWorktreeCreate: true,
          async: false,
        },
      ];
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Rename",
        workspaceRoot: config.baseDir,
        scripts: script("exit 23"),
      });
      const launches = Context.get(server.context, Launch.ThreadLaunchService);
      const input = {
        projectId,
        commandId: CommandId.make("native-launch"),
        title: "Native",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        createdBy: "user" as const,
        creationSource: "web" as const,
        workspaceStrategy: { type: "worktree" as const, baseRef: "main", branch: "review/work" },
        initialMessage: { text: "Prepare work", attachments: [] },
      };
      yield* launches.launch(input);
      const thread = (yield* host.reconcile({ environmentId: host.environmentId, projectId }))
        .threads[0]!;
      const runFailure = yield* threads
        .streamStoredEventsFrom({
          threadId: thread.threadId,
          afterSequence: 0,
          eventType: "run.updated",
        })
        .pipe(
          Stream.filter(
            (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
          ),
          Stream.runHead,
        );
      expect(runFailure._tag).toBe("Some");
      const run = (yield* threads.getThreadRecords(thread.threadId, ["runs"])).runs[0]!;
      const checkout = (yield* threads.getThreadShell(thread.threadId))!.worktreePath!;
      if (proof === "reflog")
        yield* git(
          config.baseDir,
          "config",
          "--local",
          "--unset",
          "branch.review/work.t3codeBaseCommit",
        );
      if (proof === "expired")
        yield* git(config.baseDir, "reflog", "expire", "--expire=now", "--all");
      // Only the source branch advances. The recorded checkout, branch,
      // ownership, and original commit remain untouched.
      if (baseAdvanced)
        yield* git(
          config.baseDir,
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "main advanced",
        );
      expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
      expect(yield* git(checkout, "branch", "--show-current")).toBe("review/work");
      expect((yield* git(config.baseDir, "rev-parse", "main")) === pinned).toBe(!baseAdvanced);
      yield* projects.update({
        commandId: CommandId.make("repair"),
        projectId,
        scripts: script("printf recovered > base-ref-recovery-marker"),
      });
      yield* Fiber.interrupt(server.fiber);
      ready = yield* Deferred.make<Host["Service"]>();
      server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      host = yield* Deferred.await(ready);
      threads = Context.get(server.context, Threads.ThreadManagementService);
      const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
      yield* Context.get(server.context, Launch.ThreadLaunchService).retryPreparation({
        threadId: thread.threadId,
        runId: run.id,
        commandId: CommandId.make("retry"),
      });
      const outcome = yield* tracker.stream(thread.threadId).pipe(
        Stream.filter(
          (x) =>
            x?.phase === "failed" ||
            x?.stages.some((s) => s.id === "agent" && s.status === "done") === true,
        ),
        Stream.runHead,
      );
      expect(outcome._tag).toBe("Some");
      if (outcome._tag === "Some") {
        expect(outcome.value!.phase).not.toBe("failed");
      }
      expect(yield* fs.exists(checkout + "/base-ref-recovery-marker")).toBe(true);
      expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
      yield* Fiber.interrupt(server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Config from "../config.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { startEnvironment } from "../plugins/PluginHost.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Stream from "effect/Stream";

it.live("ordinary launch preserves upstream tracking without any plugins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* makeReplayServerConfig("independent-pr4-tracking");
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: string[]) =>
        spawner.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((x) => x.trim()));
      const cwd = config.baseDir;
      yield* git(cwd, "init", "-b", "main");
      yield* git(
        cwd,
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      );
      const remote = yield* fs.makeTempDirectoryScoped({ prefix: "independent-local-remote-" });
      yield* git(remote, "init", "--bare");
      yield* git(cwd, "remote", "add", "origin", remote);
      yield* git(cwd, "push", "origin", "HEAD:dev");
      yield* git(cwd, "fetch", "origin");
      yield* git(cwd, "config", "branch.autoSetupMerge", "true");
      const ctx = yield* Layer.build(
        Git.layer.pipe(Layer.provide(Layer.succeed(Config.ServerConfig, config))),
      );
      const driver = Context.get(ctx, Git.GitVcsDriver);
      const control = yield* driver.createWorktree({
        cwd,
        refName: "origin/dev",
        newRefName: "independent/control",
        baseRefName: "origin/dev",
        path: cwd + "/control",
      });
      const owned = yield* driver.createWorktree(
        {
          cwd,
          refName: "origin/dev",
          newRefName: "independent/owned",
          baseRefName: "origin/dev",
          path: cwd + "/owned",
        },
        { ownerId: "run:owned" },
      );
      expect(yield* git(control.worktree.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
        "origin/dev",
      );
      const upstream = yield* git(
        owned.worktree.path,
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ).pipe(Effect.result);
      expect(
        yield* git(
          owned.worktree.path,
          "config",
          "--get",
          "branch.independent/owned.gh-merge-base",
        ),
      ).toBe("dev");
      expect(yield* git(owned.worktree.path, "rev-parse", "HEAD")).toBe(
        yield* git(control.worktree.path, "rev-parse", "HEAD"),
      );
      const pull = yield* spawner.exitCode(
        ChildProcess.make("git", ["pull", "--ff-only"], { cwd: owned.worktree.path }),
      );
      const controlPull = yield* spawner.exitCode(
        ChildProcess.make("git", ["pull", "--ff-only"], { cwd: control.worktree.path }),
      );
      expect(Number(controlPull)).toBe(0);
      const server = yield* startEnvironment(
        { ...config, noBrowser: true, traceTimingEnabled: false },
        [],
      );
      const projectId = ProjectId.make("ordinary-project");
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Ordinary",
        workspaceRoot: cwd,
      });
      const launched = yield* Context.get(server.context, Launch.ThreadLaunchService).launch({
        commandId: CommandId.make("ordinary-launch"),
        projectId,
        title: "Ordinary",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: {
          type: "worktree",
          baseRef: "origin/dev",
          startFromOrigin: false,
          branch: "independent/ordinary",
        },
        createdBy: "user",
        creationSource: "web",
      });
      const done = yield* Context.get(server.context, Tracker.WorktreeSetupTracker)
        .stream(launched.threadId)
        .pipe(
          Stream.filter((s) => s !== null && s.phase !== "running"),
          Stream.runHead,
        );
      expect(done._tag === "Some" ? done.value?.phase : null).toBe("done");
      const ordinary = (yield* Context.get(
        server.context,
        Threads.ThreadManagementService,
      ).getThreadShell(launched.threadId))!;
      const ordinaryUpstream = yield* git(
        ordinary.worktreePath!,
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      );
      const ordinaryPull = yield* spawner.exitCode(
        ChildProcess.make("git", ["pull", "--ff-only"], { cwd: ordinary.worktreePath! }),
      );
      expect(upstream._tag === "Success" ? upstream.success : null).toBe("origin/dev");
      expect(ordinaryUpstream).toBe("origin/dev");
      expect(Number(pull)).toBe(0);
      expect(Number(ordinaryPull)).toBe(0);
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => {
      expect(exit._tag).toBe("Success");
    }),
  ),
);

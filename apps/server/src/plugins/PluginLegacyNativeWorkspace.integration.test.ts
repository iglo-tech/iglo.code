import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { makeProviderFailure } from "../orchestration-v2/ProviderFailure.ts";

it.live.each([
  "legacy",
  "advanced-source",
  "owned",
  "unclaimed-new",
  "foreign-claim",
  "moved-legacy",
] as const)("native recorded preparation recovery: %s", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("legacy-native-workspace")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      const binary = config.baseDir + "/provider-fixture";
      yield* fs.writeFileString(
        binary,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
      );
      yield* fs.chmod(binary, 0o755);
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providers: { codex: { binaryPath: binary }, claudeAgent: { binaryPath: binary } },
        }),
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: string[]) =>
        spawn.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((s) => s.trim()));
      const commit = (cwd: string, message: string) =>
        git(
          cwd,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          message,
        );
      yield* git(config.baseDir, "init", "-b", "main");
      yield* fs.writeFileString(config.baseDir + "/tracked-file", "initial");
      yield* git(config.baseDir, "add", "tracked-file");
      yield* commit(config.baseDir, "initial");
      const pinned = yield* git(config.baseDir, "rev-parse", "HEAD");
      let server = yield* startEnvironment(config, []);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const projectId = ProjectId.make("legacy-native-project");
      const threadId = ThreadId.make("legacy-native-thread");
      const selection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
      const projects = Context.get(server.context, Projects.ProjectService);
      const threads = Context.get(server.context, Threads.ThreadManagementService);
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Legacy native",
        workspaceRoot: config.baseDir,
      });
      yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("native-launch"),
        threadId,
        projectId,
        title: "Native",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      // The persisted prefix of the old native launch: deferred instruction,
      // unclaimed Git checkout, recorded workspace, then setup failure.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("native-launch:initial-message"),
        threadId,
        messageId: MessageId.make("initial-message"),
        text: "Initial instruction",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: {
            type: "worktree",
            baseRef: "main",
            branch: "legacy-native",
            ...(mode === "owned" || mode === "unclaimed-new" ? { requiresOwnership: true } : {}),
          },
        },
      });
      const run = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]!;
      const created = yield* Context.get(server.context, Git.GitVcsDriver).createWorktree(
        {
          cwd: config.baseDir,
          refName: "main",
          newRefName: "legacy-native",
          baseRefName: "main",
          path: null,
        },
        mode === "owned" ? { ownerId: `run:${run.id}` } : undefined,
      );
      const checkout = created.worktree.path;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("workspace"),
        threadId,
        branch: created.worktree.refName,
        worktreePath: checkout,
      });
      yield* threads.dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make("setup-failed"),
        threadId,
        runId: run.id,
        failure: makeProviderFailure({
          message: "Old native setup failed",
          class: "validation_error",
          retryable: false,
        }),
      });
      if (mode === "advanced-source") yield* commit(config.baseDir, "source advanced");
      if (mode === "moved-legacy") yield* commit(checkout, "checkout advanced");
      if (mode === "foreign-claim")
        yield* git(
          config.baseDir,
          "config",
          "--local",
          "branch.legacy-native.t3codeOwner",
          "foreign-owner",
        );
      yield* fs.writeFileString(checkout + "/retained-user-file", "keep");
      yield* fs.writeFileString(checkout + "/tracked-file", "setup edits");
      yield* projects.update({
        commandId: CommandId.make("repair"),
        projectId,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            runOnWorktreeCreate: true,
            async: false,
            command: "printf repaired > legacy-recovery-marker",
          },
        ],
      });
      yield* Fiber.interrupt(server.fiber);
      server = yield* startEnvironment(config, []);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      yield* Context.get(server.context, Launch.ThreadLaunchService).retryPreparation({
        commandId: CommandId.make("retry"),
        threadId,
        runId: run.id,
      });
      const terminal = yield* Context.get(server.context, Tracker.WorktreeSetupTracker)
        .stream(threadId)
        .pipe(
          Stream.filter(
            (snapshot) =>
              snapshot?.phase === "failed" ||
              snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
                true,
          ),
          Stream.runHead,
        );
      const accepted = mode === "legacy" || mode === "advanced-source" || mode === "owned";
      expect(terminal._tag).toBe("Some");
      if (terminal._tag === "Some") expect(terminal.value?.phase === "failed").toBe(!accepted);
      expect(yield* fs.exists(checkout + "/legacy-recovery-marker")).toBe(accepted);
      expect(yield* fs.readFileString(checkout + "/retained-user-file")).toBe("keep");
      expect(yield* fs.readFileString(checkout + "/tracked-file")).toBe("setup edits");
      const marker = yield* spawn.exitCode(
        ChildProcess.make(
          "git",
          ["config", "--local", "--get", "branch.legacy-native.t3codeOwner"],
          { cwd: config.baseDir },
        ),
      );
      expect(marker).toBe(accepted || mode === "foreign-claim" ? 0 : 1);
      if (accepted) {
        expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
        expect(
          yield* git(
            config.baseDir,
            "config",
            "--local",
            "--get",
            "branch.legacy-native.t3codeBaseCommit",
          ),
        ).toBe(pinned);
      }
      if (mode === "foreign-claim")
        expect(
          yield* git(
            config.baseDir,
            "config",
            "--local",
            "--get",
            "branch.legacy-native.t3codeOwner",
          ),
        ).toBe("foreign-owner");
      yield* Fiber.interrupt(server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

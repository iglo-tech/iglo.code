import { expect, it } from "@effect/vitest";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Spawner from "effect/unstable/process/ChildProcessSpawner";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

const fixture = Effect.gen(function* () {
  const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
  const plugin: ServerPlugin = {
    manifest: {
      id: "fresh_review",
      displayName: "Review",
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
  const config = {
    ...(yield* makeReplayServerConfig("fresh-pr4-workspace")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const spawner = yield* Spawner.ChildProcessSpawner;
  const git = (...args: string[]) =>
    spawner
      .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
      .pipe(Effect.map((x) => x.trim()));
  yield* git("init", "-b", "main");
  yield* git(
    "-c",
    "user.name=Review",
    "-c",
    "user.email=review@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const head = yield* git("rev-parse", "HEAD");
  const server = yield* startEnvironment(config, [plugin]);
  const { host, storage } = yield* Deferred.await(ready);
  const projectId = ProjectId.make("workspace-review");
  const projects = Context.get(server.context, Projects.ProjectService);
  const threads = Context.get(server.context, Threads.ThreadManagementService);
  const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
  yield* projects.create({
    commandId: CommandId.make("project"),
    projectId,
    title: "Review",
    workspaceRoot: config.baseDir,
  });
  const input = {
    environmentId: host.environmentId,
    projectId,
    commandId: CommandId.make("launch"),
    title: "Review",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "approval-required" as const,
    workspace: { type: "exact-ref" as const, ref: head },
  };
  const gate = config.baseDir + "/setup-gate";
  yield* spawner.exitCode(ChildProcess.make("mkfifo", [gate]));
  const gated = () =>
    projects.update({
      commandId: CommandId.make("add-gate"),
      projectId,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          icon: "configure",
          command: `printf 'FRESH_REVIEW_READY\n'; cat '${gate}'`,
          runOnWorktreeCreate: true,
          async: false,
        },
      ],
    });
  const waitGate = (threadId: ThreadId) =>
    tracker.stream(threadId).pipe(
      Stream.filter(
        (x) =>
          x?.phase === "running" && x.stages.some((s) => s.tail.includes("FRESH_REVIEW_READY")),
      ),
      Stream.runHead,
    );
  return {
    host,
    storage,
    config,
    server,
    projectId,
    threads,
    tracker,
    projects,
    input,
    git,
    gated,
    waitGate,
  };
});

it.live("clears the workspace after every cancellation of the same launch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      yield* s.gated();
      const first = yield* s.host.launch(s.input).pipe(Effect.result, Effect.forkScoped);
      const created = yield* Context.get(s.server.context, Host)
        .lifecycle({
          environmentId: s.host.environmentId,
          projectId: s.projectId,
          afterCursor: 0,
        })
        .pipe(
          Stream.filter((x) => x.kind === "event"),
          Stream.runHead,
        );
      if (created._tag === "None" || created.value.kind !== "event") {
        return yield* Effect.die("Missing created thread event");
      }
      const threadId = created.value.threadId;
      const fs = yield* FileSystem.FileSystem;
      let launching = first;
      const paths: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        yield* s.waitGate(threadId);
        const shell = yield* s.threads.getThreadShell(threadId);
        expect(shell?.worktreePath).not.toBeNull();
        const worktreePath = shell!.worktreePath!;
        paths.push(worktreePath);
        yield* Fiber.interrupt(launching);
        expect(yield* s.tracker.cancel(threadId)).toBe(true);
        expect((yield* s.threads.getThreadShell(threadId))!.worktreePath).toBeNull();
        expect(yield* fs.exists(worktreePath)).toBe(false);
        if (attempt === 0) {
          launching = yield* s.host.launch(s.input).pipe(Effect.result, Effect.forkScoped);
        }
      }
      expect(paths[1]).not.toBe(paths[0]);
      yield* s.projects.update({
        commandId: CommandId.make("remove-gate"),
        projectId: s.projectId,
        scripts: [],
      });
      const recovered = yield* s.host.launch(s.input);
      expect(recovered.status).toBe("accepted");
      expect(recovered.threadId).toBe(threadId);
      const restored = yield* s.threads.getThreadShell(threadId);
      expect(yield* fs.exists(restored!.worktreePath!)).toBe(true);
      const spawner = yield* Spawner.ChildProcessSpawner;
      expect(
        (yield* spawner.string(
          ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: restored!.worktreePath! }),
        )).trim(),
      ).toBe(s.input.workspace.ref);
      expect(yield* s.host.receipt(s.input.commandId)).toEqual(recovered);
      yield* Fiber.interrupt(s.server.fiber);
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => expect(exit._tag).toBe("Success")),
  ),
);

it.live("does not acknowledge cancelled preparation before its metadata clears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      yield* s.gated();
      const launching = yield* s.host.launch(s.input).pipe(Effect.result, Effect.forkScoped);
      const created = yield* Context.get(s.server.context, Host)
        .lifecycle({
          environmentId: s.host.environmentId,
          projectId: s.projectId,
          afterCursor: 0,
        })
        .pipe(
          Stream.filter((event) => event.kind === "event"),
          Stream.runHead,
        );
      if (created._tag === "None" || created.value.kind !== "event") {
        return yield* Effect.die("Missing created thread event");
      }
      const threadId = created.value.threadId;
      yield* s.waitGate(threadId);
      const prepared = (yield* s.threads.getThreadShell(threadId))!;
      yield* Fiber.interrupt(launching);
      expect(yield* s.tracker.cancel(threadId)).toBe(true);
      expect((yield* s.threads.getThreadShell(threadId))!.worktreePath).toBeNull();
      // Recreate the reachable prefix after cancellation is published but before
      // cleanup clears the binding. Receipt reconciliation must reject this state.
      yield* s.threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("cancelled-before-metadata-clear"),
        threadId,
        branch: prepared.branch,
        worktreePath: prepared.worktreePath,
      });
      expect((yield* s.host.launch(s.input).pipe(Effect.result))._tag).toBe("Failure");
      const rows = yield* s.storage.sql<{ result: string | null }>`
          SELECT result FROM host_commands WHERE id=${s.input.commandId}`;
      expect(rows[0]?.result).toBeNull();
      yield* Fiber.interrupt(s.server.fiber);
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => expect(exit._tag).toBe("Success")),
  ),
);

it.live.each(["another thread", "external checkout", "external branch"] as const)(
  "keeps an occupied branch conflict on retry: %s",
  (owner) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const input = {
          ...s.input,
          workspace: { ...s.input.workspace, branch: "shared-branch" },
        };
        let originalThreadId: ThreadId | null = null;
        let originalPath: string | null = null;
        if (owner === "another thread") {
          const original = yield* s.host.launch({
            ...input,
            commandId: CommandId.make("original"),
          });
          originalThreadId = original.threadId;
          originalPath = (yield* s.threads.getThreadShell(original.threadId))!.worktreePath!;
        } else if (owner === "external checkout") {
          originalPath = (yield* Context.get(s.server.context, Git.GitVcsDriver).createWorktree({
            cwd: s.config.baseDir,
            refName: input.workspace.ref,
            newRefName: input.workspace.branch,
            path: null,
          })).worktree.path;
        } else {
          yield* s.git("branch", input.workspace.branch);
        }
        if (originalPath !== null) {
          yield* fs.writeFileString(originalPath + "/untracked-user-work.txt", "must survive");
        }
        const conflicting = { ...input, commandId: CommandId.make("conflicting") };
        for (let attempt = 0; attempt < 2; attempt++) {
          expect((yield* s.host.launch(conflicting).pipe(Effect.result))._tag).toBe("Failure");
          const receipt = (yield* s.host.receipt(conflicting.commandId))!;
          expect(receipt.threadId).not.toBe(originalThreadId);
          expect((yield* s.threads.getThreadShell(receipt.threadId))!.worktreePath).toBeNull();
          expect((yield* s.tracker.get(receipt.threadId))?.phase).toBe("failed");
          if (originalPath !== null) {
            expect(yield* fs.readFileString(originalPath + "/untracked-user-work.txt")).toBe(
              "must survive",
            );
          }
        }
        expect(yield* s.git("rev-parse", input.workspace.branch)).toBe(input.workspace.ref);
        if (originalThreadId !== null) {
          expect((yield* s.threads.getThreadShell(originalThreadId))!.worktreePath).toBe(
            originalPath,
          );
        }
        const control = yield* s.host.launch({
          ...input,
          commandId: CommandId.make("free-branch"),
          workspace: { ...input.workspace, branch: "free-branch" },
        });
        expect(control.status).toBe("accepted");
        expect((yield* s.threads.getThreadShell(control.threadId))!.worktreePath).not.toBeNull();
        yield* Fiber.interrupt(s.server.fiber);
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.exit,
      Effect.map((exit) => expect(exit._tag).toBe("Success")),
    ),
);

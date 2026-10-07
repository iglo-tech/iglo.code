import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
it.live.each([false, true])("recorded workspace recovery after reflog expiry=%s", (expire) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("independent-reflog")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/review-provider-disabled"}}}',
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawn
          .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
          .pipe(Effect.map((s) => s.trim()));
      yield* git("init", "-b", "main");
      yield* git(
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "base",
      );
      const pinned = yield* git("rev-parse", "HEAD");
      const ready = yield* Deferred.make<Host["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "expiry",
          displayName: "Expiry",
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
      const server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const host = yield* Deferred.await(ready);
      const projectId = ProjectId.make("expiry-project");
      const projects = Context.get(server.context, Projects.ProjectService);
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Expiry",
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
      const input = {
        environmentId: host.environmentId,
        projectId,
        commandId: CommandId.make("launch"),
        title: "Pinned",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required" as const,
        workspace: { type: "exact-ref" as const, ref: pinned, branch: "expiry-owned" },
      };
      expect((yield* host.launch(input).pipe(Effect.result))._tag).toBe("Failure");
      const state = (yield* host.reconcile({ environmentId: host.environmentId, projectId }))
        .threads[0]!;
      yield* fs.writeFileString(state.workspacePath + "/retained-user-file", "keep");
      const before = yield* git("reflog", "show", "--format=%gs", "refs/heads/expiry-owned");
      expect(before).toContain("refs/t3/worktree-owners/");
      if (expire) yield* git("reflog", "expire", "--expire=now", "--all");
      const after = yield* git("reflog", "show", "--format=%gs", "refs/heads/expiry-owned");
      expect(after).toBe(expire ? "" : before);
      yield* projects.update({ commandId: CommandId.make("repair"), projectId, scripts: [] });
      const result = yield* host.launch(input).pipe(Effect.result);
      expect(yield* fs.readFileString(state.workspacePath + "/retained-user-file")).toBe("keep");
      yield* Fiber.interrupt(server.fiber);
      expect(result._tag).toBe("Success");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

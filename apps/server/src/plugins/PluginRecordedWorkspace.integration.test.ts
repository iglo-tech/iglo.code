import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live.each([
  "unchanged",
  "tracked edits",
  "new commit",
  "other branch",
  "other repository",
  "foreign repository at same HEAD",
] as const)("recorded checkout recovery with %s", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("gilfoyle-recorded-ref")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/review-provider-disabled"}}}',
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: string[]) =>
        spawn.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((s) => s.trim()));
      yield* git(config.baseDir, "init", "-b", "main");
      yield* fs.writeFileString(config.baseDir + "/tracked.txt", "base\n");
      yield* git(config.baseDir, "add", "tracked.txt");
      yield* git(
        config.baseDir,
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "-m",
        "base",
      );
      const pinned = yield* git(config.baseDir, "rev-parse", "HEAD");
      let acquired = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "review_ref",
          displayName: "Review ref",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "persistence"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(acquired, { host: yield* Host, storage: yield* Storage });
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const first = yield* startEnvironment(config, [plugin]);
      yield* Context.get(first.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const bound = yield* Deferred.await(acquired);
      const projectId = ProjectId.make("review-ref-project");
      const projects = Context.get(first.context, Projects.ProjectService);
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
        title: "Ref test",
        workspaceRoot: config.baseDir,
        scripts: script("exit 23"),
      });
      const input = {
        environmentId: bound.host.environmentId,
        projectId,
        commandId: CommandId.make("launch"),
        title: "Pinned",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required" as const,
        workspace: { type: "exact-ref" as const, ref: pinned, branch: "review/pinned" },
      };
      const failed = yield* bound.host.launch(input).pipe(Effect.result);
      expect(failed._tag).toBe("Failure");
      const snapshot = yield* bound.host.reconcile({
        environmentId: bound.host.environmentId,
        projectId,
      });
      const thread = snapshot.threads[0]!;
      const checkout = thread.workspacePath;
      expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
      yield* projects.update({
        projectId,
        commandId: CommandId.make("repair-script"),
        scripts: script("git rev-parse HEAD > executed-ref"),
      });
      yield* Fiber.interrupt(first.fiber);
      if (scenario === "foreign repository at same HEAD") {
        yield* fs.remove(checkout, { recursive: true });
        yield* git(config.baseDir, "clone", "--no-local", config.baseDir, checkout);
        yield* git(checkout, "switch", "review/pinned");
      }
      if (scenario === "other repository") {
        yield* git(config.baseDir, "worktree", "remove", "--force", checkout);
        yield* fs.makeDirectory(checkout, { recursive: true });
        yield* git(checkout, "init", "-b", "foreign");
      }
      if (scenario === "other branch") yield* git(checkout, "switch", "-c", "review/unrelated");
      if (scenario !== "unchanged" && scenario !== "foreign repository at same HEAD")
        yield* fs.writeFileString(checkout + "/tracked.txt", "offline work\n");
      if (
        scenario === "new commit" ||
        scenario === "other branch" ||
        scenario === "other repository"
      ) {
        yield* git(checkout, "add", "tracked.txt");
        yield* git(
          checkout,
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "-m",
          "offline",
        );
      }
      const actualRef = yield* git(checkout, "rev-parse", "HEAD");
      acquired = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const second = yield* startEnvironment(config, [plugin]);
      yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const recovered = yield* Deferred.await(acquired);
      const result = yield* recovered.host.launch(input).pipe(Effect.result);
      const marker = yield* fs.exists(checkout + "/executed-ref");
      const executed = marker
        ? (yield* fs.readFileString(checkout + "/executed-ref")).trim()
        : null;
      if (scenario === "unchanged" || scenario === "tracked edits") {
        expect(result._tag).toBe("Success");
        expect(executed).toBe(pinned);
        if (scenario === "tracked edits")
          expect(yield* fs.readFileString(checkout + "/tracked.txt")).toBe("offline work\n");
      } else {
        if (scenario === "foreign repository at same HEAD") expect(actualRef).toBe(pinned);
        else expect(actualRef).not.toBe(pinned);
        // Expected contract: an unfinished exact-ref preparation cannot acknowledge a different revision.
        expect(result._tag).toBe("Failure");
        expect(marker).toBe(false);
      }
      yield* Fiber.interrupt(second.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

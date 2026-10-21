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
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live.each(["cancel", "shutdown"] as const)(
  "a gated setup script leaves no descendants after %s",
  (stop) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("setup-process-cleanup")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"binaryPath":"/nonexistent/setup-cleanup-provider"}}}',
        );
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawn.string(ChildProcess.make("git", args, { cwd: config.baseDir }));
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
        const pinned = (yield* git("rev-parse", "HEAD")).trim();
        const gate = config.baseDir + "/setup-gate";
        const held = config.baseDir + "/setup-held";
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [gate, held]));
        const ready = yield* Deferred.make<Host["Service"]>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "cleanup_probe",
            displayName: "Cleanup probe",
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
        const projectId = ProjectId.make("cleanup-project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Cleanup",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
              // The script and its blocked reader both hold `held` open.
              command: `exec 3>'${held}'; printf '%s%s\\n' 'SETUP_' 'GATE_REACHED'; cat '${gate}' >/dev/null`,
            },
          ],
        });
        // `cat` reaches EOF once every process holding `held` open for writing
        // has exited. A child process, unlike a blocking read, dies with the scope.
        const writersGone = yield* spawn
          .exitCode(ChildProcess.make("cat", [held]))
          .pipe(Effect.forkScoped);
        const launching = yield* host
          .launch({
            environmentId: host.environmentId,
            projectId,
            commandId: CommandId.make("launch"),
            title: "Gated setup",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
            runtimeMode: "approval-required",
            workspace: { type: "exact-ref", ref: pinned, branch: "t3/cleanup1" },
          })
          .pipe(Effect.result, Effect.forkScoped);
        const created = yield* host
          .lifecycle({ environmentId: host.environmentId, projectId, afterCursor: 0 })
          .pipe(
            Stream.filter((x) => x.kind === "event"),
            Stream.runHead,
          );
        if (created._tag !== "Some" || created.value.kind !== "event")
          return yield* Effect.die("missing created event");
        const threadId = created.value.threadId;
        yield* Context.get(server.context, Tracker.WorktreeSetupTracker)
          .stream(threadId)
          .pipe(
            Stream.filter(
              (s) => s?.stages.some((stage) => stage.tail.includes("SETUP_GATE_REACHED")) === true,
            ),
            Stream.runHead,
          );

        if (stop === "cancel") {
          expect(
            yield* host.interrupt({
              environmentId: host.environmentId,
              projectId,
              threadId,
              commandId: CommandId.make("cancel"),
            }),
          ).toMatchObject({ status: "accepted" });
          expect((yield* Fiber.join(launching))._tag).toBe("Failure");
        } else yield* Fiber.interrupt(server.fiber);

        // The gate is never released: only killing the script's descendants ends this.
        yield* Fiber.join(writersGone);
        yield* Fiber.interrupt(server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

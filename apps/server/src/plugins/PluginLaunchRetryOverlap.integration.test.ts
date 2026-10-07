import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";

it.live.each(
  [false, true].flatMap((lost) =>
    ["public retry", "intent recovery"].flatMap((replayPath) =>
      ["current", "exact-ref"].map((workspaceMode) => ({ lost, replayPath, workspaceMode })),
    ),
  ),
)("lost original acknowledgement plus newer retry: %o", ({ lost, replayPath, workspaceMode }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("pr4-fresh-review-retry-overlap")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providers: Object.fromEntries(
            ["codex", "claudeAgent", "opencode", "cursor", "grok", "antigravity", "pi"].map(
              (id) => [
                id,
                { enabled: id === "codex", binaryPath: "/nonexistent/pr4-external-provider" },
              ],
            ),
          ),
        }),
      );
      const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "probe",
          displayName: "Probe",
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
      const server = yield* startEnvironment(config, [plugin]);
      const bound = yield* Deferred.await(ready);
      const projects = Context.get(server.context, Projects.ProjectService);
      const threads = Context.get(server.context, Threads.ThreadManagementService);
      const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
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
      const ref = yield* git("rev-parse", "HEAD");
      const projectId = ProjectId.make("probe");
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Probe",
        workspaceRoot: config.baseDir,
      });
      const configure = (command: string, id: string, scriptId = "setup") =>
        projects.update({
          commandId: CommandId.make(id),
          projectId,
          scripts: [
            {
              id: scriptId,
              name: "Setup",
              icon: "configure",
              command,
              async: false,
              runOnWorktreeCreate: true,
            },
          ],
        });
      yield* configure("exit 23", "fail");
      if (lost)
        yield* bound.storage
          .sql`CREATE TRIGGER lose_launch_ack BEFORE UPDATE OF result ON host_commands WHEN old.id = 'launch' BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
      const input = {
        environmentId: bound.host.environmentId,
        projectId,
        commandId: CommandId.make("launch"),
        title: "Work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "approval-required" as const,
        workspace:
          workspaceMode === "current"
            ? { type: "current" as const }
            : { type: "exact-ref" as const, ref, branch: "probe" },
        instruction: "Initial work",
      };
      const launchResult = yield* bound.host.launch(input).pipe(Effect.result);
      expect(launchResult._tag).toBe(lost ? "Failure" : "Success");
      const receipt = (yield* bound.host.receipt(input.commandId))!;
      yield* threads
        .streamStoredEventsFrom({
          threadId: receipt.threadId,
          afterSequence: 0,
          eventType: "run.updated",
        })
        .pipe(
          Stream.filter(
            (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
          ),
          Stream.runHead,
        );
      if (lost) yield* bound.storage.sql`DROP TRIGGER lose_launch_ack`;
      const runId = (yield* threads.getThreadRecords(receipt.threadId, ["runs"])).runs[0]!.id;
      const gate = config.baseDir + "/gate";
      const marker = config.baseDir + "/setup-count";
      yield* spawn.exitCode(ChildProcess.make("mkfifo", [gate]));
      yield* configure(
        `printf 'attempt\\n' >> '${marker}'; printf 'PROBE_READY\\n'; read gate < '${gate}'; :`,
        "repair",
      );
      yield* bound.host.retryPreparation({
        environmentId: input.environmentId,
        projectId,
        threadId: receipt.threadId,
        commandId: CommandId.make("retry"),
        runId,
      });
      const entered = () =>
        tracker.stream(receipt.threadId).pipe(
          Stream.filter((s) => s?.stages.some((x) => x.tail.includes("PROBE_READY")) === true),
          Stream.runHead,
        );
      const first = (yield* entered())!;
      // Updating the script identity gives each accidentally started preparation its own real terminal.
      // It changes no launch or retry input, and both differential cases make this same edit.
      yield* configure(
        `printf 'attempt\\n' >> '${marker}'; printf 'PROBE_READY\\n'; read gate < '${gate}'; :`,
        "new-script-identity",
        "setup-replay",
      );
      if (replayPath === "public retry") yield* bound.host.launch(input);
      else {
        const replay = yield* Bound.make("probe").pipe(
          Effect.provideService(Host, Context.get(server.context, Host)),
          Effect.provideService(Storage, bound.storage),
        );
        yield* replay.recover;
      }
      const second = yield* tracker.get(receipt.threadId);
      if (
        second?.preparationId !== (first._tag === "Some" ? first.value?.preparationId : undefined)
      )
        yield* entered();
      const count = (yield* fs.readFileString(marker)).trim().split("\n").length;
      expect(second?.preparationId).toBe(
        first._tag === "Some" ? first.value?.preparationId : undefined,
      );
      expect(count).toBe(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as CP from "effect/process/ChildProcess";
import * as Spawner from "effect/process/ChildProcessSpawner";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";

const fixture = Effect.gen(function* () {
  const config = {
    ...(yield* makeReplayServerConfig("pr4-new-independent")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const fs = yield* FileSystem.FileSystem;
  const spawn = yield* Spawner.ChildProcessSpawner;
  const git = (...args: string[]) =>
    spawn.string(CP.make("git", args, { cwd: config.baseDir })).pipe(Effect.map((x) => x.trim()));
  yield* fs.writeFileString(
    config.settingsPath,
    '{"providers":{"codex":{"binaryPath":"/nonexistent/pr4-external-provider"},"claudeAgent":{"binaryPath":"/nonexistent/pr4-external-provider"}}}',
  );
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
  yield* commit("root-advanced");
  const rootHead = yield* git("rev-parse", "HEAD");
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
  yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
  const bound = yield* Deferred.await(ready);
  const projectId = ProjectId.make("probe-project");
  const projects = Context.get(server.context, Projects.ProjectService);
  yield* projects.create({
    commandId: CommandId.make("project"),
    projectId,
    title: "Probe",
    workspaceRoot: config.baseDir,
  });
  const threads = Context.get(server.context, Threads.ThreadManagementService);
  const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
  const events = Context.get(server.context, Events.OrchestrationEventStore);
  const input = {
    environmentId: bound.host.environmentId,
    projectId,
    commandId: CommandId.make("launch"),
    title: "Pinned work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "approval-required" as const,
    workspace: { type: "exact-ref" as const, ref: pinned, branch: "probe-work" },
    instruction: "Initial instruction",
  };
  return {
    config,
    fs,
    spawn,
    git,
    pinned,
    rootHead,
    server,
    bound,
    projectId,
    projects,
    threads,
    tracker,
    events,
    input,
  };
});

it.live.each([true, false])(
  "old retry recovery respects newer preparation, lost acknowledgement=%s",
  (lostAck) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const configure = (command: string, id: string) =>
          s.projects.update({
            projectId: s.projectId,
            commandId: CommandId.make(id),
            scripts: [
              {
                id: "setup",
                name: "Setup",
                icon: "configure",
                command,
                runOnWorktreeCreate: true,
                async: false,
              },
            ],
          });
        yield* configure("exit 23", "fail-setup");
        const launched = yield* s.bound.host.launch(s.input);
        const target = {
          environmentId: s.input.environmentId,
          projectId: s.projectId,
          threadId: launched.threadId,
        };
        yield* s.threads
          .streamStoredEventsFrom({
            threadId: target.threadId,
            afterSequence: 0,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
            ),
            Stream.runHead,
          );
        const runId = (yield* s.threads.getThreadRecords(target.threadId, ["runs"])).runs[0]!.id;
        if (lostAck)
          yield* s.bound.storage
            .sql`CREATE TRIGGER lose_old_ack BEFORE UPDATE OF result ON host_commands WHEN old.id = 'retry-A' BEGIN SELECT RAISE(ABORT, 'lost old retry acknowledgement'); END`;
        const cursor = yield* s.events.latestAgentSequence(target.threadId);
        expect(
          (yield* s.bound.host
            .retryPreparation({ ...target, commandId: CommandId.make("retry-A"), runId })
            .pipe(Effect.result))._tag,
        ).toBe(lostAck ? "Failure" : "Success");
        yield* s.threads
          .streamStoredEventsFrom({
            threadId: target.threadId,
            afterSequence: cursor,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
            ),
            Stream.runHead,
          );
        if (lostAck) yield* s.bound.storage.sql`DROP TRIGGER lose_old_ack`;
        const marker = s.config.baseDir + "/setup-count";
        const gate = s.config.baseDir + "/setup-gate";
        yield* s.spawn.exitCode(CP.make("mkfifo", [gate]));
        yield* configure(
          `printf 'run\\n' >> '${marker}'; printf '%s%s\\n' 'RETRY_SETUP_' 'ENTERED'; read gate < '${gate}'; :`,
          "gated-setup",
        );
        yield* s.bound.host.retryPreparation({
          ...target,
          commandId: CommandId.make("retry-B"),
          runId,
        });
        yield* s.tracker.stream(target.threadId).pipe(
          Stream.filter(
            (x) => x?.stages.some((stage) => stage.tail.includes("RETRY_SETUP_ENTERED")) === true,
          ),
          Stream.runHead,
        );
        const first = (yield* s.tracker.get(target.threadId))!.preparationId;
        const recovery = yield* Bound.make("probe").pipe(
          Effect.provideService(Host, Context.get(s.server.context, Host)),
          Effect.provideService(Storage, s.bound.storage),
        );
        yield* recovery.recover;
        expect((yield* s.tracker.get(target.threadId))!.preparationId).toBe(first);
        yield* s.spawn.exitCode(CP.make("/bin/sh", ["-c", `printf continue > '${gate}'`]));
        yield* s.threads
          .streamStoredEventsFrom({
            threadId: target.threadId,
            afterSequence: cursor,
            eventType: "checkpoint-scope.created",
          })
          .pipe(Stream.runHead);
        const count = (yield* s.fs.readFileString(marker)).trim().split("\n").length;
        yield* Fiber.interrupt(s.server.fiber);
        expect(count).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

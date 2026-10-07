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
  "queued plugin send waits for checkout release, hook failure=%s",
  (failed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const hooks = s.config.baseDir + "/hooks";
        yield* s.fs.makeDirectory(hooks);
        const entered = s.config.baseDir + "/entered";
        const release = s.config.baseDir + "/release";
        yield* s.spawn.exitCode(CP.make("mkfifo", [entered, release]));
        yield* s.fs.writeFileString(
          hooks + "/post-checkout",
          `#!/bin/sh\nprintf entered > '${entered}'\nread gate < '${release}'\nexit ${failed ? 23 : 0}\n`,
        );
        yield* s.fs.chmod(hooks + "/post-checkout", 0o755);
        yield* s.git("config", "core.hooksPath", hooks);
        const entering = yield* s.spawn
          .string(CP.make("/bin/sh", ["-c", `cat '${entered}'`]))
          .pipe(Effect.forkScoped);
        const launched = yield* s.bound.host.launch(s.input);
        yield* Fiber.join(entering);
        const target = { ...s.input, threadId: launched.threadId };
        const sendInput = {
          ...target,
          commandId: CommandId.make("queued-send"),
          instruction: "Must run at pinned ref",
          mode: "queue" as const,
        };
        const send = yield* s.bound.host.send(sendInput).pipe(Effect.result);
        expect(send._tag).toBe("Failure");
        if (send._tag === "Failure")
          expect(send.failure).toMatchObject({ code: "unavailable", operation: "send" });
        const before = yield* s.threads.getThreadRecords(target.threadId, ["runs"]);
        expect(before.runs.map((r) => r.status)).toEqual(["preparing"]);
        const cursor = yield* s.events.latestAgentSequence(target.threadId);
        yield* s.spawn.exitCode(CP.make("/bin/sh", ["-c", `printf continue > '${release}'`]));
        if (failed) {
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
          const stopped = yield* s.threads.getThreadRecords(target.threadId, ["runs", "messages"]);
          expect(stopped.runs).toHaveLength(1);
          expect(stopped.messages.map((message) => message.text)).not.toContain(
            sendInput.instruction,
          );
          yield* s.fs.writeFileString(hooks + "/post-checkout", "#!/bin/sh\nexit 0\n");
          yield* s.bound.host.retryPreparation({
            ...target,
            commandId: CommandId.make("repair-preparation"),
            runId: stopped.runs[0]!.id,
          });
        }
        const scope = yield* s.threads
          .streamStoredEventsFrom({
            threadId: target.threadId,
            afterSequence: cursor,
            eventType: "checkpoint-scope.created",
          })
          .pipe(
            Stream.filter(
              (e) =>
                e.event.type === "checkpoint-scope.created" && e.event.payload.kind === "root_run",
            ),
            Stream.runHead,
          );
        const state = yield* s.threads.getThreadRecords(target.threadId, ["runs"]);
        if (scope._tag !== "Some" || scope.value.event.type !== "checkpoint-scope.created")
          return yield* Effect.die("Missing released workspace");
        expect(scope.value.event.payload.cwd).toBe(state.thread.worktreePath);
        expect(state.thread.worktreePath).not.toBe(s.config.baseDir);
        expect(
          yield* s.spawn
            .string(CP.make("git", ["rev-parse", "HEAD"], { cwd: state.thread.worktreePath! }))
            .pipe(Effect.map((x) => x.trim())),
        ).toBe(s.pinned);
        const receipt = yield* s.bound.host.send(sendInput);
        expect(receipt.status).toBe("accepted");
        expect(yield* s.bound.host.send(sendInput)).toEqual(receipt);
        expect(
          (yield* s.threads.getThreadRecords(target.threadId, ["messages"])).messages.filter(
            (message) => message.text === sendInput.instruction,
          ),
        ).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

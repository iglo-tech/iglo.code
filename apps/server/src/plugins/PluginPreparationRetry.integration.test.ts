import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const fixture = Effect.gen(function* () {
  const config = {
    ...(yield* makeReplayServerConfig("clean-independent-pr4")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const fs = yield* FileSystem.FileSystem;
  // Block native execution; only external provider process I/O is replaced.
  const binary = config.baseDir + "/codex-fixture";
  yield* fs.writeFileString(
    binary,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
  );
  yield* fs.chmod(binary, 0o755);
  yield* fs.writeFileString(
    config.settingsPath,
    yield* encodeJson({
      providers: { codex: { binaryPath: binary } },
    }),
  );
  let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
  const plugin: ServerPlugin = {
    manifest: {
      id: "clean",
      displayName: "Clean",
      version: "1",
      hostVersion: 1,
      requiredCapabilities: ["execution", "lifecycle", "persistence"],
      server: { tools: [], api: [], scheduleTargets: [] },
      web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
    },
    migrations: [],
    acquire: Effect.gen(function* () {
      yield* Deferred.succeed(ready, { host: yield* Host, storage: yield* Storage });
      return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
    }),
  };
  let server = yield* startEnvironment(config, [plugin]);
  yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
  const bound = yield* Deferred.await(ready);
  const projectId = ProjectId.make("clean-project");
  const projects = Context.get(server.context, Projects.ProjectService);
  const threads = Context.get(server.context, Threads.ThreadManagementService);
  yield* projects.create({
    projectId,
    commandId: CommandId.make("project"),
    title: "Clean",
    workspaceRoot: config.baseDir,
  });
  return {
    config,
    server,
    bound,
    projects,
    threads,
    projectId,
    plugin,
    replaceReady: (value: typeof ready) => {
      ready = value;
    },
  };
});

it.live.each([
  { instructed: false, restart: false },
  { instructed: true, restart: false },
  { instructed: true, restart: true },
])("public preparation recovery: %o", ({ instructed, restart }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawner
          .string(ChildProcess.make("git", args, { cwd: s.config.baseDir }))
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
      const ref = yield* git("rev-parse", "HEAD");
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
      const input = {
        environmentId: s.bound.host.environmentId,
        projectId: s.projectId,
        commandId: CommandId.make("launch"),
        title: "Recovery",
        modelSelection: selection,
        runtimeMode: "approval-required" as const,
        workspace: { type: "exact-ref" as const, ref, branch: "recovery" },
        ...(instructed ? { instruction: "Initial work" } : {}),
      };
      yield* s.bound.host.launch(input).pipe(Effect.result);
      const snapshot = yield* s.bound.host.reconcile({
        environmentId: input.environmentId,
        projectId: s.projectId,
      });
      const target = snapshot.threads[0]!;
      let tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
      yield* tracker.stream(target.threadId).pipe(
        Stream.filter((x) => x?.phase === "failed"),
        Stream.runHead,
      );
      if (instructed)
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
      const marker = s.config.baseDir + "/recovery-did-run";
      yield* configure(`printf recovered > '${marker}'`, "repair-setup");
      const run = (yield* s.threads.getThreadRecords(target.threadId, ["runs"])).runs[0];
      if (restart) {
        yield* Fiber.interrupt(s.server.fiber);
        const ready = yield* Deferred.make<{
          host: Host["Service"];
          storage: Storage["Service"];
        }>();
        s.replaceReady(ready);
        s.server = yield* startEnvironment(s.config, [s.plugin]);
        yield* Context.get(s.server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        s.bound = yield* Deferred.await(ready);
        s.threads = Context.get(s.server.context, Threads.ThreadManagementService);
        tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
      }
      const retry = instructed
        ? yield* s.bound.host
            .retryPreparation({
              environmentId: input.environmentId,
              projectId: s.projectId,
              threadId: target.threadId,
              runId: run!.id,
              commandId: CommandId.make("public-retry"),
            })
            .pipe(Effect.result)
        : yield* s.bound.host.launch(input).pipe(Effect.result);
      if (instructed)
        yield* tracker.stream(target.threadId).pipe(
          Stream.filter(
            (x) =>
              x?.stages.some((stage) => stage.id === "agent" && stage.status === "done") === true,
          ),
          Stream.runHead,
        );
      const fs = yield* FileSystem.FileSystem;
      const didRun = yield* fs.exists(marker);
      const sent = yield* s.bound.host
        .send({
          environmentId: input.environmentId,
          projectId: s.projectId,
          threadId: target.threadId,
          commandId: CommandId.make("after-repair"),
          instruction: "Continue",
          mode: "queue",
        })
        .pipe(Effect.result);
      expect(retry._tag).toBe("Success");
      expect(didRun).toBe(true);
      expect(sent._tag).toBe("Success");
      if (instructed) {
        const repeated = yield* s.bound.host.retryPreparation({
          environmentId: input.environmentId,
          projectId: s.projectId,
          threadId: target.threadId,
          runId: run!.id,
          commandId: CommandId.make("public-retry"),
        });
        if (retry._tag === "Success") expect(repeated).toEqual(retry.success);
        const records = yield* s.threads.getThreadRecords(target.threadId, [
          "messages",
          "checkpointScopes",
        ]);
        expect(records.messages.filter((m) => m.text === "Initial work")).toHaveLength(1);
        const released = yield* s.threads
          .streamStoredEventsFrom({
            threadId: target.threadId,
            afterSequence: 0,
            eventType: "checkpoint-scope.created",
          })
          .pipe(
            Stream.filter(
              (e) =>
                e.event.type === "checkpoint-scope.created" && e.event.payload.runId === run!.id,
            ),
            Stream.runHead,
          );
        expect(released._tag).toBe("Some");
        expect(
          (yield* s.bound.host.send({
            environmentId: input.environmentId,
            projectId: s.projectId,
            threadId: target.threadId,
            commandId: CommandId.make("second-after-repair"),
            instruction: "Continue again",
            mode: "queue",
          })).status,
        ).toBe("accepted");
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

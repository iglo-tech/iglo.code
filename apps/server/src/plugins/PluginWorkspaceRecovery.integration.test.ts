import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  MessageId,
  type TerminalSummary,
} from "@t3tools/contracts";
import { PluginLaunchInput } from "@t3tools/plugin-host-contract/schema";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Spawner from "effect/unstable/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import { startEnvironment } from "../plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Terminals from "../terminal/Manager.ts";

const encodeIdentity = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, CommandId])),
);

const LaunchRequest = Schema.Struct({ kind: Schema.Literal("launch"), input: PluginLaunchInput });
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(LaunchRequest));
const encodeIntent = Schema.encodeEffect(
  Schema.fromJsonString(
    LaunchRequest.mapFields((fields) => ({ ...fields, coreCommandId: CommandId })),
  ),
);

const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const fixture = Effect.gen(function* () {
  let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
  let startupProbe: ((host: Host["Service"]) => Effect.Effect<void>) | undefined;
  const plugin: ServerPlugin = {
    manifest: {
      id: "isolated_probe",
      displayName: "Probe",
      version: "1",
      hostVersion: 1,
      requiredCapabilities: ["execution", "persistence"],
      server: { tools: [], api: [], scheduleTargets: [] },
      web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
    },
    migrations: [],
    acquire: Effect.gen(function* () {
      const host = yield* Host;
      if (startupProbe !== undefined) yield* startupProbe(host);
      yield* Deferred.succeed(ready, { host, storage: yield* Storage });
      return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
    }),
  };
  const config = {
    ...(yield* makeReplayServerConfig("clean-workspace-probe")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    config.settingsPath,
    '{"providers":{"codex":{"binaryPath":"/nonexistent/isolated-provider-disabled"}}}',
  );
  const spawner = yield* Spawner.ChildProcessSpawner;
  const git = (...args: string[]) =>
    spawner
      .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
      .pipe(Effect.map((x) => x.trim()));
  yield* git("init", "-b", "main");
  yield* fs.writeFileString(config.baseDir + "/tracked.txt", "original\n");
  yield* git("add", "tracked.txt");
  yield* git(
    "-c",
    "user.name=Review",
    "-c",
    "user.email=review@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const ref = yield* git("rev-parse", "HEAD");
  const server = yield* startEnvironment(config, [plugin]);
  yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
  const bound = yield* Deferred.await(ready);
  const projects = Context.get(server.context, Projects.ProjectService);
  const threads = Context.get(server.context, Threads.ThreadManagementService);
  const projectId = ProjectId.make("probe-project");
  yield* projects.create({
    commandId: CommandId.make("project"),
    projectId,
    title: "Probe",
    workspaceRoot: config.baseDir,
  });
  const input = {
    environmentId: bound.host.environmentId,
    projectId,
    commandId: CommandId.make("launch"),
    title: "Probe",
    modelSelection: selection,
    runtimeMode: "approval-required" as const,
    workspace: { type: "exact-ref" as const, ref, branch: "probe-branch" },
  };
  const restart = (probe?: (host: Host["Service"]) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      startupProbe = probe;
      yield* Fiber.interrupt(server.fiber);
      ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const restarted = yield* startEnvironment(config, [plugin]);
      yield* Context.get(restarted.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      return { server: restarted, bound: yield* Deferred.await(ready) };
    });
  return {
    config,
    fs,
    spawner,
    git,
    ref,
    server,
    bound,
    projects,
    threads,
    projectId,
    input,
    restart,
  };
});

it.live("resumes unfinished synchronous setup after recorded workspace metadata", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("setup-script"),
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            command: "printf completed > setup-completed.txt",
            runOnWorktreeCreate: true,
            async: false,
          },
        ],
      });
      const identity = yield* encodeIdentity(["isolated_probe", s.input.commandId]);
      const coreId = CommandId.make(`plugin:${identity}`);
      const request = yield* encodeRequest({ kind: "launch", input: s.input });
      const intent = yield* encodeIntent({ kind: "launch", input: s.input, coreCommandId: coreId });
      yield* s.bound.storage
        .sql`INSERT INTO host_commands(id,request,intent) VALUES (${s.input.commandId},${request},${intent})`;
      const threadId = ThreadId.make("crashed-thread");
      yield* s.threads.dispatch({
        type: "thread.create",
        commandId: coreId,
        threadId,
        projectId: s.projectId,
        title: s.input.title,
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: s.input.workspace.branch,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "mcp",
      });
      const checkout = yield* Context.get(s.server.context, Git.GitVcsDriver).createWorktree(
        { cwd: s.config.baseDir, refName: s.ref, newRefName: s.input.workspace.branch, path: null },
        { ownerId: `launch:${coreId}` },
      );
      yield* s.threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`${coreId}:workspace:crash-prefix`),
        threadId,
        branch: s.input.workspace.branch,
        worktreePath: checkout.worktree.path,
      });
      expect(yield* s.fs.exists(checkout.worktree.path + "/setup-completed.txt")).toBe(false);
      const restarted = yield* s.restart();
      const receipt = yield* restarted.bound.host.launch(s.input);
      const row = yield* restarted.bound.storage
        .sql`SELECT result FROM host_commands WHERE id=${s.input.commandId}`;
      expect(row[0]?.result).not.toBeNull();
      expect(receipt.threadId).toBe(threadId);
      const control = yield* restarted.bound.host.launch({
        ...s.input,
        commandId: CommandId.make("control"),
        workspace: { ...s.input.workspace, branch: "control-branch" },
      });
      const controlPath = (yield* restarted.bound.host.inspect({
        ...s.input,
        threadId: control.threadId,
      })).workspacePath;
      expect(yield* s.fs.exists(controlPath + "/setup-completed.txt")).toBe(true);
      expect(receipt.status).toBe("accepted");

      expect(yield* s.fs.exists(checkout.worktree.path + "/setup-completed.txt")).toBe(true);
      yield* Fiber.interrupt(restarted.server.fiber);
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => expect(exit._tag).toBe("Success")),
  ),
);

it.live("interrupts another thread while a plugin launch awaits synchronous setup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      const other = ThreadId.make("unrelated-thread");
      yield* s.threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("other"),
        threadId: other,
        projectId: s.projectId,
        title: "Other",
        modelSelection: selection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* s.threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("prepare-other"),
        threadId: other,
        messageId: MessageId.make("prepare-other-message"),
        text: "Held preparation",
        attachments: [],
        dispatchMode: { type: "defer_start", workspaceStrategy: { type: "root" } },
        createdBy: "user",
        creationSource: "web",
      });
      const fifo = s.config.baseDir + "/gate";
      yield* s.spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("gate-script"),
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            command: `printf 'GATE_ENTERED\n'; cat '${fifo}'`,
            runOnWorktreeCreate: true,
            async: false,
          },
        ],
      });
      const launching = yield* s.bound.host.launch(s.input).pipe(Effect.forkScoped);
      const core = Context.get(s.server.context, Host);
      const created = yield* core
        .lifecycle({ environmentId: core.environmentId, projectId: s.projectId, afterCursor: 0 })
        .pipe(
          Stream.filter((x) => x.kind === "event" && x.threadId !== other),
          Stream.runHead,
        );
      if (created._tag !== "Some" || created.value.kind !== "event")
        return yield* Effect.die("missing launch");
      const tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
      yield* tracker.stream(created.value.threadId).pipe(
        Stream.filter(
          (x) => x?.stages.some((stage) => stage.tail.includes("GATE_ENTERED")) === true,
        ),
        Stream.runHead,
      );
      const target = { environmentId: core.environmentId, projectId: s.projectId, threadId: other };
      const stopping = yield* s.bound.host
        .interrupt({ ...target, commandId: CommandId.make("stop-other") })
        .pipe(Effect.forkScoped);
      const stopped = yield* Fiber.join(stopping);
      expect(stopped?.status).toBe("accepted");
      expect(launching.pollUnsafe()).toBeUndefined();
      expect(
        (yield* s.bound.storage.sql`SELECT result FROM host_commands WHERE id='stop-other'`)[0]
          ?.result,
      ).not.toBeNull();
      yield* s.spawner.exitCode(ChildProcess.make("sh", ["-c", `echo release > '${fifo}'`]));
      yield* Fiber.join(launching);
      yield* Fiber.interrupt(s.server.fiber);
    }),
  ).pipe(
    Effect.provide(NodeServices.layer),
    Effect.exit,
    Effect.map((exit) => expect(exit._tag).toBe("Success")),
  ),
);

it.live.each(["untracked", "tracked", "clean"] as const)(
  "resumed checkout cancellation protects %s state",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const fifo = s.config.baseDir + "/resume-gate";
        yield* s.spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
        yield* s.projects.update({
          projectId: s.projectId,
          commandId: CommandId.make("gate-script"),
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf 'RESUME_ENTERED\\n'; cat '${fifo}'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        const identity = yield* encodeIdentity(["isolated_probe", s.input.commandId]);
        const coreId = CommandId.make(`plugin:${identity}`);
        const request = yield* encodeRequest({ kind: "launch", input: s.input });
        const intent = yield* encodeIntent({
          kind: "launch",
          input: s.input,
          coreCommandId: coreId,
        });
        yield* s.bound.storage
          .sql`INSERT INTO host_commands(id,request,intent) VALUES (${s.input.commandId},${request},${intent})`;
        const threadId = ThreadId.make("unrecorded-checkout");
        yield* s.threads.dispatch({
          type: "thread.create",
          commandId: coreId,
          threadId,
          projectId: s.projectId,
          title: s.input.title,
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: s.input.workspace.branch,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        const checkout = yield* Context.get(s.server.context, Git.GitVcsDriver).createWorktree(
          {
            cwd: s.config.baseDir,
            refName: s.ref,
            newRefName: s.input.workspace.branch,
            path: null,
          },
          { ownerId: `launch:${coreId}` },
        );
        const userFile =
          checkout.worktree.path + (state === "tracked" ? "/tracked.txt" : "/user-work.txt");
        if (state !== "clean") yield* s.fs.writeFileString(userFile, "valuable offline work\n");
        const restarted = yield* s.restart();
        const tracker = Context.get(restarted.server.context, Tracker.WorktreeSetupTracker);
        const outcome = yield* tracker.stream(threadId).pipe(
          Stream.filter(
            (x) =>
              x?.phase === "failed" ||
              x?.stages.some((stage) => stage.tail.includes("RESUME_ENTERED")) === true,
          ),
          Stream.runHead,
        );
        if (outcome._tag !== "Some") return yield* Effect.die("missing preparation state");
        if (state === "tracked") {
          expect(outcome.value?.phase).toBe("failed");
          expect(yield* s.fs.exists(userFile)).toBe(true);
          expect(yield* s.fs.readFileString(userFile)).toBe("valuable offline work\n");
        } else {
          expect(outcome.value?.phase).toBe("running");
          expect(yield* tracker.cancel(threadId)).toBe(true);
          const metadata = yield* Deferred.make<ReadonlyArray<TerminalSummary>>();
          const unsubscribe = yield* Context.get(
            restarted.server.context,
            Terminals.TerminalManager,
          ).subscribeMetadata((event) =>
            event.type === "snapshot" ? Deferred.succeed(metadata, event.terminals) : Effect.void,
          );
          expect(
            (yield* Deferred.await(metadata)).some(
              (terminal) => terminal.threadId === threadId && terminal.status === "running",
            ),
          ).toBe(false);
          unsubscribe();
          expect(yield* s.fs.exists(checkout.worktree.path)).toBe(true);
          if (state !== "clean")
            expect(yield* s.fs.readFileString(userFile)).toBe("valuable offline work\n");
        }
        yield* Fiber.interrupt(restarted.server.fiber);
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.exit,
      Effect.map((exit) => expect(exit._tag).toBe("Success")),
    ),
);

it.live.each([false, true])(
  "keeps failed synchronous setup retryable with tracked edits=%s",
  (trackedEdits) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const marker = s.config.baseDir + "/setup-results";
        const configure = (fails: boolean) =>
          s.projects.update({
            projectId: s.projectId,
            commandId: CommandId.make(fails ? "bad-setup" : "good-setup"),
            scripts: [
              {
                id: "setup",
                name: "Setup",
                icon: "configure",
                command: `${fails && trackedEdits ? "printf setup-edited > tracked.txt; " : ""}printf '${fails ? "failed" : "good"}\\n' >> '${marker}'; exit ${fails ? 23 : 0}`,
                runOnWorktreeCreate: true,
                async: false,
              },
            ],
          });
        yield* configure(true);
        const failed = yield* s.bound.host.launch(s.input).pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        const shell = (yield* s.threads.getShellSnapshot()).threads[0]!;
        const tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
        expect((yield* tracker.get(shell.id))?.phase).toBe("failed");
        expect(
          (yield* s.bound.storage.sql<{
            result: string | null;
          }>`SELECT result FROM host_commands WHERE id=${s.input.commandId}`)[0]?.result,
        ).toBeNull();
        yield* configure(false);
        const recovered = yield* s.bound.host.launch(s.input);
        expect(recovered.status).toBe("accepted");
        expect(recovered.threadId).toBe(shell.id);
        const preserved = (yield* s.threads.getThreadShell(shell.id))!.worktreePath!;
        expect(preserved).toBe(shell.worktreePath);
        if (trackedEdits)
          expect(yield* s.fs.readFileString(preserved + "/tracked.txt")).toBe("setup-edited");
        expect(yield* s.fs.readFileString(marker)).toBe("failed\ngood\n");
        const repeat = yield* s.bound.host.launch(s.input);
        expect(repeat).toEqual(recovered);
        expect(yield* s.fs.readFileString(marker)).toBe("failed\ngood\n");
        expect((yield* s.threads.getShellSnapshot()).threads).toHaveLength(1);
        yield* Fiber.interrupt(s.server.fiber);
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.exit,
      Effect.map((exit) => expect(exit._tag).toBe("Success")),
    ),
);

it.live(
  "preparation interrupts keep their selected attempt after lost acknowledgement and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const fifo = s.config.baseDir + "/cancel-gate";
        yield* s.spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
        yield* s.projects.update({
          projectId: s.projectId,
          commandId: CommandId.make("gate-script"),
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf 'CANCEL_READY\\n'; cat '${fifo}'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        const launching = yield* s.bound.host
          .launch(s.input)
          .pipe(Effect.result, Effect.forkScoped);
        const created = yield* s.bound.host
          .lifecycle({
            environmentId: s.input.environmentId,
            projectId: s.projectId,
            afterCursor: 0,
          })
          .pipe(
            Stream.filter((x) => x.kind === "event"),
            Stream.runHead,
          );
        if (created._tag !== "Some" || created.value.kind !== "event")
          return yield* Effect.die("missing thread");
        const target = {
          environmentId: s.input.environmentId,
          projectId: s.projectId,
          threadId: created.value.threadId,
        };
        const tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
        const waitGate = (current: Tracker.WorktreeSetupTracker["Service"]) =>
          current.stream(target.threadId).pipe(
            Stream.filter(
              (x) => x?.stages.some((stage) => stage.tail.includes("CANCEL_READY")) === true,
            ),
            Stream.runHead,
          );
        yield* waitGate(tracker);
        const before = yield* s.bound.host.inspect(target);
        expect(before.runs).toEqual([]);
        expect(before.preparationId).toBeDefined();
        expect(before.outstandingWork).toContainEqual({
          id: before.preparationId,
          status: "running",
        });
        const stop = { ...target, commandId: CommandId.make("stop-preparation") };
        yield* s.bound.storage
          .sql`CREATE TRIGGER lose_stop_ack BEFORE UPDATE OF result ON host_commands WHEN OLD.id='stop-preparation' BEGIN SELECT RAISE(ABORT,'lost acknowledgement'); END`;
        expect((yield* s.bound.host.interrupt(stop).pipe(Effect.result))._tag).toBe("Failure");
        expect((yield* tracker.get(target.threadId))?.phase).toBe("cancelled");
        expect((yield* Fiber.join(launching))._tag).toBe("Failure");
        const committed = yield* s.bound.host.receipt(stop.commandId);
        expect(committed?.status).toBe("accepted");
        const restarted = yield* s.restart();
        const current = Context.get(restarted.server.context, Tracker.WorktreeSetupTracker);
        // Cancellation stays stopped; only this explicit request starts a new attempt.
        const retrying = yield* restarted.bound.host
          .launch(s.input)
          .pipe(Effect.result, Effect.forkScoped);
        yield* waitGate(current);
        const resumed = yield* restarted.bound.host.inspect(target);
        expect(resumed.preparationId).toBeDefined();
        expect(resumed.preparationId).not.toBe(before.preparationId);
        yield* restarted.bound.storage.sql`DROP TRIGGER lose_stop_ack`;
        expect(yield* restarted.bound.host.interrupt(stop)).toEqual(committed);
        expect((yield* current.get(target.threadId))?.phase).toBe("running");
        yield* restarted.bound.host.interrupt({
          ...stop,
          commandId: CommandId.make("stale-attempt"),
          preparationId: before.preparationId!,
        });
        expect((yield* current.get(target.threadId))?.phase).toBe("running");
        const cancelled = yield* restarted.bound.host.interrupt({
          ...stop,
          commandId: CommandId.make("stop-current"),
        });
        expect(cancelled?.status).toBe("accepted");
        expect((yield* current.get(target.threadId))?.phase).toBe("cancelled");
        expect((yield* Fiber.join(retrying))._tag).toBe("Failure");
        expect((yield* restarted.bound.host.inspect(target)).preparationId).toBeUndefined();
        yield* Fiber.interrupt(restarted.server.fiber);
      }),
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.exit,
      Effect.map((exit) => expect(exit._tag).toBe("Success")),
    ),
);

it.live("pending setup-only launch blocks cold-restart sends before recovery begins", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const s = yield* fixture;
      const fifo = `${s.config.baseDir}/cold-send-gate`;
      yield* s.spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
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
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("failing-setup"),
        scripts: script("exit 23"),
      });
      expect((yield* s.bound.host.launch(s.input).pipe(Effect.result))._tag).toBe("Failure");
      const snapshot = yield* s.bound.host.reconcile({
        environmentId: s.bound.host.environmentId,
        projectId: s.projectId,
      });
      const target = snapshot.threads[0]!;
      const sendInput = {
        environmentId: target.environmentId,
        projectId: target.projectId,
        threadId: target.threadId,
        commandId: CommandId.make("cold-send"),
        instruction: "Wait for recovery",
        mode: "queue" as const,
      };
      yield* s.projects.update({
        projectId: s.projectId,
        commandId: CommandId.make("repair-setup"),
        scripts: script(`printf 'COLD_SETUP_WAITING\\n'; cat '${fifo}'`),
      });
      const restarted = yield* s.restart((host) =>
        Effect.gen(function* () {
          const cold = yield* host.inspect(target).pipe(Effect.orDie);
          expect(cold.preparationId).toBeUndefined();
          const denied = yield* host.send(sendInput).pipe(Effect.result);
          expect(denied._tag).toBe("Failure");
          if (denied._tag === "Failure")
            expect(denied.failure).toMatchObject({ code: "unavailable", operation: "send" });
        }),
      );
      const tracker = Context.get(restarted.server.context, Tracker.WorktreeSetupTracker);
      yield* tracker.stream(target.threadId).pipe(
        Stream.filter(
          (state) =>
            state?.stages.some((stage) => stage.tail.includes("COLD_SETUP_WAITING")) === true,
        ),
        Stream.runHead,
      );
      yield* s.spawner.exitCode(
        ChildProcess.make("/bin/sh", ["-c", `printf 'continue\n' > '${fifo}'`]),
      );
      expect((yield* restarted.bound.host.launch(s.input)).status).toBe("accepted");
      const sent = yield* restarted.bound.host.send(sendInput);
      expect(sent.status).toBe("accepted");
      expect(yield* restarted.bound.host.send(sendInput)).toEqual(sent);
      expect(
        (yield* Context.get(
          restarted.server.context,
          Threads.ThreadManagementService,
        ).getThreadRecords(target.threadId, ["runs"])).runs,
      ).toHaveLength(1);
      yield* Fiber.interrupt(restarted.server.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

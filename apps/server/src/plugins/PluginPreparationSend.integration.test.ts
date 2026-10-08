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
  const ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
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
  const server = yield* startEnvironment(config, [plugin]);
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
  return { config, server, bound, projects, threads, projectId };
});

it.live.each([false, true])(
  "queueing after a lost launch acknowledgement respects synchronous setup, initial instruction=%s",
  (instruction) =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* fixture;
        const host = s.bound.host;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawner
            .string(ChildProcess.make("git", args, { cwd: s.config.baseDir }))
            .pipe(Effect.map((x) => x.trim()));
        yield* git("init", "-b", "main");
        yield* git(
          "-c",
          "user.name=Clean",
          "-c",
          "user.email=clean@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "fixture",
        );
        const ref = yield* git("rev-parse", "HEAD");
        const gate = s.config.baseDir + "/setup-gate";
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [gate]));
        yield* s.projects.update({
          projectId: s.projectId,
          commandId: CommandId.make("setup"),
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf 'INDEPENDENT_GATE_READY\n'; cat '${gate}'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        const commandId = CommandId.make("gated-launch");
        const launching = yield* host
          .launch({
            environmentId: host.environmentId,
            projectId: s.projectId,
            commandId,
            title: "Gated",
            modelSelection: selection,
            runtimeMode: "approval-required",
            workspace: { type: "exact-ref", ref, branch: "gated" },
            ...(instruction ? { instruction: "Initial work" } : {}),
          })
          .pipe(Effect.result, Effect.forkScoped);
        const created = yield* host
          .lifecycle({ environmentId: host.environmentId, projectId: s.projectId, afterCursor: 0 })
          .pipe(
            Stream.filter((x) => x.kind === "event" && x.event === "thread-changed"),
            Stream.runHead,
          );
        if (created._tag !== "Some" || created.value.kind !== "event")
          return yield* Effect.die("Missing thread");
        const threadId = created.value.threadId;
        const tracker = Context.get(s.server.context, Tracker.WorktreeSetupTracker);
        yield* tracker.stream(threadId).pipe(
          Stream.filter(
            (x) =>
              x?.stages.some((y) => y.tail.some((z) => z.includes("INDEPENDENT_GATE_READY"))) ===
              true,
          ),
          Stream.runHead,
        );
        const receipt = yield* host.receipt(commandId);
        expect(receipt?.status).toBe("accepted");
        // Lose the caller's pending reply, not the server-owned preparation.
        yield* Fiber.interrupt(launching);
        const before = yield* tracker.get(threadId);
        expect(before?.phase).toBe("running");
        expect(before?.stages.find((x) => x.id === "agent")?.status).toBe("pending");
        const sendInput = {
          environmentId: host.environmentId,
          projectId: s.projectId,
          threadId,
          commandId: CommandId.make("post-receipt-queue"),
          instruction: "Must wait for setup",
          mode: "queue" as const,
        };
        const sent = yield* host.send(sendInput).pipe(Effect.result);
        const after = yield* s.threads.getThreadRecords(threadId, ["runs"]);
        expect(sent._tag).toBe("Failure");
        if (sent._tag === "Failure")
          expect(sent.failure).toMatchObject({ code: "unavailable", operation: "send" });
        expect(after.runs.map((run) => run.status)).toEqual(instruction ? ["preparing"] : []);
        yield* spawner.exitCode(
          ChildProcess.make("/bin/sh", ["-c", `printf 'continue\n' > '${gate}'`]),
        );
        yield* tracker.stream(threadId).pipe(
          Stream.filter(
            (snapshot) =>
              snapshot?.stages.some((stage) => stage.id === "agent" && stage.status === "done") ===
              true,
          ),
          Stream.runHead,
        );
        const accepted = yield* host.send(sendInput);
        expect(accepted.status).toBe("accepted");
        expect(yield* host.send(sendInput)).toEqual(accepted);
        expect((yield* s.threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(
          instruction ? 2 : 1,
        );
        yield* Fiber.interrupt(s.server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

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
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live.each([
  { instruction: false, guardBefore: false },
  { instruction: false, guardBefore: true },
  { instruction: true, guardBefore: false },
  { instruction: true, guardBefore: true },
])(
  "failed exact-ref launch must keep send barrier after restart, instruction=$instruction priorSend=$guardBefore",
  ({ instruction, guardBefore }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("independent-failed-launch")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
          "pinned",
        );
        const pinned = yield* git("rev-parse", "HEAD");
        yield* git(
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "advanced",
        );
        const rootHead = yield* git("rev-parse", "HEAD");
        expect(rootHead).not.toBe(pinned);
        yield* git("branch", "collision");
        const binary = config.baseDir + "/codex-fixture";
        yield* fs.writeFileString(
          binary,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.156.1\\n"; else exit 1; fi\n',
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ providers: { codex: { binaryPath: binary } } }),
        );
        let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "barrier",
            displayName: "Barrier",
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
        const first = yield* startEnvironment(config, [plugin]);
        yield* Context.get(first.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const bound = yield* Deferred.await(ready);
        const projectId = ProjectId.make("barrier-project");
        yield* Context.get(first.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Barrier",
          workspaceRoot: config.baseDir,
        });
        const input = {
          environmentId: bound.host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Pinned",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace: { type: "exact-ref" as const, ref: pinned, branch: "collision" },
          ...(instruction ? { instruction: "Initial work" } : {}),
        };
        const launched = yield* bound.host.launch(input).pipe(Effect.result);
        if (instruction) expect(launched._tag).toBe("Success");
        const snap = yield* bound.host.reconcile({ environmentId: input.environmentId, projectId });
        const threadId = snap.threads[0]!.threadId;
        const tracker = Context.get(first.context, Tracker.WorktreeSetupTracker);
        yield* tracker.stream(threadId).pipe(
          Stream.filter((s) => s?.phase === "failed"),
          Stream.runHead,
        );
        const threads = Context.get(first.context, Threads.ThreadManagementService);
        if (instruction)
          yield* threads
            .streamStoredEventsFrom({ threadId, afterSequence: 0, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
              ),
              Stream.runHead,
            );
        const before = guardBefore
          ? yield* bound.host
              .send({
                environmentId: input.environmentId,
                projectId,
                threadId,
                commandId: CommandId.make("before"),
                instruction: "Must not run",
                mode: "queue",
              })
              .pipe(Effect.result)
          : null;
        if (before !== null) expect(before._tag).toBe("Failure");
        const shell = yield* threads.getThreadShell(threadId);
        expect(shell!.worktreePath).toBeNull();
        yield* Fiber.interrupt(first.fiber);
        ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const second = yield* startEnvironment(config, [plugin]);
        yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const restored = yield* Deferred.await(ready);
        if (instruction)
          expect(
            yield* Context.get(second.context, Tracker.WorktreeSetupTracker).get(threadId),
          ).toBeNull();
        const sent = yield* restored.host
          .send({
            environmentId: input.environmentId,
            projectId,
            threadId,
            commandId: CommandId.make("after"),
            instruction: "Must not run",
            mode: "auto",
          })
          .pipe(Effect.result);
        const records = yield* Context.get(
          second.context,
          Threads.ThreadManagementService,
        ).getThreadRecords(threadId, ["runs", "messages", "checkpointScopes"]);
        expect(records.runs).toHaveLength(instruction ? 1 : 0);
        expect(records.messages).toHaveLength(instruction ? 1 : 0);
        expect(records.checkpointScopes).toEqual([]);
        yield* Fiber.interrupt(second.fiber);
        expect(sent._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

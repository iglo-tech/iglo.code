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
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Bound from "../../../../packages/plugin-host-adapter/src/BoundHost.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live.each([
  { workspaceType: "current", mode: "pending" },
  { workspaceType: "exact-ref", mode: "pending" },
  { workspaceType: "current", mode: "cancelled" },
  { workspaceType: "exact-ref", mode: "cancelled" },
  { workspaceType: "current", mode: "lost-ack" },
  { workspaceType: "exact-ref", mode: "lost-ack" },
] as const)(
  "automatic preparation recovery for $workspaceType after $mode",
  ({ workspaceType, mode }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cancelled = mode !== "pending";
        const config = {
          ...(yield* makeReplayServerConfig("independent-cancel-recovery")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        yield* fs.writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-review-provider"}}}',
        );
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawn
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
          "base",
        );
        const head = yield* git("rev-parse", "HEAD");
        const fifo = config.baseDir + "/setup-gate";
        const marker = config.baseDir + "/setup-attempts";
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [fifo]));
        let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "cancel_probe",
            displayName: "Cancel probe",
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
        const projectId = ProjectId.make("cancel-project");
        yield* Context.get(first.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Cancel",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
              command: `printf 'attempt\\n' >> '${marker}'; printf '%s%s\\n' 'SETUP_' 'GATE_REACHED'; cat '${fifo}' >/dev/null`,
            },
          ],
        });
        const input = {
          environmentId: bound.host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Gated setup",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
          runtimeMode: "approval-required" as const,
          workspace:
            workspaceType === "current"
              ? { type: "current" as const }
              : { type: "exact-ref" as const, ref: head, branch: "review/gated" },
        };
        const launching = yield* bound.host.launch(input).pipe(Effect.result, Effect.forkScoped);
        const created = yield* bound.host
          .lifecycle({ environmentId: input.environmentId, projectId, afterCursor: 0 })
          .pipe(
            Stream.filter((x) => x.kind === "event"),
            Stream.runHead,
          );
        if (created._tag !== "Some" || created.value.kind !== "event")
          return yield* Effect.die("missing created event");
        const target = {
          environmentId: input.environmentId,
          projectId,
          threadId: created.value.threadId,
        };
        const waitGate = (server: typeof first) =>
          Context.get(server.context, Tracker.WorktreeSetupTracker)
            .stream(target.threadId)
            .pipe(
              Stream.filter(
                (s) =>
                  s?.stages.some((stage) => stage.tail.includes("SETUP_GATE_REACHED")) === true,
              ),
              Stream.runHead,
            );
        yield* waitGate(first);
        expect(yield* fs.readFileString(marker)).toBe("attempt\n");
        let stop: unknown = null;
        if (cancelled) {
          if (mode === "lost-ack")
            yield* bound.storage
              .sql`CREATE TRIGGER fail_cancel_ack BEFORE UPDATE OF result ON host_commands WHEN OLD.id = 'cancel' BEGIN SELECT RAISE(ABORT, 'lost acknowledgement'); END`;
          const stopping = bound.host.interrupt({ ...target, commandId: CommandId.make("cancel") });
          if (mode === "lost-ack") {
            expect(yield* stopping.pipe(Effect.flip)).toMatchObject({ code: "storage" });
            yield* bound.storage.sql`DROP TRIGGER fail_cancel_ack`;
          } else {
            stop = yield* stopping;
            expect(stop).toMatchObject({ status: "accepted" });
          }

          expect((yield* Fiber.join(launching))._tag).toBe("Failure");
          expect(
            (yield* Context.get(first.context, Tracker.WorktreeSetupTracker).get(target.threadId))
              ?.phase,
          ).toBe("cancelled");
        } else yield* Fiber.interrupt(launching);
        const [pending] = yield* bound.storage.sql<{
          result: string | null;
        }>`SELECT result FROM host_commands WHERE id = 'launch'`;
        expect(pending?.result).toBeNull();
        yield* Fiber.interrupt(first.fiber);
        ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const second = yield* startEnvironment(config, [plugin]);
        yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const restored = yield* Deferred.await(ready);
        if (cancelled) {
          // Await the actual recovery implementation, so absence is checked after replay.
          const replay = yield* Bound.make("cancel_probe").pipe(
            Effect.provideService(Host, Context.get(second.context, Host)),
            Effect.provideService(Storage, restored.storage),
          );
          yield* replay.recover;
          expect(yield* fs.readFileString(marker)).toBe("attempt\n");
          expect((yield* restored.host.inspect(target)).outstandingWork).toEqual([]);
          const retry = yield* restored.host.launch(input).pipe(Effect.forkScoped);
          yield* waitGate(second);
          expect(yield* fs.readFileString(marker)).toBe("attempt\nattempt\n");
          yield* spawn.exitCode(
            ChildProcess.make("/bin/sh", ["-c", `printf 'release\n' > '${fifo}'`]),
          );
          expect((yield* Fiber.join(retry)).status).toBe("accepted");
          expect(yield* restored.storage.sql`SELECT * FROM host_cancelled_launches`).toEqual([]);
        } else {
          yield* waitGate(second);
          expect(yield* fs.readFileString(marker)).toBe("attempt\nattempt\n");
          expect((yield* restored.host.inspect(target)).outstandingWork).toHaveLength(1);
          yield* restored.host.interrupt({ ...target, commandId: CommandId.make("cleanup") });
        }
        yield* Fiber.interrupt(second.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["automatic", "preparation-id", "run-id"] as const)(
  "interrupting an instructed launch via %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = {
          ...(yield* makeReplayServerConfig("independent-instructed-stop")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        yield* fs.writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-review-provider"}}}',
        );
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawn
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
          "base",
        );
        const head = yield* git("rev-parse", "HEAD");
        const fifo = config.baseDir + "/setup-gate";
        const marker = config.baseDir + "/continued-after-stop";
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [fifo]));
        const ready = yield* Deferred.make<Host["Service"]>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "instructed_stop",
            displayName: "Stop probe",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution"],
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
        const projectId = ProjectId.make("instructed-stop-project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          projectId,
          commandId: CommandId.make("project"),
          title: "Stop",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              runOnWorktreeCreate: true,
              async: false,
              command: `printf '%s%s\\n' 'INSTRUCTED_' 'GATE_REACHED'; cat '${fifo}' >/dev/null; printf 'continued\\n' > '${marker}'`,
            },
          ],
        });
        const launched = yield* host.launch({
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Instructed setup",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
          runtimeMode: "approval-required",
          workspace: { type: "exact-ref", ref: head, branch: "review/instructed" },
          instruction: "Start only after setup",
        });
        const target = {
          environmentId: host.environmentId,
          projectId,
          threadId: launched.threadId,
        };
        const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        yield* tracker.stream(target.threadId).pipe(
          Stream.filter(
            (s) =>
              s?.stages.some((stage) => stage.tail.includes("INSTRUCTED_GATE_REACHED")) === true,
          ),
          Stream.runHead,
        );
        const before = yield* host.inspect(target);
        expect(before.runs[0]?.status).toBe("preparing");
        expect(before.preparationId).toBeDefined();
        const stopped = yield* host.interrupt({
          ...target,
          commandId: CommandId.make("stop"),
          ...(mode === "preparation-id"
            ? { preparationId: before.preparationId! }
            : mode === "run-id"
              ? { runId: before.runs[0]!.id }
              : {}),
        });
        expect(stopped?.status).toBe("accepted");
        const after = yield* host.inspect(target);
        const phaseAfterStop = (yield* tracker.get(target.threadId))?.phase;
        expect(after.runs[0]?.status).toBe("interrupted");
        expect(phaseAfterStop).toBe("cancelled");
        expect(yield* fs.exists(marker)).toBe(false);
        yield* Fiber.interrupt(server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

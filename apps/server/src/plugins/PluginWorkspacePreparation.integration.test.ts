import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Spawner from "effect/unstable/process/ChildProcessSpawner";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live.each([false, true])(
  "checkout survives restart when setup is asynchronous=%s",
  (asyncSetup) =>
    Effect.scoped(
      Effect.gen(function* () {
        let ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "ack_probe",
            displayName: "Ack probe",
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
        const config = {
          ...(yield* makeReplayServerConfig("gilfoyle-workspace-ack")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const spawner = yield* Spawner.ChildProcessSpawner;
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
          "original",
        );
        const head = yield* git("rev-parse", "HEAD");
        const fifo = config.baseDir + "/setup-gate";
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [fifo]));
        const first = yield* startEnvironment(config, [plugin]);
        const bound = yield* Deferred.await(ready);
        const core = Context.get(first.context, Host);
        const projectId = ProjectId.make("ack-project");
        const projects = Context.get(first.context, Projects.ProjectService);
        yield* projects.create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Ack project",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              command: `printf 'REVIEW_SETUP_READY\\n'; cat '${fifo}'`,
              icon: "configure",
              runOnWorktreeCreate: true,
              async: asyncSetup,
            },
          ],
        });
        const input = {
          environmentId: core.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Launch",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace: { type: "exact-ref" as const, ref: head },
        };
        const launching = yield* bound.host.launch(input).pipe(Effect.forkScoped);
        const created = yield* core
          .lifecycle({ environmentId: core.environmentId, projectId, afterCursor: 0 })
          .pipe(
            Stream.filter((x) => x.kind === "event"),
            Stream.take(1),
            Stream.runCollect,
          );
        const threadId =
          created[0]!.kind === "event" ? created[0]!.threadId : yield* Effect.die("missing event");
        const tracker = Context.get(first.context, Tracker.WorktreeSetupTracker);
        const running = yield* tracker.stream(threadId).pipe(
          Stream.filter(
            (x) =>
              x !== null &&
              x.stages.some(
                (s) => s.id === "setup-script" && s.tail.includes("REVIEW_SETUP_READY"),
              ),
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(running[0]?.phase).toBe("running");
        const preparedPath = (yield* Context.get(
          first.context,
          Threads.ThreadManagementService,
        ).getThreadShell(threadId))!.worktreePath;
        expect(preparedPath).not.toBeNull();
        if (!asyncSetup) {
          yield* Fiber.interrupt(launching);
          const retrying = yield* bound.host.launch(input).pipe(Effect.forkScoped);
          yield* bound.storage.sql`SELECT result FROM host_commands WHERE id=${input.commandId}`;
          expect(retrying.pollUnsafe()).toBeUndefined();
          yield* Fiber.interrupt(retrying);
          expect((yield* tracker.get(threadId))?.phase).toBe("running");
        } else {
          expect((yield* Fiber.join(launching)).status).toBe("accepted");
          expect((yield* tracker.get(threadId))?.phase).toBe("running");
        }
        yield* projects.update({
          commandId: CommandId.make("remove-script"),
          projectId,
          scripts: [],
        });
        yield* Fiber.interrupt(first.fiber);
        yield* git(
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "root-advanced",
        );
        const advanced = yield* git("rev-parse", "HEAD");
        expect(advanced).not.toBe(head);
        ready = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
        const second = yield* startEnvironment(config, [plugin]);
        const restored = yield* Deferred.await(ready);
        expect((yield* restored.host.launch(input)).status).toBe("accepted");
        const state = yield* restored.host.inspect({
          environmentId: core.environmentId,
          projectId,
          threadId,
        });
        const shell = yield* Context.get(
          second.context,
          Threads.ThreadManagementService,
        ).getThreadShell(threadId);
        const actualHead = yield* spawner.string(
          ChildProcess.make("git", ["rev-parse", "HEAD"], { cwd: state.workspacePath }),
        );
        expect(actualHead.trim()).toBe(head);
        expect(shell!.worktreePath).not.toBeNull();
        yield* Fiber.interrupt(second.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

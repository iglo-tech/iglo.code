import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";

it.live("emits a lifecycle change when no-instruction workspace preparation fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("independent-lifecycle-failure")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (...args: string[]) =>
        spawner
          .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
          .pipe(Effect.map((s) => s.trim()));
      yield* git("init");
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
      const gate = `${config.baseDir}/setup-gate`;
      yield* spawner.string(ChildProcess.make("mkfifo", [gate]));
      const acquired = yield* Deferred.make<Host["Service"]>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "lifecycle_probe",
          displayName: "Lifecycle probe",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "lifecycle"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(acquired, yield* Host);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const server = yield* startEnvironment(config, [plugin]);
      const host = yield* Deferred.await(acquired);
      const projects = Context.get(server.context, Projects.ProjectService);
      const projectId = ProjectId.make("lifecycle-project");
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Lifecycle",
        workspaceRoot: config.baseDir,
        scripts: [
          {
            id: "setup",
            name: "Setup",
            icon: "configure",
            command: `printf 'INDEPENDENT_SETUP_WAITING\\n'; read gate < '${gate}'; exit 23`,
            runOnWorktreeCreate: true,
            async: false,
          },
        ],
      });
      const baseline = yield* host.reconcile({ environmentId: host.environmentId, projectId });
      const launching = yield* host
        .launch({
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("prepare"),
          title: "Preparation",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required",
          workspace: { type: "exact-ref", ref: head, branch: "review/preparation" },
        })
        .pipe(Effect.forkScoped);
      const created = yield* host
        .lifecycle({ environmentId: host.environmentId, projectId, afterCursor: baseline.cursor })
        .pipe(
          Stream.filter((item) => item.kind === "event"),
          Stream.runHead,
        );
      if (created._tag !== "Some" || created.value.kind !== "event")
        return yield* Effect.die("Missing thread event");
      const threadId = created.value.threadId;
      const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
      yield* tracker.stream(threadId).pipe(
        Stream.filter(
          (s) =>
            s?.stages.some((stage) => stage.tail.includes("INDEPENDENT_SETUP_WAITING")) === true,
        ),
        Stream.runHead,
      );
      const before = yield* host.reconcile({ environmentId: host.environmentId, projectId });
      expect(before.threads[0]!.outstandingWork).toHaveLength(1);
      yield* spawner.string(
        ChildProcess.make("/bin/sh", ["-c", `printf 'continue\\n' > '${gate}'`]),
      );
      const launched = yield* Fiber.await(launching);
      expect(launched._tag).toBe("Failure");
      const finished = yield* tracker.get(threadId);
      expect(finished?.phase).toBe("failed");
      const settlement = yield* host
        .lifecycle({ environmentId: host.environmentId, projectId, afterCursor: before.cursor })
        .pipe(Stream.runHead);
      expect(settlement._tag).toBe("Some");
      if (settlement._tag !== "Some") return yield* Effect.die("Missing settlement");
      expect(settlement.value.cursor).toBeGreaterThan(before.cursor);
      const after = yield* host.reconcile({ environmentId: host.environmentId, projectId });
      expect(after.threads[0]!.outstandingWork).toHaveLength(0);
      const replay = yield* host
        .lifecycle({ environmentId: host.environmentId, projectId, afterCursor: before.cursor })
        .pipe(Stream.runHead);
      expect(replay).toEqual(settlement);
      yield* Fiber.interrupt(server.fiber);
      expect(after.cursor).toBeGreaterThan(before.cursor);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

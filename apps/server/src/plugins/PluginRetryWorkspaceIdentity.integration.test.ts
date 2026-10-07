import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
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

it.live.each(
  [false, true].flatMap((instructed) =>
    ["unchanged", "tracked edits", "new commit"].map((scenario) => ({ instructed, scenario })),
  ),
)("exact-ref public retry: %o", ({ instructed, scenario }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("gilfoyle-recorded-ref")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        '{"providers":{"codex":{"binaryPath":"/nonexistent/review-provider-disabled"}}}',
      );
      const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = (cwd: string, ...args: string[]) =>
        spawn.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((s) => s.trim()));
      yield* git(config.baseDir, "init", "-b", "main");
      yield* fs.writeFileString(config.baseDir + "/tracked.txt", "base\n");
      yield* git(config.baseDir, "add", "tracked.txt");
      yield* git(
        config.baseDir,
        "-c",
        "user.name=Review",
        "-c",
        "user.email=review@example.invalid",
        "commit",
        "-m",
        "base",
      );
      const pinned = yield* git(config.baseDir, "rev-parse", "HEAD");
      let acquired = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "review_ref",
          displayName: "Review ref",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["execution", "persistence"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          yield* Deferred.succeed(acquired, { host: yield* Host, storage: yield* Storage });
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }),
      };
      const first = yield* startEnvironment(config, [plugin]);
      yield* Context.get(first.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const bound = yield* Deferred.await(acquired);
      const projectId = ProjectId.make("review-ref-project");
      const projects = Context.get(first.context, Projects.ProjectService);
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
      yield* projects.create({
        commandId: CommandId.make("project"),
        projectId,
        title: "Ref test",
        workspaceRoot: config.baseDir,
        scripts: script("exit 23"),
      });
      const input = {
        environmentId: bound.host.environmentId,
        projectId,
        commandId: CommandId.make("launch"),
        title: "Pinned",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "approval-required" as const,
        workspace: { type: "exact-ref" as const, ref: pinned, branch: "review/pinned" },
        ...(instructed ? { instruction: "Review precisely the pinned code" } : {}),
      };
      const failed = yield* bound.host.launch(input).pipe(Effect.result);
      expect(failed._tag).toBe(instructed ? "Success" : "Failure");
      const threads = Context.get(first.context, Threads.ThreadManagementService);
      const receipt = (yield* bound.host.receipt(input.commandId))!;
      if (instructed)
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
      const runId = (yield* threads.getThreadRecords(receipt.threadId, ["runs"])).runs[0]?.id;
      const snapshot = yield* bound.host.reconcile({
        environmentId: bound.host.environmentId,
        projectId,
      });
      const thread = snapshot.threads[0]!;
      const checkout = thread.workspacePath;
      expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
      yield* projects.update({
        projectId,
        commandId: CommandId.make("repair-script"),
        scripts: script("git rev-parse HEAD > executed-ref"),
      });
      yield* Fiber.interrupt(first.fiber);
      if (scenario !== "unchanged")
        yield* fs.writeFileString(checkout + "/tracked.txt", "offline work\n");
      if (scenario === "new commit") {
        yield* git(checkout, "add", "tracked.txt");
        yield* git(
          checkout,
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "-m",
          "offline",
        );
      }
      const actualRef = yield* git(checkout, "rev-parse", "HEAD");
      acquired = yield* Deferred.make<{ host: Host["Service"]; storage: Storage["Service"] }>();
      const second = yield* startEnvironment(config, [plugin]);
      yield* Context.get(second.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const recovered = yield* Deferred.await(acquired);
      const result = yield* (
        instructed
          ? recovered.host.retryPreparation({
              environmentId: input.environmentId,
              projectId,
              threadId: thread.threadId,
              runId: runId!,
              commandId: CommandId.make("retry"),
            })
          : recovered.host.launch(input)
      ).pipe(Effect.result);
      if (instructed && result._tag === "Success")
        yield* Context.get(second.context, Tracker.WorktreeSetupTracker)
          .stream(thread.threadId)
          .pipe(
            Stream.filter((x) => x !== null && x.phase !== "running"),
            Stream.runHead,
          );
      const marker = yield* fs.exists(checkout + "/executed-ref");
      const executed = marker
        ? (yield* fs.readFileString(checkout + "/executed-ref")).trim()
        : null;
      if (scenario === "unchanged" || scenario === "tracked edits") {
        expect(result._tag).toBe("Success");
        expect(executed).toBe(pinned);
        if (scenario === "tracked edits")
          expect(yield* fs.readFileString(checkout + "/tracked.txt")).toBe("offline work\n");
      } else {
        expect(actualRef).not.toBe(pinned);
        // A committed intent cannot release setup at a different revision.
        if (!instructed) expect(result._tag).toBe("Failure");
        expect(marker).toBe(false);
        if (instructed && result._tag === "Success") {
          yield* Context.get(second.context, Threads.ThreadManagementService)
            .streamStoredEventsFrom({
              threadId: thread.threadId,
              afterSequence: result.success.cursor,
              eventType: "run.updated",
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === runId &&
                  stored.event.payload.status === "failed",
              ),
              Stream.runHead,
            );
          expect(
            (yield* Context.get(second.context, Threads.ThreadManagementService).getThreadRecords(
              thread.threadId,
              ["runs"],
            )).runs[0]?.status,
          ).toBe("failed");
        }
      }
      yield* Fiber.interrupt(second.fiber);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

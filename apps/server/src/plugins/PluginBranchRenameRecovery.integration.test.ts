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
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Startup from "../serverRuntimeStartup.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Git from "../git/GitWorkflowService.ts";

it.live.each([false, true])(
  "owned branch rename crash prefix; metadata committed=%s",
  (metadataCommitted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("independent-rename-prefix")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        // Replace only external provider I/O. No core service is mocked.
        yield* fs.writeFileString(
          config.settingsPath,
          '{"providers":{"codex":{"binaryPath":"/nonexistent/independent-review-disabled"}}}',
        );
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (cwd: string, ...args: string[]) =>
          spawn.string(ChildProcess.make("git", args, { cwd })).pipe(Effect.map((s) => s.trim()));
        yield* git(config.baseDir, "init", "-b", "main");
        yield* git(
          config.baseDir,
          "-c",
          "user.name=Review",
          "-c",
          "user.email=review@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        );
        const pinned = yield* git(config.baseDir, "rev-parse", "HEAD");
        let ready = yield* Deferred.make<Host["Service"]>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "rename_review",
            displayName: "Rename review",
            version: "1",
            hostVersion: 1,
            requiredCapabilities: ["execution", "persistence"],
            server: { tools: [], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.gen(function* () {
            yield* Deferred.succeed(ready, yield* Host);
            return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
          }),
        };
        let server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        let host = yield* Deferred.await(ready);
        const projectId = ProjectId.make("rename-review-project");
        let projects = Context.get(server.context, Projects.ProjectService);
        let threads = Context.get(server.context, Threads.ThreadManagementService);
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
          title: "Rename",
          workspaceRoot: config.baseDir,
          scripts: script("exit 23"),
        });
        const input = {
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Rename",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace: { type: "exact-ref" as const, ref: pinned, branch: "t3/abcdef12" },
          instruction: "Prepare work",
        };
        yield* host.launch(input);
        const thread = (yield* host.reconcile({ environmentId: host.environmentId, projectId }))
          .threads[0]!;
        const runFailure = yield* threads
          .streamStoredEventsFrom({
            threadId: thread.threadId,
            afterSequence: 0,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (e) => e.event.type === "run.updated" && e.event.payload.status === "failed",
            ),
            Stream.runHead,
          );
        expect(runFailure._tag).toBe("Some");
        const run = (yield* threads.getThreadRecords(thread.threadId, ["runs"])).runs[0]!;
        const checkout = (yield* threads.getThreadShell(thread.threadId))!.worktreePath!;
        const beforeOwner = yield* git(
          checkout,
          "config",
          "--local",
          "--get",
          "branch.t3/abcdef12.t3codeOwner",
        );
        // Execute the real first half of ThreadLaunchService's rename sequence, then
        // model process loss before its thread.metadata.update commit. The prefix
        // has the same durable Git/DB state whether setup later fails or is recovered.
        const renamed = yield* Context.get(server.context, Git.GitWorkflowService).renameBranch({
          cwd: checkout,
          oldBranch: "t3/abcdef12",
          newBranch: "generated-branch",
          exactName: true,
        });
        expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
        expect(
          yield* git(checkout, "config", "--local", "--get", "branch.generated-branch.t3codeOwner"),
        ).toBe(beforeOwner);
        if (metadataCommitted)
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("rename-prefix-metadata"),
            threadId: thread.threadId,
            branch: renamed.branch,
            worktreePath: checkout,
          });
        yield* projects.update({
          commandId: CommandId.make("repair"),
          projectId,
          scripts: script("printf recovered > rename-recovery-marker"),
        });
        yield* Fiber.interrupt(server.fiber);
        ready = yield* Deferred.make<Host["Service"]>();
        server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        host = yield* Deferred.await(ready);
        threads = Context.get(server.context, Threads.ThreadManagementService);
        const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        yield* host.retryPreparation({
          environmentId: host.environmentId,
          projectId,
          threadId: thread.threadId,
          runId: run.id,
          commandId: CommandId.make("retry"),
        });
        const outcome = yield* tracker.stream(thread.threadId).pipe(
          Stream.filter(
            (x) =>
              x?.phase === "failed" ||
              x?.stages.some((s) => s.id === "agent" && s.status === "done") === true,
          ),
          Stream.runHead,
        );
        expect(outcome._tag).toBe("Some");
        if (outcome._tag === "Some") {
          expect(outcome.value!.phase).not.toBe("failed");
        }
        expect(yield* fs.exists(checkout + "/rename-recovery-marker")).toBe(true);
        expect((yield* threads.getThreadShell(thread.threadId))!.branch).toBe("generated-branch");
        expect(yield* git(checkout, "rev-parse", "HEAD")).toBe(pinned);
        yield* Fiber.interrupt(server.fiber);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

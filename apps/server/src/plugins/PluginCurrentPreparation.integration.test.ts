import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Startup from "../serverRuntimeStartup.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.live.each(["current", "exact-ref"] as const)(
  "honors synchronous preparation for %s",
  (workspaceType) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("fresh-gilfoyle-current")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const providerGate = `${config.baseDir}/provider-started`;
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [providerGate]));
        const providerStarted = yield* spawn
          .string(ChildProcess.make("/bin/sh", ["-c", `cat '${providerGate}'`]))
          .pipe(Effect.forkScoped);
        const binary = `${config.baseDir}/codex-fixture`;
        const providerGateJson = yield* encodeJson(providerGate);
        // Replace only native Codex process I/O. Mark the execution adapter's initialize
        // frame; provider-discovery probes have no optOutNotificationMethods capability.
        yield* fs.writeFileString(
          binary,
          `#!/usr/bin/env node
import * as readline from 'node:readline';
import * as fs from 'node:fs';
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.156.1\\n'); process.exit(0); }
const lines = readline.createInterface({ input: process.stdin });
lines.once('line', line => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize' && frame.params.capabilities.optOutNotificationMethods) {
    fs.writeFileSync(${providerGateJson}, 'execution-adapter-initialized\\n');
  }
  process.exit(1);
});
`,
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          yield* encodeJson({ providers: { codex: { binaryPath: binary } } }),
        );
        const git = (...args: string[]) =>
          spawn
            .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
            .pipe(Effect.map((x) => x.trim()));
        yield* git("init", "-b", "main");
        yield* git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "base",
        );
        const ref = yield* git("rev-parse", "HEAD");
        const fifo = `${config.baseDir}/gate`;
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [fifo]));
        const acquired = yield* Deferred.make<Host["Service"]>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "fresh_probe",
            displayName: "Probe",
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
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const host = yield* Deferred.await(acquired);
        const projectId = ProjectId.make("fixture");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Fixture",
          workspaceRoot: config.baseDir,
          scripts: [
            {
              id: "setup",
              name: "Setup",
              icon: "configure",
              command: `printf '%s%s\\n' 'GILFOYLE_' 'SETUP_BLOCKED'; read gate < '${fifo}'; printf '%s%s\\n' 'GILFOYLE_' 'SETUP_FINISHED'`,
              runOnWorktreeCreate: true,
              async: false,
            },
          ],
        });
        const blocked = yield* Deferred.make<string>();
        const finished = yield* Deferred.make<void>();
        const terminals = Context.get(server.context, Terminals.TerminalManager);
        let output = "";
        const unsubscribe = yield* terminals.subscribe((event) => {
          if (event.type !== "output") return Effect.void;
          output += event.data;
          if (output.includes("GILFOYLE_SETUP_FINISHED"))
            return Deferred.succeed(finished, undefined).pipe(Effect.asVoid);
          if (output.includes("GILFOYLE_SETUP_BLOCKED"))
            return Deferred.succeed(blocked, event.threadId).pipe(Effect.asVoid);
          return Effect.void;
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const input = {
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Fixture",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace:
            workspaceType === "current"
              ? { type: "current" as const }
              : { type: "exact-ref" as const, ref, branch: "fixture" },
        };
        const launching = yield* host.launch(input).pipe(Effect.forkScoped);
        const threadId = ThreadId.make(yield* Deferred.await(blocked));
        const target = { environmentId: host.environmentId, projectId, threadId };
        const before = yield* host.inspect(target);
        const sent = yield* host
          .send({
            ...target,
            commandId: CommandId.make("send"),
            instruction: "Must wait for setup",
            mode: "queue",
          })
          .pipe(Effect.result);
        const records = yield* Context.get(
          server.context,
          Threads.ThreadManagementService,
        ).getThreadRecords(threadId, ["runs"]);
        const setupFinishedBeforeSend = yield* Deferred.isDone(finished);
        let setupFinishedAtProviderStart: boolean | null = null;
        yield* spawn.exitCode(
          ChildProcess.make("/bin/sh", ["-c", `printf 'continue\\n' > '${fifo}'`]),
        );
        yield* Deferred.await(finished);
        yield* Fiber.join(launching);
        {
          // Control: the same public command becomes accepted after actual handoff.
          expect(
            (yield* host.send({
              ...target,
              commandId: CommandId.make("send"),
              instruction: "Must wait for setup",
              mode: "queue",
            })).status,
          ).toBe("accepted");
          expect(yield* Fiber.join(providerStarted)).toContain("execution-adapter-initialized");
          setupFinishedAtProviderStart = yield* Deferred.isDone(finished);
        }
        yield* Fiber.interrupt(server.fiber);
        expect(setupFinishedBeforeSend).toBe(false);
        expect(before.outstandingWork.length).toBeGreaterThan(0);
        expect(sent._tag).toBe("Failure");
        expect(records.runs).toHaveLength(0);
        expect(setupFinishedAtProviderStart).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

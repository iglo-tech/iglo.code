import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  AuthOrchestrationOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import { startEnvironment, makeClient } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Tracker from "../project/WorktreeSetupTracker.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live.each([true, false])(
  "actual native adapter workspace after plugin preparation failure=%s",
  (failed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("pr4-native-barrier")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const fs = yield* FileSystem.FileSystem;
        const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
        const git = (...args: string[]) =>
          spawn
            .string(ChildProcess.make("git", args, { cwd: config.baseDir }))
            .pipe(Effect.map((s) => s.trim()));
        yield* git("init", "-b", "main");
        const commit = (message: string) =>
          git(
            "-c",
            "user.name=Review",
            "-c",
            "user.email=review@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            message,
          );
        yield* commit("pinned");
        const pinned = yield* git("rev-parse", "HEAD");
        yield* commit("root advanced");
        yield* git("branch", "occupied");
        const gate = config.baseDir + "/provider-started";
        yield* spawn.exitCode(ChildProcess.make("mkfifo", [gate]));
        const binary = config.baseDir + "/codex-fixture";
        yield* fs.writeFileString(
          binary,
          `#!/usr/bin/env node
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
if (process.argv[2] === '--version') { process.stdout.write('codex-cli 0.156.1\\n'); process.exit(0); }
const lines = readline.createInterface({input: process.stdin});
lines.on('line', line => {
  const frame = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(config.baseDir + "/probe-methods")}, String(frame.method)+"\\n");
  if (frame.method === 'initialize') {
    if (!frame.params.capabilities.optOutNotificationMethods) {process.exit(1);}
    process.stdout.write(JSON.stringify({id:frame.id,result:{userAgent:'review',codexHome:${JSON.stringify(config.baseDir + "/fake-codex-home")},platformFamily:'unix',platformOs:'macos'}})+'\\n');
  } else if (frame.method === 'thread/start') {
    fs.appendFileSync(${JSON.stringify(config.baseDir + "/probe-methods")}, 'before gate '+JSON.stringify(frame.params.cwd)+"\\n");
    const observation = {cwd:frame.params.cwd,head:execFileSync('git',['rev-parse','HEAD'],{cwd:frame.params.cwd,encoding:'utf8'}).trim()};
    fs.writeFileSync(${JSON.stringify(config.baseDir + "/provider-observation.json")},JSON.stringify(observation));
    fs.writeFileSync(${JSON.stringify(gate)}, JSON.stringify(observation)+'\\n');
    fs.appendFileSync(${JSON.stringify(config.baseDir + "/probe-methods")}, 'after gate'+"\\n");
    process.stdout.write(JSON.stringify({id:frame.id,result:{thread:{id:'fixture:'+frame.params.cwd,sessionId:'fixture:'+frame.params.cwd,forkedFromId:null,createdAt:1,updatedAt:1,cwd:frame.params.cwd,ephemeral:false,path:null,source:'vscode',modelProvider:'openai',status:{type:'idle'},preview:'',turns:[],cliVersion:'0.156.1',threadSource:null,agentNickname:null,agentRole:null,gitInfo:null,name:null},model:'gpt-5.4',modelProvider:'openai',serviceTier:null,cwd:frame.params.cwd,instructionSources:[],approvalPolicy:'on-request',sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false},approvalsReviewer:'user',reasoningEffort:'medium'}})+'\\n');
  } else if (frame.id !== undefined) {
    process.stdout.write(JSON.stringify({id:frame.id,error:{code:-32601,message:'External provider probe unsupported'}})+'\\n');
  }
});
`,
        );
        yield* fs.chmod(binary, 0o755);
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({
            providers: {
              codex: { binaryPath: binary },
              claudeAgent: { binaryPath: "/nonexistent/pr4-provider" },
            },
          }),
        );
        const ready = yield* Deferred.make<Host["Service"]>();
        const plugin: ServerPlugin = {
          manifest: {
            id: "probe",
            displayName: "Probe",
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
        const server = yield* startEnvironment(config, [plugin]);
        yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
        const host = yield* Deferred.await(ready);
        const projectId = ProjectId.make("project");
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Project",
          workspaceRoot: config.baseDir,
        });
        const input = {
          environmentId: host.environmentId,
          projectId,
          commandId: CommandId.make("launch"),
          title: "Exact ref",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "approval-required" as const,
          workspace: {
            type: "exact-ref" as const,
            ref: pinned,
            branch: failed ? "occupied" : "prepared",
          },
        };
        const launched = yield* host.launch(input).pipe(Effect.result);
        expect(launched._tag).toBe(failed ? "Failure" : "Success");
        const receipt = (yield* host.receipt(input.commandId))!;
        expect(receipt.status).toBe("accepted");
        const threadId = receipt.threadId;
        const target = { environmentId: host.environmentId, projectId, threadId };
        const tracker = Context.get(server.context, Tracker.WorktreeSetupTracker);
        const threads = Context.get(server.context, Threads.ThreadManagementService);
        if (failed) {
          expect((yield* tracker.get(threadId))?.phase).toBe("failed");
          expect((yield* threads.getThreadShell(threadId))?.worktreePath).toBeNull();
          expect(
            (yield* host
              .send({
                ...target,
                commandId: CommandId.make("guarded-send"),
                instruction: "Wait for the pinned checkout",
                mode: "queue",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(0);
        } else {
          expect((yield* threads.getThreadShell(threadId))?.worktreePath).not.toBeNull();
        }
        const providerStarted = yield* spawn
          .string(ChildProcess.make("/bin/sh", ["-c", `cat '${gate}'`]))
          .pipe(Effect.forkScoped);
        const client = yield* makeClient(server.context, [AuthOrchestrationOperateScope]);
        const result = yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "message.dispatch",
          commandId: CommandId.make("native-chat"),
          threadId,
          messageId: MessageId.make("native-chat"),
          text: "Work on the requested pinned revision",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.result);
        expect(result._tag).toBe(failed ? "Failure" : "Success");
        if (failed) return;
        const observed = JSON.parse(yield* Fiber.join(providerStarted));
        expect(observed.cwd).not.toBe(config.baseDir);
        expect(observed.head).toBe(pinned);
        expect((yield* threads.getThreadRecords(threadId, ["runs"])).runs).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60000 },
);

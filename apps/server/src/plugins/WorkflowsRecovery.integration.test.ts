import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { rpcs, apiScopes, Run } from "@t3tools/plugin-workflows/contracts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { sequence } from "./Workflows.testkit.ts";

it.live(
  "canceled pending workflow host intent must not create a core thread on plugin restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = { ...(yield* makeReplayServerConfig("pr7-cancel-core")), noBrowser: true };
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(ChildProcess.make("git", ["init", config.baseDir]));
        yield* spawner.exitCode(
          ChildProcess.make("git", [
            "-C",
            config.baseDir,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
          ]),
        );
        const { context } = yield* startEnvironment(config, []);
        const core = Context.get(context, Host);
        const projectId = ProjectId.make("private-cancel-project");
        yield* Context.get(context, Projects.ProjectService).create({
          commandId: CommandId.make("project"),
          projectId,
          title: "Review",
          workspaceRoot: config.baseDir,
        });
        let blocked = true;
        const host = Host.of({
          ...core,
          providers: () =>
            core.providers().pipe(
              Effect.map((providers) =>
                providers.map((provider) => ({
                  ...provider,
                  available: provider.instanceId === "codex",
                })),
              ),
            ),
          launch: (input) =>
            blocked
              ? Effect.fail(
                  new PluginError({
                    pluginId: "host",
                    operation: "launch",
                    code: "service",
                    message: "Crash before core launch commit",
                  }),
                )
              : core.launch({ ...input, instruction: undefined }),
        });
        const boot = Effect.fnUntraced(function* () {
          const lifetime = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(lifetime, Exit.void));
          const services = Layer.mergeAll(
            Layer.succeedContext(context),
            NodeServices.layer,
            Scheduler.layer,
            ScheduleTargets.layer,
            Layer.succeed(Host, host),
          );
          const pluginContext = yield* Layer.build(
            Registry.layer({
              environmentId: core.environmentId,
              directory: `${config.stateDir}/review-plugins`,
              plugins: [plugin],
              clientApis: new Map(
                Object.values(rpcs).map((rpc) => [
                  rpc._tag,
                  { rpc, requiredScope: apiScopes[rpc._tag]! },
                ]),
              ),
            }).pipe(Layer.provide(services)),
          ).pipe(Scope.provide(lifetime));
          const registry = Context.get(pluginContext, Registry.PluginRegistry);
          yield* registry.start;
          const invoke = Effect.fnUntraced(function* (method: string, input: unknown) {
            const api = yield* registry.api(`plugins.workflows.${method}`);
            const effect = api.invoke(input);
            if (!Effect.isEffect(effect)) return yield* Effect.die("Expected request");
            return yield* effect;
          });
          return { invoke, close: Scope.close(lifetime, Exit.void) };
        });
        let runtime = yield* boot();
        const scope = { environmentId: core.environmentId, projectId };
        const run = yield* runtime
          .invoke("start", {
            ...scope,
            clientRequestId: "cancel-recovery",
            definition: sequence,
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Run)));
        yield* runtime.invoke("reconcile", scope);
        const query = () =>
          runtime
            .invoke("get", { ...scope, runId: run.id })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Run)));
        const control = yield* runtime
          .invoke("start", {
            ...scope,
            clientRequestId: "recover-without-cancel",
            definition: sequence,
            input: {},
            workspace: { type: "current" },
          })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Run)));
        yield* runtime.invoke("reconcile", scope);
        const current = yield* query();
        const threadId = current.attempts[0]!.threadId!;
        expect(
          yield* Context.get(context, Threads.ThreadManagementService).getThreadShell(threadId),
        ).toBeNull();
        yield* runtime.invoke("cancel", {
          ...scope,
          runId: run.id,
          expectedRevision: current.revision,
          clientRequestId: "cancel",
        });
        yield* runtime.invoke("reconcile", scope);
        yield* runtime.close;
        blocked = false;
        runtime = yield* boot();
        yield* runtime.invoke("reconcile", scope);
        const after = yield* query();
        const coreThread = yield* Context.get(
          context,
          Threads.ThreadManagementService,
        ).getThreadShell(threadId);
        expect(after.state).toBe("canceled");
        expect(coreThread).toBeNull();
        const controlThread = control.attempts[0]!.threadId!;
        expect(
          yield* Context.get(context, Threads.ThreadManagementService).getThreadShell(
            controlThread,
          ),
        ).not.toBeNull();
        yield* runtime.close;
        runtime = yield* boot();
        yield* runtime.invoke("reconcile", scope);
        const shell = yield* Context.get(
          context,
          Threads.ThreadManagementService,
        ).getShellSnapshot();
        expect(shell.threads.filter((thread) => thread.projectId === projectId)).toHaveLength(1);
        expect(
          yield* Context.get(context, Threads.ThreadManagementService).getThreadShell(threadId),
        ).toBeNull();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

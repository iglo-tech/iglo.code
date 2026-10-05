import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { rpcs, apiScopes } from "@t3tools/plugin-workflows/contracts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Projects from "../project/ProjectService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { startEnvironment } from "./PluginHost.testkit.ts";

/** Real core and private plugin SQL; quiet launches isolate provider execution from recovery. */
export const makeCoreWorkflowFixture = Effect.gen(function* () {
  const config = { ...(yield* makeReplayServerConfig("workflow-core-recovery")), noBrowser: true };
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
  const actual = Context.get(context, Host);
  const projectId = ProjectId.make("workflow-core-project");
  yield* Context.get(context, Projects.ProjectService).create({
    commandId: CommandId.make("project"),
    projectId,
    title: "Review",
    workspaceRoot: config.baseDir,
  });
  const core = Host.of({
    ...actual,
    providers: () =>
      actual.providers().pipe(
        Effect.map((providers) =>
          providers.map((provider) => ({
            ...provider,
            available: provider.instanceId === "codex",
          })),
        ),
      ),
    launch: (input) => actual.launch({ ...input, instruction: undefined }),
  });
  const directory = `${config.stateDir}/workflow-plugins`;
  const boot = Effect.fnUntraced(function* (
    host: Host["Service"] = core,
    selected: ServerPlugin = plugin,
  ) {
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
        directory,
        plugins: [selected],
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
    return { registry, invoke, close: Scope.close(lifetime, Exit.void) };
  });
  return {
    core,
    boot,
    scope: { environmentId: core.environmentId, projectId },
    threads: Context.get(context, Threads.ThreadManagementService),
    databasePath: `${directory}/workflows/state.sqlite`,
  };
});

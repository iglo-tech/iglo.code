import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type EnvironmentId,
  type PluginCatalog,
  type ServerConfig,
} from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import type {
  PluginCommandReceipt,
  PluginLifecycleItem,
  PluginThreadState,
} from "@t3tools/plugin-host-contract/schema";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { plugin as workflowPlugin } from "@t3tools/plugin-workflows/server";
import {
  authoringTimings,
  preloadWorkflowPages,
  web as workflowsWeb,
} from "@t3tools/plugin-workflows/web";
import {
  Definition,
  type Run,
  type WorkflowClient,
  type WorkflowPermissions,
} from "@t3tools/plugin-workflows/contracts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { act, useMemo, useSyncExternalStore } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as Yaml from "yaml";
import { vi } from "vite-plus/test";

import * as Auth from "../../server/src/auth/EnvironmentAuth.ts";
import * as Projects from "../../server/src/project/ProjectService.ts";
import * as Registry from "../../../packages/plugin-host-adapter/src/PluginRegistry.ts";
import {
  startEnvironment,
  makeClient,
  origin,
} from "../../server/src/plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../../server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const binding = vi.hoisted(() => ({
  configs: new Map<string, ServerConfig>(),
  contexts: new Map<string, Context.Context<Supervisor.EnvironmentSupervisor>>(),
}));

// Bind the production client to each test environment's authenticated server session.
vi.mock("../src/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { FetchHttpClient } = await import("effect/http");
  const { EnvironmentRegistry } = await import("@t3tools/client-runtime/connection");
  return {
    connectionAtomRuntime: Atom.runtime(
      Layer.unwrap(
        Effect.gen(function* () {
          const entries = yield* SubscriptionRef.make<
            ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
          >(new Map());
          const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
          return Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
            entries,
            networkStatus,
            run: (environmentId, effect) =>
              Effect.suspend(() => {
                const context = binding.contexts.get(environmentId);
                return context === undefined
                  ? Effect.die("Unexpected client environment")
                  : Effect.provide(effect, context);
              }),
            followStream: (environmentId, stream) =>
              Stream.unwrap(
                Effect.sync(() => {
                  const context = binding.contexts.get(environmentId);
                  if (context === undefined) throw new Error("Unexpected client environment");
                  return Stream.concat(Stream.provideContext(stream, context), Stream.never);
                }),
              ),
          });
        }),
      ).pipe(Layer.merge(FetchHttpClient.layer)),
    ),
  };
});
vi.mock("../src/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() => Atom.make(Option.some(true))),
      initialConfigValueAtom: Atom.family((environmentId: string) =>
        Atom.make(binding.configs.get(environmentId) ?? null),
      ),
    },
  };
});

import { createWorkflowsClient } from "../src/plugins/workflowsClient";
import { createPluginWebContext } from "../src/plugins/context";
import { bind } from "../src/plugins/contributions";
import { pluginDesign } from "../src/plugins/design";
import { PluginPageContent } from "../src/plugins/PluginPageContent";
import { validatePluginSearch } from "../src/plugins/pageLink";
import { availableCatalogAtom } from "../src/plugins/runtime";
import { appAtomRegistry } from "../src/rpc/atomRegistry";

const HEAD = "a".repeat(40);
const projectId = ProjectId.make("same-project");
const decodeDefinition = Schema.decodeUnknownSync(Definition);
/** Scripted check outcomes: an exit code, or "lost" when execution ends without a result. */
const checkResults: Array<number | "lost"> = [];
let checkExecutions = 0;
// Provider turns and check commands are replayed at the execution boundary; the plugin,
// catalog, persistence, authorization and RPC transport are real.
const threads = new Map<string, PluginThreadState>();
const receipts = new Map<string, PluginCommandReceipt>();
const replayedWorkflows: ServerPlugin = {
  ...workflowPlugin,
  acquire: Effect.gen(function* () {
    const host = yield* Host;
    return yield* workflowPlugin.acquire.pipe(
      Effect.provideService(
        Host,
        Host.of({
          ...host,
          providers: () =>
            Effect.succeed([
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: "codex",
                displayName: "Codex",
                toolsSupported: true,
                available: true,
                reason: null,
                runtimeModes: ["approval-required", "full-access"],
                models: [
                  { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, optionDescriptors: [] },
                ],
              },
            ]),
          skills: () => Effect.succeed([]),
          workspace: (id) =>
            host
              .workspace(id)
              .pipe(Effect.map((value) => ({ ...value, branch: "main", head: HEAD }))),
          resolveRef: () => Effect.succeed(HEAD),
          prepareWorkspace: (input) =>
            host
              .workspace(input.projectId)
              .pipe(Effect.map((value) => ({ path: value.path, branch: input.key, head: HEAD }))),
          verifyWorkspace: () => Effect.succeed({ head: HEAD, clean: true }),
          verifyPullRequestHead: () => Effect.sync(() => ({ head: HEAD, branch: "feature" })),
          cancelPending: () => Effect.void,
          receipt: (id) => Effect.sync(() => receipts.get(id) ?? null),
          launch: (input) =>
            Effect.sync(() => {
              const previous = receipts.get(input.commandId);
              if (previous) return previous;
              threads.set(input.threadId!, {
                environmentId: input.environmentId,
                projectId: input.projectId,
                threadId: input.threadId!,
                title: input.title,
                runtimeMode: input.runtimeMode,
                workspacePath:
                  input.workspace.type === "existing" ? input.workspace.path : "/replayed",
                branch: "main",
                runs: [{ id: `${input.threadId}:run`, status: "running" }],
                outstandingWork: [],
                requests: [],
                checkpoints: [],
                nativeSession: { id: `${input.threadId}:native`, canResume: true },
              });
              const receipt: PluginCommandReceipt = {
                commandId: input.commandId,
                threadId: input.threadId!,
                cursor: 1,
                status: "accepted",
                error: null,
              };
              receipts.set(input.commandId, receipt);
              return receipt;
            }),
          inspect: (target) =>
            Effect.suspend(() => {
              const state = threads.get(target.threadId);
              return state
                ? Effect.succeed(state)
                : Effect.fail(
                    new PluginError({
                      pluginId: "host",
                      code: "unavailable",
                      operation: "inspect",
                      message: "Thread is unavailable",
                    }),
                  );
            }),
          send: (input) =>
            Effect.sync(() => {
              const receipt: PluginCommandReceipt = {
                commandId: input.commandId,
                threadId: input.threadId,
                cursor: 2,
                status: "accepted",
                error: null,
              };
              receipts.set(input.commandId, receipt);
              return receipt;
            }),
          // Check commands are replayed at the execution boundary, one scripted result each.
          execute: () =>
            Effect.suspend(() => {
              checkExecutions++;
              const result = checkResults.shift() ?? 0;
              return result === "lost"
                ? Effect.fail(
                    new PluginError({
                      pluginId: "host",
                      code: "unavailable",
                      operation: "execute",
                      message: "The check process ended before reporting.",
                    }),
                  )
                : Effect.succeed({
                    exitCode: result,
                    timedOut: false,
                    stdout: "replayed check output",
                    stderr: "",
                  });
            }),
          interrupt: () => Effect.succeed(null),
          lifecycle: () => Stream.never,
          reconcile: () =>
            Effect.succeed({
              kind: "snapshot",
              cursor: 1,
              replayGap: true,
              threads: [...threads.values()],
            } satisfies PluginLifecycleItem),
        }),
      ),
    );
  }),
};

/** Records requests and run deliveries so the test awaits exact server milestones. */
function track(client: WorkflowClient) {
  const queued = new Map<string, Array<Promise<unknown>>>();
  const waiting = new Map<string, Array<(call: { promise: Promise<unknown> }) => void>>();
  const record = <A,>(method: string, promise: Promise<A>): Promise<A> => {
    const waiter = waiting.get(method)?.shift();
    if (waiter) waiter({ promise });
    else queued.set(method, [...(queued.get(method) ?? []), promise]);
    return promise;
  };
  const next = (method: string) =>
    new Promise<{ promise: Promise<unknown> }>((resolve) => {
      const promise = queued.get(method)?.shift();
      if (promise) resolve({ promise });
      else waiting.set(method, [...(waiting.get(method) ?? []), resolve]);
    });
  let runs: ReadonlyArray<Run> = [];
  const runWaiters: Array<{ predicate: (run: Run) => boolean; resolve: () => void }> = [];
  const permissionWaiters: Array<(value: WorkflowPermissions) => void> = [];
  const wrapped: WorkflowClient = {
    ...client,
    subscribePermissions: (listener) =>
      client.subscribePermissions((value) => {
        listener(value);
        for (const waiter of permissionWaiters.splice(0)) waiter(value);
      }),
    projects: () => record("projects", client.projects()),
    library: (input) => record("library", client.library(input)),
    read: (input) => record("read", client.read(input)),
    validate: (input) => record("validate", client.validate(input)),
    save: (input) => record("save", client.save(input)),
    capabilities: (input) => record("capabilities", client.capabilities(input)),
    skills: (input) => record("skills", client.skills(input)),
    preview: (input) => record("preview", client.preview(input)),
    startSaved: (input) => record("launch", client.startSaved(input)),
    gate: (input) => record("gate", client.gate(input)),
    retry: (input) => record("retry", client.retry(input)),
    watchRun: (input, onRun, onError) =>
      client.watchRun(
        input,
        (run) => {
          onRun(run);
          runs = [run];
          for (const waiter of runWaiters.filter((item) => item.predicate(run))) {
            runWaiters.splice(runWaiters.indexOf(waiter), 1);
            waiter.resolve();
          }
        },
        onError,
      ),
  };
  return {
    client: wrapped,
    settle: async (method: string) => {
      const call = await next(method);
      await act(async () => {
        await call.promise.catch(() => undefined);
      });
    },
    /** Await the most recent call (or the next one), dropping older ones it supersedes. */
    settleLatest: async (method: string) => {
      const latest = queued.get(method)?.pop();
      queued.delete(method);
      const call = latest === undefined ? await next(method) : { promise: latest };
      await act(async () => {
        await call.promise.catch(() => undefined);
      });
    },
    /** Drop calls that need no assertion (for example a page's own project lookup). */
    forget: (method: string) => {
      queued.delete(method);
    },
    /** Later waits need a delivery from a fresh run subscription (after a reload). */
    forgetRuns: () => {
      runs = [];
    },
    /** Resolves once the open run view's latest delivery matches. */
    run: async (predicate: (run: Run) => boolean) => {
      const latest = runs.at(-1);
      if (latest === undefined || !predicate(latest))
        await new Promise<void>((resolve) => runWaiters.push({ predicate, resolve }));
      await act(async () => {});
    },
    permissions: (predicate: (value: WorkflowPermissions) => boolean) =>
      new Promise<void>((resolve) => {
        const check = (value: WorkflowPermissions) =>
          predicate(value) ? resolve() : permissionWaiters.push(check);
        permissionWaiters.push(check);
      }),
  };
}

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};
const flush = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

it.live(
  "authors and runs a checked decision with one bounded repeat and a human gate over an authenticated connection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const timings = { ...authoringTimings };
        Object.assign(authoringTimings, {
          searchDelayMs: 0,
          validationDelayMs: 0,
          draftDelayMs: 0,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => Object.assign(authoringTimings, timings)),
        );
        yield* Effect.promise(preloadWorkflowPages);
        const fs = yield* FileSystem.FileSystem;
        const environments = yield* Effect.forEach(["Workstation"], (label, index) =>
          Effect.gen(function* () {
            const config = {
              ...(yield* makeReplayServerConfig(`workflow-decisions-${index}`)),
              noBrowser: true,
              traceTimingEnabled: false,
            };
            const server = yield* startEnvironment(config, [replayedWorkflows]);
            const environmentId = Context.get(server.context, Host).environmentId;
            yield* Context.get(server.context, Projects.ProjectService).create({
              commandId: CommandId.make("same-project"),
              projectId,
              title: "Same name",
              workspaceRoot: config.baseDir,
            });
            const rpc = yield* makeClient(server.context, [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
            if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
              return yield* Effect.die("Expected config");
            const target = new PrimaryConnectionTarget({
              environmentId,
              label,
              httpBaseUrl: origin(server.context),
              wsBaseUrl: origin(server.context).replace("http", "ws"),
            });
            const auth = Context.get(server.context, Auth.EnvironmentAuth);
            const prepare = (token: string): PreparedConnection => ({
              environmentId,
              label,
              httpBaseUrl: origin(server.context),
              socketUrl: target.wsBaseUrl,
              httpAuthorization: { _tag: "Bearer", token },
              target,
            });
            const readOnly = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
            const writable = yield* auth.issueSession({
              scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
            });
            const prepared = yield* SubscriptionRef.make(Option.some(prepare(readOnly.token)));
            const session: RpcSession = {
              client: rpc,
              initialConfig: Effect.succeed(snapshot.value.config),
              subscribeServerConfig: (input) => rpc[WS_METHODS.subscribeServerConfig](input),
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
            };
            const context = yield* Layer.build(
              Layer.mock(Supervisor.EnvironmentSupervisor)({
                target,
                session: yield* SubscriptionRef.make(Option.some(session)),
                state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
                prepared,
              }),
            );
            binding.configs.set(environmentId, snapshot.value.config);
            binding.contexts.set(environmentId, context);
            const registry = Context.get(server.context, Registry.PluginRegistry);
            const catalog: PluginCatalog = yield* registry.catalog;
            const invoke = Effect.fnUntraced(function* (method: string, input: unknown) {
              const api = yield* registry.api(`plugins.workflows.${method}`);
              const result = api.invoke(input);
              if (!Effect.isEffect(result)) return yield* Effect.die("Expected request");
              return yield* result;
            });
            return {
              label,
              environmentId,
              catalog,
              registry,
              invoke,
              directory: `${config.baseDir}/.t3code/workflows`,
              tracked: track(createWorkflowsClient(environmentId)),
              grantWrite: SubscriptionRef.set(prepared, Option.some(prepare(writable.token))),
            };
          }),
        );
        const [first] = environments as [(typeof environments)[number]];
        // Streams wait for each environment's published plugin catalog.
        for (const environment of environments)
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                const release = appAtomRegistry.subscribe(
                  availableCatalogAtom(environment.environmentId),
                  (value) => {
                    if (value !== null) {
                      queueMicrotask(() => release());
                      resolve();
                    }
                  },
                  { immediate: true },
                );
              }),
          );
        yield* fs.makeDirectory(first.directory, { recursive: true });
        const scope = { environmentId: first.environmentId, projectId };
        const reconcile = first.invoke("reconcile", scope);

        const storage = memoryStorage();
        const connections = new Map<string, "connected" | "disconnected">();
        const rootRoute = createRootRoute();
        const router = createRouter({
          routeTree: rootRoute.addChildren([
            createRoute({
              getParentRoute: () => rootRoute,
              path: "/plugins/$environmentId/$pluginId/$pageId",
              validateSearch: validatePluginSearch,
            }),
            createRoute({ getParentRoute: () => rootRoute, path: "/$environmentId/$threadId" }),
          ]),
          history: createMemoryHistory({
            initialEntries: [
              `/plugins/${first.environmentId}/workflows/workflows.library?pluginProjectId=${projectId}`,
            ],
          }),
        });
        const loaded = new Set<() => void>();
        const unsubscribe = router.history.subscribe(() => {
          void router.load().then(() => {
            for (const notify of loaded) notify();
          });
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* Effect.promise(() => router.load());
        const bound = new Map(
          environments.map((environment) => [
            environment.environmentId as string,
            { environment, plugin: bind(workflowsWeb, environment.tracked.client) },
          ]),
        );
        const contextFor = (
          environment: (typeof environments)[number],
          input: {
            projectId: ProjectId | null;
            threadId?: ThreadId | null;
            state?: Record<string, string>;
          },
        ) =>
          createPluginWebContext({
            environmentId: environment.environmentId,
            environmentLabel: environment.label,
            descriptor: environment.catalog.plugins.find(
              (item) => item.manifest.id === "workflows",
            )!,
            projectId: input.projectId,
            threadId: input.threadId ?? null,
            pageState: input.state ?? {},
            connection: connections.get(environment.environmentId) ?? "connected",
            navigate: router.navigate,
            storage,
          });
        function Harness() {
          const href = useSyncExternalStore(
            (notify) => {
              loaded.add(notify);
              return () => loaded.delete(notify);
            },
            () => router.state.location.href,
          );
          const location = useMemo(() => router.state.location, [href]);
          const [, first = "", second = "", , pageId = ""] = location.pathname
            .split("/")
            .map(decodeURIComponent);
          // Thread routes render the contributed context strip, as the chat header does.
          const threadRoute = first !== "plugins";
          const environmentId = threadRoute ? first : second;
          const search = validatePluginSearch(location.search as Record<string, unknown>);
          const target = bound.get(environmentId)!;
          const connection = connections.get(environmentId) ?? "connected";
          const stateKey = JSON.stringify(search.pluginState ?? {});
          const context = useMemo(
            () =>
              contextFor(target.environment, {
                projectId: threadRoute ? projectId : (search.pluginProjectId ?? null),
                threadId: threadRoute ? ThreadId.make(second) : null,
                state: JSON.parse(stateKey) as Record<string, string>,
              }),
            [target, search.pluginProjectId, stateKey, connection, threadRoute, second],
          );
          return threadRoute ? (
            <div>
              {target.plugin.threadContext.map((item) => (
                <div key={item.id}>{item.render(context)}</div>
              ))}
            </div>
          ) : (
            <PluginPageContent
              catalog={target.environment.catalog}
              contributions={[{ ...target.plugin, context }]}
              pluginId="workflows"
              pageId={pageId}
              status={connection}
              showEnvironment
            />
          );
        }
        let renderer: ReactTestRenderer | undefined;
        const mount = () =>
          act(async () => {
            renderer = create(
              <RouterContextProvider router={router}>
                <Harness />
              </RouterContextProvider>,
            );
          });
        const unmount = () => act(async () => renderer?.unmount());
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await unmount();
            appAtomRegistry.dispose();
            vi.unstubAllGlobals();
          }),
        );
        const root = () => renderer!.root;
        const page = () => textOf(root());
        const buttons = (label: string) =>
          root().findAll(
            (node) =>
              node.type === pluginDesign.Button &&
              (node.props.ariaLabel === label || textOf(node) === label),
          );
        const button = (label: string) => buttons(label)[0]!;
        const control = (type: unknown, key: string) =>
          root().find(
            (node) => node.type === type && (node.props.id === key || node.props.ariaLabel === key),
          );
        const click = (label: string) => act(async () => button(label).props.onClick());
        const choose = (key: string, value: string) =>
          act(async () => control(pluginDesign.Select, key).props.onChange(value));
        const write = (key: string, value: string) =>
          act(async () => control(pluginDesign.Textarea, key).props.onChange(value));
        const go = (environmentId: EnvironmentId, pageId: string, state?: Record<string, string>) =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: { environmentId, pluginId: "workflows", pageId },
              search: { pluginProjectId: projectId, ...(state ? { pluginState: state } : {}) },
            });
          });
        const promise = <A,>(run: () => Promise<A>) => Effect.promise(run);
        const { tracked } = first;
        const type = (key: string, value: string) =>
          act(async () => control(pluginDesign.Input, key).props.onChange(value));
        const keyDown = (nodeId: string, key: string) =>
          act(async () =>
            root()
              .find(
                (node) =>
                  node.type === "li" &&
                  typeof node.props.onKeyDown === "function" &&
                  node.findAll((child) => child.props.id === `wf-step-${nodeId}`).length > 0,
              )
              .props.onKeyDown({ altKey: false, key, preventDefault: () => {} }),
          );
        const select = (key: string) => control(pluginDesign.Select, key);
        // Segmented switches are host controls; drive them through their change handler.
        const toggle = (key: string, value: string) =>
          act(async () => control(pluginDesign.SegmentedControl, key).props.onChange(value));
        // A step's lines in the Routes view.
        const routesOf = (nodeId: string) =>
          textOf(
            root().find(
              (node) =>
                node.type === "li" &&
                typeof node.props.onKeyDown === "function" &&
                node.findAll((child) => child.props.id === `wf-step-${nodeId}`).length > 0,
            ),
          );
        const validated = () => promise(() => tracked.settleLatest("validate"));
        const runId = () =>
          (router.state.location.search as { pluginState?: { run?: string } }).pluginState?.run;
        const get = (id: string) =>
          first.invoke("get", { ...scope, runId: id }).pipe(Effect.map((run) => run as Run));
        const reportTool = (yield* first.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!;
        /** The visit's agent reports completion and its native turn settles. */
        const finishImplementation = (run: Run) =>
          Effect.gen(function* () {
            const threadId = run.attempts.at(-1)!.threadId!;
            yield* reportTool.tool.invoke(
              {
                version: 1,
                clientRetryKey: `report-${run.attempts.length}`,
                outcome: "completed",
                summary: "Implemented",
                data: { ready: true },
                evidence: [],
              },
              {
                environmentId: first.environmentId,
                projectId,
                threadId,
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: "native-session",
                runtimeMode: "approval-required",
              },
            );
            const native = threads.get(threadId)!;
            threads.set(threadId, {
              ...native,
              runs: native.runs.map((item) => ({ ...item, status: "completed" })),
            });
          });

        // New workflow from the library; every step is added and connected without dragging.
        yield* promise(mount);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => click("New workflow"));
        yield* promise(() => type("Workflow name", "Repeat implementation once"));
        yield* promise(() => click("Create"));
        yield* promise(flush);
        // Until this environment's step types load, only agent steps and ends are offered.
        expect(button("Check").props.disabled).toBe(true);
        expect(button("Check").props.tooltip).toBe("Loading step types…");
        expect(button("Agent step").props.disabled).toBe(false);
        yield* promise(() => tracked.settle("capabilities"));
        // The backend advertises every kind; a Join is only added with its Parallel group.
        expect(button("Check").props.disabled).toBe(false);
        expect(button("Decision").props.disabled).toBe(false);
        expect(button("Human gate").props.disabled).toBe(false);
        expect(button("Parallel group").props.disabled).toBe(false);
        expect(button("Join").props.disabled).toBe(true);
        yield* promise(() => click("Agent step"));
        yield* promise(() => tracked.settle("skills"));
        yield* promise(() => write("wf-agent-1-instruction", "Implement the change"));
        yield* promise(() => click("Add report field"));
        yield* promise(() => type("wf-agent-1-report-fields-0", "ready"));
        yield* promise(() => click("Check"));
        yield* promise(() => type("wf-check-1-command", "project-check"));
        yield* promise(() => write("wf-check-1-args", "--ci"));
        // Unsupported check policies are visible but unavailable.
        expect(select("wf-check-1-retry").props.disabled).toBe(true);
        expect(select("wf-check-1-retry").props.options).toContainEqual({
          value: "automatic",
          label: "Retry automatically (not available)",
          disabled: true,
        });
        expect(select("wf-check-1-workspace").props.value).toBe("run");
        // The check's declared result fields, which decisions read; exitCode is optional.
        expect(page()).toContain("exitCode?");
        yield* promise(() => click("Decision"));
        expect(select("wf-decision-1-source").props.value).toBe("check-1");
        expect(
          select("wf-decision-1-source").props.options.map(
            (option: { value: string }) => option.value,
          ),
        ).toEqual(["agent-1", "check-1"]);
        yield* promise(() => click("Human gate"));
        yield* promise(() => click("End"));
        yield* promise(() => type("wf-end-1-title", "Changes requested"));
        yield* promise(() => choose("wf-end-1-outcome", "failed"));
        yield* promise(() => click("Human gate: Human gate 1"));
        yield* promise(() => choose("wf-human-1-changes", "end-1"));

        // The decision: Match all with a nested Match any group, a destination and Otherwise.
        yield* promise(() => click("Decision: Decision 1"));
        yield* promise(() => click("Add rule"));
        expect(select("wf-decision-1-rules-0-when-0").props.value).toBe("outcome");
        expect(select("wf-decision-1-rules-0-when-0-value").props.value).toBe("completed");
        yield* promise(() => click("Add condition to rule 1"));
        yield* promise(() => choose("wf-decision-1-rules-0-when-1", "exitCode"));
        expect(control(pluginDesign.Input, "wf-decision-1-rules-0-when-1-value").props.value).toBe(
          "0",
        );
        yield* promise(() => click("Add group to rule 1"));
        yield* promise(() => choose("wf-decision-1-rules-0-when-2-0", "timedOut"));
        yield* promise(() => choose("wf-decision-1-rules-0-when-2-0-value", "false"));
        yield* promise(() => click("Add condition to this group"));
        yield* promise(() => choose("wf-decision-1-rules-0-when-2-1", "interrupted"));
        yield* promise(() => choose("wf-decision-1-rules-0-when-2-1-value", "false"));
        yield* promise(() => choose("wf-decision-1-rules-0", "human-1"));
        const readsAs =
          'If outcome equals "completed" and exitCode equals 0 (false when exitCode is absent) and (timedOut equals false or interrupted equals false)';
        expect(page()).toContain(`Reads as: ${readsAs}`);
        // Operators are typed by field: numbers compare by order, enums and text by membership.
        expect(
          select("wf-decision-1-rules-0-when-1-op").props.options.map(
            (option: { value: string }) => option.value,
          ),
        ).toEqual(["eq", "ne", "gt", "gte", "lt", "lte", "present", "absent"]);
        // Otherwise repeats the implementation once, then goes to the human gate.
        yield* promise(() => toggle("Otherwise route", "repeat"));
        expect(select("wf-decision-1-otherwise").props.value).toBe("agent-1");
        expect(select("wf-decision-1-otherwise-max").props.value).toBe("1");
        yield* promise(() => choose("wf-decision-1-otherwise-repeat", "human-1"));
        // Repeat once means two visits in total.
        expect(select("wf-decision-1-otherwise-max").props.options[0]).toEqual({
          value: "1",
          label: "×1 · 2 visits",
        });
        // Rule order is first-match order; a rule back to the agent without a repeat bound is an
        // unbounded cycle and blocks saving until it is removed.
        yield* promise(() => click("Add rule"));
        yield* promise(() => click("1 to fix"));
        expect(page()).toContain("Every cycle must cross a bounded repeat route.");
        yield* promise(() => click("Decision: Decision 1"));
        // Making it a second repeat back to the same step is rejected at the later route's
        // At limit control, since both would share one counter.
        yield* promise(() => toggle("Rule 2 route", "repeat"));
        expect(select("wf-decision-1-rules-1").props.value).toBe("agent-1");
        expect(page()).toContain(
          "decision-1: Rule 2 already repeats back to agent-1, and repeats from one step to the same step share one counter.",
        );
        expect(select("wf-decision-1-otherwise-repeat").props.invalid).toBe(true);
        expect(select("wf-decision-1-rules-1-repeat").props.invalid).toBe(false);
        yield* promise(() => click("Move rule 2 up"));
        expect(routesOf("decision-1")).toContain(
          "Rule 1 outcome = completed ↩ Agent step 1repeat ×1 (2 visits)at limit → Done",
        );
        expect(routesOf("decision-1")).toContain(
          "Rule 2 outcome = completed and +2 → Human gate 1",
        );
        yield* promise(() => click("Remove rule 1"));
        expect(page()).not.toContain("Every cycle must cross a bounded repeat route.");
        expect(page()).not.toContain("already repeats back to");
        // The run-wide visit bound also ends at the human gate.
        yield* promise(() => click("Decision: Decision 1"));
        yield* promise(() => choose("wf-workflow-atLimit", "human-1"));
        yield* validated();
        expect(page()).not.toContain("to fix");
        expect(routesOf("decision-1")).toContain(
          "Rule 1 outcome = completed and +2 → Human gate 1",
        );
        expect(routesOf("decision-1")).toContain(
          "Otherwise ↩ Agent step 1repeat ×1 (2 visits)at limit → Human gate 1",
        );
        expect(routesOf("human-1")).toContain("Request changes → Changes requested");

        // Changing the source removes fields the conditions use: each is located and blocking.
        yield* promise(() => click("Decision: Decision 1"));
        // Locally invalid drafts are not sent for server validation; the shared rules locate them.
        yield* promise(() => choose("wf-decision-1-source", "agent-1"));
        expect(page()).toContain("decision-1: unknown predicate path exitCode.");
        expect(select("wf-decision-1-rules-0-when-1").props.invalid).toBe(true);
        expect(select("wf-decision-1-rules-0-when-1").props.options[0]).toEqual({
          value: "exitCode",
          label: "exitCode (missing field)",
        });
        expect(select("wf-decision-1-rules-0-when-0").props.invalid).toBe(false);
        yield* promise(() => choose("wf-decision-1-source", "check-1"));
        // Removing a route target leaves the route dangling as a repairable error.
        yield* promise(() => keyDown("end-1", "Delete"));
        expect(routesOf("human-1")).toContain("Request changes → end-1 (missing)");
        yield* promise(() => click("1 to fix"));
        expect(page()).toContain("human-1: unknown route target end-1.");
        expect(button("Save").props.disabled).toBe(true);
        yield* promise(() => click("Show"));
        expect(select("wf-human-1-changes").props.invalid).toBe(true);
        yield* promise(() => click("End"));
        yield* promise(() => type("wf-end-1-title", "Changes requested"));
        yield* promise(() => choose("wf-end-1-outcome", "failed"));
        yield* validated();
        expect(page()).not.toContain("to fix");

        // The draft survives a reload of the page.
        yield* promise(unmount);
        yield* promise(mount);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("capabilities"));
        yield* promise(() => click("Decision: Decision 1"));
        expect(page()).toContain(`Reads as: ${readsAs}`);
        yield* validated();

        // Saving needs operate access on this authenticated connection.
        expect(button("Save").props.disabled).toBe(true);
        const granted = tracked.permissions((value) => value.save && value.start && value.gate);
        yield* first.grantWrite;
        yield* promise(() => granted);
        yield* promise(flush);
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));
        expect(page()).toContain("Saved revision 1");
        const saved = decodeDefinition(
          Yaml.parse(
            yield* fs.readFileString(`${first.directory}/repeat-implementation-once.yaml`),
          ),
        );
        expect(saved).toMatchObject({ entry: "agent-1", atLimit: "human-1" });
        expect(saved.nodes.find((node) => node.id === "decision-1")).toEqual({
          id: "decision-1",
          kind: "decision",
          title: "Decision 1",
          source: "check-1",
          rules: [
            {
              when: {
                op: "all",
                terms: [
                  { op: "eq", path: "outcome", value: "completed" },
                  { op: "eq", path: "exitCode", value: 0 },
                  {
                    op: "any",
                    terms: [
                      { op: "eq", path: "timedOut", value: false },
                      { op: "eq", path: "interrupted", value: false },
                    ],
                  },
                ],
              },
              route: { to: "human-1" },
            },
          ],
          otherwise: { to: "agent-1", repeat: { max: 1, atLimit: "human-1" } },
        });

        // Start it; both check runs fail, so Otherwise repeats once and then reaches At limit.
        checkResults.push(1, 1);
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", {
            start: "1",
            workflow: "repeat-implementation-once",
          }),
        );
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        const id = runId()!;
        expect(id).toMatch(/^workflow-/);
        // Launches and check results arrive as persisted run deliveries; native settlement is
        // observed when the server reconciles.
        yield* reconcile;
        for (let visit = 1; visit <= 2; visit++) {
          yield* promise(() =>
            tracked.run(
              (run) =>
                run.id === id &&
                run.attempts.filter((attempt) => attempt.nodeId === "agent-1").length === visit &&
                run.attempts.at(-1)?.phase === "running",
            ),
          );
          yield* finishImplementation(yield* get(id));
          yield* reconcile;
        }
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        const limited = yield* get(id);
        expect(limited).toMatchObject({
          automationStopped: true,
          repeats: { "decision-1:agent-1": 1 },
        });

        // Route history shows the recorded rule, the repeat counter and the limit exit.
        const history = page();
        expect(history).toContain("Needs your decision");
        expect(history).toContain("Decision 1 → Agent step 1otherwiserepeat 1/1");
        expect(history).toContain("Decision 1 → Human gate 1otherwiseat limit");
        const tip = (content: string) =>
          root().findAll(
            (node) => node.type === pluginDesign.Tooltip && node.props.content === content,
          );
        expect(tip("Visit 2 of up to 2 · at limit → Human gate 1")).toHaveLength(1);
        expect(tip("1/1 repeats used · at limit → Human gate 1")).toHaveLength(1);
        yield* promise(() => toggle("Run view", "steps"));
        // The check visit shows its recorded result as execution evidence.
        const checkButton = root().findAll(
          (node) =>
            node.type === pluginDesign.Button &&
            typeof node.props.ariaLabel === "string" &&
            /^Visit \d+: Check 1, Failed$/.test(node.props.ariaLabel),
        );
        expect(checkButton).toHaveLength(2);
        yield* promise(() => act(async () => checkButton[0]!.props.onClick()));
        yield* promise(flush);
        expect(page()).toContain("Check result recorded (failed)");
        expect(page()).toContain("exit 1");
        // Checks are commands without a native thread.
        expect(buttons("Open thread")).toHaveLength(0);
        expect(page()).toContain("Check 1 → Decision 1");
        yield* promise(() => toggle("Run view", "routes"));
        // The decision's routing lists every rule it considered and why Otherwise was taken.
        yield* promise(() => click("Decision: Decision 1"));
        yield* promise(flush);
        expect(page()).toContain(`Rule 1 did not match: ${readsAs.slice(3)}`);
        expect(page()).toContain("Otherwise taken: no rule matched");

        // A reload restores the same counters and route; nothing is recomputed in the client.
        yield* promise(unmount);
        tracked.forgetRuns();
        yield* promise(mount);
        yield* promise(() =>
          tracked.run((run) => run.id === id && run.state === "awaiting-review"),
        );
        expect(page()).toContain("Decision 1 → Human gate 1otherwiseat limit");
        expect(button("Request changes").props.disabled).toBe(false);
        yield* promise(() => click("Approve"));
        yield* promise(() => tracked.settle("gate"));
        yield* promise(() => tracked.run((run) => run.state === "completed"));
        // Deselecting the decision shows the whole route history again.
        yield* promise(() => click("Decision: Decision 1"));
        expect(page()).toContain("Human gate 1 → Doneapprove");
        const finished = yield* get(id);
        expect(finished.trace.at(-1)).toMatchObject({ route: "approve", chosen: "done" });
        expect(finished.attempts.filter((attempt) => attempt.nodeId === "agent-1")).toHaveLength(2);

        // Run again: the check's execution ends without a retained result. The run is unresolved,
        // never passed or failed, and the check runs again only on an explicit Retry.
        checkResults.push("lost", 0);
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", {
            start: "1",
            workflow: "repeat-implementation-once",
          }),
        );
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        const lostId = runId()!;
        expect(lostId).not.toBe(id);
        yield* reconcile;
        yield* promise(() =>
          tracked.run((run) => run.id === lostId && run.attempts.at(-1)?.phase === "running"),
        );
        yield* finishImplementation(yield* get(lostId));
        const executionsBefore = checkExecutions;
        yield* reconcile;
        yield* promise(() => tracked.run((run) => run.id === lostId && run.state === "unresolved"));
        expect(checkExecutions).toBe(executionsBefore + 1);
        // Further reconciliation (as after a restart) neither replays nor resolves the check.
        yield* reconcile;
        const lost = yield* get(lostId);
        expect(lost).toMatchObject({
          state: "unresolved",
          allowedActions: ["cancel", "retry"],
          reason: "The check result is unresolved. An explicit retry is required.",
        });
        expect(lost.attempts.at(-1)).toMatchObject({
          nodeId: "check-1",
          phase: "unresolved",
          check: { outcome: "unresolved", exitCode: null, interrupted: true },
        });
        expect(lost.trace.some((item) => item.nodeId === "check-1")).toBe(false);
        expect(checkExecutions).toBe(executionsBefore + 1);
        yield* promise(() => toggle("Run view", "steps"));
        const lostVisit = root().findAll(
          (node) =>
            node.type === pluginDesign.Button &&
            node.props.ariaLabel === "Visit 2: Check 1, Unresolved",
        );
        expect(lostVisit).toHaveLength(1);
        yield* promise(() => act(async () => lostVisit[0]!.props.onClick()));
        yield* promise(flush);
        const lostEvidence = page();
        expect(lostEvidence).toContain("Unresolved");
        expect(lostEvidence).toContain(
          "No check result was retained; the check was interrupted, so it is neither a pass nor a failure",
        );
        expect(lostEvidence).toContain("Routing stopped at this visit");
        expect(lostEvidence).not.toContain("Check result recorded (completed)");
        expect(lostEvidence).not.toContain("Check result recorded (failed)");
        expect(buttons("Resume retained session")).toHaveLength(0);
        expect(button("Retry with a new attempt").props.disabled).toBe(false);
        yield* promise(() => click("Retry with a new attempt"));
        yield* promise(() => tracked.settle("retry"));
        yield* promise(() =>
          tracked.run((run) => run.id === lostId && run.state === "awaiting-review"),
        );
        expect(checkExecutions).toBe(executionsBefore + 2);
        const retried = yield* get(lostId);
        expect(retried.attempts.filter((attempt) => attempt.nodeId === "check-1")).toHaveLength(2);
        expect(retried.trace.at(-1)).toMatchObject({ nodeId: "decision-1", route: "rules.0" });

        // At the whole-run visit limit a gate never offers a repeat it would divert, and says why.
        yield* fs.writeFileString(
          `${first.directory}/bounded.yaml`,
          Yaml.stringify({
            version: 1,
            id: "bounded",
            revision: 1,
            title: "Bounded gate",
            entry: "work",
            atLimit: "review",
            maxVisits: 2,
            nodes: [
              {
                id: "work",
                kind: "agent",
                title: "Work",
                modelSelection: { instanceId: "codex", model: "gpt-5.4" },
                runtimeMode: "approval-required",
                instruction: "Do the work",
                report: { fields: [{ name: "ready", type: "boolean", required: true }] },
                next: { to: "review" },
              },
              {
                id: "review",
                kind: "human",
                title: "Human review",
                approve: { to: "done" },
                changes: { to: "work", repeat: { max: 1, atLimit: "review" } },
              },
              { id: "done", kind: "end", title: "Done", outcome: "completed" },
            ],
          }),
        );
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", { start: "1", workflow: "bounded" }),
        );
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        const boundedId = runId()!;
        yield* reconcile;
        yield* promise(() =>
          tracked.run((run) => run.id === boundedId && run.attempts.at(-1)?.phase === "running"),
        );
        yield* finishImplementation(yield* get(boundedId));
        yield* reconcile;
        yield* promise(() =>
          tracked.run((run) => run.id === boundedId && run.state === "awaiting-review"),
        );
        expect(buttons("Request changes")).toHaveLength(0);
        expect(button("Approve").props.disabled).toBe(false);
        // The withheld decision is explained inside the gate's own alert.
        expect(page()).toContain("Request changes unavailable · ↩ Work · run visit limit reached");
        expect(page()).not.toContain("Visit or repeat limit reached");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);

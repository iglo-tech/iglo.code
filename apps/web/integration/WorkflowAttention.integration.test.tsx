import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
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
import { preloadWorkflowPages, web as workflowsWeb } from "@t3tools/plugin-workflows/web";
import type { AttentionPage, Run, WorkflowClient } from "@t3tools/plugin-workflows/contracts";
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { act, useMemo, useSyncExternalStore } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
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

const projectId = ProjectId.make("review-project");
const HEAD = "a".repeat(40);
// The pull request head the replayed forge reports; a review freezes the value it saw.
const forge = { head: HEAD };
const reviewer = (id: string, title: string) => ({
  id,
  title,
  skill: undefined,
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  instruction: `Review the ${title.toLowerCase()} of the change`,
  report: {
    fields: [{ name: "verdict", type: "enum", required: true, values: ["pass", "changes"] }],
  },
});
const review = {
  version: 1,
  id: "review",
  revision: 1,
  title: "Frozen review",
  entry: "reviews",
  atLimit: "gate",
  nodes: [
    {
      id: "reviews",
      kind: "parallel",
      title: "Reviewers",
      pullRequest: { repository: "test/repo", number: 1 },
      branches: [reviewer("code", "Code"), reviewer("security", "Security"), reviewer("ux", "UX")],
      next: "join",
    },
    {
      id: "join",
      kind: "join",
      title: "Wait for all",
      fork: "reviews",
      rules: [
        { when: { op: "eq", path: "result", value: "all_completed" }, route: { to: "gate" } },
      ],
      otherwise: { to: "stop" },
    },
    {
      id: "gate",
      kind: "human",
      title: "Human review",
      approve: { to: "done" },
      changes: { to: "done" },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
    { id: "stop", kind: "end", title: "Stopped", outcome: "unresolved" },
  ],
};

// Provider turns are replayed at the execution boundary; the plugin, catalog, persistence,
// authorization and RPC transport are real.
const threads = new Map<string, PluginThreadState>();
const receipts = new Map<string, PluginCommandReceipt>();
const serverStreams = { open: 0, closed: [] as Array<() => void> };
/** Resolves once the server has closed every attention stream it served. */
const attentionStreamsClosed = () =>
  new Promise<void>((resolve) =>
    serverStreams.open === 0 ? resolve() : serverStreams.closed.push(resolve),
  );
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
          verifyPullRequestHead: () => Effect.sync(() => ({ head: forge.head, branch: "feature" })),
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
      // Count the server's open attention streams, so cleanup is checked at the transport.
      Effect.map((services) => ({
        ...services,
        api: services.api.map((api) =>
          api.rpc._tag === "plugins.workflows.attention"
            ? {
                ...api,
                invoke: (input: unknown) => {
                  const result = api.invoke(input);
                  return Stream.isStream(result)
                    ? Stream.unwrap(
                        Effect.sync(() => {
                          serverStreams.open++;
                          return result.pipe(
                            Stream.ensuring(
                              Effect.sync(() => {
                                serverStreams.open--;
                                if (serverStreams.open === 0)
                                  for (const resolve of serverStreams.closed.splice(0)) resolve();
                              }),
                            ),
                          );
                        }),
                      )
                    : result;
                },
              }
            : api,
        ),
      })),
    );
  }),
};

/** Awaits exact subscription deliveries and counts the subscriptions views hold open. */
function track(client: WorkflowClient) {
  let open = 0;
  const hold = (close: () => void) => {
    open++;
    return () => {
      open--;
      close();
    };
  };
  const latest: { run?: Run; attention?: AttentionPage } = {};
  const waiters: Array<{ check: () => boolean; resolve: () => void }> = [];
  const notify = () => {
    for (const waiter of waiters.filter((item) => item.check())) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  // Deliveries held back, so a test can look at the screen before a snapshot arrives.
  let held: Array<() => void> | null = null;
  const until = async (check: () => boolean) => {
    if (!check()) await new Promise<void>((resolve) => waiters.push({ check, resolve }));
    await act(async () => {});
  };
  const wrapped: WorkflowClient = {
    ...client,
    watchRun: (input, onRun, onError) =>
      hold(
        client.watchRun(
          input,
          (run) => {
            onRun(run);
            latest.run = run;
            notify();
          },
          onError,
        ),
      ),
    subscribeAttention: (scope, onPage, onError) =>
      hold(
        client.subscribeAttention(
          scope,
          (page) => {
            const deliver = () => {
              onPage(page);
              latest.attention = page;
              notify();
            };
            if (held === null) deliver();
            else held.push(deliver);
          },
          onError,
        ),
      ),
  };
  return {
    client: wrapped,
    holdAttention: () => {
      held = [];
    },
    releaseAttention: () =>
      act(async () => {
        const pending = held ?? [];
        held = null;
        for (const deliver of pending) deliver();
      }),
    run: (predicate: (run: Run) => boolean) =>
      until(() => latest.run !== undefined && predicate(latest.run)),
    attention: (predicate: (page: AttentionPage) => boolean) =>
      until(() => latest.attention !== undefined && predicate(latest.attention)),
    open: () => open,
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
  "resolves parallel review attention through the hosted pages with exact native requests",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        yield* Effect.promise(preloadWorkflowPages);
        const config = {
          ...(yield* makeReplayServerConfig("workflow-attention")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [replayedWorkflows]);
        const environmentId = Context.get(server.context, Host).environmentId;
        yield* Context.get(server.context, Projects.ProjectService).create({
          commandId: CommandId.make("review-project"),
          projectId,
          title: "Review project",
          workspaceRoot: config.baseDir,
        });
        const rpc = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
        const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
        if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
          return yield* Effect.die("Expected config");
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Workstation",
          httpBaseUrl: origin(server.context),
          wsBaseUrl: origin(server.context).replace("http", "ws"),
        });
        const auth = Context.get(server.context, Auth.EnvironmentAuth);
        // A read-only pairing: attention and evidence need no operate access.
        const reader = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
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
            prepared: yield* SubscriptionRef.make(
              Option.some<PreparedConnection>({
                environmentId,
                label: "Workstation",
                httpBaseUrl: origin(server.context),
                socketUrl: target.wsBaseUrl,
                httpAuthorization: { _tag: "Bearer", token: reader.token },
                target,
              }),
            ),
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
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const release = appAtomRegistry.subscribe(
                availableCatalogAtom(environmentId),
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
        const scope = { environmentId, projectId };
        const reconcile = invoke("reconcile", scope);
        const tracked = track(createWorkflowsClient(environmentId));
        const plugin = bind(workflowsWeb, tracked.client);
        const descriptor = catalog.plugins.find((item) => item.manifest.id === "workflows")!;

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
            initialEntries: [`/plugins/${environmentId}/workflows/workflows.attention`],
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
        const storage = memoryStorage();
        let connection: "connected" | "disconnected" = "connected";
        function Harness() {
          const href = useSyncExternalStore(
            (notify) => {
              loaded.add(notify);
              return () => loaded.delete(notify);
            },
            () => router.state.location.href,
          );
          const location = useMemo(() => router.state.location, [href]);
          const [, first = "", , , pageId = ""] = location.pathname
            .split("/")
            .map(decodeURIComponent);
          const search = validatePluginSearch(location.search as Record<string, unknown>);
          const stateKey = JSON.stringify(search.pluginState ?? {});
          const pageContext = useMemo(
            () =>
              createPluginWebContext({
                environmentId,
                environmentLabel: "Workstation",
                descriptor,
                projectId: search.pluginProjectId ?? null,
                threadId: null,
                pageState: JSON.parse(stateKey) as Record<string, string>,
                connection,
                navigate: router.navigate,
                storage,
              }),
            [search.pluginProjectId, stateKey, connection],
          );
          // The native thread route stands in for the existing thread view and its controls.
          return first !== "plugins" ? (
            <p>Native thread view</p>
          ) : (
            <PluginPageContent
              catalog={catalog}
              contributions={[{ ...plugin, context: pageContext }]}
              pluginId="workflows"
              pageId={pageId}
              status={connection}
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
        const rerender = () =>
          act(async () =>
            renderer!.update(
              <RouterContextProvider router={router}>
                <Harness />
              </RouterContextProvider>,
            ),
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await unmount();
            appAtomRegistry.dispose();
            vi.unstubAllGlobals();
          }),
        );
        const page = () => textOf(renderer!.root);
        const buttons = (label: string) =>
          renderer!.root.findAll(
            (node) =>
              node.type === pluginDesign.Button &&
              (node.props.ariaLabel === label || textOf(node) === label),
          );
        const promise = <A,>(run: () => Promise<A>) => Effect.promise(run);

        // Nothing needs attention yet; the empty state is stated, not implied.
        yield* promise(mount);
        yield* promise(() => tracked.attention((value) => value.total === 0));
        expect(page()).toContain("Nothing needs your attention");

        // Three reviewers run; two native requests wait in one thread and one in another.
        const started = (yield* invoke("start", {
          ...scope,
          clientRequestId: "review",
          definition: review,
          input: {},
          workspace: { type: "current" },
        })) as Run;
        yield* reconcile;
        const forked = (yield* invoke("get", { ...scope, runId: started.id })) as Run;
        expect(forked.attempts.map((attempt) => attempt.phase)).toEqual([
          "running",
          "running",
          "running",
        ]);
        const [code, security] = forked.attempts.map((attempt) => attempt.threadId!);
        const request = (id: string, kind: string, createdAt: number, resolved = false) => ({
          id,
          kind,
          status: resolved ? "resolved" : "pending",
          createdAt,
          resolvedAt: resolved ? createdAt + 1 : null,
        });
        const ask = (threadId: string, requests: PluginThreadState["requests"]) =>
          threads.set(threadId, { ...threads.get(threadId)!, requests });
        ask(code!, [request("approve-1", "approval", 1), request("question-1", "user_input", 2)]);
        ask(security!, [request("approve-2", "approval", 3)]);
        yield* reconcile;
        yield* promise(() => tracked.attention((value) => value.runs[0]?.items.length === 3));
        const listed = page();
        expect(listed).toContain("1 run");
        // Each request keeps its native queue position in its own thread.
        expect(listed).toContain(
          "Reviewers · CodeNeeds inputApproval request 1 of 2 · answered next",
        );
        expect(listed).toContain(
          "Reviewers · CodeNeeds inputUser input request 2 of 2 · after 1 earlier",
        );
        expect(listed).toContain(
          "Reviewers · SecurityNeeds inputApproval request 1 of 1 · answered next",
        );
        // Generic navigation opens the existing native thread and its own controls.
        yield* promise(() =>
          act(async () =>
            buttons(
              "Open the thread of Reviewers · Code to answer its request",
            )[0]!.props.onClick(),
          ),
        );
        yield* promise(flush);
        expect(decodeURIComponent(router.state.location.pathname)).toBe(
          `/${environmentId}/${code}`,
        );
        expect(page()).toBe("Native thread view");
        expect(tracked.open()).toBe(0);

        // Back on the page, answering the first request clears only that item.
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: { environmentId, pluginId: "workflows", pageId: "workflows.attention" },
              search: {},
            });
          }),
        );
        ask(code!, [
          request("approve-1", "approval", 1, true),
          request("question-1", "user_input", 2),
        ]);
        yield* reconcile;
        yield* promise(() =>
          tracked.attention(
            (value) =>
              value.runs[0]?.items.length === 2 &&
              value.runs[0]!.items[0]!.request?.id === "question-1",
          ),
        );
        expect(page()).toContain(
          "Reviewers · CodeNeeds inputUser input request 1 of 1 · answered next",
        );
        expect(page()).not.toContain("Approval request 1 of 2");

        // The run view lists every required reviewer and keeps reports apart from settlement.
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: { environmentId, pluginId: "workflows", pageId: "workflows.runs" },
              search: { pluginProjectId: projectId, pluginState: { run: started.id } },
            });
          }),
        );
        yield* promise(() => tracked.run((run) => run.id === started.id));
        ask(code!, []);
        ask(security!, []);
        const reportTool = (yield* registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!;
        for (const attempt of forked.attempts)
          yield* reportTool.tool.invoke(
            {
              version: 1,
              clientRetryKey: "review",
              outcome: "completed",
              summary: "Reviewed",
              data: { verdict: attempt.branchId === "code" ? "changes" : "pass" },
              evidence: [],
            },
            {
              environmentId,
              projectId,
              threadId: attempt.threadId!,
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "native-session",
              runtimeMode: "approval-required",
            },
          );
        for (const threadId of [code!, security!]) {
          const state = threads.get(threadId)!;
          threads.set(threadId, {
            ...state,
            runs: state.runs.map((run) => ({ ...run, status: "completed" })),
          });
        }
        yield* reconcile;
        yield* promise(() =>
          tracked.run(
            (run) => run.overview?.review?.reported === 3 && run.overview.review.settled === 2,
          ),
        );
        const pending = page();
        expect(pending).toContain("Parallel review: Reviewers · generation 1");
        expect(pending).toContain(`test/repo#1 at committed head ${HEAD.slice(0, 12)}`);
        expect(pending).toContain("Wait for all · All 3 reviewers required");
        // Reports and settlement are counted apart; only every settled reviewer decides.
        expect(pending).toContain("Waiting for all3/3 reported · 2/3 settled");
        expect(buttons("Show the evidence of reviewer Security")[0]!.props.tooltip).toContain(
          "Review the security of the change",
        );
        expect(pending).toContain("Execution still running");
        expect(pending).not.toContain("Canceled");

        // Older runs come from the same live read, widened: every listed run is current.
        const ux = forked.attempts[2]!.threadId!;
        ask(ux, [request("ux-1", "user_input", 4), request("ux-2", "user_input", 5)]);
        yield* reconcile;
        const stopped = (index: number) =>
          invoke("start", {
            ...scope,
            clientRequestId: `stopped-${index}`,
            definition: {
              version: 1,
              id: "stopped",
              revision: 1,
              title: `Stopped ${String(index).padStart(3, "0")}`,
              entry: "stop",
              atLimit: "stop",
              nodes: [{ id: "stop", kind: "end", title: "Stop", outcome: "unresolved" }],
            },
            input: {},
            workspace: { type: "current" },
          }) as Effect.Effect<Run, unknown>;
        const created: Run[] = [];
        for (let index = 0; index < 26; index++) created.push(yield* stopped(index));
        const listedTitles = () => page().match(/Stopped \d{3}/g) ?? [];
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: { environmentId, pluginId: "workflows", pageId: "workflows.attention" },
              search: {},
            });
          }),
        );
        yield* promise(() =>
          tracked.attention((value) => value.total === 27 && value.runs.length === 25),
        );
        expect(page()).toContain("27 runs");
        expect(page()).toContain("Newest 25 of 27");
        expect(page()).not.toContain("Frozen review");
        // Widening keeps the current runs on screen until the wider snapshot arrives.
        tracked.holdAttention();
        yield* promise(() => act(async () => buttons("Load older runs")[0]!.props.onClick()));
        yield* promise(flush);
        expect(listedTitles()).toHaveLength(25);
        expect(page()).toContain("Loading older runs…");
        yield* promise(tracked.releaseAttention);
        yield* promise(() => tracked.attention((value) => value.runs.length === 27));
        expect(listedTitles()).toHaveLength(26);
        expect(listedTitles()).toContain("Stopped 000");
        expect(page()).toContain(
          "Reviewers · UXNeeds inputUser input request 2 of 2 · after 1 earlier",
        );
        expect(page()).not.toContain("Load older runs");
        // A change to an older run alone refreshes it, and nothing collapses meanwhile.
        ask(ux, [request("ux-1", "user_input", 4, true), request("ux-2", "user_input", 5)]);
        yield* reconcile;
        yield* promise(() =>
          tracked.attention(
            (value) => value.runs.find((run) => run.runId === started.id)?.items.length === 1,
          ),
        );
        expect(page()).toContain(
          "Reviewers · UXNeeds inputUser input request 1 of 1 · answered next",
        );
        expect(listedTitles()).toHaveLength(26);
        // (a) An older run resolved on the server is no longer listed.
        yield* invoke("cancel", {
          ...scope,
          runId: created[0]!.id,
          clientRequestId: "cancel-oldest",
          expectedRevision: created[0]!.revision,
        });
        yield* promise(() => tracked.attention((value) => value.total === 26));
        expect(listedTitles()).toHaveLength(25);
        expect(listedTitles()).not.toContain("Stopped 000");
        // (b) A new run pushes the newest page's oldest run into the older range: listed once.
        yield* stopped(26);
        yield* promise(() =>
          tracked.attention(
            (value) => value.total === 27 && value.runs[0]?.workflowTitle === "Stopped 026",
          ),
        );
        expect(listedTitles()).toHaveLength(26);
        expect(listedTitles().filter((title) => title === "Stopped 001")).toHaveLength(1);
        // Offline, the last snapshot (older runs included) stays visible and marked.
        connection = "disconnected";
        yield* promise(rerender);
        expect(page()).toContain("Last loaded");
        expect(listedTitles()).toHaveLength(26);
        expect(page()).toContain("Frozen review");
        expect(page()).not.toContain("Loading older runs…");
        connection = "connected";
        yield* promise(rerender);
        yield* promise(() => tracked.attention((value) => value.runs.length === 27));
        expect(page()).not.toContain("Last loaded");
        // Past the server's bound, the page says how many it shows and how to narrow it.
        for (let index = 27; index < 102; index++) yield* stopped(index);
        yield* promise(() => tracked.attention((value) => value.total === 102));
        for (const expected of [75, 100]) {
          yield* promise(() => act(async () => buttons("Load older runs")[0]!.props.onClick()));
          yield* promise(() => tracked.attention((value) => value.runs.length === expected));
        }
        expect(page()).toContain("102 runs");
        expect(page()).toContain("Newest 100 of 102 · open a run's project to see the rest");
        expect(buttons("Load older runs")).toHaveLength(0);
        // The guidance is actionable: a run's project opens that project's attention.
        yield* promise(() =>
          act(async () =>
            buttons("Show workflow attention for project Review project")[0]!.props.onClick(),
          ),
        );
        yield* promise(flush);
        expect(router.state.location.pathname).toContain("workflows.attention");
        expect(router.state.location.search).toMatchObject({ pluginProjectId: projectId });
        yield* promise(() => tracked.attention((value) => value.total === 102));
        // The project breadcrumb names the scope and switches back to every project.
        const project = renderer!.root.find((node) => node.type === pluginDesign.PageHeader).props
          .breadcrumb[0];
        expect(project).toMatchObject({ ariaLabel: "Project", value: projectId });
        expect(project.options[0]).toEqual({ value: "", label: "All projects" });

        // Leaving the pages closes every subscription they opened.
        yield* promise(unmount);
        expect(tracked.open()).toBe(0);
        // The server closed the attention stream it served this page.
        yield* promise(attentionStreamsClosed);
        expect(serverStreams.open).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

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
import { Run as RunSchema } from "@t3tools/plugin-workflows/contracts";
import type {
  Definition,
  Run,
  ThreadLink,
  WorkflowClient,
  WorkflowPermissions,
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
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { Atom } from "effect/reactivity";
import { act, useMemo, useSyncExternalStore } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import * as Yaml from "yaml";
import { vi } from "vite-plus/test";
import { stepButtonId } from "../../../packages/plugin-workflows/src/web/Flow.tsx";

import * as Auth from "../../server/src/auth/EnvironmentAuth.ts";
import * as Projects from "../../server/src/project/ProjectService.ts";
import * as Registry from "../../../packages/plugin-host-adapter/src/PluginRegistry.ts";
import {
  startEnvironment,
  makeClient,
  origin,
} from "../../server/src/plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../../server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { takenEdges } from "../../../packages/plugin-workflows/src/web/run.ts";

const binding = vi.hoisted(() => ({
  configs: new Map<string, ServerConfig>(),
  contexts: new Map<string, Context.Context<Supervisor.EnvironmentSupervisor>>(),
  prepared: new Map<string, Atom.Writable<Option.Option<boolean>>>(),
  runDelivery: new Map<string, (run: Run) => Promise<void>>(),
}));

// Bind the production client to each test environment's authenticated server session.
vi.mock("../src/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const Schema = await import("effect/Schema");
  const { Run } = await import("@t3tools/plugin-workflows/contracts");
  const isRun = Schema.is(Run);
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
                  return Stream.concat(
                    Stream.provideContext(stream, context).pipe(
                      Stream.tap((value) => {
                        const deliver = binding.runDelivery.get(environmentId);
                        return deliver && isRun(value)
                          ? Effect.promise(() => deliver(value))
                          : Effect.void;
                      }),
                    ),
                    Stream.never,
                  );
                }),
              ),
          });
        }),
      ).pipe(Layer.merge(FetchHttpClient.layer)),
    ),
  };
});
// Hover popups need a DOM; the header's action button is what these tests drive.
vi.mock("../src/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ render }: { render: unknown }) => render,
  TooltipPopup: () => null,
}));
// Overlays portal into a document, which this node harness lacks. Swap them for in-place
// doubles that keep the role, accessible name and blocker wiring the plugin flows rely on.
vi.mock("../src/plugins/design", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/design")>();
  const { useBlocker } = await import("@tanstack/react-router");
  const Dialog: typeof actual.pluginDesign.Dialog = ({
    open,
    title,
    description,
    children,
    footer,
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{title}</p>
        {description === undefined ? null : <p>{description}</p>}
        {children}
        {footer}
      </div>
    ) : null;
  const NavigationGuard: typeof actual.pluginDesign.NavigationGuard = ({
    when,
    title,
    description,
    onDiscard,
    keepLabel,
  }) => {
    const blocker = useBlocker({ shouldBlockFn: () => when, withResolver: true });
    const { Button } = actual.pluginDesign;
    return blocker.status === "blocked" ? (
      <div role="alertdialog" aria-label={title}>
        <p>{title}</p>
        {description === undefined ? null : <p>{description}</p>}
        <Button onClick={() => blocker.reset?.()}>Keep editing</Button>
        {keepLabel === undefined ? null : (
          <Button onClick={() => blocker.proceed?.()}>{keepLabel}</Button>
        )}
        <Button
          onClick={() => {
            onDiscard?.();
            blocker.proceed?.();
          }}
        >
          Discard
        </Button>
      </div>
    ) : null;
  };
  const Tooltip: typeof actual.pluginDesign.Tooltip = ({ children }) => children;
  return {
    ...actual,
    pluginDesign: { ...actual.pluginDesign, Dialog, NavigationGuard, Tooltip },
  };
});

vi.mock("../src/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family((environmentId: string) => {
        const value = Atom.make<Option.Option<boolean>>(Option.some(true));
        binding.prepared.set(environmentId, value);
        return value;
      }),
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
import { PluginProjectActions } from "../src/plugins/PluginSlots";
import { validatePluginSearch } from "../src/plugins/pageLink";
import { availableCatalogAtom } from "../src/plugins/runtime";
import { AppAtomRegistryProvider, appAtomRegistry } from "../src/rpc/atomRegistry";

const projectId = ProjectId.make("same-project");
const HEAD = "a".repeat(40);
const sequence = (revision: number, title: string) => ({
  version: 1,
  id: "sequence",
  revision,
  title,
  entry: "work",
  atLimit: "review",
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
});
// The pull request head the replayed forge reports; a review freezes the value it saw.
const forge = { head: HEAD };
const verdict = {
  fields: [{ name: "verdict", type: "enum", required: true, values: ["pass", "changes"] }],
};
const direct = {
  ...sequence(1, "Quick change"),
  id: "quick",
  atLimit: "done",
  nodes: [
    { ...sequence(1, "").nodes[0], next: { to: "done" } },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
  ],
};
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
      branches: [
        {
          id: "code",
          title: "Code",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          instruction: "Review the code",
          report: verdict,
        },
      ],
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
let checkExecutions = 0;
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
          // Replay only command execution; routing, receipts and persisted results stay real.
          execute: () =>
            Effect.sync(() => {
              checkExecutions++;
              return { exitCode: 0, timedOut: false, stdout: "check passed", stderr: "" };
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

/** Records requests and subscription deliveries so the test awaits exact milestones. */
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
  // Deliveries of the currently open run-history subscription only.
  let listed: ReadonlyArray<{ readonly id: string; readonly state: string }> | undefined;
  const listWaiters: Array<{
    predicate: (runs: NonNullable<typeof listed>) => boolean;
    resolve: () => void;
  }> = [];
  const permissionWaiters: Array<(value: WorkflowPermissions) => void> = [];
  let openSubscriptions = 0;
  const release = (close: () => void) => {
    openSubscriptions++;
    return () => {
      openSubscriptions--;
      close();
    };
  };
  let loseNextStart = false;
  let failNextStart: Error | null = null;
  let launches = 0;
  // Open run subscriptions' error callbacks, to deliver a stream failure after loading.
  const runErrors = new Set<(message: string) => void>();
  let link: ThreadLink | null | undefined;
  const linkWaiters: Array<{
    predicate: (link: ThreadLink | null) => boolean;
    resolve: () => void;
  }> = [];
  let beforeCancel: (() => Promise<void>) | null = null;
  let runRequest: Parameters<WorkflowClient["watchRun"]>[0] | null = null;
  const wrapped: WorkflowClient = {
    ...client,
    subscribePermissions: (listener) =>
      client.subscribePermissions((value) => {
        listener(value);
        for (const waiter of permissionWaiters.splice(0)) waiter(value);
      }),
    projects: () => record("projects", client.projects()),
    library: (input) => record("library", client.library(input)),
    runs: (input) => record("runs", client.runs(input)),
    preview: (input) => record("preview", client.preview(input)),
    watchThread: (input, onLink, onError) => {
      link = undefined;
      return release(
        client.watchThread(
          input,
          (value) => {
            onLink(value);
            link = value;
            for (const waiter of linkWaiters.filter((item) => item.predicate(value))) {
              linkWaiters.splice(linkWaiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          },
          onError,
        ),
      );
    },
    startSaved: (input) => {
      launches++;
      // The registry refuses before the service could consult the stored result.
      const failure = failNextStart;
      failNextStart = null;
      if (failure) return record("launch", Promise.reject(failure));
      return record(
        "launch",
        client.startSaved(input).then((run) => {
          // The server committed the start, but its response is lost on the way back.
          if (loseNextStart) {
            loseNextStart = false;
            throw new Error("The connection closed before the response arrived.");
          }
          return run;
        }),
      );
    },
    cancel: (input) => {
      // Another actor's change may commit first, leaving this request's revision stale.
      const before = beforeCancel;
      beforeCancel = null;
      return record(
        "cancel",
        (before ? before() : Promise.resolve()).then(() => client.cancel(input)),
      );
    },
    gate: (input) => record("gate", client.gate(input)),
    subscribeRuns: (id, onRuns, onError) => {
      listed = undefined;
      return release(
        client.subscribeRuns(
          id,
          (value) => {
            onRuns(value);
            listed = value;
            for (const waiter of listWaiters.filter((item) => item.predicate(value))) {
              listWaiters.splice(listWaiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          },
          onError,
        ),
      );
    },
    watchRun: (input, onRun, onError, onWaiting) => {
      runRequest = input;
      runs = [];
      runErrors.add(onError);
      const close = release(
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
          onWaiting,
        ),
      );
      return () => {
        runErrors.delete(onError);
        close();
      };
    },
  };
  return {
    client: wrapped,
    runRequest: () => {
      if (runRequest === null) throw new Error("Expected an open run subscription");
      return runRequest;
    },
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
    /** Resolves once the view's latest run delivery matches. */
    run: async (predicate: (run: Run) => boolean) => {
      const latest = runs.at(-1);
      if (latest === undefined || !predicate(latest))
        await new Promise<void>((resolve) => runWaiters.push({ predicate, resolve }));
      await act(async () => {});
    },
    /** Reload proof waits for a new delivery, rather than the previous tracked snapshot. */
    forgetRuns: () => {
      runs = [];
    },
    /** Resolves once the open run-history subscription's latest delivery matches. */
    listed: async (predicate: (runs: NonNullable<typeof listed>) => boolean) => {
      if (listed === undefined || !predicate(listed))
        await new Promise<void>((resolve) => listWaiters.push({ predicate, resolve }));
      await act(async () => {});
    },
    permissions: (predicate: (value: WorkflowPermissions) => boolean) =>
      new Promise<void>((resolve) => {
        const check = (value: WorkflowPermissions) =>
          predicate(value) ? resolve() : permissionWaiters.push(check);
        permissionWaiters.push(check);
      }),
    /** Holds the next Cancel until the returned release runs, after another change commits. */
    holdNextCancel: () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeCancel = () => held;
      return () => release();
    },
    /** Resolves once the open thread-link subscription's latest delivery matches. */
    link: async (predicate: (link: ThreadLink | null) => boolean) => {
      if (link === undefined || !predicate(link))
        await new Promise<void>((resolve) => linkWaiters.push({ predicate, resolve }));
      await act(async () => {});
    },
    /** Delivers a stream failure to the open run views after they loaded. */
    failRunStream: (message: string) =>
      act(async () => {
        // Later waits need a delivery from the resubscribed stream.
        runs = [];
        for (const onError of runErrors) onError(message);
      }),
    failNextStart: (error: Error) => {
      failNextStart = error;
    },
    launches: () => launches,
    loseNextStart: () => {
      loseNextStart = true;
    },
    openSubscriptions: () => openSubscriptions,
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
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets queued socket messages land, not a wait for time
const flush = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
const displayedTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

it.live(
  "starts, inspects and decides a workflow run through the hosted pages on the selected environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        // The real graph needs window keyboard listeners; this renderer invents no DOM geometry.
        vi.stubGlobal("window", new EventTarget());
        vi.stubGlobal("cancelAnimationFrame", () => {});
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
        const environments = yield* Effect.forEach(
          ["Workstation", "Workstation (2)"],
          (label, index) =>
            Effect.gen(function* () {
              const config = {
                ...(yield* makeReplayServerConfig(`workflow-run-${index}`)),
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
              const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
                Stream.runHead,
              );
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
        const [first, second] = environments as [
          (typeof environments)[number],
          (typeof environments)[number],
        ];
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
        yield* fs.writeFileString(
          `${first.directory}/sequence.yaml`,
          Yaml.stringify(sequence(1, "Implement and review")),
        );
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
        const toasts: Array<string> = [];
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
            // Transient outcomes are host toasts; record them instead of rendering a toaster.
            design: { toast: (toast) => void toasts.push(toast.title) },
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
        const rerender = () =>
          act(async () =>
            renderer!.update(
              <RouterContextProvider router={router}>
                <Harness />
              </RouterContextProvider>,
            ),
          );
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
        const graphBox = (id: string) =>
          root().find((node) => node.type === "button" && node.props.id === stepButtonId(id));
        const graphEdge = (id: string) => {
          const canvas = root().find(
            (node) =>
              node.props["aria-label"] === "Workflow graph" && Array.isArray(node.props.edges),
          );
          const edges: ReadonlyArray<{
            readonly id: string;
            readonly data: { readonly taken: boolean };
          }> = canvas.props.edges;
          const edge = edges.find((edge) => edge.id === id);
          if (edge === undefined) throw new Error(`No graph edge for ${id}`);
          return edge;
        };
        const selectGraphBox = (id: string) =>
          act(async () => {
            let target: ReactTestInstance | null = graphBox(id);
            // Graph buttons bubble to the real React Flow node wrapper's selection handler.
            while (target !== null && typeof target.props.onClick !== "function")
              target = target.parent;
            if (target === null) throw new Error(`No graph selection handler for ${id}`);
            target.props.onClick({});
          });
        // Host popups (combobox, segmented switch, breadcrumb) are driven through the same
        // handlers the host controls call.
        const choose = (key: string, value: string) =>
          act(async () => control(pluginDesign.Combobox, key).props.onChange(value));
        const toggle = (key: string, value: string) =>
          act(async () => control(pluginDesign.SegmentedControl, key).props.onChange(value));
        const crumb = (label: string) =>
          act(async () =>
            root()
              .find((node) => node.type === pluginDesign.PageHeader)
              .props.breadcrumb.find((item: { label: string }) => item.label === label)
              .onSelect(),
          );
        const runRows = () =>
          root().findAll(
            (node) =>
              node.type === pluginDesign.ListRow &&
              String(node.props.openLabel).startsWith("Open run "),
          );
        const labelled = (label: string) =>
          root().findAll(
            (node) => node.props["aria-label"] === label && typeof node.type === "string",
          );
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

        // Library entry point: Run opens the shared start dialog in place with the saved workflow.
        yield* promise(mount);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => click("Run Implement and review"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => tracked.settle("preview"));
        expect(router.state.location.pathname).toContain("workflows.library");
        const libraryDialog = page();
        expect(libraryDialog).toContain("Run workflow");
        expect(libraryDialog).toContain("Saved revision 1");
        expect(libraryDialog).toContain("Work: Codex · gpt-5.4 · approval-required");
        expect(libraryDialog).toContain(`From main at ${HEAD.slice(0, 12)}`);
        expect(
          labelled("Run workflow").filter((node) => node.props.role === "dialog"),
        ).toHaveLength(1);
        // A read-only pairing cannot start until operate access is granted.
        expect(libraryDialog).toContain("This connection cannot start workflows.");
        expect(buttons("Run workflow").at(-1)!.props.disabled).toBe(true);
        // Cancel keeps the library where it was.
        yield* promise(() => click("Cancel"));
        expect(
          labelled("Run workflow").filter((node) => node.props.role === "dialog"),
        ).toHaveLength(0);
        expect(router.state.location.pathname).toContain("workflows.library");

        // The chat header's project action opens the dialog in place and keeps it, with its
        // typed text, through a connection drop.
        {
          let header!: ReactTestRenderer;
          yield* promise(() =>
            act(async () => {
              header = create(
                <AppAtomRegistryProvider>
                  <RouterContextProvider router={router}>
                    <PluginProjectActions
                      environmentId={first.environmentId}
                      projectId={projectId}
                    />
                  </RouterContextProvider>
                </AppAtomRegistryProvider>,
              );
            }),
          );
          yield* promise(flush);
          const headerDialogs = () =>
            header.root.findAll(
              (node) =>
                node.props["aria-label"] === "Run workflow" &&
                typeof node.type === "string" &&
                node.props.role === "dialog",
            );
          const prepared = binding.prepared.get(first.environmentId);
          if (prepared === undefined) throw new Error("Expected the mounted header connection");
          // The mounted header subscribes to the catalog stream; wait for its first snapshot.
          yield* promise(
            () =>
              new Promise<void>((resolve) => {
                const release = appAtomRegistry.subscribe(
                  availableCatalogAtom(first.environmentId),
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
          yield* promise(flush);
          yield* promise(() =>
            act(async () =>
              header.root
                .findAll(
                  (node) => node.props["aria-label"] === "Run workflow" && node.props.onClick,
                )
                .at(0)!
                .props.onClick(),
            ),
          );
          yield* promise(flush);
          expect(headerDialogs()).toHaveLength(1);
          expect(router.state.location.pathname).toContain("workflows.library");
          yield* promise(flush);
          yield* promise(() =>
            act(async () =>
              header.root
                .find(
                  (node) => node.type === pluginDesign.Textarea && node.props.ariaLabel === "Task",
                )
                .props.onChange("keep this text"),
            ),
          );
          appAtomRegistry.set(prepared, Option.none());
          yield* promise(flush);
          expect(headerDialogs()).toHaveLength(1);
          expect(
            header.root.find(
              (node) => node.type === pluginDesign.Textarea && node.props.ariaLabel === "Task",
            ).props.value,
          ).toBe("keep this text");
          appAtomRegistry.set(prepared, Option.some(true));
          yield* promise(flush);
          yield* promise(() =>
            act(async () =>
              header.root
                .find((node) => node.type === pluginDesign.Button && textOf(node) === "Cancel")
                .props.onClick(),
            ),
          );
          expect(headerDialogs()).toHaveLength(0);
          expect(router.state.location.pathname).toContain("workflows.library");
          yield* promise(() => act(async () => header.unmount()));
        }

        // Project entry point: the same dialog and service, choosing the workflow explicitly.
        // The chat header opens its dialog in place; its link is the Runs page deep link.
        const projectAction = workflowsWeb.projectActions.find(
          (item) => item.id === "workflows.project-run",
        )!;
        expect(projectAction.dialog).toBeDefined();
        const link = projectAction.link(projectId);
        expect(link).toEqual({ pageId: "workflows.runs", projectId, state: { start: "1" } });
        yield* promise(() => go(first.environmentId, link.pageId, link.state));
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => tracked.listed((runs) => runs.length === 0));
        expect(page()).toContain("No runs yet");
        expect(control(pluginDesign.Combobox, "Workflow").props.value).toBe("");
        yield* promise(() => choose("Workflow", "sequence"));
        yield* promise(() => tracked.settle("preview"));
        expect(page()).toContain("Saved revision 1");
        const granted = tracked.permissions((value) => value.start && value.cancel && value.gate);
        yield* first.grantWrite;
        yield* promise(() => granted);
        yield* promise(flush);
        yield* promise(() => toggle("Workspace", "current"));
        yield* promise(() => write("Task", "Ship the release notes"));
        expect(page()).toContain("Works in");

        // The start commits but its response is lost: the intent and its input are retained.
        tracked.loseNextStart();
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        expect(page()).toContain("The start request did not complete");
        const intents = [...storage.values.keys()].filter((key) => key.includes(":entry:start"));
        expect(intents).toHaveLength(1);
        expect(control(pluginDesign.Textarea, "Task").props.value).toBe("Ship the release notes");
        expect(button("Retry start request").props.disabled, "retry-start").toBe(false);

        // The workflow is edited, then the page reloads: the retained intent reconciles to the
        // committed run instead of starting a second one from the new revision.
        yield* fs.writeFileString(
          `${first.directory}/sequence.yaml`,
          Yaml.stringify(sequence(2, "Implement and review v2")),
        );
        yield* promise(unmount);
        expect(tracked.openSubscriptions()).toBe(0);
        yield* promise(mount);
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        const runId = (router.state.location.search as { pluginState?: { run?: string } })
          .pluginState?.run;
        expect(runId).toMatch(/^workflow-/);
        expect([...storage.values.keys()].filter((key) => key.includes(":entry:start"))).toEqual(
          [],
        );
        const listed = (yield* first.invoke("list", scope)) as ReadonlyArray<{ id: string }>;
        expect(listed.map((run) => run.id)).toEqual([runId]);

        // The run view: persisted snapshot, start source, workspace and allowed actions.
        yield* promise(() => tracked.run((run) => run.id === runId));
        // The overview keeps full metadata available alongside its compact desktop values.
        const tip = (content: string) =>
          root().findAll(
            (node) => node.type === pluginDesign.Tooltip && node.props.label === content,
          );
        expect(page()).toContain("Manual · sequence.yaml");
        expect(tip("Manual · .t3code/workflows/sequence.yaml")).toHaveLength(1);
        expect(tip("sequence · revision 1")).toHaveLength(1);
        expect(page()).toContain("Current checkout");
        expect(page()).toContain("Cancel run");
        // The run always opens its actual read-only graph, even without layout APIs.
        expect(labelled("Workflow graph")).toHaveLength(1);
        expect(page()).not.toContain("Routes");
        const snapshotBeforeKeys = (yield* first.invoke("get", { ...scope, runId })) as Run;
        yield* promise(() =>
          act(async () => {
            for (const key of ["ArrowUp", "ArrowDown", "Delete", "Backspace"])
              graphBox("work").props.onKeyDown({
                key,
                altKey: true,
                preventDefault: () => {
                  throw new Error("A read-only graph must not handle authoring shortcuts");
                },
              });
          }),
        );
        expect(((yield* first.invoke("get", { ...scope, runId })) as Run).definition).toEqual(
          snapshotBeforeKeys.definition,
        );
        yield* promise(() => selectGraphBox("work"));
        expect(router.state.location.search).toMatchObject({
          pluginProjectId: projectId,
          pluginState: { run: runId, node: "work" },
        });
        yield* reconcile;
        yield* promise(() => tracked.run((run) => run.attempts[0]?.phase === "running"));
        const running = (yield* first.invoke("get", { ...scope, runId })) as Run;
        const threadId = running.attempts[0]!.threadId!;
        expect(running.input).toEqual({ task: "Ship the release notes" });
        // A persisted start time remains truthful even when this view stays open overnight.
        expect(textOf(labelled("Run overview")[0]!)).toContain(displayedTime(running.createdAt));

        // An accepted report while execution still runs is a claim, not a finished step.
        const reportTool = (yield* first.registry.tools).find(
          (item) => item.tool.id === "plugin_workflows_report",
        )!;
        yield* reportTool.tool.invoke(
          {
            version: 1,
            clientRetryKey: "report",
            outcome: "completed",
            summary: "Notes drafted",
            data: { ready: true },
            evidence: [{ kind: "file", reference: "NOTES.md" }],
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
        yield* promise(() => tracked.run((run) => run.attempts[0]?.phase === "reported"));
        yield* promise(() => toggle("Run view", "steps"));
        yield* promise(() => click("Visit 1: Work, Execution still running"));
        yield* promise(flush);
        expect(router.state.location.search).toMatchObject({
          pluginState: { run: runId, node: "work", attempt: running.attempts[0]!.id },
        });
        const evidence = page();
        expect(evidence).toContain("Report accepted (completed claim)");
        expect(evidence).toContain("Execution still running");
        expect(evidence).toContain("Agent report");
        expect(evidence).toContain("completed claim");
        expect(evidence).toContain("file: NOTES.md");
        expect(evidence).toContain("Not routed yet");

        // The native thread shows its owning run and links back to the exact attempt.
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: first.environmentId, threadId },
            });
          }),
        );
        const threadRoute = (id: string) =>
          act(async () => {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: first.environmentId, threadId: ThreadId.make(id) },
            });
          });
        yield* promise(() => tracked.link((link) => link?.phase === "reported"));
        expect(page()).toContain("Implement and review · Work");
        expect(page()).toContain("report accepted");

        // The strip follows its run: settlement updates it without reopening the thread.
        const state = threads.get(threadId)!;
        threads.set(threadId, {
          ...state,
          runs: state.runs.map((run) => ({ ...run, status: "completed" })),
        });
        yield* reconcile;
        yield* promise(() => tracked.link((link) => link?.phase === "completed"));
        expect(page()).toContain(
          "Completed · report accepted · later messages are not part of this attempt",
        );

        // Switching to an ordinary thread clears the strip at once, before its lookup answers,
        // and stays clear when the lookup answers that no workflow owns it.
        yield* promise(() => threadRoute("plain-thread"));
        expect(buttons("Open workflow run")).toHaveLength(0);
        yield* promise(() => tracked.link((link) => link === null));
        expect(buttons("Open workflow run")).toHaveLength(0);
        // Disconnected, no lookup runs and the previous thread's link is not carried over.
        yield* promise(() => threadRoute(threadId));
        yield* promise(() => tracked.link((link) => link?.runId === runId));
        connections.set(first.environmentId, "disconnected");
        yield* promise(rerender);
        // Without a live subscription the same thread's link is marked as possibly outdated.
        expect(page()).toContain("Last loaded state");
        expect(buttons("Open workflow run")).toHaveLength(1);
        yield* promise(() => threadRoute("plain-thread"));
        expect(buttons("Open workflow run")).toHaveLength(0);
        connections.delete(first.environmentId);
        yield* promise(() => threadRoute(threadId));
        yield* promise(() => tracked.link((link) => link?.runId === runId));
        yield* promise(() => click("View route"));
        yield* promise(flush);
        expect(router.state.location.search).toMatchObject({
          pluginProjectId: projectId,
          pluginState: {
            run: runId,
            node: "work",
            attempt: running.attempts[0]!.id,
            focus: "route",
          },
        });
        yield* promise(() => tracked.run((run) => run.id === runId));

        // Settlement routed to the human gate; the decision is bound to its displayed revision.
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        expect(page()).toContain("Needs your decision");
        // The decision alert carries the next action; the overview does not repeat it.
        expect(buttons("Approve")).toHaveLength(1);
        expect(page()).not.toContain("Decide on the human gate");
        expect(page()).toContain("Work → Human review");
        // A plain Next route carries no route badge in the history.
        expect(
          root().findAll((node) => node.type === pluginDesign.Badge && textOf(node) === "next"),
        ).toHaveLength(0);

        // A failed run subscription keeps the snapshot visibly stale with actions held; Retry
        // resubscribes and reloads the run.
        yield* promise(() => tracked.failRunStream("The run subscription ended."));
        expect(page()).toContain("Not updating");
        expect(page()).toContain("The run subscription ended.");
        expect(button("Approve").props.disabled).toBe(true);
        // Hold real RPC snapshots before the production adapter, with an independent live
        // consumer retaining the same request's prior success. Cached state cannot reconcile us.
        const peerReady = Promise.withResolvers<void>();
        const releasePeer = createWorkflowsClient(first.environmentId).watchRun(
          tracked.runRequest(),
          () => peerReady.resolve(),
          (message) => peerReady.reject(new Error(message)),
        );
        yield* Effect.addFinalizer(() => Effect.sync(releasePeer));
        yield* promise(() => peerReady.promise);
        const held = new Set<() => void>();
        const holdRunDelivery = () => {
          const captured = Promise.withResolvers<Run>();
          const released = Promise.withResolvers<void>();
          const release = () => {
            binding.runDelivery.delete(first.environmentId);
            released.resolve();
            held.delete(release);
          };
          held.add(release);
          binding.runDelivery.set(first.environmentId, async (run) => {
            captured.resolve(run);
            await released.promise;
          });
          return { captured: captured.promise, release };
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const release of held) release();
          }),
        );
        const retryDelivery = holdRunDelivery();
        yield* promise(() => click("Retry"));
        expect(
          button("Approve").props.disabled,
          "Replacement run must reconcile before approval",
        ).toBe(true);
        yield* promise(() => retryDelivery.captured);
        expect(page()).toContain("Not updating");
        expect(button("Cancel run").props.disabled).toBe(true);
        retryDelivery.release();
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        expect(page()).not.toContain("Not updating");
        expect(button("Approve").props.disabled, "approve-1").toBe(false);

        // Disconnected: the last snapshot stays visible, decisions wait for reconnection.
        connections.set(first.environmentId, "disconnected");
        yield* promise(rerender);
        expect(page()).toContain("Last loaded state");
        expect(button("Approve").props.disabled).toBe(true);
        expect(page()).toContain("Actions wait until this environment reconnects");
        const reconnectDelivery = holdRunDelivery();
        connections.delete(first.environmentId);
        yield* promise(rerender);
        expect(button("Approve").props.disabled, "Reconnect must reconcile before approval").toBe(
          true,
        );
        yield* promise(() => reconnectDelivery.captured);
        expect(page()).toContain("Not updating");
        expect(button("Cancel run").props.disabled).toBe(true);
        reconnectDelivery.release();
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        expect(button("Approve").props.disabled, "approve-2").toBe(false);
        releasePeer();
        // Catalog replacement reevaluates a live atom with a retained waiting Success.
        // Its old envelope cannot become a delivery of the new stream generation.
        const refreshReady = Promise.withResolvers<void>();
        const refreshWaiting = Promise.withResolvers<void>();
        const refreshReceived = Promise.withResolvers<Run>();
        let refreshing = false;
        let freshReceived = false;
        const releaseRefresh = createWorkflowsClient(first.environmentId).watchRun(
          tracked.runRequest(),
          (value) => {
            if (refreshing) {
              freshReceived = true;
              refreshReceived.resolve(value);
            } else refreshReady.resolve();
          },
          (message) => refreshReceived.reject(new Error(message)),
          () => {
            if (refreshing) refreshWaiting.resolve();
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseRefresh));
        yield* promise(() => refreshReady.promise);
        const refreshDelivery = holdRunDelivery();
        refreshing = true;
        const currentPrepared = binding.prepared.get(first.environmentId);
        if (currentPrepared === undefined) throw new Error("Expected the current gate connection");
        yield* promise(() => act(async () => appAtomRegistry.set(currentPrepared, Option.none())));
        yield* promise(() => refreshWaiting.promise);
        expect(freshReceived).toBe(false);
        yield* promise(() =>
          act(async () => appAtomRegistry.set(currentPrepared, Option.some(true))),
        );
        yield* promise(() => refreshDelivery.captured);
        expect(freshReceived, "A retained waiting value is not a new stream delivery").toBe(false);
        refreshDelivery.release();
        const refreshed = yield* promise(() => refreshReceived.promise);
        expect(refreshed.id).toBe(runId);
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        releaseRefresh();
        yield* promise(() => click("Approve"));
        yield* promise(() => tracked.settle("gate"));
        yield* promise(() => tracked.run((run) => run.state === "completed"));
        expect(toasts).toContain("Approve applied");
        // A finished run has no next action, so the overview names none.
        expect(
          root().findAll((node) => node.type === "dt" && textOf(node) === "Next"),
        ).toHaveLength(0);
        expect(page()).not.toContain("Cancel run");

        // Run again from the project: a new intent whose response is lost reconciles by itself
        // once the environment reconnects.
        yield* fs.writeFileString(`${first.directory}/quick.yaml`, Yaml.stringify(direct));
        yield* promise(() => click("Run workflow"));
        yield* promise(flush);
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => choose("Workflow", "quick"));
        yield* promise(() => tracked.settleLatest("preview"));
        // The registry refuses before the service could consult a stored result: the intent and
        // its identity are kept rather than released for a possibly duplicate start.
        tracked.failNextStart(
          new PluginError({
            pluginId: "workflows",
            operation: "plugins.workflows.launch",
            code: "unavailable",
            message: "This plugin API is unavailable in the selected environment.",
          }),
        );
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        expect(page()).toContain("The start request did not complete");
        expect(page()).toContain("This plugin API is unavailable in the selected environment.");
        expect(
          [...storage.values.keys()].filter((key) => key.includes(":entry:start")),
        ).toHaveLength(1);
        // Opening Run for another workflow shows the pending request instead of resending it.
        const sent = tracked.launches();
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", { start: "1", workflow: "sequence" }),
        );
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        yield* promise(flush);
        expect(tracked.launches()).toBe(sent);
        expect(page()).toContain("Unconfirmed start of quick (revision 1)");
        // Reopened for its own workflow, the intent is resent; this response is lost too.
        tracked.loseNextStart();
        yield* promise(() => go(first.environmentId, "workflows.runs", { start: "1" }));
        yield* promise(() => tracked.settle("launch"));
        expect(tracked.launches()).toBe(sent + 1);
        expect(page()).toContain("The start request did not complete");
        connections.set(first.environmentId, "disconnected");
        yield* promise(rerender);
        expect(page()).toContain("Starting waits until this environment reconnects.");
        connections.delete(first.environmentId);
        yield* promise(rerender);
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        const quickId = (router.state.location.search as { pluginState?: { run?: string } })
          .pluginState?.run;
        expect(quickId).toMatch(/^workflow-/);
        expect(quickId).not.toBe(runId);
        expect([...storage.values.keys()].filter((key) => key.includes(":entry:start"))).toEqual(
          [],
        );
        const quickRuns = (yield* first.invoke("list", scope)) as ReadonlyArray<{
          definition: { id: string };
        }>;
        expect(quickRuns.filter((run) => run.definition.id === "quick")).toHaveLength(1);

        // Cancel races natural completion: the completion commits first, so the Cancel decided
        // on the displayed revision is refused and the page shows the run's actual outcome.
        yield* reconcile;
        yield* promise(() =>
          tracked.run((run) => run.id === quickId && run.attempts[0]?.phase === "running"),
        );
        const quick = (yield* first.invoke("get", { ...scope, runId: quickId })) as Run;
        const quickThread = quick.attempts[0]!.threadId!;
        yield* reportTool.tool.invoke(
          {
            version: 1,
            clientRetryKey: "quick",
            outcome: "completed",
            summary: "Done",
            data: { ready: true },
            evidence: [],
          },
          {
            environmentId: first.environmentId,
            projectId,
            threadId: quickThread,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "native-session",
            runtimeMode: "approval-required",
          },
        );
        yield* promise(() => tracked.run((run) => run.attempts[0]?.phase === "reported"));
        const releaseCancel = tracked.holdNextCancel();
        yield* promise(() => click("Cancel run"));
        const settled = threads.get(quickThread)!;
        threads.set(quickThread, {
          ...settled,
          runs: settled.runs.map((run) => ({ ...run, status: "completed" })),
        });
        yield* reconcile;
        releaseCancel();
        yield* promise(() => tracked.settle("cancel"));
        yield* promise(() => tracked.run((run) => run.state === "completed"));
        expect(page()).toContain("Cancel run not applied");
        expect(page()).toContain("The run revision changed. Reload before deciding.");
        // The run's own end step shows the outcome, not only the header badge.
        const endStep = graphBox("done");
        expect(textOf(endStep)).toContain("Completed");
        expect(buttons("Cancel run")).toHaveLength(0);

        // A gate decision on a frozen review whose pull request head moved is not applied.
        yield* fs.writeFileString(`${first.directory}/review.yaml`, Yaml.stringify(review));
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", { start: "1", workflow: "review" }),
        );
        yield* promise(() => tracked.settleLatest("library"));
        yield* promise(() => tracked.settleLatest("preview"));
        expect(page()).toContain(
          "Reviewers · Code: Codex · gpt-5.4 · approval-required · plan mode",
        );
        yield* promise(() => act(async () => buttons("Run workflow").at(-1)!.props.onClick()));
        yield* promise(() => tracked.settle("launch"));
        yield* promise(flush);
        const reviewId = (router.state.location.search as { pluginState?: { run?: string } })
          .pluginState?.run;
        yield* reconcile;
        yield* promise(() =>
          tracked.run((run) => run.id === reviewId && run.attempts[0]?.phase === "running"),
        );
        const reviewing = (yield* first.invoke("get", { ...scope, runId: reviewId })) as Run;
        const reviewThread = reviewing.attempts[0]!.threadId!;
        yield* promise(() => selectGraphBox("reviews/code"));
        expect(router.state.location.search).toMatchObject({
          pluginProjectId: projectId,
          pluginState: { run: reviewId, node: "reviews", branch: "code" },
        });
        // A launched lane has not reached its join while native execution is still active.
        expect(reviewing.overview?.review).toMatchObject({
          required: 1,
          reported: 0,
          settled: 0,
          result: null,
        });
        expect(reviewing.trace).toEqual([]);
        expect(graphEdge("reviews/code->join").data.taken).toBe(false);
        expect(graphEdge("join:rules.0").data.taken).toBe(false);
        yield* reportTool.tool.invoke(
          {
            version: 1,
            clientRetryKey: "review",
            outcome: "completed",
            summary: "Looks good",
            data: { verdict: "pass" },
            evidence: [],
          },
          {
            environmentId: first.environmentId,
            projectId,
            threadId: reviewThread,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "native-session",
            runtimeMode: "approval-required",
          },
        );
        yield* promise(() =>
          tracked.run((run) => run.id === reviewId && run.attempts[0]?.phase === "reported"),
        );
        const reportedReview = (yield* first.invoke("get", { ...scope, runId: reviewId })) as Run;
        expect(reportedReview.state).toBe("running");
        expect(reportedReview.attempts[0]?.phase).toBe("reported");
        expect(reportedReview.overview?.review).toMatchObject({
          required: 1,
          reported: 1,
          settled: 0,
          result: null,
        });
        expect(reportedReview.trace).toEqual([]);
        expect(reportedReview.allowedActions).not.toContain("approve");
        expect(page()).toContain("Execution still running");
        expect(page()).toContain("Report accepted (completed claim)");
        expect(page()).toContain("Not routed yet");
        expect(textOf(graphBox("reviews/code"))).toContain("Reported");
        expect(graphEdge("reviews/code->join").data.taken).toBe(false);
        expect(graphEdge("join:rules.0").data.taken).toBe(false);
        const reviewed = threads.get(reviewThread)!;
        threads.set(reviewThread, {
          ...reviewed,
          runs: reviewed.runs.map((run) => ({ ...run, status: "completed" })),
        });
        yield* reconcile;
        yield* promise(() => tracked.run((run) => run.state === "awaiting-review"));
        expect(page()).toContain("reviews 1/1 reported, 1/1 settled");
        expect(page()).toContain(`reviewed head ${forge.head.slice(0, 12)}`);
        // Only real terminal provider settlement and the persisted join unlock this path/gate.
        const settledReview = (yield* first.invoke("get", { ...scope, runId: reviewId })) as Run;
        expect(settledReview.attempts[0]?.phase).toBe("completed");
        expect(settledReview.overview?.review).toMatchObject({
          reported: 1,
          settled: 1,
          result: "all_completed",
        });
        expect(settledReview.currentNode).toBe("gate");
        expect(settledReview.trace).toHaveLength(1);
        expect(settledReview.trace[0]).toMatchObject({
          nodeId: "join",
          chosen: "gate",
          sourceIds: [settledReview.reviews[0]!.id, reportedReview.attempts[0]!.report!.receipt.id],
        });
        expect(graphEdge("reviews/code->join").data.taken).toBe(true);
        expect(graphEdge("join:rules.0").data.taken).toBe(true);
        expect(button("Approve").props.disabled).toBe(false);
        expect(page()).toContain("Needs your decision");
        forge.head = "d".repeat(40);
        yield* promise(() => click("Approve"));
        yield* promise(() => tracked.settle("gate"));
        yield* promise(() => tracked.run((run) => run.state === "unresolved"));
        expect(page()).toContain("Decision not applied");
        expect(page()).toContain("The pull request head changed after review.");
        expect(page()).toContain("Unresolved");

        // An accepted completed claim remains distinct from failed native settlement.
        forge.head = HEAD;
        const failedReview = (yield* first.invoke("launch", {
          ...scope,
          clientRequestId: "failed-review",
          definitionId: "review",
          revision: 1,
          task: "Inspect unsuccessful reviewer settlement",
          workspace: "current",
        })) as Run;
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", { run: failedReview.id, node: "reviews" }),
        );
        yield* reconcile;
        const admittedReview = (yield* first.invoke("get", {
          ...scope,
          runId: failedReview.id,
        })) as Run;
        expect(admittedReview.attempts[0]?.phase).toBe("running");
        yield* promise(() =>
          tracked.run((run) => run.id === failedReview.id && run.attempts[0]?.phase === "running"),
        );
        expect(admittedReview.overview?.review).toMatchObject({
          required: 1,
          reported: 0,
          settled: 0,
          result: null,
        });
        expect(graphBox("reviews").props["aria-label"]).toBe("Parallel: Reviewers, 0 of 1 settled");
        const failureThread = admittedReview.attempts[0]!.threadId!;
        yield* reportTool.tool.invoke(
          {
            version: 1,
            clientRetryKey: "failed-review-report",
            outcome: "completed",
            summary: "Claim accepted before native failure",
            data: { verdict: "pass" },
            evidence: [],
          },
          {
            environmentId: first.environmentId,
            projectId,
            threadId: failureThread,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerSessionId: "native-session",
            runtimeMode: "approval-required",
          },
        );
        yield* promise(() =>
          tracked.run((run) => run.id === failedReview.id && run.attempts[0]?.phase === "reported"),
        );
        expect(graphBox("reviews").props["aria-label"]).toBe("Parallel: Reviewers, 0 of 1 settled");
        expect(graphEdge("reviews/code->join").data.taken).toBe(false);
        const failingNative = threads.get(failureThread)!;
        threads.set(failureThread, {
          ...failingNative,
          runs: failingNative.runs.map((run) => ({ ...run, status: "failed" })),
        });
        yield* reconcile;
        yield* promise(() =>
          tracked.run(
            (run) =>
              run.id === failedReview.id &&
              run.attempts[0]?.phase === "failed" &&
              run.overview?.review?.result === "failed",
          ),
        );
        const failedSnapshot = (yield* first.invoke("get", {
          ...scope,
          runId: failedReview.id,
        })) as Run;
        expect(failedSnapshot.state).toBe("unresolved");
        expect(failedSnapshot.overview?.review).toMatchObject({
          required: 1,
          reported: 1,
          settled: 1,
          result: "failed",
        });
        expect(failedSnapshot.attempts[0]).toMatchObject({
          phase: "failed",
          reason: "Native execution or checkpoint failed.",
          report: { outcome: "completed" },
        });
        expect(graphBox("reviews").props["aria-label"]).toBe("Parallel: Reviewers, 1 of 1 settled");
        expect(textOf(graphBox("reviews"))).toContain("Failed");
        expect(graphBox("reviews/code").props["aria-label"]).toBe("Reviewer: Code, Failed");
        expect(page()).toContain("reviews 1/1 reported, 1/1 settled");
        yield* promise(() => selectGraphBox("reviews/code"));
        expect(page()).toContain("ExecutionFailed");
        expect(page()).toContain("Report accepted (completed claim)");
        expect(page()).toContain("Native execution or checkpoint failed.");
        expect(failedSnapshot.trace).toHaveLength(1);
        expect(failedSnapshot.trace[0]).toMatchObject({
          nodeId: "join",
          chosen: "stop",
          considered: [{ matched: false }],
          sourceIds: [
            failedSnapshot.reviews[0]!.id,
            failedSnapshot.attempts[0]!.report!.receipt.id,
          ],
        });
        expect(graphEdge("reviews/code->join").data.taken).toBe(false);
        expect(graphEdge("join:rules.0").data.taken).toBe(false);
        expect(graphEdge("join:otherwise").data.taken).toBe(true);
        expect(failedSnapshot.allowedActions).not.toContain("approve");

        // A deep link to a visit older than the newest page opens that exact visit.
        const deep = (yield* first.invoke("launch", {
          ...scope,
          clientRequestId: "deep",
          definitionId: "quick",
          revision: 1,
          task: "",
          workspace: "current",
        })) as Run;
        // Each drain is a deterministic server milestone; a few cover launch and settlement.
        const drainUntil = (predicate: (run: Run) => boolean) =>
          Effect.gen(function* () {
            for (let drains = 0; drains < 5; drains++) {
              yield* reconcile;
              const current = (yield* first.invoke("get", { ...scope, runId: deep.id })) as Run;
              if (predicate(current)) return current;
            }
            return yield* Effect.die("The run did not reach the expected state.");
          });
        for (let visit = 1; visit <= 52; visit++) {
          const current = yield* drainUntil(
            (run) => run.overview?.visits === visit && run.attempts.at(-1)?.phase === "running",
          );
          if (visit === 52) break;
          const stopped = current.attempts.at(-1)!.threadId!;
          const native = threads.get(stopped)!;
          threads.set(stopped, {
            ...native,
            runs: native.runs.map((run) => ({ ...run, status: "interrupted" })),
          });
          const unresolved = yield* drainUntil((run) => run.state === "unresolved");
          yield* first.invoke("retry", {
            ...scope,
            runId: deep.id,
            clientRequestId: `deep-${visit}`,
            expectedRevision: unresolved.revision,
          });
        }
        const firstVisit = (
          (yield* first.invoke("get", { ...scope, runId: deep.id, historyOffset: 0 })) as Run
        ).attempts[0]!;
        yield* promise(() =>
          go(first.environmentId, "workflows.runs", { run: deep.id, attempt: firstVisit.id }),
        );
        yield* promise(() => tracked.run((run) => run.id === deep.id));
        expect(page()).toContain("Earlier visits: 1–50 of 52");
        expect(page()).toContain(firstVisit.id);
        expect(page()).toContain("Routing stopped at this visit");
        // Overview totals still describe the whole run, including its newest active visit.
        expect(page()).toContain("Progress52 visits");
        expect(page()).toContain("Active attemptsWork (Running)");

        // An old intent's run is still found from the history list, which is live.
        yield* promise(() => crumb("Runs"));
        yield* promise(() =>
          tracked.listed((runs) =>
            runs.some((run) => run.id === runId && run.state === "completed"),
          ),
        );
        expect(page()).toContain("Implement and review");
        expect(page()).toContain("Completed");

        // Older runs stay listed across the live page's boundary when a new run starts.
        const extra = (id: string) =>
          first.invoke("launch", {
            ...scope,
            clientRequestId: id,
            definitionId: "quick",
            revision: 1,
            task: "",
            workspace: "current",
          });
        let newest = "";
        for (let index = 0; index < 18; index++)
          newest = ((yield* extra(`history-${index}`)) as Run).id;
        yield* promise(() => tracked.listed((runs) => runs[0]?.id === newest));
        yield* promise(() => click("Load older runs"));
        yield* promise(() => tracked.settle("runs"));
        const live = (yield* first.invoke("list", scope)) as ReadonlyArray<{ id: string }>;
        const olderRuns = (yield* first.invoke("list", {
          ...scope,
          before: live.at(-1)!.id,
        })) as ReadonlyArray<{ id: string }>;
        expect(olderRuns.length).toBeGreaterThan(0);
        expect(runRows()).toHaveLength(live.length + olderRuns.length);
        const pushedOut = live.at(-1)!.id;
        const added = ((yield* extra("history-new")) as Run).id;
        yield* promise(() =>
          tracked.listed(
            (runs) => runs[0]?.id === added && !runs.some((run) => run.id === pushedOut),
          ),
        );
        // The run pushed out of the live page joins the older ones: listed once, none lost.
        // Every run is listed once: the new live page, the pushed-out run, and the older page.
        expect(runRows()).toHaveLength(live.length + olderRuns.length + 1);

        // The similarly named second environment has no runs and does not own the thread.
        yield* promise(() => go(second.environmentId, "workflows.runs"));
        yield* promise(() => second.tracked.settle("projects"));
        yield* promise(() => second.tracked.listed((runs) => runs.length === 0));
        expect(page()).toContain("Workstation (2)");
        expect(page()).toContain("No runs yet");
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: second.environmentId, threadId },
            });
          }),
        );
        yield* promise(() => second.tracked.link((link) => link === null));
        expect(buttons("Open workflow run")).toHaveLength(0);

        // Real manual gates cover both the rendered row and graph evidence without provider work.
        const routingDefinition = (
          id: string,
          atLimit: string,
          max = 1,
          maxVisits = 100,
        ): Definition => ({
          version: 1,
          id,
          revision: 1,
          title: "Routing evidence",
          entry: "review",
          atLimit,
          maxVisits,
          nodes: [
            {
              id: "review",
              kind: "human",
              title: "Human review",
              approve: { to: "done" },
              changes: {
                to: "work",
                repeat: { max, atLimit: atLimit === "stop" ? "done" : "review" },
              },
            },
            maxVisits === 1
              ? {
                  id: "work",
                  kind: "agent",
                  title: "Work",
                  instruction: "Do the work",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.4",
                  },
                  runtimeMode: "approval-required",
                  report: { fields: [{ name: "ready", type: "boolean", required: true }] },
                  next: { to: "review" },
                }
              : {
                  id: "work",
                  kind: "human",
                  title: "Manual work",
                  approve: { to: "review" },
                  changes: { to: "stop" },
                },
            { id: "done", kind: "end", title: "Done", outcome: "completed" },
            { id: "stop", kind: "end", title: "Stopped", outcome: "unresolved" },
          ],
        });
        const startRouting = Effect.fnUntraced(function* (definition: Definition) {
          yield* fs.writeFileString(
            `${first.directory}/${definition.id}.yaml`,
            Yaml.stringify(definition),
          );
          return yield* first
            .invoke("launch", {
              ...scope,
              clientRequestId: definition.id,
              definitionId: definition.id,
              revision: 1,
              task: "Inspect recorded routing",
              workspace: "current",
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
        });
        const decide = (run: Run, decision: "approve" | "request-changes", id: string) =>
          first
            .invoke("gate", {
              ...scope,
              runId: run.id,
              clientRequestId: id,
              expectedRevision: run.gate!.revision,
              decision,
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
        const showRouting = (run: Run) =>
          promise(async () => {
            await go(first.environmentId, "workflows.runs", { run: run.id, node: "review" });
            await tracked.run((value) => value.id === run.id && value.revision === run.revision);
          });
        // Approval shares the other route's repeat exit, but its persisted kind is ordinary.
        const ordinary = routingDefinition("ordinary-routing", "stop");
        const approved = yield* decide(
          yield* startRouting(ordinary),
          "approve",
          "ordinary-approve",
        );
        expect(approved.trace.at(-1)).toMatchObject({ chosen: "done", repeatCount: null });
        expect(approved.repeats).toEqual({});
        expect(approved.automationStopped).toBe(false);
        expect([...takenEdges(approved.definition, approved.trace)]).toEqual(["review:approve"]);
        yield* showRouting(approved);
        expect(textOf(labelled("Recorded routing")[0]!)).toContain("Human review → Done");
        expect(textOf(labelled("Recorded routing")[0]!)).not.toContain("at limit");
        expect(textOf(labelled("Recorded routing")[0]!)).not.toContain("repeat");

        // A distinct repeat exit remains identifiable after the actual second decision.
        const initialRepeat = yield* startRouting(routingDefinition("repeat-routing", "stop"));
        const workGate = yield* decide(initialRepeat, "request-changes", "repeat-first");
        const reviewGate = yield* decide(workGate, "approve", "repeat-return");
        const exhausted = yield* decide(reviewGate, "request-changes", "repeat-exhausted");
        expect(exhausted.trace.at(-1)).toMatchObject({
          chosen: "done",
          repeatCount: 1,
          reason: "The repeat limit was reached.",
        });
        expect([...takenEdges(exhausted.definition, exhausted.trace)]).toContain(
          "review:changes.repeat",
        );
        yield* showRouting(exhausted);
        expect(textOf(labelled("Recorded routing")[0]!)).toContain("at limit");

        // A gate cannot admit a route that the run bound would divert. Refusal preserves state.
        for (const max of [20, 1]) {
          const initialWhole = yield* startRouting(
            routingDefinition(`whole-routing-${max}`, "review", max, 1),
          );
          const before = yield* first
            .invoke("get", { ...scope, runId: initialWhole.id })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
          expect(before.allowedActions).toEqual(["cancel", "approve"]);
          expect(before.withheld).toEqual([
            { action: "request-changes", to: "work", repeat: true, cause: "visit-limit" },
          ]);
          const refused = yield* decide(before, "request-changes", `whole-refused-${max}`).pipe(
            Effect.flip,
          );
          expect(refused).toMatchObject({ code: "conflict", operation: "gate" });
          const unchanged = yield* first
            .invoke("get", { ...scope, runId: before.id })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
          expect(unchanged).toEqual(before);
          expect(unchanged).toMatchObject({
            state: "awaiting-review",
            trace: [],
            attempts: [],
            repeats: {},
            automationStopped: false,
          });
          yield* showRouting(unchanged);
          expect(buttons("Request changes")).toHaveLength(0);
          expect(page()).toContain(
            "Request changes unavailable · ↩ Work · run visit limit reached",
          );
          expect(button("Approve").props.disabled).toBe(false);
        }

        // Actual autonomous routes can be diverted. A real check drives each saved decision.
        const checkedRouting = (id: string, max: number, maxVisits: number): Definition => ({
          version: 1,
          id,
          revision: 1,
          title: "Autonomous routing evidence",
          entry: "checks",
          atLimit: "review",
          maxVisits,
          nodes: [
            {
              id: "checks",
              kind: "check",
              title: "Checks",
              command: "project-check",
              args: [],
              next: { to: "decide" },
            },
            {
              id: "decide",
              kind: "decision",
              title: "Check decision",
              source: "checks",
              rules: [],
              otherwise: { to: "checks", repeat: { max, atLimit: "review" } },
            },
            {
              id: "review",
              kind: "human",
              title: "Human review",
              approve: { to: "done" },
              changes: { to: "done" },
            },
            { id: "done", kind: "end", title: "Done", outcome: "completed" },
          ],
        });
        const runChecked = Effect.fnUntraced(function* (definition: Definition) {
          const started = yield* startRouting(definition);
          yield* promise(() =>
            go(first.environmentId, "workflows.runs", {
              run: started.id,
              node: definition.maxVisits === 1 ? "checks" : "decide",
            }),
          );
          yield* reconcile;
          yield* promise(() =>
            tracked.run((run) => run.id === started.id && run.state === "awaiting-review"),
          );
          return yield* first
            .invoke("get", { ...scope, runId: started.id })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
        });
        // Below the repeat max and at the old spent-count coincidence, no repeat is spent.
        for (const max of [20, 1]) {
          const executions = checkExecutions;
          const limited = yield* runChecked(checkedRouting(`autonomous-first-${max}`, max, 2));
          expect(checkExecutions).toBe(executions + 1);
          expect(limited.attempts).toHaveLength(1);
          expect(limited.attempts[0]).toMatchObject({
            nodeId: "checks",
            threadId: null,
            phase: "completed",
            check: { outcome: "completed", exitCode: 0, stdout: "check passed" },
          });
          expect(limited.repeats).toEqual({});
          expect(limited.trace.at(-1)).toMatchObject({
            nodeId: "decide",
            route: "otherwise",
            chosen: "review",
            repeatCount: 0,
            repeat: { max, atLimit: "review", exhausted: false, outcome: "visit-limit" },
            diverted: "visit-limit",
          });
          expect([...takenEdges(limited.definition, limited.trace)]).toEqual(["checks:next"]);
          expect(textOf(labelled("Recorded routing")[0]!)).toContain(
            "Check decision → Human review",
          );
          expect(textOf(labelled("Recorded routing")[0]!)).toContain("not repeated");
          expect(page()).toContain(
            `Run visit limit reached · 0/${max} repeats used · → Human review`,
          );
        }
        // When one repeat already ran, max1 exits at its own limit; max20 hits the run bound.
        for (const max of [20, 1]) {
          const executions = checkExecutions;
          const limited = yield* runChecked(checkedRouting(`autonomous-used-${max}`, max, 4));
          expect(checkExecutions).toBe(executions + 2);
          expect(limited.repeats).toEqual({ "decide:checks": 1 });
          expect(limited.attempts).toHaveLength(2);
          expect(limited.trace.at(-1)).toMatchObject({
            repeatCount: 1,
            repeat: {
              max,
              atLimit: "review",
              exhausted: max === 1,
              outcome: max === 1 ? "limit" : "visit-limit",
            },
          });
          expect(limited.trace.at(-1)?.diverted).toBe(max === 1 ? undefined : "visit-limit");
          const recorded = textOf(labelled("Recorded routing")[0]!);
          expect(recorded).toContain(max === 1 ? "at limit" : "not repeated");
          expect([...takenEdges(limited.definition, limited.trace)]).toEqual(
            max === 1
              ? ["checks:next", "decide:otherwise", "decide:otherwise.repeat"]
              : ["checks:next", "decide:otherwise"],
          );
          // Reload reads identical persisted evidence and counters; the check is not replayed.
          const executionsAtGate = checkExecutions;
          yield* promise(unmount);
          tracked.forgetRuns();
          yield* promise(mount);
          yield* promise(() => tracked.run((run) => run.id === limited.id));
          const reloaded = yield* first
            .invoke("get", { ...scope, runId: limited.id })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RunSchema)));
          expect(reloaded.trace).toEqual(limited.trace);
          expect(reloaded.repeats).toEqual(limited.repeats);
          expect(checkExecutions).toBe(executionsAtGate);
        }
        // An ordinary check edge diverted by the whole-run bound has its own run-limit badge.
        const plain = yield* runChecked(checkedRouting("autonomous-plain", 1, 1));
        expect(plain.trace.at(-1)).toMatchObject({
          nodeId: "checks",
          route: "next",
          chosen: "review",
          repeatCount: null,
          diverted: "visit-limit",
        });
        expect(plain.trace.at(-1)?.repeat).toBeUndefined();
        expect([...takenEdges(plain.definition, plain.trace)]).toEqual([]);
        expect(textOf(labelled("Recorded routing")[0]!)).toContain("Checks → Human review");
        expect(textOf(labelled("Recorded routing")[0]!)).toContain("run limit");
        expect(page()).toContain("Run visit limit reached · → Human review");
        yield* promise(unmount);
        expect(tracked.openSubscriptions()).toBe(0);
        expect(second.tracked.openSubscriptions()).toBe(0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

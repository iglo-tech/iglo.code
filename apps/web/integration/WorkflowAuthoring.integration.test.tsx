import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
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
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { plugin as workflowPlugin } from "@t3tools/plugin-workflows/server";
import {
  authoringTimings,
  preloadWorkflowPages,
  web as workflowsWeb,
} from "@t3tools/plugin-workflows/web";
import {
  Definition,
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
import { act, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
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

// The graph requires window event listeners. Host tooltips still have no DOM refs or portals
// in this renderer, so preserve their triggers just like the other overlay doubles below.
vi.mock("../src/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipPopup: () => null,
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

// Overlays portal into a document, which this node harness lacks. Swap them for in-place
// doubles that keep the role, accessible name and blocker wiring the plugin flows rely on.
vi.mock("../src/plugins/design", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/plugins/design")>();
  const { useBlocker } = await import("@tanstack/react-router");
  const Dialog: typeof actual.pluginDesign.Dialog = ({ open, title, children, footer }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{title}</p>
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

import { createWorkflowsClient } from "../src/plugins/workflowsClient";
import { createPluginWebContext } from "../src/plugins/context";
import { bind } from "../src/plugins/contributions";
import { pluginDesign } from "../src/plugins/design";
import { PluginPageContent } from "../src/plugins/PluginPageContent";
import { validatePluginSearch } from "../src/plugins/pageLink";
import { appAtomRegistry } from "../src/rpc/atomRegistry";
import { createPluginDraftStore } from "../src/plugins/drafts";
import {
  draftKey,
  unusedWorkflowId,
  writeDraft,
} from "../../../packages/plugin-workflows/src/web/common.tsx";

const decodeDefinition = Schema.decodeUnknownSync(Definition);
const projectId = ProjectId.make("same-project");
const sequence = (id: string, title: string) => ({
  version: 1,
  id,
  revision: 1,
  title,
  entry: "work",
  atLimit: "done",
  nodes: [
    {
      id: "work",
      kind: "agent",
      title: "Work",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      instruction: "Do the work",
      report: { fields: [{ name: "ready", type: "boolean", required: true }] },
      next: { to: "done" },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
  ],
});

// External provider discovery is replayed; the plugin, catalog files, auth and RPC are real.
const replay = { providersFail: false, skillsFail: false, projectsFail: false };
const discoveryFailure = (operation: string) =>
  new PluginError({
    pluginId: "host",
    code: "unavailable",
    operation,
    message: `Replayed ${operation} discovery is offline.`,
  });
const replayedWorkflows: ServerPlugin = {
  ...workflowPlugin,
  acquire: Effect.gen(function* () {
    const host = yield* Host;
    return yield* workflowPlugin.acquire.pipe(
      Effect.provideService(
        Host,
        Host.of({
          ...host,
          projects: () =>
            replay.projectsFail ? Effect.fail(discoveryFailure("projects")) : host.projects(),
          providers: () =>
            replay.providersFail
              ? Effect.fail(discoveryFailure("providers"))
              : Effect.succeed([
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
          skills: () =>
            replay.skillsFail
              ? Effect.fail(discoveryFailure("skills"))
              : Effect.succeed([
                  { name: "code-review", path: "/skills/code-review/SKILL.md", enabled: true },
                ]),
        }),
      ),
    );
  }),
};

/** Records every request so the test awaits the exact server round trip it depends on. */
function track(client: WorkflowClient) {
  const queued = new Map<string, Array<Promise<unknown>>>();
  // Calls are boxed so awaiting a waiter does not adopt (and rethrow) the call's own result.
  const waiting = new Map<string, Array<(call: { promise: Promise<unknown> }) => void>>();
  const record = <A,>(method: string, promise: Promise<A>): Promise<A> => {
    const waiter = waiting.get(method)?.shift();
    if (waiter) waiter({ promise });
    else queued.set(method, [...(queued.get(method) ?? []), promise]);
    return promise;
  };
  const permissionWaiters: Array<(value: WorkflowPermissions) => void> = [];
  const wrapped: WorkflowClient = {
    // Run APIs are not exercised by authoring; they pass through untracked.
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
    replace: (input) => record("replace", client.replace(input)),
    remove: (input) => record("remove", client.remove(input)),
    capabilities: (input) => record("capabilities", client.capabilities(input)),
    skills: (input) => record("skills", client.skills(input)),
  };
  const next = (method: string) =>
    new Promise<{ promise: Promise<unknown> }>((resolve) => {
      const promise = queued.get(method)?.shift();
      if (promise) resolve({ promise });
      else waiting.set(method, [...(waiting.get(method) ?? []), resolve]);
    });
  return {
    client: wrapped,
    /** Await the oldest unobserved call, or the next one, and its settlement. */
    settle: async (method: string) => {
      // Wait outside act: React holds updates made inside an act scope until it exits.
      const call = await next(method);
      await act(async () => {
        await call.promise.catch(() => undefined);
      });
    },
    /** Await the most recent call (or the next one) and drop older ones it supersedes. */
    settleLatest: async (method: string) => {
      const latest = queued.get(method)?.pop();
      queued.delete(method);
      const call = latest === undefined ? await next(method) : { promise: latest };
      await act(async () => {
        await call.promise.catch(() => undefined);
      });
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
/** Every microtask-driven router/blocker transition has settled once a macrotask runs. */
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary that lets queued socket messages land, not a wait for time
const flush = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

/** Clone identity checks use the production client and authenticated, registered catalog API. */
const cloneFixture = Effect.gen(function* () {
  const config = {
    ...(yield* makeReplayServerConfig("workflow-clone")),
    noBrowser: true,
    traceTimingEnabled: false,
  };
  const server = yield* startEnvironment(config, [replayedWorkflows]);
  const environmentId = Context.get(server.context, Host).environmentId;
  yield* Context.get(server.context, Projects.ProjectService).create({
    commandId: CommandId.make("clone-project"),
    projectId,
    title: "Clone project",
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
    label: "Clone environment",
    httpBaseUrl: origin(server.context),
    wsBaseUrl: origin(server.context).replace("http", "ws"),
  });
  const writable = yield* Context.get(server.context, Auth.EnvironmentAuth).issueSession({
    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  });
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some({
      environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: { _tag: "Bearer", token: writable.token },
      target,
    } satisfies PreparedConnection),
  );
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
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      appAtomRegistry.reset();
      binding.configs.delete(environmentId);
      binding.contexts.delete(environmentId);
    }),
  );
  return {
    environmentId,
    directory: `${config.baseDir}/.t3code/workflows`,
    client: createWorkflowsClient(environmentId),
    drafts: createPluginDraftStore(memoryStorage(), environmentId, "workflows"),
  };
});

it.live.each([
  { copies: 3, expectedId: "implementation-copy-4" },
  { copies: 51, expectedId: "implementation-copy-52" },
])("clones and saves with $copies matching catalog files", ({ copies, expectedId }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* cloneFixture;
      const fs = yield* FileSystem.FileSystem;
      const original = yield* Effect.promise(() =>
        test.client.read({ projectId, source: "packaged:implementation" }),
      );
      if (original.definition === null) return yield* Effect.die("Expected packaged definition");
      const definition = original.definition;
      yield* fs.makeDirectory(test.directory, { recursive: true });
      const existing = new Map<string, string>();
      for (let index = 1; index <= copies; index++) {
        const id = index === 1 ? "implementation-copy" : `implementation-copy-${index}`;
        const text = Yaml.stringify({ ...definition, id });
        existing.set(id, text);
        yield* fs.writeFileString(`${test.directory}/${id}.yaml`, text);
      }
      const id = yield* Effect.promise(() =>
        unusedWorkflowId(test.client, test.drafts, projectId, "implementation-copy"),
      );
      expect(id).toBe(expectedId);
      const clone = { ...definition, id, title: `${definition.title} (copy)`, revision: 1 };
      const saved = yield* Effect.promise(() =>
        test.client.save({ projectId, definition: clone, expectedRevision: null }),
      );
      expect(saved).toMatchObject({ runnable: true, definition: clone });
      const reopened = yield* Effect.promise(() =>
        test.client.read({ projectId, source: saved.source }),
      );
      expect(reopened.definition).toEqual(clone);
      expect(
        decodeDefinition(Yaml.parse(yield* fs.readFileString(`${test.directory}/${id}.yaml`))),
      ).toEqual(clone);
      for (const [occupied, text] of existing)
        expect(yield* fs.readFileString(`${test.directory}/${occupied}.yaml`)).toBe(text);
      expect(
        (yield* Effect.promise(() =>
          test.client.read({ projectId, source: "packaged:implementation" }),
        )).definition,
      ).toEqual(definition);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("clones past a later-page invalid filename and scoped local drafts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const test = yield* cloneFixture;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(test.directory, { recursive: true });
      const existing = new Map<string, string>();
      for (let index = 2; index <= 51; index++)
        existing.set(
          `implementation-copy-${index}.yaml`,
          Yaml.stringify(sequence(`implementation-copy-${index}`, `Copy ${index}`)),
        );
      existing.set("implementation-copy.yaml", "nodes: [");
      // A valid file's declared identity differs from the filename that a new save would use.
      existing.set(
        "implementation-copy-52.yaml",
        Yaml.stringify(sequence("different-identity", "Keep this filename")),
      );
      for (const [filename, text] of existing)
        yield* fs.writeFileString(`${test.directory}/${filename}`, text);
      const envelope = {
        version: 1 as const,
        base: { mode: "new" as const, source: null, fingerprint: null, revision: null },
        definition: decodeDefinition(sequence("implementation-copy-53", "Local copy")),
        updatedAt: 1,
      };
      expect(writeDraft(test.drafts, draftKey(projectId, "new:local"), envelope)).toBe(true);
      const foreign = {
        ...envelope,
        definition: { ...envelope.definition, id: "implementation-copy-54" },
      };
      expect(
        writeDraft(test.drafts, draftKey(ProjectId.make("other-project"), "new:local"), foreign),
      ).toBe(true);
      const draftBefore = test.drafts.read(draftKey(projectId, "new:local"));
      const later = yield* Effect.promise(() =>
        test.client.library({ projectId, query: "implementation-copy", offset: 50, limit: 50 }),
      );
      expect(later.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: ".t3code/workflows/implementation-copy.yaml",
            definitionId: null,
            reasons: ["Invalid workflow YAML."],
          }),
        ]),
      );
      const id = yield* Effect.promise(() =>
        unusedWorkflowId(test.client, test.drafts, projectId, "implementation-copy"),
      );
      expect(id).toBe("implementation-copy-54");
      const clone = decodeDefinition(sequence(id, "New copy"));
      const saved = yield* Effect.promise(() =>
        test.client.save({ projectId, definition: clone, expectedRevision: null }),
      );
      expect(saved).toMatchObject({ runnable: true, definition: clone });
      expect(test.drafts.read(draftKey(projectId, "new:local"))).toBe(draftBefore);
      for (const [filename, text] of existing)
        expect(yield* fs.readFileString(`${test.directory}/${filename}`)).toBe(text);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "authors, saves, repairs and clones workflows through the hosted pages on the selected environment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = new EventTarget();
        const eventMethods = ["addEventListener", "removeEventListener", "dispatchEvent"] as const;
        const eventDescriptors = eventMethods.map(
          (method) => [method, Object.getOwnPropertyDescriptor(globalThis, method)] as const,
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            vi.unstubAllGlobals();
            for (const [method, descriptor] of eventDescriptors) {
              if (descriptor === undefined) Reflect.deleteProperty(globalThis, method);
              else Object.defineProperty(globalThis, method, descriptor);
            }
          }),
        );
        // Keep page lifecycle events through navigation helpers that unstub other globals.
        for (const method of eventMethods)
          Object.defineProperty(globalThis, method, {
            configurable: true,
            value: events[method].bind(events),
          });
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        // Keep the real graph's keyboard listeners without inventing DOM geometry.
        const graphGlobals = () => {
          vi.stubGlobal("window", events);
          vi.stubGlobal("cancelAnimationFrame", () => {});
        };
        graphGlobals();
        // Requests coalesced while typing are issued immediately, so tests await each request.
        const timings = { ...authoringTimings };
        Object.assign(authoringTimings, {
          searchDelayMs: 0,
          validationDelayMs: 0,
          draftDelayMs: 0,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            Object.assign(authoringTimings, timings);
            Object.assign(replay, { providersFail: false, skillsFail: false, projectsFail: false });
          }),
        );
        // Lazy page modules resolve within act once loaded.
        yield* Effect.promise(preloadWorkflowPages);
        const fs = yield* FileSystem.FileSystem;
        const environments = yield* Effect.forEach(
          ["Workstation", "Workstation (2)"],
          (label, index) =>
            Effect.gen(function* () {
              const config = {
                ...(yield* makeReplayServerConfig(`workflow-authoring-${index}`)),
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
              const catalog: PluginCatalog = yield* Context.get(
                server.context,
                Registry.PluginRegistry,
              ).catalog;
              return {
                label,
                environmentId,
                config,
                catalog,
                directory: `${config.baseDir}/.t3code/workflows`,
                tracked: track(createWorkflowsClient(environmentId)),
                projects: Context.get(server.context, Projects.ProjectService),
                grantWrite: SubscriptionRef.set(prepared, Option.some(prepare(writable.token))),
                fiber: server.fiber,
              };
            }),
        );
        const [first, second] = environments as [
          (typeof environments)[number],
          (typeof environments)[number],
        ];
        expect(first.environmentId).not.toBe(second.environmentId);
        yield* fs.makeDirectory(first.directory, { recursive: true });
        for (let index = 0; index < 23; index++)
          yield* fs.writeFileString(
            `${first.directory}/w${String(index).padStart(2, "0")}.yaml`,
            Yaml.stringify(sequence(`w${index}`, `Workflow ${index}`)),
          );
        const brokenFile = `${first.directory}/zz-broken.yaml`;
        yield* fs.writeFileString(brokenFile, "version: 1\nid: zz-broken\nnodes: [");
        const unrelated = yield* fs.readFileString(`${first.directory}/w00.yaml`);
        yield* fs.makeDirectory(second.directory, { recursive: true });
        yield* fs.writeFileString(
          `${second.directory}/second-only.yaml`,
          Yaml.stringify(sequence("second-only", "Second environment only")),
        );

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
              `/plugins/${first.environmentId}/workflows/workflows.library?pluginProjectId=late-project`,
            ],
          }),
        });
        // Mirror the app's router provider, which reloads on every committed history change.
        // Node routers are non-reactive (server mode), so the harness follows loads itself.
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
        function Harness() {
          useSyncExternalStore(
            (notify) => {
              loaded.add(notify);
              return () => loaded.delete(notify);
            },
            () => router.state.location.href,
          );
          const location = router.state.location;
          const [, , environmentId = "", pluginId = "", pageId = ""] = location.pathname
            .split("/")
            .map(decodeURIComponent);
          const search = validatePluginSearch(location.search as Record<string, unknown>);
          const target = bound.get(environmentId)!;
          const connection = connections.get(environmentId) ?? "connected";
          const stateKey = JSON.stringify(search.pluginState ?? {});
          const context = useMemo(
            () =>
              createPluginWebContext({
                environmentId: target.environment.environmentId,
                environmentLabel: target.environment.label,
                descriptor: target.environment.catalog.plugins.find(
                  (item) => item.manifest.id === "workflows",
                )!,
                projectId: search.pluginProjectId ?? null,
                threadId: null,
                pageState: JSON.parse(stateKey) as Record<string, string>,
                connection,
                navigate: router.navigate,
                storage,
              }),
            [target, search.pluginProjectId, stateKey, connection],
          );
          return (
            <PluginPageContent
              catalog={target.environment.catalog}
              contributions={[{ ...target.plugin, context }]}
              pluginId={pluginId}
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
          }),
        );
        const root = () => renderer!.root;
        const page = () => textOf(root());
        const button = (label: string) =>
          root().find(
            (node) =>
              node.type === pluginDesign.Button &&
              (node.props.ariaLabel === label || textOf(node) === label),
          );
        const buttons = (label: string) =>
          root().findAll(
            (node) =>
              node.type === pluginDesign.Button &&
              (node.props.ariaLabel === label || textOf(node) === label),
          );
        const control = (type: unknown, key: string) => {
          const found = root().findAll(
            (node) => node.type === type && (node.props.id === key || node.props.ariaLabel === key),
          );
          if (found.length !== 1)
            throw new Error(`Expected one control ${key}, found ${found.length}`);
          return found[0]!;
        };
        // TanStack history consults blockers only when a document exists, checked on push.
        const leaveToLibrary = async () => {
          await act(async () => {
            vi.stubGlobal("document", {});
            crumb("Workflows").onSelect();
            vi.unstubAllGlobals();
            vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
            graphGlobals();
          });
          await flush();
        };
        const click = (label: string, index = 0) =>
          act(async () => {
            const found = buttons(label);
            let target: ReactTestInstance | null =
              found[index] ??
              root().find((node) => node.type === "button" && node.props["aria-label"] === label);
            // Graph buttons bubble to the real React Flow node wrapper's selection handler.
            while (target !== null && typeof target.props.onClick !== "function")
              target = target.parent;
            if (target === null) throw new Error(`No click handler for ${label}`);
            target.props.onClick({});
          });
        // Host-owned controls (the navigation guard) are plain rendered buttons.
        const press = (label: string) =>
          act(async () =>
            root()
              .find((node) => node.type === "button" && textOf(node) === label)
              .props.onClick(),
          );
        const type = (key: string, value: string) =>
          act(async () => control(pluginDesign.Input, key).props.onChange(value));
        const write = (key: string, value: string) =>
          act(async () => control(pluginDesign.Textarea, key).props.onChange(value));
        const choose = (key: string, value: string) =>
          act(async () => control(pluginDesign.Select, key).props.onChange(value));
        // Header breadcrumb segments and overflow-menu actions are host-rendered; drive them
        // through the same handlers the host menu and links call.
        const crumb = (label: string) =>
          root()
            .find((node) => node.type === pluginDesign.PageHeader)
            .props.breadcrumb.find(
              (item: { label: string; ariaLabel?: string }) =>
                item.ariaLabel === label || item.label === label,
            );
        const menuItems = (label: string) =>
          root()
            .findAll((node) => node.type === pluginDesign.Menu)
            .flatMap((node) =>
              (node.props.items as Array<{ label: string; onSelect: () => void }>).filter(
                (item) => item.label === label,
              ),
            );
        const select = (label: string) => act(async () => menuItems(label)[0]!.onSelect());
        const openRow = (label: string) =>
          act(async () =>
            root()
              .find((node) => node.type === "button" && node.props["aria-label"] === label)
              .props.onClick(),
          );
        const toLibrary = () => act(async () => crumb("Workflows").onSelect());
        const keyDown = (nodeId: string, init: { key: string; altKey?: boolean }) =>
          act(async () =>
            root()
              .find((node) => node.type === "button" && node.props.id === `wf-step-${nodeId}`)
              .props.onKeyDown({ altKey: false, ...init, preventDefault: () => {} }),
          );
        const clearSelection = () =>
          act(async () =>
            root()
              .find(
                (node) =>
                  node.type === "div" &&
                  node.props.className?.split(" ").includes("react-flow__pane"),
              )
              .props.onClick({ target: null }),
          );
        const { tracked } = first;
        const promise = <A,>(run: () => Promise<A>) => Effect.promise(run);

        // Loading, a load error with Retry, and the empty state on a project added later.
        yield* promise(mount);
        expect(page()).toContain("Loading workflows…");
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("Could not load workflows");
        expect(page()).toContain("The project is unavailable.");
        const lateRoot = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-late-" });
        yield* first.projects.create({
          commandId: CommandId.make("late-project"),
          projectId: ProjectId.make("late-project"),
          title: "Late project",
          workspaceRoot: lateRoot,
        });
        yield* promise(() => click("Retry"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).not.toContain("Could not load workflows");
        expect(page()).toContain("Implementation and human review");
        yield* promise(() => type("Search workflows", "no-such-workflow"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("No workflows match this search.");

        // Library: explicit target, full-catalog paging, invalid entries with their reason.
        yield* promise(() => act(async () => crumb("Project").onChange(projectId)));
        yield* promise(flush);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("Workstation");
        expect(crumb("Project").value).toBe(projectId);
        expect(page()).toContain("1–20 of 26");
        yield* promise(() => click("Next"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("21–26 of 26");
        expect(page()).toContain("zz-broken.yaml");
        expect(page()).toContain("Invalid file");
        expect(page()).toContain("Invalid workflow YAML.");
        expect(menuItems("Repair")).toHaveLength(1);
        yield* promise(() => type("Search workflows", "workflow 1"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("Workflow 10");
        expect(page()).not.toContain("Workflow 2");

        // New workflow: name, palette, graph and inspector without dragging. Provider and
        // skill discovery start out failing to show their recoverable states.
        Object.assign(replay, { providersFail: true, skillsFail: true });
        yield* promise(() => click("New workflow"));
        yield* promise(() => type("Workflow name", "Release notes"));
        yield* promise(() => click("Create"));
        yield* promise(flush);
        expect(router.state.location.search).toMatchObject({
          pluginState: { draft: expect.stringMatching(/^new:release-notes:/) },
        });
        yield* promise(() => tracked.settle("capabilities"));
        expect(page()).toContain("Unsaved changes");
        // The real graph renders its keyboard step buttons even without DOM measurement.
        expect(control(pluginDesign.SegmentedControl, "Workflow view").props.value).toBe("graph");
        expect(
          root().findAll((node) => node.type === "button" && textOf(node) === "Routes"),
        ).toHaveLength(0);
        yield* promise(() => click("Agent step"));
        yield* promise(() => tracked.settle("skills"));
        expect(page()).toContain(
          "Provider discovery is unavailable: Replayed providers discovery is offline.",
        );
        expect(page()).toContain("Skill discovery failed:");
        Object.assign(replay, { providersFail: false, skillsFail: false });
        yield* promise(() => click("Retry provider discovery"));
        yield* promise(() => tracked.settle("capabilities"));
        yield* promise(() => click("Retry skill discovery"));
        yield* promise(() => tracked.settle("skills"));
        expect(page()).not.toContain("discovery is unavailable");
        expect(page()).not.toContain("Skill discovery failed");
        yield* promise(() => choose("wf-agent-1-model", "gpt-5.4"));
        yield* promise(() => write("wf-agent-1-instruction", "Draft the release notes"));
        yield* promise(() => click("Add report field"));
        yield* promise(() => type("wf-agent-1-report-fields-0", "ready"));
        yield* promise(() => choose("wf-agent-1-skill", "code-review"));
        yield* promise(() => click("Agent step"));
        yield* promise(() => tracked.settle("skills"));
        yield* promise(() => write("wf-agent-2-instruction", "Review the notes"));
        yield* promise(() => click("Add input"));
        yield* promise(() => choose("wf-agent-2-bindings-0", "agent-1\u0000data.ready"));
        // Keyboard reorder changes reading order only; Delete removes a step.
        yield* promise(() => keyDown("agent-2", { key: "ArrowUp", altKey: true }));
        yield* promise(() => click("End"));
        yield* promise(() => keyDown("end-1", { key: "Delete" }));
        expect(page()).not.toContain("end-1");
        const steps = root()
          .findAll((node) => node.type === "button" && String(node.props.id).startsWith("wf-step-"))
          .map((node) => node.props.id);
        expect(steps).toEqual(["wf-step-agent-2", "wf-step-agent-1", "wf-step-done"]);
        yield* promise(() => tracked.settleLatest("validate"));
        expect(page()).not.toContain("to fix");
        expect(page()).not.toContain("Checking…");
        yield* promise(() => click("Agent step: Agent step 1"));
        yield* promise(() => tracked.settle("skills"));
        expect(control(pluginDesign.Select, "wf-agent-1-next").props.value).toBe("agent-2");
        // Connect explicitly through the canonical inspector, then restore the sequence.
        yield* promise(() => choose("wf-agent-1-next", "done"));
        yield* promise(() => choose("wf-agent-1-next", "agent-2"));
        yield* promise(() => click("Agent step: Agent step 2"));
        yield* promise(() => tracked.settle("skills"));
        expect(control(pluginDesign.Select, "wf-agent-2-next").props.value).toBe("done");
        // The inspector's keyboard/touch controls preserve the graph shortcut's result.
        expect(button("Move Agent step 2 up").props.disabled).toBe(true);
        yield* promise(() => click("Move Agent step 2 down"));
        yield* promise(() => click("Move Agent step 2 up"));

        // The draft survives a reload, keyed by environment, project and workflow.
        const draftKeys = [...storage.values.keys()].filter((key) =>
          key.includes(`${encodeURIComponent(first.environmentId)}:workflows:entry:`),
        );
        expect(draftKeys).toHaveLength(1);
        expect(draftKeys[0]).toContain(encodeURIComponent(`${projectId}:new:release-notes:`));
        yield* promise(unmount);
        yield* promise(mount);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("capabilities"));
        yield* promise(() => click("Agent step: Agent step 2"));
        yield* promise(() => tracked.settle("skills"));
        expect(control(pluginDesign.Textarea, "wf-agent-2-instruction").props.value).toBe(
          "Review the notes",
        );
        // A failed server check is reported with Retry instead of "checking" forever.
        replay.projectsFail = true;
        yield* promise(() => write("wf-agent-2-instruction", "Review the notes carefully"));
        yield* promise(() => tracked.settleLatest("validate"));
        expect(page()).toContain("Validation unavailable");
        replay.projectsFail = false;
        yield* promise(() => click("Retry validation"));
        yield* promise(() => tracked.settleLatest("validate"));
        expect(page()).not.toContain("Validation unavailable");
        expect(page()).not.toContain("to fix");

        // Authorization: a read-only pairing cannot save until operate access is granted.
        expect(page()).toContain("View only");
        expect(button("Save").props.disabled).toBe(true);
        const granted = tracked.permissions((value) => value.save && value.replace);
        yield* first.grantWrite;
        yield* promise(() => granted);
        yield* promise(flush);
        expect(button("Save").props.disabled).toBe(false);
        // Disconnection keeps the draft but holds mutations until reconnecting.
        connections.set(first.environmentId, "disconnected");
        yield* promise(() =>
          act(async () =>
            renderer!.update(
              <RouterContextProvider router={router}>
                <Harness />
              </RouterContextProvider>,
            ),
          ),
        );
        expect(page()).toContain("Unsaved · kept on this device");
        expect(page()).toContain("Disconnected");
        expect(button("Save").props.disabled).toBe(true);
        connections.delete(first.environmentId);
        yield* promise(() =>
          act(async () =>
            renderer!.update(
              <RouterContextProvider router={router}>
                <Harness />
              </RouterContextProvider>,
            ),
          ),
        );
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("capabilities"));

        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));
        expect(page()).toContain("Saved revision 1");
        // Reopening the saved file keeps the selected step in the inspector.
        expect(router.state.location.search).toMatchObject({
          pluginState: { source: ".t3code/workflows/release-notes.yaml", step: "agent-2" },
        });
        expect(control(pluginDesign.Textarea, "wf-agent-2-instruction").props.value).toBe(
          "Review the notes carefully",
        );
        expect(storage.values.has(draftKeys[0]!)).toBe(false);
        const saved = decodeDefinition(
          Yaml.parse(yield* fs.readFileString(`${first.directory}/release-notes.yaml`)),
        );
        expect(saved).toMatchObject({ id: "release-notes", revision: 1, title: "Release notes" });
        expect(saved.nodes.map((node) => node.id)).toEqual(["agent-2", "agent-1", "done"]);
        const [agent2, agent1] = saved.nodes;
        expect(agent1).toMatchObject({
          kind: "agent",
          skill: "code-review",
          instruction: "Draft the release notes",
          report: { fields: [{ name: "ready", type: "boolean", required: true }] },
          next: { to: "agent-2" },
        });
        expect(agent2).toMatchObject({
          bindings: [
            { name: "ready", node: "agent-1", path: "data.ready", field: { type: "boolean" } },
          ],
          next: { to: "done" },
        });

        // A coalesced draft write still pending when the page is hidden (reload, tab close) is
        // flushed then, since unmount effects never run on a reload.
        const sourceDraft = (key: string) =>
          key.endsWith(encodeURIComponent(`${projectId}:.t3code/workflows/release-notes.yaml`));
        authoringTimings.draftDelayMs = 60_000;
        yield* promise(clearSelection);
        yield* promise(() => type("wf-workflow-title", "Pending title"));
        expect([...storage.values.keys()].some(sourceDraft)).toBe(false);
        yield* promise(() => act(async () => void globalThis.dispatchEvent(new Event("pagehide"))));
        const pending = [...storage.values].find(([key]) => sourceDraft(key));
        expect(pending?.[1]).toContain("Pending title");
        authoringTimings.draftDelayMs = 0;

        // A concurrent external edit conflicts; the draft is kept with compare and reload.
        yield* fs.writeFileString(
          `${first.directory}/release-notes.yaml`,
          Yaml.stringify({ ...saved, revision: 2, title: "Edited elsewhere" }),
        );
        yield* promise(() => type("wf-workflow-title", "Release notes v2"));
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        expect(page()).toContain("Changed on the server");
        expect(control(pluginDesign.Input, "wf-workflow-title").props.value).toBe(
          "Release notes v2",
        );
        yield* promise(() => click("Compare"));
        yield* promise(() => tracked.settle("read"));
        expect(control(pluginDesign.Textarea, "wf-compare-server").props.value).toContain(
          "Edited elsewhere",
        );
        // A failed import leaves the current draft untouched.
        yield* promise(() => select("Import YAML"));
        yield* promise(() => write("wf-import", "nodes: ["));
        yield* promise(() => click("Preview import"));
        expect(page()).toContain("Not imported · current draft unchanged");
        expect(control(pluginDesign.Input, "wf-workflow-title").props.value).toBe(
          "Release notes v2",
        );
        yield* promise(() => click("Reload"));
        yield* promise(() => tracked.settle("read"));
        expect(control(pluginDesign.Input, "wf-workflow-title").props.value).toBe(
          "Edited elsewhere",
        );
        expect(page()).toContain("Saved revision 2");

        // Navigation away from unsaved edits offers Keep editing or Discard. TanStack history
        // consults blockers only when a document exists, which it checks synchronously on push.
        const leave = () => {
          vi.stubGlobal("document", {});
          void router.navigate({
            to: "/plugins/$environmentId/$pluginId/$pageId",
            params: {
              environmentId: first.environmentId,
              pluginId: "workflows",
              pageId: "workflows.library",
            },
            search: { pluginProjectId: projectId },
          });
          vi.unstubAllGlobals();
          vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
          graphGlobals();
          return flush();
        };
        yield* promise(() => type("wf-workflow-title", "Unsaved title"));
        yield* promise(leave);
        expect(page()).toContain("Leave with unsaved workflow changes?");
        yield* promise(() => press("Keep editing"));
        yield* promise(flush);
        expect(router.state.location.pathname).toContain("workflows.editor");
        expect(control(pluginDesign.Input, "wf-workflow-title").props.value).toBe("Unsaved title");
        yield* promise(leave);
        yield* promise(() => press("Discard"));
        yield* promise(flush);
        expect(router.state.location.pathname).toContain("workflows.library");
        expect(
          [...storage.values.keys()].filter((key) => key.includes(":workflows:entry:")),
        ).toEqual([]);
        yield* promise(() => tracked.settle("projects"));
        yield* promise(() => tracked.settle("library"));

        // Repair the invalid file through its observed fingerprint.
        yield* promise(() => type("Search workflows", "zz-broken"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => select("Repair"));
        yield* promise(flush);
        expect(page()).toContain("Loading workflow…");
        yield* promise(() => tracked.settle("read"));
        expect(control(pluginDesign.Textarea, "wf-import").props.value).toContain("zz-broken");
        yield* promise(() => write("wf-import", Yaml.stringify(sequence("zz-broken", "Repaired"))));
        yield* promise(() => click("Preview import"));
        yield* promise(() => click("Replace draft"));
        yield* promise(() => tracked.settleLatest("validate"));
        yield* promise(() => click("Validate and replace file"));
        yield* promise(() => tracked.settle("replace"));
        yield* promise(flush);
        expect(page()).toContain("Saved revision 1");
        expect(decodeDefinition(Yaml.parse(yield* fs.readFileString(brokenFile))).title).toBe(
          "Repaired",
        );
        expect(yield* fs.readFileString(`${first.directory}/w00.yaml`)).toBe(unrelated);

        // Packaged examples are read-only and clone under a new identity.
        yield* promise(toLibrary);
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => type("Search workflows", "packaged:implementation"));
        yield* promise(() => tracked.settle("library"));
        expect(page()).toContain("Packaged");
        const cloneImplementation = function* () {
          yield* promise(() => select("Clone to edit"));
          yield* promise(() => tracked.settle("read"));
          yield* promise(() => tracked.settle("library"));
          yield* promise(flush);
          yield* promise(() => tracked.settleLatest("validate"));
        };
        yield* cloneImplementation();
        expect(control(pluginDesign.Input, "wf-workflow-id").props.value).toBe(
          "implementation-copy",
        );
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        expect(
          decodeDefinition(
            Yaml.parse(yield* fs.readFileString(`${first.directory}/implementation-copy.yaml`)),
          ).nodes.map((node) => node.kind),
        ).toEqual(["agent", "human", "end"]);
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));

        // A second clone gets an unused identity, skipping names taken by files (even invalid
        // ones); leaving keeps it listed as a local draft.
        yield* fs.writeFileString(`${first.directory}/implementation-copy-2.yaml`, "nodes: [");
        yield* promise(toLibrary);
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => type("Search workflows", "packaged:implementation"));
        yield* promise(() => tracked.settle("library"));
        yield* cloneImplementation();
        expect(control(pluginDesign.Input, "wf-workflow-id").props.value).toBe(
          "implementation-copy-3",
        );
        yield* promise(leaveToLibrary);
        expect(page()).toContain("Leave with unsaved workflow changes?");
        yield* promise(() => press("Leave and keep draft"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        expect(router.state.location.pathname).toContain("workflows.library");
        expect(page()).toContain("Unsaved drafts");
        const cloneTitle = "Implementation and human review (copy)";
        yield* promise(() => openRow(`Open draft ${cloneTitle}`));
        yield* promise(flush);
        expect(control(pluginDesign.Input, "wf-workflow-id").props.value).toBe(
          "implementation-copy-3",
        );
        yield* promise(leaveToLibrary);
        yield* promise(() => press("Leave and keep draft"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => click(`Discard draft ${cloneTitle}`));
        expect(page()).not.toContain("Unsaved drafts");
        expect(
          [...storage.values.keys()].filter((key) => key.includes(":workflows:entry:")),
        ).toEqual([]);

        // A packaged clone must be persisted before leaving its source. Reject only the
        // external storage write; keep the real host store, Editor, router and API paths.
        const filesBeforeCloneFailure = new Map(
          yield* Effect.forEach(yield* fs.readDirectory(first.directory), (filename) =>
            fs
              .readFileString(`${first.directory}/${filename}`)
              .pipe(Effect.map((text) => [filename, text] as const)),
          ),
        );
        yield* promise(() => type("Search workflows", "packaged:implementation"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => openRow("View Implementation and human review"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));
        yield* promise(() => tracked.settleLatest("validate"));
        yield* promise(() => select("Export YAML"));
        const packagedYaml = control(pluginDesign.Textarea, "wf-export").props.value;
        const packagedDefinition = decodeDefinition(Yaml.parse(packagedYaml));
        yield* promise(() =>
          act(async () =>
            control(pluginDesign.SegmentedControl, "Workflow view").props.onChange("graph"),
          ),
        );
        yield* promise(() => click("Agent step: Implement"));
        yield* promise(() => tracked.settle("skills"));
        const packagedLocation = router.state.location.href;
        const setItem = storage.setItem;
        let rejectedWrites = 0;
        storage.setItem = (key, value) => {
          if (key.includes(":workflows:entry:")) {
            rejectedWrites++;
            throw new Error("QuotaExceededError: fixture storage is full");
          }
          setItem(key, value);
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            storage.setItem = setItem;
          }),
        );
        yield* promise(() => click("Clone to edit"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(flush);
        expect(rejectedWrites).toBe(1);
        expect(router.state.location.href).toBe(packagedLocation);
        expect(page()).toContain("Not cloned");
        expect(page()).toContain(
          "This browser could not keep a local draft. Free some site storage.",
        );
        expect(page()).not.toContain("This draft is no longer on this device");
        expect(page()).not.toContain("Not saved · edits kept");
        expect(buttons("Retry save")).toHaveLength(0);
        expect(buttons("Save")).toHaveLength(0);
        expect(control(pluginDesign.SegmentedControl, "Workflow view").props.value).toBe("graph");
        expect(
          root().find((node) => node.type === "button" && node.props.id === "wf-step-implement")
            .props["aria-pressed"],
        ).toBe(true);
        yield* promise(() => select("Export YAML"));
        expect(control(pluginDesign.Textarea, "wf-export").props.value).toBe(packagedYaml);
        expect(
          [...storage.values.keys()].filter((key) => key.includes(":workflows:entry:")),
        ).toEqual([]);
        expect((yield* fs.readDirectory(first.directory)).sort()).toEqual(
          [...filesBeforeCloneFailure.keys()].sort(),
        );
        for (const [filename, text] of filesBeforeCloneFailure)
          expect(yield* fs.readFileString(`${first.directory}/${filename}`)).toBe(text);

        // The same failure through Library remains useful, then Editor retries normally
        // when the browser can keep drafts again, saving and reopening canonical YAML.
        yield* promise(() => click("Open library"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => type("Search workflows", "packaged:implementation"));
        yield* promise(() => tracked.settle("library"));
        const libraryLocation = router.state.location.href;
        yield* promise(() => select("Clone to edit"));
        yield* promise(() => tracked.settle("read"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(flush);
        expect(rejectedWrites).toBe(2);
        expect(router.state.location.href).toBe(libraryLocation);
        expect(page()).toContain(
          "This browser could not keep a local draft. Free some site storage.",
        );
        yield* promise(() => openRow("View Implementation and human review"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));
        yield* promise(() => tracked.settleLatest("validate"));
        yield* promise(() => click("Clone to edit"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(flush);
        expect(page()).toContain("Not cloned");
        storage.setItem = setItem;
        yield* promise(() => click("Clone to edit"));
        yield* promise(() => tracked.settle("library"));
        yield* promise(flush);
        yield* promise(() => tracked.settleLatest("validate"));
        expect(page()).not.toContain("Not cloned");
        expect(control(pluginDesign.Input, "wf-workflow-id").props.value).toBe(
          "implementation-copy-3",
        );
        const recoveredClone = {
          ...packagedDefinition,
          id: "implementation-copy-3",
          title: `${packagedDefinition.title} (copy)`,
          revision: 1,
        };
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("read"));
        expect(page()).toContain("Saved revision 1");
        expect(router.state.location.search).toMatchObject({
          pluginState: { source: ".t3code/workflows/implementation-copy-3.yaml" },
        });
        expect(
          decodeDefinition(
            Yaml.parse(yield* fs.readFileString(`${first.directory}/implementation-copy-3.yaml`)),
          ),
        ).toEqual(recoveredClone);
        yield* promise(() => select("Export YAML"));
        expect(
          decodeDefinition(Yaml.parse(control(pluginDesign.Textarea, "wf-export").props.value)),
        ).toEqual(recoveredClone);
        for (const [filename, text] of filesBeforeCloneFailure)
          expect(yield* fs.readFileString(`${first.directory}/${filename}`)).toBe(text);

        // A link to a draft that is gone explains it instead of loading forever.
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: {
                environmentId: first.environmentId,
                pluginId: "workflows",
                pageId: "workflows.editor",
              },
              search: { pluginProjectId: projectId, pluginState: { draft: "new:gone:x" } },
            });
          }),
        );
        yield* promise(flush);
        expect(page()).toContain("This draft is no longer on this device");

        // Importing an existing identity names the conflict and lets the user pick another ID.
        yield* promise(() => click("Open library"));
        yield* promise(flush);
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => select("Import YAML"));
        yield* promise(() =>
          write("Workflow YAML to import", Yaml.stringify(sequence("w0", "W0 again"))),
        );
        yield* promise(() => click("Open as new draft"));
        yield* promise(flush);
        yield* promise(() => tracked.settleLatest("validate"));
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        expect(page()).toContain(
          "A workflow with ID w0 already exists in this project. Choose a different workflow ID.",
        );
        expect(buttons("Compare")).toHaveLength(0);
        yield* promise(() => click("Change workflow ID"));
        yield* promise(() => type("wf-workflow-id", "w0-imported"));
        yield* promise(() => tracked.settleLatest("validate"));
        yield* promise(() => click("Save"));
        yield* promise(() => tracked.settle("save"));
        expect(
          decodeDefinition(
            Yaml.parse(yield* fs.readFileString(`${first.directory}/w0-imported.yaml`)),
          ).title,
        ).toBe("W0 again");
        expect(yield* fs.readFileString(`${first.directory}/w00.yaml`)).toBe(unrelated);

        // The similarly named second environment keeps its own catalog and receives no writes.
        yield* promise(() =>
          act(async () => {
            await router.navigate({
              to: "/plugins/$environmentId/$pluginId/$pageId",
              params: {
                environmentId: second.environmentId,
                pluginId: "workflows",
                pageId: "workflows.library",
              },
              search: { pluginProjectId: projectId },
            });
          }),
        );
        yield* promise(() => second.tracked.settle("projects"));
        yield* promise(() => second.tracked.settle("library"));
        expect(page()).toContain("Workstation (2)");
        expect(page()).toContain("Second environment only");
        expect(page()).not.toContain("Release notes");
        expect((yield* fs.readDirectory(second.directory)).sort()).toEqual(["second-only.yaml"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

import { EnvironmentCacheStore } from "../../../packages/client-runtime/src/platform/persistence.ts";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import { FetchHttpClient } from "effect/http";
import { environmentProjects } from "../src/state/projects";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  WS_METHODS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import { Definition } from "@t3tools/plugin-workflows/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import { preloadWorkflowPages } from "@t3tools/plugin-workflows/web";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver, type RpcSession } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, type Atom } from "effect/reactivity";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { vi } from "vite-plus/test";
import * as Auth from "../../server/src/auth/EnvironmentAuth.ts";
import * as Projects from "../../server/src/project/ProjectService.ts";
import {
  startEnvironment,
  makeClient,
  origin,
} from "../../server/src/plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../../server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";

// Bun's native transport stays intact; install only a real DOM for React/Base UI.
// Vitest's jsdom global EventTarget setup is incompatible with this Bun worker.
const binding = await vi.hoisted(async () => {
  const { createRequire } = await import("node:module");
  const {
    JSDOM,
  }: {
    JSDOM: new (
      html: string,
      options: { url: string; pretendToBeVisual: boolean },
    ) => { window: Window & typeof globalThis };
  } = createRequire(import.meta.url)("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000",
    pretendToBeVisual: true,
  });
  for (const key of [
    "window",
    "document",
    "navigator",
    "history",
    "location",
    "screen",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLAnchorElement",
    "HTMLSelectElement",
    "SVGElement",
    "Document",
    "DocumentFragment",
    "Element",
    "Node",
    "MutationObserver",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "DOMRect",
    "ShadowRoot",
    "localStorage",
  ] as const)
    vi.stubGlobal(key, key === "window" ? dom.window : dom.window[key]);
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const)
    vi.stubGlobal(key, dom.window[key].bind(dom.window));
  return {
    entry: null as ConnectionCatalogEntry | null,
    context: null as Context.Context<Supervisor.EnvironmentSupervisor> | null,
    closeDOM: () => dom.window.close(),
  };
});

// Only bind the client connection owner to the isolated real authenticated server.
// Settings, permission/session atoms, contributions, menus and history remain production code.
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
          const entry = binding.entry;
          if (entry === null) return yield* Effect.die("Expected isolated connection");
          const entries = yield* SubscriptionRef.make<
            ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
          >(new Map([[entry.target.environmentId, entry]]));
          const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
          return Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
            entries,
            networkStatus,
            run: (environmentId, effect) =>
              Effect.suspend(() => {
                const context = binding.context;
                return context === null || environmentId !== entry.target.environmentId
                  ? Effect.die("Unexpected client environment")
                  : Effect.provide(effect, context);
              }),
            followStream: (environmentId, stream) =>
              Stream.unwrap(
                Effect.sync(() => {
                  const context = binding.context;
                  if (context === null || environmentId !== entry.target.environmentId)
                    throw new Error("Unexpected client environment");
                  return Stream.concat(Stream.provideContext(stream, context), Stream.never);
                }),
              ),
          });
        }),
      ).pipe(Layer.merge(FetchHttpClient.layer)),
    ),
  };
});

import { ScheduledTasksSettings } from "../src/components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../src/components/settings/SettingsScopeContext";
import { AppAtomRegistryProvider, appAtomRegistry } from "../src/rpc/atomRegistry";
import { availableCatalogAtom } from "../src/plugins/runtime";
import { serverEnvironment } from "../src/state/server";
import { environmentSession } from "../src/state/session";
import { createWorkflowsClient } from "../src/plugins/workflowsClient";

const decodeDefinition = Schema.decodeUnknownSync(Definition);

/** Keep the atom live until this case's scope closes; await its authoritative milestone. */
const until = <A,>(atom: Atom.Atom<A>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    let resolve: () => void = () => {};
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    const release = appAtomRegistry.subscribe(
      atom,
      (value) => {
        if (predicate(value)) resolve();
      },
      { immediate: true },
    );
    yield* Effect.addFinalizer(() => Effect.sync(release));
    yield* Effect.promise(() => ready);
  });

// React owns its act scope; the existing test Effect owns the scoped child fiber.
const actEffect = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Latch.make();
    let complete: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const rendering = yield* Effect.promise(() =>
      act(async () => {
        started.openUnsafe();
        await done;
      }),
    ).pipe(Effect.forkScoped);
    yield* started.await;
    const result = yield* Effect.exit(work).pipe(Effect.ensuring(Effect.sync(() => complete())));
    yield* Fiber.join(rendering);
    return yield* result;
  });

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function openActions(label: string) {
  button(label).focus();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
}

function setText(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function selectOption(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing option: ${label}`);
  found.click();
}

function menuItem(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing menu item: ${label}`);
  return found;
}

it.live("workflow schedule draft survives a transient unavailable connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          binding.closeDOM();
          vi.unstubAllGlobals();
        }),
      );
      yield* Effect.promise(preloadWorkflowPages);
      const config = {
        ...(yield* makeReplayServerConfig("settings-schedule-history")),
        noBrowser: true,
        devUrl: new URL(window.location.origin),
        devAllowedOrigins: [window.location.origin],
        traceTimingEnabled: false,
      };
      const server = yield* startEnvironment(config, [plugin]);
      const environmentId = Context.get(server.context, Host).environmentId;
      const projectId = ProjectId.make("settings-project");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      expect(yield* spawner.exitCode(ChildProcess.make("git", ["init", config.baseDir]))).toBe(0);
      yield* Context.get(server.context, Projects.ProjectService).create({
        commandId: CommandId.make("settings-project"),
        projectId,
        title: "Settings project",
        workspaceRoot: config.baseDir,
      });
      const operator = yield* makeClient(server.context, [
        AuthOrchestrationReadScope,
        AuthOrchestrationOperateScope,
      ]);
      const reader = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
      const scope = { environmentId, projectId };
      yield* operator["plugins.workflows.save"]({
        ...scope,
        expectedRevision: null,
        definition: decodeDefinition({
          version: 1,
          id: "history",
          revision: 1,
          title: "Saved history workflow",
          entry: "done",
          atLimit: "done",
          nodes: [{ id: "done", kind: "end", title: "Done", outcome: "completed" }],
        }),
      });
      yield* operator["plugins.workflows.schedule"]({
        ...scope,
        id: "history",
        title: "Workflow schedule",
        definitionId: "history",
        task: "Keep the saved occurrence",
        workspace: "current",
        enabled: false,
        schedule: { type: "interval", everyMs: 3_600_000 },
      });
      const workflowId = ScheduledTaskId.make("plugin:workflows:history");
      yield* operator["scheduledTasks.runNow"]({
        id: workflowId,
        occurrenceId: "first-occurrence",
      });
      const before = yield* reader["plugins.workflows.schedule-history"]({
        ...scope,
        scheduleId: "history",
      });
      expect(before.occurrences[0]).toMatchObject({
        id: "first-occurrence",
        dispatch: "succeeded",
        run: { state: "completed", definition: { revision: 1 } },
      });
      for (const [id, title, schedule] of [
        ["prompt", "Prompt schedule", { type: "interval", everyMs: 3_600_000 }],
        ["webhook", "Webhook schedule", { type: "webhook" }],
      ] as const)
        yield* operator["scheduledTasks.upsert"]({
          id: ScheduledTaskId.make(id),
          title,
          prompt: "Ordinary prompt stays paused",
          projectId,
          enabled: false,
          schedule,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          runtimeMode: "approval-required",
          interactionMode: "default",
        });
      const snapshot = yield* reader[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
      if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
        return yield* Effect.die("Expected config");
      const initialConfig = snapshot.value.config;
      const target = new PrimaryConnectionTarget({
        environmentId,
        label: "Authenticated Settings",
        httpBaseUrl: origin(server.context),
        wsBaseUrl: origin(server.context).replace("http", "ws"),
      });
      const auth = Context.get(server.context, Auth.EnvironmentAuth);
      const readonlySession = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
      const writableSession = yield* auth.issueSession({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      });
      const prepare = (token: string, baseUrl = origin(server.context)): PreparedConnection => ({
        environmentId,
        label: target.label,
        httpBaseUrl: baseUrl,
        socketUrl: baseUrl.replace("http", "ws"),
        httpAuthorization: { _tag: "Bearer", token },
        target,
      });
      const rpcSession = (client: typeof reader): RpcSession => ({
        client,
        initialConfig: Effect.succeed(initialConfig),
        subscribeServerConfig: (input) => client[WS_METHODS.subscribeServerConfig](input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      });
      const prepared = yield* SubscriptionRef.make(Option.some(prepare(writableSession.token)));
      const session = yield* SubscriptionRef.make(Option.some(rpcSession(operator)));
      const context = yield* Layer.build(
        Layer.mergeAll(
          Layer.mock(Supervisor.EnvironmentSupervisor)({
            target,
            prepared,
            session,
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected",
              desired: true,
              network: "online",
            }),
          }),
          Layer.mock(EnvironmentCacheStore)({
            loadShell: () => Effect.succeedNone,
            saveShell: () => Effect.void,
          }),
          ShellSnapshotLoader.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        ),
      );
      let catalogGate: {
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      } | null = null;
      const invoked: string[] = [];
      const waiting = new Map<string, () => void>();
      const next = (method: string) => new Promise<void>((resolve) => waiting.set(method, resolve));
      binding.entry = { target, profile: Option.none(), enabled: true };
      binding.context = context.pipe(
        Context.add(EnvironmentRpcRequestObserver, {
          observe: ({ method }) =>
            Effect.gen(function* () {
              invoked.push(method);
              const gate = catalogGate;
              if (method === "plugins.catalog" && gate !== null) {
                yield* Deferred.succeed(gate.started, undefined);
                yield* Deferred.await(gate.release);
              }
              return Effect.sync(() => {
                waiting.get(method)?.();
                waiting.delete(method);
              });
            }),
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          appAtomRegistry.dispose();
          binding.context = null;
          binding.entry = null;
        }),
      );
      yield* until(
        environmentSession.sessionStateAtom(environmentId),
        (value) => AsyncResult.isSuccess(value) && value.value.authenticated,
      );
      yield* until(
        availableCatalogAtom(environmentId),
        (catalog) =>
          catalog?.plugins.some(
            (item) => item.manifest.id === "workflows" && item.status === "available",
          ) === true,
      );
      const tasksAtom = serverEnvironment.scheduledTasksLive({ environmentId, input: {} });
      yield* until(
        tasksAtom,
        (value) => AsyncResult.isSuccess(value) && value.value.tasks.length === 3,
      );
      yield* until(environmentProjects.projectsAtom, (projects) =>
        projects.some((project) => project.id === projectId),
      );
      const root = createRoot(document.body.appendChild(document.createElement("div")));
      yield* Effect.addFinalizer(() => Effect.promise(() => act(async () => root.unmount())));
      const router = createRouter({
        history: createMemoryHistory(),
        routeTree: createRootRoute({
          component: () => (
            <SettingsScopeProvider search={{ machine: environmentId }} onChange={() => {}}>
              <ScheduledTasksSettings />
            </SettingsScopeProvider>
          ),
        }),
      });
      yield* Effect.promise(() => router.load());
      yield* Effect.promise(() =>
        act(async () =>
          root.render(
            <AppAtomRegistryProvider>
              <RouterProvider router={router} />
            </AppAtomRegistryProvider>,
          ),
        ),
      );

      const permission = serverEnvironment.upsertScheduledTask.permissionAtom(environmentId);
      yield* until(permission, (allowed) => allowed);
      const libraryRead = next("plugins.workflows.library");
      const previewRead = next("plugins.workflows.preview");
      yield* Effect.promise(() => act(async () => openActions("Actions for Workflow schedule")));
      yield* Effect.promise(() => act(async () => menuItem("Edit").click()));
      yield* Effect.promise(() =>
        act(async () => {
          await libraryRead;
          await previewRead;
        }),
      );
      const taskInput = () => document.querySelector<HTMLTextAreaElement>("#wf-schedule-task")!;
      expect(taskInput()?.value).toBe("Keep the saved occurrence");
      yield* Effect.promise(() =>
        act(async () => {
          setText(taskInput(), "Unsaved reviewer task text");
        }),
      );
      expect(taskInput().value).toBe("Unsaved reviewer task text");
      // Confirm React accepted the native input event, rather than only changing the DOM value.
      expect(document.body.textContent).toContain(
        `${"Unsaved reviewer task text".length}/4000 characters.`,
      );
      yield* Effect.logInfo("HOST_DRAFT_BEFORE", {
        value: taskInput().value,
        reactCharacterCount: `${"Unsaved reviewer task text".length}/4000 characters.`,
      });
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(prepared, Option.none());
          yield* until(
            environmentSession.preparedConnectionValueAtom(environmentId),
            Option.isNone,
          );
        }),
      );
      expect(taskInput()?.value).toBe("Unsaved reviewer task text");
      expect(document.body.textContent).toContain(
        "Disconnected. Saving waits until this environment reconnects.",
      );
      expect(button("Save task").disabled).toBe(true);
      const blocked = invoked.length;
      yield* Effect.promise(() => act(async () => button("Save task").click()));
      expect(invoked.slice(blocked)).not.toContain("plugins.workflows.schedule");
      expect(invoked.slice(blocked)).not.toContain("scheduledTasks.upsert");
      const persistedTask = () =>
        reader["scheduledTasks.list"]({}).pipe(
          Effect.map((result) => result.tasks.find((task) => task.id === workflowId)!),
        );
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        task: "Keep the saved occurrence",
      });

      // The same connection is back, but its actual catalog read is deliberately held.
      // Cached grants/payload do not make the retained editor's Save action usable.
      catalogGate = {
        started: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const repreview = next("plugins.workflows.preview");
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(prepared, Option.some(prepare(writableSession.token)));
          yield* Deferred.await(catalogGate!.started);
        }),
      );
      expect(appAtomRegistry.get(availableCatalogAtom(environmentId))).toBeNull();
      expect(taskInput()?.value).toBe("Unsaved reviewer task text");
      expect(button("Save task").disabled).toBe(true);
      yield* Effect.promise(() => act(async () => button("Save task").click()));
      expect(invoked.slice(blocked)).not.toContain("plugins.workflows.schedule");
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        task: "Keep the saved occurrence",
      });
      yield* actEffect(Deferred.succeed(catalogGate.release, undefined).pipe(Effect.asVoid));
      catalogGate = null;
      yield* Effect.promise(() =>
        act(async () => {
          await repreview;
        }),
      );
      yield* actEffect(until(permission, (allowed) => allowed));
      expect(taskInput()?.value).toBe("Unsaved reviewer task text");
      expect(document.body.textContent).toContain("26/4000 characters.");
      expect(button("Save task").disabled).toBe(false);
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        task: "Keep the saved occurrence",
      });

      // Re-pairing is a real HTTP/WS principal downgrade, not a prop permission flag.
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(session, Option.some(rpcSession(reader)));
          yield* SubscriptionRef.set(prepared, Option.some(prepare(readonlySession.token)));
          yield* until(permission, (allowed) => !allowed);
        }),
      );
      expect(button("Save task").disabled).toBe(true);
      expect(taskInput()?.value).toBe("Unsaved reviewer task text");
      yield* Effect.promise(() => act(async () => button("Save task").click()));
      expect(invoked.slice(blocked)).not.toContain("plugins.workflows.schedule");
      const denied = yield* actEffect(
        reader["plugins.workflows.schedule"]({
          ...scope,
          id: "history",
          definitionId: "history",
          title: "Denied",
          task: "Denied",
          workspace: "current",
          enabled: false,
          schedule: { type: "interval", everyMs: 3_600_000 },
        }).pipe(Effect.flip),
      );
      expect(denied._tag).toBe("EnvironmentAuthorizationError");
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        task: "Keep the saved occurrence",
      });
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(session, Option.some(rpcSession(operator)));
          yield* SubscriptionRef.set(prepared, Option.some(prepare(writableSession.token)));
          yield* until(permission, (allowed) => allowed);
        }),
      );
      expect(button("Save task").disabled).toBe(false);
      const saved = next("plugins.workflows.schedule");
      yield* Effect.promise(() =>
        act(async () => {
          button("Save task").click();
          await saved;
        }),
      );
      yield* actEffect(
        until(
          tasksAtom,
          (value) =>
            AsyncResult.isSuccess(value) &&
            value.value.tasks.some(
              (task) =>
                task.id === workflowId &&
                typeof task.dispatchTarget?.payload === "object" &&
                task.dispatchTarget.payload !== null &&
                "task" in task.dispatchTarget.payload &&
                task.dispatchTarget.payload.task === "Unsaved reviewer task text",
            ),
        ),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        definitionId: "history",
        task: "Unsaved reviewer task text",
        workspace: "current",
      });
      expect(
        yield* actEffect(
          reader["plugins.workflows.schedule-history"]({ ...scope, scheduleId: "history" }),
        ),
      ).toEqual({
        ...before,
        schedule: {
          ...before.schedule,
          payload: {
            definitionId: "history",
            task: "Unsaved reviewer task text",
            workspace: "current",
          },
        },
      });

      // A new schedule uses the same retained host contribution, without a saved payload.
      yield* Effect.promise(() => act(async () => button("New task").click()));
      yield* Effect.promise(() =>
        act(async () =>
          setText(
            document.querySelector<HTMLInputElement>("#scheduled-task-title")!,
            "Unsaved new schedule",
          ),
        ),
      );
      yield* Effect.promise(() =>
        act(async () =>
          document.querySelector<HTMLButtonElement>("#scheduled-task-target")!.click(),
        ),
      );
      const newLibrary = next("plugins.workflows.library");
      yield* Effect.promise(() => act(async () => selectOption("Run a workflow")));
      yield* Effect.promise(() =>
        act(async () => {
          await newLibrary;
        }),
      );
      yield* Effect.promise(() =>
        act(async () =>
          document.querySelector<HTMLButtonElement>("#wf-schedule-workflow")!.click(),
        ),
      );
      const newPreview = next("plugins.workflows.preview");
      yield* Effect.promise(() => act(async () => selectOption("Saved history workflow")));
      yield* Effect.promise(() =>
        act(async () => {
          await newPreview;
        }),
      );
      yield* Effect.promise(() =>
        act(async () => setText(taskInput(), "Unsaved new schedule task")),
      );
      expect(document.body.textContent).toContain("25/4000 characters.");
      expect(taskInput()?.value).toBe("Unsaved new schedule task");
      const newBlocked = invoked.length;
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(prepared, Option.none());
          yield* until(
            environmentSession.preparedConnectionValueAtom(environmentId),
            Option.isNone,
          );
        }),
      );
      expect(taskInput()?.value).toBe("Unsaved new schedule task");
      expect(button("Create task").disabled).toBe(true);
      yield* Effect.promise(() => act(async () => button("Create task").click()));
      const newRepreview = next("plugins.workflows.preview");
      yield* actEffect(SubscriptionRef.set(prepared, Option.some(prepare(writableSession.token))));
      yield* Effect.promise(() =>
        act(async () => {
          await newRepreview;
        }),
      );
      expect(taskInput()?.value).toBe("Unsaved new schedule task");
      expect(button("Create task").disabled).toBe(false);
      expect(invoked.slice(newBlocked)).not.toContain("plugins.workflows.schedule");
      expect(invoked.slice(newBlocked)).not.toContain("scheduledTasks.upsert");
      expect((yield* actEffect(persistedTask())).dispatchTarget?.payload).toMatchObject({
        task: "Unsaved reviewer task text",
      });
      const cachedClient = createWorkflowsClient(environmentId);

      // Restart the same real persisted environment with the plugin removed. Its current
      // descriptor replaces the retained one; neither cached Save nor prompt substitution works.
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(prepared, Option.none());
          yield* SubscriptionRef.set(session, Option.none());
          yield* until(
            environmentSession.preparedConnectionValueAtom(environmentId),
            Option.isNone,
          );
        }),
      );
      const { removedServer, removedClient, removedSession } = yield* actEffect(
        Effect.gen(function* () {
          yield* Fiber.interrupt(server.fiber);
          const removedServer = yield* startEnvironment(config, []);
          expect(Context.get(removedServer.context, Host).environmentId).toBe(environmentId);
          const removedClient = yield* makeClient(removedServer.context, [
            AuthOrchestrationReadScope,
            AuthOrchestrationOperateScope,
          ]);
          const removedSession = yield* Context.get(
            removedServer.context,
            Auth.EnvironmentAuth,
          ).issueSession({ scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] });
          return { removedServer, removedClient, removedSession };
        }),
      );
      yield* actEffect(
        Effect.gen(function* () {
          yield* SubscriptionRef.set(session, Option.some(rpcSession(removedClient)));
          yield* SubscriptionRef.set(
            prepared,
            Option.some(prepare(removedSession.token, origin(removedServer.context))),
          );
          yield* until(
            availableCatalogAtom(environmentId),
            (catalog) =>
              catalog?.plugins.some(
                (item) => item.manifest.id === "workflows" && item.status === "unavailable",
              ) === true,
          );
          yield* until(permission, (allowed) => allowed);
        }),
      );
      expect(taskInput()).toBeNull();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "workflows.start is unavailable",
      );
      expect(document.querySelector("#scheduled-task-prompt")).toBeNull();
      expect(button("Create task").disabled).toBe(true);
      yield* Effect.promise(() => act(async () => button("Create task").click()));
      expect(invoked.slice(newBlocked)).not.toContain("plugins.workflows.schedule");
      expect(invoked.slice(newBlocked)).not.toContain("scheduledTasks.upsert");
      const stale = yield* actEffect(
        Effect.promise(() =>
          cachedClient
            .schedule({
              projectId,
              id: "cached-new",
              definitionId: "history",
              title: "Cached new schedule",
              task: "Cannot bypass removal",
              workspace: "current",
              enabled: false,
              schedule: { type: "interval", everyMs: 3_600_000 },
            })
            .then(
              () => "unexpected success",
              (error: unknown) => (error instanceof Error ? error.message : String(error)),
            ),
        ),
      );
      expect(stale).toContain("unavailable in this environment");
      expect(invoked.slice(newBlocked)).not.toContain("plugins.workflows.schedule");
      const finalTasks = (yield* actEffect(removedClient["scheduledTasks.list"]({}))).tasks;
      expect(finalTasks).toHaveLength(3);
      expect(
        finalTasks.find((task) => task.id === workflowId)?.dispatchTarget?.payload,
      ).toMatchObject({ task: "Unsaved reviewer task text" });
      expect(
        finalTasks.filter((task) => task.dispatchTarget === undefined).map((task) => task.prompt),
      ).toEqual(["Ordinary prompt stays paused", "Ordinary prompt stays paused"]);
      yield* Effect.promise(() => act(async () => button("Cancel").click()));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

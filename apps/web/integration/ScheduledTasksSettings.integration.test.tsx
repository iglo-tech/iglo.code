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
const actEffect = <E, R>(work: Effect.Effect<void, E, R>) =>
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
    yield* result;
  });

function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function switchControl(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (element) => element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing switch: ${label}`);
  return found;
}

function openActions(label: string) {
  button(label).focus();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
  );
}

function closeActions() {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
}

function menuItem(label: string) {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing menu item: ${label}`);
  return found;
}

it.live(
  "read-only Settings opens workflow history while mutations stay guarded after re-pairing",
  () =>
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
        const prepare = (token: string): PreparedConnection => ({
          environmentId,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: target.wsBaseUrl,
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
        const prepared = yield* SubscriptionRef.make(Option.some(prepare(readonlySession.token)));
        const session = yield* SubscriptionRef.make(Option.some(rpcSession(reader)));
        const context = yield* Layer.build(
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
        );
        const invoked: string[] = [];
        const waiting = new Map<string, () => void>();
        const next = (method: string) =>
          new Promise<void>((resolve) => waiting.set(method, resolve));
        binding.entry = { target, profile: Option.none(), enabled: true };
        binding.context = context.pipe(
          Context.add(EnvironmentRpcRequestObserver, {
            observe: ({ method }) =>
              Effect.sync(() => {
                invoked.push(method);
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

        // Exercise the real host trigger and menu, not contribution callbacks or static markup.
        yield* Effect.promise(() =>
          act(async () => button("Actions for Workflow schedule").click()),
        );
        expect(menuItem("Run history").getAttribute("aria-disabled")).not.toBe("true");
        yield* Effect.promise(() => act(async () => closeActions()));
        yield* Effect.promise(() => act(async () => openActions("Actions for Workflow schedule")));
        expect(menuItem("Run history").getAttribute("aria-disabled")).not.toBe("true");
        for (const label of ["Edit", "Run now", "Delete"]) {
          expect(menuItem(label).getAttribute("aria-disabled")).toBe("true");
          yield* Effect.promise(() => act(async () => menuItem(label).click()));
        }
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(button("New task").disabled).toBe(true);
        expect(switchControl("Enable Workflow schedule").getAttribute("aria-disabled")).toBe(
          "true",
        );
        yield* Effect.promise(() =>
          act(async () => {
            switchControl("Enable Workflow schedule").click();
            button("New task").click();
          }),
        );
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(button("Actions for Prompt schedule").disabled).toBe(true);
        expect(button("Actions for Webhook schedule").disabled).toBe(true);
        const read = next("plugins.workflows.schedule-history");
        yield* Effect.promise(() =>
          act(async () => {
            menuItem("Run history").click();
          }),
        );
        yield* Effect.promise(() =>
          act(async () => {
            await read;
          }),
        );
        expect(document.body.textContent).toContain("Run history · Workflow schedule");
        expect(document.body.textContent).toContain("Dispatched");
        expect(document.body.textContent).toContain("Workflow: Completed");
        expect(document.body.textContent).toContain(
          "Saved history workflow · revision 1 (snapshot taken at start)",
        );
        expect(
          yield* reader["plugins.workflows.schedule-history"]({ ...scope, scheduleId: "history" }),
        ).toEqual(before);
        expect(invoked).not.toContain("scheduledTasks.runNow");
        expect(invoked).not.toContain("scheduledTasks.delete");
        expect(invoked).not.toContain("scheduledTasks.setEnabled");
        expect(invoked).not.toContain("scheduledTasks.upsert");
        const denied = yield* Effect.all([
          reader["scheduledTasks.delete"]({ id: workflowId }).pipe(Effect.flip),
          reader["scheduledTasks.setEnabled"]({ id: workflowId, enabled: true }).pipe(Effect.flip),
          reader["scheduledTasks.runNow"]({ id: workflowId }).pipe(Effect.flip),
          reader["scheduledTasks.upsert"]({
            id: ScheduledTaskId.make("denied-create"),
            title: "Denied task",
            prompt: "Cannot write",
            projectId,
            enabled: false,
            schedule: { type: "interval", everyMs: 3_600_000 },
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            runtimeMode: "approval-required",
            interactionMode: "default",
          }).pipe(Effect.flip),
        ]);
        expect(denied.map((error) => error._tag)).toEqual(
          Array(4).fill("EnvironmentAuthorizationError"),
        );
        expect((yield* reader["scheduledTasks.list"]({})).tasks).toHaveLength(3);
        yield* Effect.promise(() => act(async () => button("Done").click()));

        // Genuine HTTP and WS grants both change when the principal re-pairs.
        const permission = serverEnvironment.upsertScheduledTask.permissionAtom(environmentId);
        yield* actEffect(
          Effect.gen(function* () {
            yield* SubscriptionRef.set(session, Option.some(rpcSession(operator)));
            yield* SubscriptionRef.set(prepared, Option.some(prepare(writableSession.token)));
            yield* until(permission, (allowed) => allowed);
          }),
        );
        const changed = next("scheduledTasks.setEnabled");
        yield* Effect.promise(() =>
          act(async () => {
            switchControl("Enable Workflow schedule").click();
            await changed;
          }),
        );
        yield* actEffect(
          until(
            tasksAtom,
            (value) =>
              AsyncResult.isSuccess(value) &&
              value.value.tasks.some((task) => task.id === workflowId && task.enabled),
          ),
        );
        expect(
          (yield* operator["scheduledTasks.list"]({})).tasks.find((task) => task.id === workflowId)
            ?.enabled,
        ).toBe(true);
        expect(button("New task").disabled).toBe(false);
        yield* Effect.promise(() => act(async () => openActions("Actions for Prompt schedule")));
        expect(menuItem("Edit").getAttribute("aria-disabled")).not.toBe("true");
        expect(menuItem("Run now").getAttribute("aria-disabled")).not.toBe("true");
        expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Run history");
        yield* Effect.promise(() => act(async () => closeActions()));
        yield* Effect.promise(() => act(async () => openActions("Actions for Webhook schedule")));
        expect(menuItem("Deliveries").getAttribute("aria-disabled")).not.toBe("true");
        expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Run history");
        yield* Effect.promise(() => act(async () => closeActions()));
        yield* Effect.promise(() => act(async () => openActions("Actions for Workflow schedule")));
        const dispatched = next("scheduledTasks.runNow");
        yield* Effect.promise(() =>
          act(async () => {
            menuItem("Run now").click();
            await dispatched;
          }),
        );
        const after = yield* operator["plugins.workflows.schedule-history"]({
          ...scope,
          scheduleId: "history",
        });
        expect(after.occurrences).toHaveLength(2);
        expect(after.occurrences[1]).toEqual(before.occurrences[0]);

        yield* actEffect(
          Effect.gen(function* () {
            yield* SubscriptionRef.set(session, Option.some(rpcSession(reader)));
            yield* SubscriptionRef.set(prepared, Option.some(prepare(readonlySession.token)));
            yield* until(permission, (allowed) => !allowed);
          }),
        );
        yield* Effect.promise(() => act(async () => openActions("Actions for Workflow schedule")));
        expect(menuItem("Edit").getAttribute("aria-disabled")).toBe("true");
        expect(menuItem("Run now").getAttribute("aria-disabled")).toBe("true");
        expect(menuItem("Delete").getAttribute("aria-disabled")).toBe("true");
        const reread = next("plugins.workflows.schedule-history");
        yield* Effect.promise(() =>
          act(async () => {
            menuItem("Run history").click();
          }),
        );
        yield* Effect.promise(() =>
          act(async () => {
            await reread;
          }),
        );
        expect(document.body.textContent).toContain("Run history · Workflow schedule");
        expect(
          yield* reader["plugins.workflows.schedule-history"]({ ...scope, scheduleId: "history" }),
        ).toEqual(after);
        expect(
          (yield* reader["scheduledTasks.list"]({})).tasks
            .filter((task) => task.id === "prompt" || task.id === "webhook")
            .every((task) => !task.enabled && task.dispatchTarget === undefined),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

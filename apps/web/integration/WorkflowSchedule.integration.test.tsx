import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  WS_METHODS,
  type EnvironmentId,
  type PluginCatalog,
  type ServerConfig,
} from "@t3tools/contracts";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import type { PluginScheduleTargetSaveInput } from "@t3tools/plugin-host-contract/web";
import {
  PluginError,
  type PluginCommandReceipt,
  type PluginLifecycleItem,
  type PluginThreadState,
} from "@t3tools/plugin-host-contract/schema";
import { plugin as workflowPlugin } from "@t3tools/plugin-workflows/server";
import {
  authoringTimings,
  preloadWorkflowPages,
  web as workflowsWeb,
} from "@t3tools/plugin-workflows/web";
import type { WorkflowClient, WorkflowPermissions } from "@t3tools/plugin-workflows/contracts";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { act, type ReactNode } from "react";
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
import { availableCatalogAtom } from "../src/plugins/runtime";
import { appAtomRegistry } from "../src/rpc/atomRegistry";

const projectId = ProjectId.make("same-project");
const HEAD = "a".repeat(40);
const sequence = (revision: number, title: string) => ({
  version: 1,
  id: "sequence",
  revision,
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

// Provider turns are replayed at the execution boundary; everything else is the real backend.
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
          verifyWorkspace: () => Effect.succeed({ head: HEAD, clean: true }),
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
                workspacePath: "/replayed",
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
          interrupt: () => Effect.succeed(null),
          reconcile: () =>
            Effect.succeed({
              kind: "snapshot",
              cursor: 1,
              replayGap: true,
              threads: [...threads.values()],
            } satisfies PluginLifecycleItem),
          lifecycle: () => Stream.never,
        }),
      ),
    );
  }),
};

/** Records requests so the test awaits exact milestones instead of time. */
function track(client: WorkflowClient) {
  const queued = new Map<string, Array<Promise<unknown>>>();
  const waiting = new Map<string, Array<(call: { promise: Promise<unknown> }) => void>>();
  const record = <A,>(method: string, promise: Promise<A>): Promise<A> => {
    const waiter = waiting.get(method)?.shift();
    if (waiter) waiter({ promise });
    else queued.set(method, [...(queued.get(method) ?? []), promise]);
    return promise;
  };
  const permissionWaiters: Array<(value: WorkflowPermissions) => void> = [];
  const wrapped: WorkflowClient = {
    ...client,
    subscribePermissions: (listener) =>
      client.subscribePermissions((value) => {
        listener(value);
        for (const waiter of permissionWaiters.splice(0)) waiter(value);
      }),
    library: (input) => record("library", client.library(input)),
    preview: (input) => record("preview", client.preview(input)),
    scheduleHistory: (input) => record("history", client.scheduleHistory(input)),
  };
  return {
    client: wrapped,
    /** Await the latest call (or the next one) and the render it causes. */
    settle: async (method: string) => {
      const latest = queued.get(method)?.pop();
      queued.delete(method);
      const call =
        latest === undefined
          ? await new Promise<{ promise: Promise<unknown> }>((resolve) =>
              waiting.set(method, [...(waiting.get(method) ?? []), resolve]),
            )
          : { promise: latest };
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

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

it.live(
  "selects a saved workflow in the host's schedule editor and links each occurrence to its run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        const timings = { ...authoringTimings };
        Object.assign(authoringTimings, { searchDelayMs: 0 });
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
                ...(yield* makeReplayServerConfig(`workflow-schedule-${index}`)),
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
              const tracked = track(createWorkflowsClient(environmentId));
              return {
                label,
                environmentId,
                catalog,
                rpc,
                directory: `${config.baseDir}/.t3code/workflows`,
                tracked,
                target: bind(workflowsWeb, tracked.client).scheduleTargets[0]!,
                grantWrite: SubscriptionRef.set(prepared, Option.some(prepare(writable.token))),
              };
            }),
        );
        const [first, second] = environments as [
          (typeof environments)[number],
          (typeof environments)[number],
        ];
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
        // The contribution names the server target the environment publishes.
        expect(first.target.id).toBe("workflows.start");
        expect(
          first.catalog.plugins.find((item) => item.manifest.id === "workflows")!.manifest.server
            .scheduleTargets,
        ).toContain(first.target.id);
        yield* fs.makeDirectory(first.directory, { recursive: true });
        yield* fs.writeFileString(
          `${first.directory}/sequence.yaml`,
          Yaml.stringify(sequence(1, "Release notes")),
        );

        const navigations: Array<unknown> = [];
        const contextFor = (
          environment: (typeof environments)[number],
          connection: "connected" | "disconnected" = "connected",
        ) =>
          createPluginWebContext({
            environmentId: environment.environmentId,
            environmentLabel: environment.label,
            descriptor: environment.catalog.plugins.find(
              (item) => item.manifest.id === "workflows",
            )!,
            projectId: null,
            threadId: null,
            connection,
            navigate: ((options: unknown) => {
              navigations.push(options);
              return Promise.resolve();
            }) as unknown as Parameters<typeof createPluginWebContext>[0]["navigate"],
            storage: null,
          });
        let renderer: ReactTestRenderer | undefined;
        const show = (node: ReactNode) =>
          act(async () => {
            if (renderer === undefined) renderer = create(<>{node}</>);
            else renderer.update(<>{node}</>);
          });
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await act(async () => renderer?.unmount());
            appAtomRegistry.dispose();
            vi.unstubAllGlobals();
          }),
        );
        const root = () => renderer!.root;
        const page = () => textOf(root());
        const control = (type: unknown, key: string) =>
          root().find(
            (node) => node.type === type && (node.props.id === key || node.props.ariaLabel === key),
          );
        const promise = <A,>(run: () => Promise<A>) => Effect.promise(run);
        const { tracked } = first;

        // Editor: the server's saved workflow and its dispatch-time revision semantics.
        const reported: Array<unknown> = [];
        const editor = (environment = first, payload: unknown = null, connection = "connected") =>
          environment.target.renderEditor(
            contextFor(environment, connection as "connected" | "disconnected"),
            { projectId, payload, onChange: (value) => reported.push(value) },
          );
        yield* promise(() => show(editor()));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() =>
          act(async () => control(pluginDesign.Select, "Workflow").props.onChange("sequence")),
        );
        yield* promise(() => tracked.settle("preview"));
        expect(page()).toContain("Release notes");
        expect(page()).toContain("Currently saved: revision 1");
        expect(page()).toContain(
          "Each occurrence starts the workflow as it is saved when that occurrence runs, not necessarily revision 1.",
        );
        // A read-only pairing cannot save; nothing is offered to the host.
        expect(page()).toContain("This connection cannot schedule workflows.");
        expect(reported.at(-1)).toBeNull();
        const granted = tracked.permissions((value) => value.schedule);
        yield* first.grantWrite;
        yield* promise(() => granted);
        yield* promise(() => act(async () => {}));
        expect(reported.at(-1)).toEqual({
          definitionId: "sequence",
          task: "",
          workspace: "new-worktree",
        });
        yield* promise(() =>
          act(async () =>
            control(pluginDesign.Textarea, "Task").props.onChange("Draft the release notes"),
          ),
        );
        yield* promise(() =>
          act(async () => control(pluginDesign.Select, "Workspace").props.onChange("current")),
        );
        const payload = reported.at(-1) as PluginScheduleTargetSaveInput["payload"];
        expect(payload).toEqual({
          definitionId: "sequence",
          task: "Draft the release notes",
          workspace: "current",
        });

        // The host saves its common fields through the plugin's validating API.
        yield* promise(() =>
          first.target.save({
            id: "nightly",
            title: "Nightly notes",
            projectId,
            schedule: { type: "interval", everyMs: 3_600_000 },
            enabled: true,
            payload,
          }),
        );
        const taskId = ScheduledTaskId.make("plugin:workflows:nightly");
        const saved = (yield* first.rpc["scheduledTasks.list"]({})).tasks.find(
          (task) => task.id === taskId,
        );
        expect(saved?.dispatchTarget).toMatchObject({ id: "workflows.start", payload });

        // Editing reopens the saved selection and task in a fresh editor.
        yield* promise(() => show(null));
        yield* promise(() => show(editor(first, saved!.dispatchTarget!.payload)));
        yield* promise(() => tracked.settle("library"));
        yield* promise(() => tracked.settle("preview"));
        expect(control(pluginDesign.Select, "Workflow").props.value).toBe("sequence");
        expect(control(pluginDesign.Textarea, "Task").props.value).toBe("Draft the release notes");

        // History: the dispatch receipt and the exact run, each with its own status.
        const history = (revision: string, connection = "connected", environment = first) =>
          environment.target.renderHistory(
            contextFor(environment, connection as "connected" | "disconnected"),
            { projectId, scheduleId: "nightly", revision },
          );
        yield* promise(() => show(history("0")));
        yield* promise(() => tracked.settle("history"));
        expect(page()).toContain(
          "Release notes: each occurrence uses the revision saved when it runs (currently 1).",
        );
        expect(page()).toContain("Draft the release notes");
        expect(page()).toContain("No occurrences yet.");
        yield* first.rpc["scheduledTasks.runNow"]({ id: taskId });
        yield* promise(() => show(history("1")));
        yield* promise(() => tracked.settle("history"));
        expect(page()).toContain("Dispatched");
        expect(page()).toContain("Workflow: Running");
        expect(page()).toContain("Release notes · revision 1 (snapshot taken at start)");

        // A later occurrence starts the revision saved by then; the first keeps its snapshot.
        yield* fs.writeFileString(
          `${first.directory}/sequence.yaml`,
          Yaml.stringify(sequence(2, "Release notes v2")),
        );
        yield* first.rpc["scheduledTasks.runNow"]({ id: taskId });
        yield* promise(() => show(history("2")));
        yield* promise(() => tracked.settle("history"));
        const listed = page();
        expect(listed).toContain("currently 2");
        expect(listed).toContain("Release notes v2 · revision 2 (snapshot taken at start)");
        expect(listed).toContain("Release notes · revision 1 (snapshot taken at start)");
        const open = root().findAll(
          (node) => node.type === pluginDesign.Button && textOf(node) === "Open run",
        );
        expect(open).toHaveLength(2);
        yield* promise(() => act(async () => open[1]!.props.onClick()));
        const runs = (yield* first.rpc["plugins.workflows.list"]({
          environmentId: first.environmentId,
          projectId,
        })) as ReadonlyArray<{ id: string; definition: { revision: number } }>;
        const oldest = runs.find((run) => run.definition.revision === 1)!;
        expect(navigations.at(-1)).toMatchObject({
          params: { environmentId: first.environmentId, pageId: "workflows.runs" },
          search: { pluginProjectId: projectId, pluginState: { run: oldest.id } },
        });

        // Disconnected: the last history stays visible and is marked as possibly stale.
        yield* promise(() => show(history("2", "disconnected")));
        expect(page()).toContain(
          "Disconnected. Showing the last loaded history; it may be out of date.",
        );
        expect(page()).toContain("Release notes v2 · revision 2");

        // Another environment with a similarly named project shows nothing of this schedule.
        yield* promise(() => show(history("0", "connected", second)));
        yield* promise(() => second.tracked.settle("history"));
        expect(page()).toContain("Workflows does not own this schedule in this project");
        expect((yield* second.rpc["scheduledTasks.list"]({})).tasks).toEqual([]);

        // A disconnected editor offers nothing to save.
        yield* promise(() => show(editor(first, payload, "disconnected")));
        expect(page()).toContain("Disconnected. Saving waits until this environment reconnects.");
        expect(reported.at(-1)).toBeNull();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 60_000 },
);

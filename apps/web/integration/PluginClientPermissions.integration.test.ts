import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  ProjectId,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { Definition } from "@t3tools/plugin-workflows/contracts";
import * as Schema from "effect/Schema";
import { Host } from "@t3tools/plugin-host-contract/server";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import * as Auth from "../../server/src/auth/EnvironmentAuth.ts";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { FixturePermissions } from "@t3tools/plugin-fixture/contracts";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi } from "vite-plus/test";

import {
  startEnvironment,
  makeClient,
  origin,
} from "../../server/src/plugins/PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../../server/src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const binding = vi.hoisted(() => ({
  environmentId: null as EnvironmentId | null,
  config: null as ServerConfig | null,
  context: null as Context.Context<Supervisor.EnvironmentSupervisor> | null,
}));

// Bind the production client to the test's authenticated server session.
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
                if (binding.context === null || binding.environmentId !== environmentId)
                  return Effect.die("Unexpected client environment");
                return Effect.provide(effect, binding.context);
              }),
            followStream: (environmentId, stream) =>
              Stream.unwrap(
                Effect.sync(() => {
                  if (binding.context === null || binding.environmentId !== environmentId)
                    throw new Error("Unexpected client environment");
                  return Stream.concat(
                    Stream.provideContext(stream, binding.context),
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
vi.mock("../src/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() => Atom.make(Option.some(true))),
      initialConfigValueAtom: Atom.family(() => Atom.make(binding.config)),
    },
  };
});

import { availableCatalogAtom, createFixtureClient } from "../src/plugins/runtime";
import { createWorkflowsClient } from "../src/plugins/workflowsClient";

const decodeDefinition = Schema.decodeUnknownSync(Definition);
import { appAtomRegistry } from "../src/rpc/atomRegistry";

it.live(
  "guards Reports mutations and refreshes their availability after re-pairing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = {
          ...(yield* makeReplayServerConfig("reports-permissions")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config);
        const environmentId = Context.get(server.context, Host).environmentId;
        const rpc = yield* makeClient(server.context, [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
        if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
          return yield* Effect.die("Expected config");
        const initialConfig = snapshot.value.config;
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "Test",
          httpBaseUrl: origin(server.context),
          wsBaseUrl: origin(server.context).replace("http", "ws"),
        });
        const auth = Context.get(server.context, Auth.EnvironmentAuth);
        const prepare = (token: string): PreparedConnection => ({
          environmentId,
          label: "Test",
          httpBaseUrl: origin(server.context),
          socketUrl: target.wsBaseUrl,
          httpAuthorization: { _tag: "Bearer", token },
          target,
        });
        const readOnly = yield* auth.issueSession({ scopes: [AuthOrchestrationReadScope] });
        const prepared = yield* SubscriptionRef.make(Option.some(prepare(readOnly.token)));
        const session: RpcSession = {
          client: rpc,
          initialConfig: Effect.succeed(initialConfig),
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
        const invoked: string[] = [];
        binding.environmentId = environmentId;
        binding.config = initialConfig;
        binding.context = context.pipe(
          Context.add(EnvironmentRpcRequestObserver, {
            observe: ({ method }) =>
              Effect.sync(() => {
                invoked.push(method);
                return Effect.void;
              }),
          }),
        );
        const client = createFixtureClient(environmentId);
        const changed = yield* Queue.unbounded<FixturePermissions>();
        const unsubscribe = client.subscribePermissions((value) => {
          Queue.offerUnsafe(changed, value);
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        const awaitGrant = (allowed: boolean) =>
          Stream.fromQueue(changed).pipe(
            Stream.filter((value) => value.resolve === allowed && value.schedule === allowed),
            Stream.take(1),
            Stream.runDrain,
          );
        yield* Effect.promise(() => client.list({}));
        const catalogReady = yield* Deferred.make<void>();
        const releaseCatalog = appAtomRegistry.subscribe(
          availableCatalogAtom(environmentId),
          (catalog) => {
            if (catalog !== null) Deferred.doneUnsafe(catalogReady, Effect.void);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseCatalog));
        yield* Deferred.await(catalogReady);
        const reportsReady = yield* Deferred.make<void, string>();
        const releaseReports = client.subscribe(
          {},
          () => Deferred.doneUnsafe(reportsReady, Effect.void),
          (error) => Deferred.doneUnsafe(reportsReady, Effect.fail(error)),
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseReports));
        yield* Deferred.await(reportsReady);
        const workflows = createWorkflowsClient(environmentId);
        const projectId = ProjectId.make("missing-project");
        const definition = decodeDefinition({
          version: 1,
          id: "guarded",
          revision: 1,
          title: "Guarded",
          entry: "done",
          atLimit: "done",
          nodes: [{ id: "done", kind: "end", title: "Done", outcome: "completed" }],
        });
        for (const command of [
          () => client.resolve("missing"),
          () => client.schedule("missing", 60000),
          () => workflows.save({ projectId, definition, expectedRevision: null }),
          () =>
            workflows.replace({
              projectId,
              source: ".t3code/workflows/guarded.yaml",
              fingerprint: "0".repeat(64),
              definition,
            }),
          () =>
            workflows.startSaved({
              projectId,
              clientRequestId: "guarded",
              definitionId: "guarded",
              revision: 1,
              task: "",
              workspace: "new-worktree",
            }),
          ...(["cancel", "retry", "resume"] as const).map(
            (action) => () =>
              workflows[action]({
                projectId,
                runId: "missing-run",
                clientRequestId: action,
                expectedRevision: 1,
              }),
          ),
          () =>
            workflows.gate({
              projectId,
              runId: "missing-run",
              clientRequestId: "gate",
              expectedRevision: 1,
              decision: "approve",
            }),
          () =>
            workflows.schedule({
              projectId,
              id: "guarded",
              title: "Guarded",
              definitionId: "guarded",
              task: "",
              workspace: "new-worktree",
              enabled: true,
              schedule: { type: "interval", everyMs: 60000 },
            }),
        ]) {
          yield* Effect.promise(() =>
            expect(command()).rejects.toMatchObject({ _tag: "EnvironmentAuthorizationError" }),
          );
        }
        expect(
          invoked.filter((method) =>
            [
              "plugins.fixture.resolve",
              "plugins.fixture.schedule",
              "plugins.workflows.save",
              "plugins.workflows.replace",
              "plugins.workflows.launch",
              "plugins.workflows.cancel",
              "plugins.workflows.retry",
              "plugins.workflows.resume",
              "plugins.workflows.gate",
              "plugins.workflows.schedule",
            ].includes(method),
          ),
        ).toEqual([]);
        const writable = yield* auth.issueSession({
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        });
        yield* SubscriptionRef.set(prepared, Option.some(prepare(writable.token)));
        yield* awaitGrant(true);
        // Missing reports return a domain error only after the authorized RPC reaches the server.
        yield* Effect.promise(() =>
          expect(client.resolve("missing")).rejects.toMatchObject({ _tag: "PluginError" }),
        );
        expect(invoked).toContain("plugins.fixture.resolve");
        yield* SubscriptionRef.set(prepared, Option.some(prepare(readOnly.token)));
        yield* awaitGrant(false);
        const callsBefore = invoked.length;
        yield* Effect.promise(() =>
          expect(client.schedule("missing", 60000)).rejects.toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          }),
        );
        expect(invoked.slice(callsBefore)).not.toContain("plugins.fixture.schedule");
        appAtomRegistry.dispose();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

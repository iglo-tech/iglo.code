import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { plugin as fixture } from "@t3tools/plugin-fixture/server";
import { Host } from "@t3tools/plugin-host-contract/server";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  EnvironmentSupervisor as Supervisor,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentRpcRequestObserver,
  EnvironmentRpcSubscriptionObserver,
} from "@t3tools/client-runtime/rpc";
import type { RpcSession } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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
  setConnected: (_value: boolean) => {},
}));

// Bind the production client to the test's authenticated server session.
vi.mock("../src/connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
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
                  return Stream.provideContext(stream, binding.context);
                }),
              ),
          });
        }),
      ),
    ),
  };
});
vi.mock("../src/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const { appAtomRegistry } = await import("../src/rpc/atomRegistry");
  const connected = Atom.make(true);
  binding.setConnected = (value: boolean) => appAtomRegistry.set(connected, value);
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() =>
        Atom.make((get) => (get(connected) ? Option.some(true) : Option.none())),
      ),
      initialConfigValueAtom: Atom.family(() => Atom.make(binding.config)),
    },
  };
});

import { availableCatalogAtom, createFixtureClient } from "../src/plugins/runtime";
import { appAtomRegistry } from "../src/rpc/atomRegistry";

it.live(
  "does not issue an absent subscription while refreshed catalog is pending",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => appAtomRegistry.dispose()));
        const absent = new Set(["plugins.fixture.subscribe"]);
        const older = {
          ...fixture,
          manifest: {
            ...fixture.manifest,
            version: "0.9.0",
            server: {
              ...fixture.manifest.server,
              api: fixture.manifest.server.api.filter((id) => !absent.has(id)),
            },
          },
          acquire: fixture.acquire.pipe(
            Effect.map((services) => ({
              ...services,
              api: services.api.filter((api) => !absent.has(api.rpc._tag)),
            })),
          ),
        };
        const config = {
          ...(yield* makeReplayServerConfig("plugin-client-reconnect")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const invoked: string[] = [];
        const start = (plugins: (typeof fixture)[]) =>
          Effect.gen(function* () {
            const server = yield* startEnvironment(config, plugins);
            const environmentId = Context.get(server.context, Host).environmentId;
            const rpc = yield* makeClient(server.context, [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
            if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
              return yield* Effect.die("Expected a server config snapshot");
            return { ...server, environmentId, rpc, initialConfig: snapshot.value.config };
          });
        const first = yield* start([fixture]);
        const refreshStarted = yield* Deferred.make<void>();
        const allowRefresh = yield* Deferred.make<void>();
        const bindSession = (server: typeof first, delayCatalog: boolean) =>
          Effect.gen(function* () {
            const rpc = server.rpc;
            const session: RpcSession = {
              client: rpc,
              initialConfig: Effect.succeed(server.initialConfig),
              subscribeServerConfig: (input) => rpc[WS_METHODS.subscribeServerConfig](input),
              ready: Effect.void,
              probe: Effect.void,
              closed: Effect.never,
            };
            const context = yield* Layer.build(
              Layer.mock(Supervisor.EnvironmentSupervisor)({
                target: new PrimaryConnectionTarget({
                  environmentId: server.environmentId,
                  label: "Test",
                  httpBaseUrl: origin(server.context),
                  wsBaseUrl: origin(server.context).replace("http", "ws"),
                }),
                session: yield* SubscriptionRef.make(Option.some(session)),
                state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
                prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
              }),
            );
            binding.environmentId = server.environmentId;
            binding.config = server.initialConfig;
            binding.context = context.pipe(
              Context.add(EnvironmentRpcRequestObserver, {
                observe: ({ method }) =>
                  Effect.gen(function* () {
                    invoked.push(method);
                    if (delayCatalog && method === "plugins.catalog") {
                      yield* Deferred.succeed(refreshStarted, undefined);
                      yield* Deferred.await(allowRefresh);
                    }
                    return Effect.void;
                  }),
              }),
              Context.add(EnvironmentRpcSubscriptionObserver, {
                observe: ({ method }) =>
                  Effect.sync(() => {
                    invoked.push(method);
                    return Effect.void;
                  }),
              }),
            );
          });
        yield* bindSession(first, false);
        const ready = yield* Deferred.make<void>();
        const release = appAtomRegistry.subscribe(
          availableCatalogAtom(first.environmentId),
          (cat) => {
            if (cat !== null) Deferred.doneUnsafe(ready, Effect.void);
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() => Effect.sync(release));
        yield* Deferred.await(ready);
        expect(
          appAtomRegistry.get(availableCatalogAtom(first.environmentId))?.plugins[0]?.manifest
            .server.api,
        ).toContain("plugins.fixture.subscribe");
        yield* Fiber.interrupt(first.fiber);
        const second = yield* start([older]);
        expect(second.environmentId).toBe(first.environmentId);
        const actualCatalog = yield* second.rpc["plugins.catalog"]({
          environmentId: second.environmentId,
        });
        expect(actualCatalog.plugins[0]).toMatchObject({
          status: "available",
          manifest: { hostVersion: 1 },
        });
        expect(actualCatalog.plugins[0]?.manifest.server.api).not.toContain(
          "plugins.fixture.subscribe",
        );
        yield* bindSession(second, true);
        // Rapid reconnect: old catalog is invalidated, the new descriptor has not arrived.
        binding.setConnected(false);
        expect(appAtomRegistry.get(availableCatalogAtom(first.environmentId))).toBeNull();
        binding.setConnected(true);
        yield* Deferred.await(refreshStarted);
        invoked.length = 0;
        const ended = yield* Deferred.make<string>();
        const client = createFixtureClient(second.environmentId);
        const releaseReports = client.subscribe(
          {},
          () => {},
          (message) => Deferred.doneUnsafe(ended, Effect.succeed(message)),
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseReports));
        expect(yield* Deferred.await(ended)).toContain("unavailable");
        expect(invoked).not.toContain("plugins.fixture.subscribe");
        yield* Deferred.succeed(allowRefresh, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

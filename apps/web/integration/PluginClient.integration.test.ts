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
}));

// Bind the production client to the test's authenticated server session.
vi.mock("../src/connection/runtime", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
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
  const { Atom } = await import("effect/unstable/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: Atom.family(() => Atom.make(Option.some(true))),
      initialConfigValueAtom: Atom.family(() => Atom.make(binding.config)),
    },
  };
});

import { availableCatalogAtom, createFixtureClient } from "../src/plugins/runtime";
import { appAtomRegistry } from "../src/rpc/atomRegistry";

it.live(
  "does not invoke commands or subscriptions absent from a compatible plugin descriptor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const absent = new Set([
          "plugins.fixture.resolve",
          "plugins.fixture.schedule",
          "plugins.fixture.subscribe",
        ]);
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
          ...(yield* makeReplayServerConfig("plugin-client-downgrade")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [older]);
        const environmentId = Context.get(server.context, Host).environmentId;
        const rpc = yield* makeClient(server.context, [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
        ]);
        const snapshot = yield* rpc[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.runHead);
        if (Option.isNone(snapshot) || snapshot.value.type !== "snapshot")
          return yield* Effect.die("Expected a server config snapshot");
        const initialConfig = snapshot.value.config;
        const session: RpcSession = {
          client: rpc,
          initialConfig: Effect.succeed(initialConfig),
          subscribeServerConfig: (input) => rpc[WS_METHODS.subscribeServerConfig](input),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const invoked: string[] = [];
        const context = yield* Layer.build(
          Layer.mock(Supervisor.EnvironmentSupervisor)({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Test environment",
              httpBaseUrl: origin(server.context),
              wsBaseUrl: origin(server.context).replace("http", "ws"),
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          }),
        );
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
          Context.add(EnvironmentRpcSubscriptionObserver, {
            observe: ({ method }) =>
              Effect.sync(() => {
                invoked.push(method);
                return Effect.void;
              }),
          }),
        );
        const client = createFixtureClient(environmentId);
        expect(yield* Effect.promise(() => client.list({}))).toEqual([]);
        for (const command of [
          () => client.resolve("missing"),
          () => client.schedule("missing", 60000),
        ])
          yield* Effect.promise(() =>
            expect(command()).rejects.toMatchObject({ _tag: "PluginError" }),
          );

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
        const ended = yield* Deferred.make<string>();
        const releaseReports = client.subscribe(
          {},
          () => {},
          (error) => {
            Deferred.doneUnsafe(ended, Effect.succeed(error));
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(releaseReports));
        expect(yield* Deferred.await(ended)).toContain("unavailable");
        expect(invoked).toContain("plugins.fixture.list");
        expect(invoked.filter((method) => absent.has(method))).toEqual([]);
        appAtomRegistry.dispose();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 30000 },
);

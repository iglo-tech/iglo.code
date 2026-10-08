import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { PluginError } from "@t3tools/contracts";
import {
  ListInput as ListInputSchema,
  type FixtureClient,
  type ListInput,
} from "@t3tools/plugin-fixture/contracts";
import {
  getInitialServerConfig,
  request,
  requestGuarded,
  subscribe,
} from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  followStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import type { EnvironmentAuthorizationError } from "@t3tools/contracts";
import type { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { createPluginAtoms } from "./atoms";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

export const supportsPlugins = (config: ServerConfig | null) =>
  config?.environment.capabilities.pluginHost === 1;
export const pluginConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    Option.isSome(get(environmentSession.preparedConnectionValueAtom(environmentId))),
  ),
);
const models = createPluginAtoms(connectionAtomRuntime, {
  connected: pluginConnectedAtom,
  supported: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      supportsPlugins(get(environmentSession.initialConfigValueAtom(environmentId))),
    ),
  ),
  catalog: (environmentId) =>
    followStreamInEnvironment(
      environmentId,
      Stream.concat(
        Stream.succeed(null),
        Stream.fromEffect(request("plugins.catalog", { environmentId })),
      ),
    ),
  attention: (environmentId) =>
    followStreamInEnvironment(environmentId, subscribe("plugins.attention", { environmentId })),
});
export const catalogAtom = models.catalog;
export const availableCatalogAtom = models.availableCatalog;
export const attentionAtom = models.attention;

const unavailable = (pluginId: string, message: string) =>
  new PluginError({ pluginId, operation: "client", code: "unavailable", message });
/** Verify the selected environment still publishes this plugin API before calling it. */
export const authorizePluginApi = (
  plugin: { readonly id: string; readonly displayName: string },
  environmentId: EnvironmentId,
  method: string,
): Effect.Effect<
  void,
  PluginError | EnvironmentAuthorizationError | EnvironmentRpcUnavailableError | RpcClientError,
  EnvironmentSupervisor.EnvironmentSupervisor
> =>
  Effect.gen(function* () {
    if (!supportsPlugins(yield* getInitialServerConfig()))
      return yield* new PluginError({
        pluginId: plugin.id,
        operation: "client",
        code: "unsupported",
        message: "This environment does not support this plugin interface.",
      });
    const catalog = yield* request("plugins.catalog", { environmentId });
    if (
      catalog.environmentId !== environmentId ||
      !catalog.plugins.some(
        (item) =>
          item.manifest.id === plugin.id &&
          item.manifest.hostVersion === 1 &&
          item.manifest.server.api.includes(method) &&
          item.status === "available",
      )
    )
      return yield* unavailable(
        plugin.id,
        `${plugin.displayName} is unavailable in this environment.`,
      );
  }).pipe(
    Effect.catchTags({
      ConnectionBlockedError: (cause) => Effect.fail(unavailable(plugin.id, cause.message)),
      ConnectionTransientError: (cause) => Effect.fail(unavailable(plugin.id, cause.message)),
    }),
  );
const fixture = { id: "fixture", displayName: "Reports" };
const authorize = (environmentId: EnvironmentId, method: string) =>
  authorizePluginApi(fixture, environmentId, method);
const list = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.fixture.list",
  execute: (input: ListInput) =>
    authorize(input.environmentId, "plugins.fixture.list").pipe(
      Effect.andThen(request("plugins.fixture.list", input)),
    ),
});
const resolve = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.fixture.resolve",
  tag: "plugins.fixture.resolve",
  execute: (input: { environmentId: EnvironmentId; id: string }) =>
    authorize(input.environmentId, "plugins.fixture.resolve").pipe(
      Effect.andThen(requestGuarded("plugins.fixture.resolve", input)),
    ),
});
const schedule = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "plugins.fixture.schedule",
  tag: "plugins.fixture.schedule",
  execute: (input: { environmentId: EnvironmentId; id: string; everyMs: number }) =>
    authorize(input.environmentId, "plugins.fixture.schedule").pipe(
      Effect.andThen(requestGuarded("plugins.fixture.schedule", input)),
    ),
});
const encodeKey = Schema.encodeSync(Schema.fromJsonString(ListInputSchema));
const permissionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => ({
    resolve: get(resolve.permissionAtom(environmentId)),
    schedule: get(schedule.permissionAtom(environmentId)),
  })),
);
const decodeKey = Schema.decodeUnknownSync(Schema.fromJsonString(ListInputSchema));
const reportsAtom = Atom.family((key: string) => {
  const input = decodeKey(key);
  return connectionAtomRuntime
    .atom((get) => {
      const catalog = get(availableCatalogAtom(input.environmentId));
      if (
        catalog?.environmentId !== input.environmentId ||
        !catalog.plugins.some(
          (plugin) =>
            plugin.manifest.id === "fixture" &&
            plugin.manifest.hostVersion === 1 &&
            plugin.manifest.server.api.includes("plugins.fixture.subscribe") &&
            plugin.status === "available",
        )
      )
        return Stream.fail(
          new PluginError({
            pluginId: "fixture",
            operation: "subscribe",
            code: "unavailable",
            message: "Reports is unavailable or disconnected in this environment.",
          }),
        );
      return followStreamInEnvironment(
        input.environmentId,
        subscribe("plugins.fixture.subscribe", input),
      );
    })
    .pipe(Atom.setIdleTTL(0));
});

export function createFixtureClient(environmentId: EnvironmentId): FixtureClient {
  return {
    subscribePermissions: (onPermissions) =>
      appAtomRegistry.subscribe(permissionsAtom(environmentId), onPermissions, { immediate: true }),
    list: async (input) => {
      const result = await list.run(appAtomRegistry, {
        environmentId,
        input: { ...input, environmentId },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    resolve: async (id) => {
      const result = await resolve.run(appAtomRegistry, {
        environmentId,
        input: { id, environmentId },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      return result.value;
    },
    schedule: async (id, everyMs) => {
      const result = await schedule.run(appAtomRegistry, {
        environmentId,
        input: { id, everyMs, environmentId },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
    },
    subscribe: (input, onReports, onError) =>
      appAtomRegistry.subscribe(
        reportsAtom(encodeKey({ ...input, environmentId })),
        (result) => {
          if (result._tag === "Success") onReports(result.value);
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            onError(error instanceof Error ? error.message : "Reports subscription ended.");
          }
        },
        { immediate: true },
      ),
  };
}

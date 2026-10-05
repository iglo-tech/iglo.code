import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { PluginError } from "@t3tools/contracts";
import {
  ListInput as ListInputSchema,
  type FixtureClient,
  type ListInput,
} from "@t3tools/plugin-fixture/contracts";
import { getInitialServerConfig, request, subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentCommand,
  followStreamInEnvironment,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { createPluginAtoms } from "./atoms";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

export const supportsPlugins = (config: ServerConfig | null) =>
  config?.environment.capabilities.pluginHost === 1;
const models = createPluginAtoms(connectionAtomRuntime, {
  connected: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.isSome(get(environmentSession.preparedConnectionValueAtom(environmentId))),
    ),
  ),
  supported: Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      supportsPlugins(get(environmentSession.initialConfigValueAtom(environmentId))),
    ),
  ),
  catalog: (environmentId) =>
    followStreamInEnvironment(
      environmentId,
      Stream.fromEffect(request("plugins.catalog", { environmentId })),
    ),
  attention: (environmentId) =>
    followStreamInEnvironment(environmentId, subscribe("plugins.attention", { environmentId })),
});
export const catalogAtom = models.catalog;
export const availableCatalogAtom = models.availableCatalog;
export const attentionAtom = models.attention;

const authorize = (environmentId: EnvironmentId, method: string) =>
  Effect.gen(function* () {
    if (!supportsPlugins(yield* getInitialServerConfig()))
      return yield* new PluginError({
        pluginId: "fixture",
        operation: "client",
        code: "unsupported",
        message: "This environment does not support this plugin interface.",
      });
    const catalog = yield* request("plugins.catalog", { environmentId });
    if (
      catalog.environmentId !== environmentId ||
      !catalog.plugins.some(
        (plugin) =>
          plugin.manifest.id === "fixture" &&
          plugin.manifest.hostVersion === 1 &&
          plugin.manifest.server.api.includes(method) &&
          plugin.status === "available",
      )
    )
      return yield* new PluginError({
        pluginId: "fixture",
        operation: "client",
        code: "unavailable",
        message: "Reports is unavailable in this environment.",
      });
  });
const list = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.fixture.list",
  execute: (input: ListInput) =>
    authorize(input.environmentId, "plugins.fixture.list").pipe(
      Effect.andThen(request("plugins.fixture.list", input)),
    ),
});
const resolve = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.fixture.resolve",
  execute: (input: { environmentId: EnvironmentId; id: string }) =>
    authorize(input.environmentId, "plugins.fixture.resolve").pipe(
      Effect.andThen(request("plugins.fixture.resolve", input)),
    ),
});
const schedule = createEnvironmentCommand(connectionAtomRuntime, {
  label: "plugins.fixture.schedule",
  execute: (input: { environmentId: EnvironmentId; id: string; everyMs: number }) =>
    authorize(input.environmentId, "plugins.fixture.schedule").pipe(
      Effect.andThen(request("plugins.fixture.schedule", input)),
    ),
});
const encodeKey = Schema.encodeSync(Schema.fromJsonString(ListInputSchema));
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

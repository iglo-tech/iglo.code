import { plugin } from "@t3tools/plugin-fixture/server";
import { Host, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import * as HostAdapter from "@t3tools/plugin-host-adapter/host";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import {
  ListRpc,
  ResolveRpc,
  ScheduleRpc,
  SubscribeRpc,
  Reports,
  Report,
  apiScopes,
} from "@t3tools/plugin-fixture/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";

const decodeReports = Schema.decodeUnknownEffect(Reports);

/** Trusted server modules explicitly included in this build. An empty list is supported. */
export class CompiledPlugins extends Context.Reference<ReadonlyArray<ServerPlugin>>(
  "t3/plugins/CompiledPlugins",
  { defaultValue: () => [plugin] },
) {}
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* Host;
    const config = yield* ServerConfig.ServerConfig;
    const compiledPlugins = yield* CompiledPlugins;
    return Registry.layer({
      environmentId: host.environmentId,
      directory: `${config.stateDir}/plugins`,
      plugins: compiledPlugins,
      clientApis: new Map(
        [ListRpc, ResolveRpc, ScheduleRpc, SubscribeRpc].map((rpc) => [
          rpc._tag,
          { rpc, requiredScope: apiScopes[rpc._tag] },
        ]),
      ),
    });
  }),
).pipe(Layer.provideMerge(HostAdapter.layer));

const request = <I, S extends Schema.Top & { readonly DecodingServices: never }>(
  registry: Registry.PluginRegistry["Service"],
  id: string,
  input: I,
  output: S,
) =>
  registry.api(id).pipe(
    Effect.flatMap((api) => {
      const result = api.invoke(input);
      return Effect.isEffect(result)
        ? result
        : Effect.fail(
            new PluginError({
              pluginId: "host",
              code: "validation",
              operation: id,
              message: "This API was registered as a subscription instead of a request.",
            }),
          );
    }),
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(output)(result).pipe(
        Effect.mapError(
          (cause) =>
            new PluginError({
              pluginId: "host",
              code: "validation",
              operation: id,
              message: "The plugin returned an invalid API response.",
              cause,
            }),
        ),
      ),
    ),
  );

export const handlers = (registry: Registry.PluginRegistry["Service"]) => ({
  "plugins.catalog": (input: { readonly environmentId: string }) =>
    registry.catalog.pipe(
      Effect.flatMap((catalog) =>
        catalog.environmentId === input.environmentId
          ? Effect.succeed(catalog)
          : Effect.fail(
              new PluginError({
                pluginId: "host",
                code: "unavailable",
                operation: "catalog",
                message: "The requested environment is not this server.",
              }),
            ),
      ),
    ),
  "plugins.attention": (input: {
    readonly environmentId: import("@t3tools/contracts").EnvironmentId;
  }) => registry.attention(input.environmentId),
  [ListRpc._tag]: (input: typeof ListRpc.payloadSchema.Type) =>
    request(registry, ListRpc._tag, input, Reports),
  [ResolveRpc._tag]: (input: typeof ResolveRpc.payloadSchema.Type) =>
    request(registry, ResolveRpc._tag, input, Report),
  [ScheduleRpc._tag]: (input: typeof ScheduleRpc.payloadSchema.Type) =>
    request(registry, ScheduleRpc._tag, input, Schema.Void),
  [SubscribeRpc._tag]: (input: typeof SubscribeRpc.payloadSchema.Type) =>
    Stream.unwrap(
      registry.api(SubscribeRpc._tag).pipe(
        Effect.map((api) => {
          const result = api.invoke(input);
          return Stream.isStream(result)
            ? result
            : Stream.fail(
                new PluginError({
                  pluginId: "fixture",
                  code: "validation",
                  operation: SubscribeRpc._tag,
                  message: "This API was registered as a request instead of a subscription.",
                }),
              );
        }),
      ),
    ).pipe(
      Stream.mapEffect((result) =>
        decodeReports(result).pipe(
          Effect.mapError(
            (cause) =>
              new PluginError({
                pluginId: "fixture",
                code: "validation",
                operation: SubscribeRpc._tag,
                message: "The plugin returned an invalid subscription response.",
                cause,
              }),
          ),
        ),
      ),
    ),
});

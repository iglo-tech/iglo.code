import type { EnvironmentId, PluginAttention, PluginCatalog } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

/** Capability gating also applies to cached values after reconnecting to an older server. */
export function createPluginAtoms<R, E, RpcError>(
  runtime: Atom.AtomRuntime<R, E>,
  options: {
    readonly connected: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
    readonly supported: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
    readonly catalog: (environmentId: EnvironmentId) => Stream.Stream<PluginCatalog, RpcError, R>;
    readonly attention: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<PluginAttention, RpcError, R>;
  },
) {
  const enabled = (get: Atom.AtomContext, environmentId: EnvironmentId) =>
    get(options.connected(environmentId)) && get(options.supported(environmentId));
  const catalog = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) =>
        enabled(get, environmentId)
          ? options
              .catalog(environmentId)
              .pipe(Stream.filter((item) => item.environmentId === environmentId))
          : Stream.succeed<PluginCatalog | null>(null),
      )
      .pipe(Atom.setIdleTTL(0)),
  );
  const availableCatalog = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      enabled(get, environmentId)
        ? Option.getOrNull(AsyncResult.value(get(catalog(environmentId))))
        : null,
    ),
  );
  const attention = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const current = get(availableCatalog(environmentId));
        if (current === null || !current.plugins.some((plugin) => plugin.status === "available"))
          return Stream.succeed<ReadonlyArray<PluginAttention>>([]);
        return options.attention(environmentId).pipe(
          Stream.filter((item) => item.environmentId === environmentId),
          Stream.scan<ReadonlyArray<PluginAttention>, PluginAttention>([], (items, item) => [
            ...items.filter((previous) => previous.pluginId !== item.pluginId),
            item,
          ]),
        );
      })
      .pipe(Atom.setIdleTTL(0)),
  );
  return { catalog, availableCatalog, attention };
}

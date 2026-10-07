import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PluginCatalog } from "@t3tools/contracts";
import { manifest } from "@t3tools/plugin-fixture/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createPluginAtoms } from "./atoms";

it.effect("hides previous capabilities while reconnect refresh is pending or fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("refresh");
      const connected = Atom.make(true);
      const supported = Atom.make(true);
      const catalog: PluginCatalog = {
        environmentId,
        hostVersion: 1,
        providerTools: [],
        plugins: [{ environmentId, manifest, status: "available", reason: null }],
      };
      const ready = yield* Deferred.make<void>();
      const refreshStarted = yield* Deferred.make<void>();
      const refresh = yield* Deferred.make<PluginCatalog, Error>();
      const failed = yield* Deferred.make<void>();
      let requests = 0;
      const atoms = createPluginAtoms(Atom.runtime(Layer.empty), {
        connected: () => connected,
        supported: () => supported,
        catalog: () =>
          ++requests === 1
            ? Stream.succeed(catalog)
            : Stream.fromEffect(
                Deferred.succeed(refreshStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(refresh)),
                ),
              ),
        attention: () => Stream.empty,
      });
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const release = registry.subscribe(
        atoms.availableCatalog(environmentId),
        (value) => {
          if (value !== null) Deferred.doneUnsafe(ready, Effect.void);
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(release));
      yield* Deferred.await(ready);
      expect(registry.get(atoms.availableCatalog(environmentId))).toEqual(catalog);
      registry.set(connected, false);
      expect(registry.get(atoms.availableCatalog(environmentId))).toBeNull();
      registry.set(connected, true);
      yield* Deferred.await(refreshStarted);
      expect(registry.get(atoms.availableCatalog(environmentId))).toBeNull();
      const releaseFailure = registry.subscribe(
        atoms.catalog(environmentId),
        (result) => {
          if (result._tag === "Failure") Deferred.doneUnsafe(failed, Effect.void);
        },
        { immediate: true },
      );
      yield* Effect.addFinalizer(() => Effect.sync(releaseFailure));
      yield* Deferred.fail(refresh, new Error("Catalog refresh failed"));
      yield* Deferred.await(failed);
      expect(registry.get(atoms.availableCatalog(environmentId))).toBeNull();
    }),
  ),
);

it.effect(
  "shares attention readers, closes their transport, and gates cached data after downgrade",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = EnvironmentId.make("first");
        const second = EnvironmentId.make("second");
        const supported = Atom.family((_environmentId: EnvironmentId) => Atom.make(true));
        const connected = Atom.family((_environmentId: EnvironmentId) => Atom.make(true));
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const calls: EnvironmentId[] = [];
        let active = 0;
        const catalog = (environmentId: EnvironmentId): PluginCatalog => ({
          environmentId,
          hostVersion: 1,
          providerTools: [],
          plugins: [{ environmentId, manifest, status: "available", reason: null }],
        });
        const atoms = createPluginAtoms(Atom.runtime(Layer.empty), {
          connected,
          supported,
          catalog: (environmentId) => Stream.succeed(catalog(environmentId)),
          attention: (environmentId) =>
            Stream.unwrap(
              Effect.gen(function* () {
                calls.push(environmentId);
                active++;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    active--;
                  }).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
                );
                yield* Deferred.succeed(started, undefined);
                return Stream.concat(
                  Stream.succeed({ environmentId, pluginId: "fixture", items: [] }),
                  Stream.never,
                );
              }),
            ),
        });
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const one = registry.subscribe(atoms.attention(first), () => {}, { immediate: true });
        const two = registry.subscribe(atoms.attention(first), () => {}, { immediate: true });
        yield* Deferred.await(started);
        expect(active).toBe(1);
        expect(calls).toEqual([first]);
        one();
        expect(active).toBe(1);
        two();
        yield* Deferred.await(stopped);
        expect(active).toBe(0);
        const mounted = registry.mount(atoms.availableCatalog(first));
        registry.set(supported(first), false);
        expect(registry.get(atoms.availableCatalog(first))).toBeNull();
        registry.set(connected(second), false);
        expect(registry.get(atoms.availableCatalog(second))).toBeNull();
        expect(calls).toEqual([first]);
        mounted();
      }),
    ),
  { timeout: 5000 },
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  EnvironmentId,
  PluginError,
  type PluginManifest,
} from "@t3tools/plugin-host-contract/schema";
import { Host, Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as PluginRegistry from "./PluginRegistry.ts";
import * as Scheduler from "../../../apps/server/src/scheduling/Scheduler.ts";

const manifest = {
  id: "example",
  displayName: "Example",
  version: "1",
  hostVersion: 1,
  requiredCapabilities: ["persistence"],
  server: { tools: [], api: [], scheduleTargets: [] },
  web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
} satisfies PluginManifest;
const plugin: ServerPlugin = {
  manifest,
  migrations: [],
  acquire: Effect.succeed({
    tools: [],
    api: [],
    scheduleTargets: [],
    attention: Stream.succeed([]),
  }),
};
const program = (plugins: ReadonlyArray<ServerPlugin>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-" });
      return yield* Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        yield* registry.start;
        return yield* registry.catalog;
      }).pipe(
        Effect.provide(
          PluginRegistry.layer({ environmentId: EnvironmentId.make("test"), directory, plugins }),
        ),
      );
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Scheduler.layer,
        Layer.mock(Host)({ environmentId: EnvironmentId.make("test") }),
      ),
    ),
  );

it.effect("keeps core boot usable with no compiled plugins", () =>
  program([]).pipe(
    Effect.map((catalog) => {
      expect(catalog.plugins).toEqual([]);
    }),
  ),
);
it.effect("rejects both duplicate identities before publishing contributions", () =>
  program([plugin, plugin]).pipe(
    Effect.map((catalog) => {
      expect(catalog.plugins.map((item) => item.status)).toEqual(["unavailable", "unavailable"]);
      expect(catalog.plugins[1]?.reason).toContain("Duplicate plugin");
    }),
  ),
);
it.effect("rejects duplicate contribution identifiers before publishing either plugin", () =>
  program([
    { ...plugin, manifest: { ...manifest, web: { ...manifest.web, pages: ["example.page"] } } },
    {
      ...plugin,
      manifest: { ...manifest, id: "other", web: { ...manifest.web, pages: ["example.page"] } },
    },
  ]).pipe(
    Effect.map((catalog) => {
      expect(catalog.plugins.map((item) => item.status)).toEqual(["unavailable", "unavailable"]);
      expect(catalog.plugins[0]?.reason).toContain("Duplicate contribution");
    }),
  ),
);
it.effect("explains an incompatible interface before acquiring contributions", () =>
  program([{ ...plugin, manifest: { ...manifest, hostVersion: 99 } }]).pipe(
    Effect.map((catalog) => {
      expect(catalog.plugins[0]?.status).toBe("incompatible");
      expect(catalog.plugins[0]?.reason).toContain("99");
    }),
  ),
);

it.effect("isolates a failed migration while the other plugin remains usable", () =>
  program([
    plugin,
    {
      ...plugin,
      manifest: { ...manifest, id: "broken" },
      migrations: [
        {
          id: 1,
          name: "broken",
          run: Effect.fail(
            new PluginError({
              pluginId: "broken",
              code: "storage",
              operation: "migrate",
              message: "The migration could not complete.",
            }),
          ),
        },
      ],
    },
  ]).pipe(
    Effect.map((catalog) => {
      expect(catalog.plugins.map((item) => item.status)).toEqual(["available", "unavailable"]);
      expect(catalog.plugins[1]?.reason).toContain("migration could not complete");
    }),
  ),
);

it.effect("retains a missing plugin's descriptor and private database across restarts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugins-retained-" });
      const durable: ServerPlugin = {
        ...plugin,
        migrations: [
          {
            id: 1,
            name: "private-state",
            run: Effect.gen(function* () {
              const { sql } = yield* Storage;
              yield* sql`CREATE TABLE private_marker (value TEXT)`;
              yield* sql`INSERT INTO private_marker VALUES ('retained')`;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new PluginError({
                    pluginId: "example",
                    code: "storage",
                    operation: "migrate",
                    message: "Could not create marker",
                    cause,
                  }),
              ),
            ),
          },
        ],
      };
      const start = (plugins: ReadonlyArray<ServerPlugin>) =>
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          yield* registry.start;
          return yield* registry.catalog;
        }).pipe(
          Effect.provide(
            PluginRegistry.layer({ environmentId: EnvironmentId.make("test"), directory, plugins }),
          ),
        );
      expect((yield* start([durable])).plugins[0]?.status).toBe("available");
      const absent = yield* start([]);
      expect(absent.plugins[0]).toMatchObject({
        status: "unavailable",
        manifest: { id: "example" },
      });
      expect(absent.plugins[0]?.reason).toContain("absent from the current build");
      expect(yield* fs.exists(`${directory}/example/state.sqlite`)).toBe(true);
      expect((yield* start([durable])).plugins[0]?.status).toBe("available");
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Scheduler.layer,
        Layer.mock(Host)({ environmentId: EnvironmentId.make("test") }),
      ),
    ),
  ),
);

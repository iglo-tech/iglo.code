import {
  EnvironmentId,
  PluginAttention,
  PluginCatalog,
  PluginError,
  PluginManifest,
  PluginId,
  PLUGIN_HOST_VERSION,
  type PluginDescriptor,
  type PluginHostCapability,
} from "@t3tools/plugin-host-contract/schema";
import {
  Host,
  Schedules,
  Storage,
  type PluginApi,
  type PluginServices,
  type PluginTool,
  type ServerPlugin,
} from "@t3tools/plugin-host-contract/server";
import * as NodeSqlite from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type { AuthEnvironmentScope } from "@t3tools/contracts";

import * as PluginSchedules from "./PluginSchedules.ts";
import * as BoundHost from "./BoundHost.ts";
import * as McpTool from "./McpTool.ts";
import * as Scheduler from "../../../apps/server/src/scheduling/Scheduler.ts";
import * as McpToolPolicy from "../../../apps/server/src/mcp/McpToolPolicy.ts";
import { PROVIDER_TOOL_MATRIX } from "./providerPolicy.ts";

const HOST_CAPABILITIES: ReadonlyArray<PluginHostCapability> = [
  "execution",
  "lifecycle",
  "projects",
  "workspaces",
  "providers",
  "skills",
  "pull-requests",
  "persistence",
  "tools",
  "client-api",
  "schedules",
  "pages",
  "navigation",
  "project-actions",
  "thread-context",
  "attention",
];
interface Options {
  readonly environmentId: EnvironmentId;
  readonly directory: string;
  readonly plugins: ReadonlyArray<ServerPlugin>;
  readonly capabilities?: ReadonlyArray<PluginHostCapability>;
  readonly clientApis?: ReadonlyMap<
    string,
    { readonly rpc: Rpc.Any; readonly requiredScope: AuthEnvironmentScope }
  >;
}
const decodeManifest = Schema.decodeUnknownEffect(PluginManifest);
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(PluginManifest));
const decodeStoredManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginManifest));
const decodeAttention = Schema.decodeUnknownEffect(PluginAttention);
const isPluginError = Schema.is(PluginError);
const isPluginId = Schema.is(PluginId);
const declaredContributions = (manifest: PluginManifest) => [
  ...manifest.server.tools,
  ...manifest.server.api,
  ...manifest.server.scheduleTargets,
  ...manifest.web.pages,
  ...manifest.web.navigation,
  ...manifest.web.projectActions,
  ...manifest.web.threadContext,
];
class Configuration extends Context.Service<Configuration, Options>()(
  "@t3tools/plugin-host-adapter/PluginRegistry/Configuration",
) {}

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly start: Effect.Effect<void>;
    readonly awaitStarted: Effect.Effect<void>;
    readonly awaitToolsReady: Effect.Effect<void>;
    readonly markToolsReady: Effect.Effect<void>;
    readonly catalog: Effect.Effect<PluginCatalog>;
    readonly tools: Effect.Effect<
      ReadonlyArray<{ readonly pluginId: string; readonly tool: PluginTool }>
    >;
    readonly api: (id: string) => Effect.Effect<PluginApi, PluginError>;
    readonly attention: (
      environmentId: EnvironmentId,
    ) => Stream.Stream<PluginAttention, PluginError>;
  }
>()("@t3tools/plugin-host-adapter/PluginRegistry") {}

const make = Effect.gen(function* () {
  const options = yield* Configuration;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const servicesContext = yield* Effect.context<Host | Scheduler.Scheduler>();
  const lifetime = yield* Effect.scope;
  const startLock = yield* Semaphore.make(1);
  const initialized = yield* Deferred.make<void>();
  const toolsReady = yield* Deferred.make<void>();
  const descriptors: PluginDescriptor[] = [];
  const registered = new Map<string, PluginServices>();
  const ids = new Set<string>();
  const identityCounts = new Map<string, number>();
  const contributionCounts = new Map<string, number>();
  let started = false;

  const start = Effect.gen(function* () {
    if (started) return;
    started = true;
    yield* fs.makeDirectory(options.directory, { recursive: true });
    const catalogContext = yield* Layer.build(
      NodeSqlite.layer({ filename: path.join(options.directory, "catalog.sqlite") }),
    ).pipe(Scope.provide(lifetime));
    const catalogSql = Context.get(catalogContext, SqlClient.SqlClient);
    yield* catalogSql`CREATE TABLE IF NOT EXISTS manifests (id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
    const previous = yield* catalogSql<{ data: string }>`SELECT data FROM manifests ORDER BY id`;
    const candidates = yield* Effect.forEach(options.plugins, (plugin, index) =>
      decodeManifest(plugin.manifest).pipe(
        Effect.result,
        Effect.map((validated) => {
          const invalid = validated._tag === "Failure";
          const manifest: PluginManifest =
            validated._tag === "Success"
              ? validated.success
              : {
                  id: isPluginId(plugin.manifest.id) ? plugin.manifest.id : `invalid_${index}`,
                  displayName: "Invalid compiled plugin",
                  version: "unknown",
                  hostVersion: PLUGIN_HOST_VERSION,
                  requiredCapabilities: [],
                  server: { tools: [], api: [], scheduleTargets: [] },
                  web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
                };
          return { plugin, manifest, invalid };
        }),
      ),
    );
    for (const { manifest, invalid } of candidates) {
      if (invalid) continue;
      identityCounts.set(manifest.id, (identityCounts.get(manifest.id) ?? 0) + 1);
      for (const id of declaredContributions(manifest))
        contributionCounts.set(id, (contributionCounts.get(id) ?? 0) + 1);
    }
    for (const { plugin, manifest, invalid } of candidates) {
      const descriptor: {
        environmentId: EnvironmentId;
        manifest: PluginManifest;
        status: PluginDescriptor["status"];
        reason: string | null;
      } = { environmentId: options.environmentId, manifest, status: "unavailable", reason: null };
      descriptors.push(descriptor);
      const declared = declaredContributions(manifest);
      const missing = manifest.requiredCapabilities.filter(
        (capability) => !(options.capabilities ?? HOST_CAPABILITIES).includes(capability),
      );
      const rejection = invalid
        ? "The compiled plugin manifest is invalid. Rebuild with a schema-compatible manifest."
        : identityCounts.get(manifest.id)! > 1
          ? `Duplicate plugin identity ${manifest.id}.`
          : manifest.hostVersion !== PLUGIN_HOST_VERSION
            ? `Plugin requires host interface ${manifest.hostVersion}; this host provides ${PLUGIN_HOST_VERSION}.`
            : missing.length > 0
              ? `Missing host capabilities: ${missing.join(", ")}.`
              : declared.some((id) => contributionCounts.get(id)! > 1)
                ? "Duplicate contribution identifier."
                : null;
      ids.add(manifest.id);
      if (rejection !== null) {
        descriptor.status =
          manifest.hostVersion !== PLUGIN_HOST_VERSION || missing.length > 0
            ? "incompatible"
            : "unavailable";
        descriptor.reason = rejection;
        continue;
      }
      const encodedManifest = yield* encodeManifest(manifest);
      yield* catalogSql`INSERT INTO manifests (id, data) VALUES (${manifest.id}, ${encodedManifest}) ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
      const scope = yield* Scope.make("sequential");
      yield* Scope.addFinalizer(lifetime, Scope.close(scope, Exit.void));
      // The plugin scope must override the parent scope captured in servicesContext.
      const acquired = yield* Effect.exit(
        Effect.gen(function* () {
          const directory = path.join(options.directory, manifest.id);
          yield* fs.makeDirectory(directory, { recursive: true });
          const context = yield* Layer.build(
            NodeSqlite.layer({ filename: path.join(directory, "state.sqlite") }),
          );
          const sql = Context.get(context, SqlClient.SqlClient);
          const storage = Storage.of({ directory, sql });
          yield* sql`PRAGMA busy_timeout = 5000`;
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE IF NOT EXISTS host_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
          const seen = new Set<number>();
          for (const migration of plugin.migrations) {
            if (seen.has(migration.id) || migration.id < 1 || !Number.isInteger(migration.id))
              return yield* new PluginError({
                pluginId: manifest.id,
                code: "validation",
                operation: "migrate",
                message: "Migration identities must be unique positive integers.",
              });
            seen.add(migration.id);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const [applied] = yield* sql<{
                  name: string;
                }>`SELECT name FROM host_migrations WHERE id = ${migration.id}`;
                if (applied !== undefined) {
                  if (applied.name !== migration.name)
                    return yield* new PluginError({
                      pluginId: manifest.id,
                      code: "conflict",
                      operation: "migrate",
                      message: `Migration ${migration.id} changed identity.`,
                    });
                  return;
                }
                yield* migration.run.pipe(Effect.provideService(Storage, storage));
                yield* sql`INSERT INTO host_migrations (id, name) VALUES (${migration.id}, ${migration.name})`;
              }),
            );
          }
          let instance: PluginServices | undefined;
          const schedules = yield* PluginSchedules.make.pipe(
            Effect.provideService(Storage, storage),
            Effect.provideService(PluginSchedules.ScheduleRegistration, {
              pluginId: manifest.id,
              targets: () => instance?.scheduleTargets ?? [],
            }),
          );
          const bound = yield* BoundHost.make(manifest.id).pipe(
            Effect.provideService(Storage, storage),
          );
          instance = yield* plugin.acquire.pipe(
            Effect.provideService(Host, bound.service),
            Effect.provideService(Storage, storage),
            Effect.provideService(Schedules, schedules.service),
          );
          const actual = [
            ...instance.tools.map((tool) => tool.id),
            ...instance.api.map((api) => api.rpc._tag),
            ...instance.scheduleTargets.map((target) => target.id),
          ];
          const expected = [
            ...manifest.server.tools,
            ...manifest.server.api,
            ...manifest.server.scheduleTargets,
          ];
          if (
            new Set(actual).size !== actual.length ||
            actual.length !== expected.length ||
            expected.some((id) => !actual.includes(id))
          )
            return yield* new PluginError({
              pluginId: manifest.id,
              code: "validation",
              operation: "register",
              message: "Server contributions do not match the manifest.",
            });
          if (
            instance.tools.some((tool) => !tool.id.startsWith(`plugin_${manifest.id}_`)) ||
            instance.api.some((api) => !api.rpc._tag.startsWith(`plugins.${manifest.id}.`)) ||
            instance.scheduleTargets.some((target) => !target.id.startsWith(`${manifest.id}.`))
          )
            return yield* new PluginError({
              pluginId: manifest.id,
              code: "validation",
              operation: "register",
              message: "Contributions must use their plugin namespace.",
            });
          for (const api of instance.api) {
            const compiled = options.clientApis?.get(api.rpc._tag);
            if (
              compiled === undefined ||
              compiled.rpc !== api.rpc ||
              compiled.requiredScope !== api.requiredScope
            )
              return yield* new PluginError({
                pluginId: manifest.id,
                code: "validation",
                operation: "register",
                message: `API ${api.rpc._tag} must match the compiled transport schema and authorization scope.`,
              });
          }
          // Validate complete wire descriptors before publishing an optional plugin.
          for (const tool of instance.tools) McpTool.make(tool);
          yield* bound.recover;
          yield* schedules.start;
          const policy = yield* Effect.serviceOption(McpToolPolicy.McpToolPolicy);
          if (policy._tag === "Some")
            yield* policy.value.register(
              instance.tools
                .filter((tool) => tool.permission.readOnly || tool.permission.allowInReadOnly)
                .map((tool) => tool.id),
            );
          return instance;
        }).pipe(Scope.provide(scope), Effect.provideContext(servicesContext)),
      );
      if (Exit.isFailure(acquired)) {
        if (Cause.hasInterruptsOnly(acquired.cause)) return yield* Effect.interrupt;
        const failure = Cause.squash(acquired.cause);
        descriptor.reason = isPluginError(failure)
          ? failure.message
          : "Plugin initialization or migration failed. Its data has been retained.";
        yield* Scope.close(scope, Exit.void);
        yield* Effect.logWarning("Optional plugin unavailable", {
          pluginId: manifest.id,
          cause: acquired.cause,
        });
        continue;
      }
      registered.set(manifest.id, acquired.value);
      descriptor.status = "available";
    }
    for (const row of previous) {
      const retained = yield* Effect.result(decodeStoredManifest(row.data));
      if (retained._tag === "Success" && !ids.has(retained.success.id))
        descriptors.push({
          environmentId: options.environmentId,
          manifest: retained.success,
          status: "unavailable",
          reason: "This plugin is absent from the current build. Its data has been retained.",
        });
    }
    yield* Deferred.succeed(initialized, undefined);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            for (const plugin of options.plugins) {
              if (descriptors.some((item) => item.manifest.id === plugin.manifest.id)) continue;
              descriptors.push({
                environmentId: options.environmentId,
                manifest: plugin.manifest,
                status: "unavailable",
                reason:
                  "Plugin storage is unavailable. Check the environment's plugin directory permissions; existing data has been retained.",
              });
            }
            yield* Effect.logWarning("Optional plugin host unavailable", { cause });
          }),
    ),
    Effect.ensuring(Deferred.succeed(initialized, undefined)),
    startLock.withPermits(1),
  );
  return PluginRegistry.of({
    start,
    awaitStarted: Deferred.await(initialized),
    awaitToolsReady: Deferred.await(toolsReady),
    markToolsReady: Deferred.succeed(toolsReady, undefined).pipe(Effect.asVoid),
    catalog: Effect.sync(() => ({
      environmentId: options.environmentId,
      hostVersion: PLUGIN_HOST_VERSION,
      plugins: descriptors,
      providerTools: PROVIDER_TOOL_MATRIX,
    })),
    tools: Effect.sync(() =>
      [...registered].flatMap(([pluginId, service]) =>
        service.tools.map((tool) => ({ pluginId, tool })),
      ),
    ),
    api: (id) =>
      Effect.suspend(() => {
        const api = [...registered.values()]
          .flatMap((service) => service.api)
          .find((api) => api.rpc._tag === id);
        return api === undefined
          ? Effect.fail(
              new PluginError({
                pluginId: id.split(".")[1] ?? "host",
                code: "unavailable",
                operation: id,
                message: "This plugin API is unavailable in the selected environment.",
              }),
            )
          : Effect.succeed(api);
      }),
    attention: (environmentId) =>
      environmentId !== options.environmentId
        ? Stream.fail(
            new PluginError({
              pluginId: "host",
              code: "unavailable",
              operation: "attention",
              message: "The requested environment is not this server.",
            }),
          )
        : Stream.unwrap(
            Effect.sync(() =>
              Stream.mergeAll(
                [...registered].map(([pluginId, service]) =>
                  service.attention.pipe(
                    Stream.map((items) => ({ environmentId, pluginId, items })),
                    Stream.mapEffect((item) => decodeAttention(item)),
                  ),
                ),
                { concurrency: "unbounded" },
              ),
            ),
          ).pipe(
            Stream.mapError((cause) =>
              isPluginError(cause)
                ? cause
                : new PluginError({
                    pluginId: "host",
                    code: "validation",
                    operation: "attention",
                    message: "A plugin returned invalid attention items.",
                    cause,
                  }),
            ),
          ),
  });
});

export const layer = (options: Options) =>
  Layer.effect(PluginRegistry, make).pipe(Layer.provide(Layer.succeed(Configuration, options)));

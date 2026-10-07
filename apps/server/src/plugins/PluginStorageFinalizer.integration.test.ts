import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { PluginError } from "@t3tools/plugin-host-contract/schema";
import { Storage, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Startup from "../serverRuntimeStartup.ts";

it.live("plugin Storage remains usable for scoped cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("independent-shutdown")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providers: Object.fromEntries(
            ["codex", "claudeAgent", "opencode", "cursor", "grok", "antigravity", "pi"].map(
              (id) => [id, { enabled: false, binaryPath: "/nonexistent/pr4-review-provider" }],
            ),
          ),
        }),
      );
      const acquired = yield* Deferred.make<Storage["Service"]>();
      const cleaned = yield* Deferred.make<unknown>();
      const plugin: ServerPlugin = {
        manifest: {
          id: "shutdown_probe",
          displayName: "Shutdown probe",
          version: "1",
          hostVersion: 1,
          requiredCapabilities: ["persistence"],
          server: { tools: [], api: [], scheduleTargets: [] },
          web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
        },
        migrations: [],
        acquire: Effect.gen(function* () {
          const storage = yield* Storage;
          yield* storage.sql`CREATE TABLE cleanup_probe (value TEXT)`;
          yield* Effect.addFinalizer(() =>
            storage.sql`INSERT INTO cleanup_probe VALUES ('shutdown')`.pipe(
              Effect.result,
              Effect.flatMap((result) => Deferred.succeed(cleaned, result)),
            ),
          );
          yield* Deferred.succeed(acquired, storage);
          return { tools: [], api: [], scheduleTargets: [], attention: Stream.empty };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new PluginError({
                pluginId: "shutdown_probe",
                code: "storage",
                operation: "acquire",
                message: String(cause),
              }),
          ),
        ),
      };
      const server = yield* startEnvironment(config, [plugin]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const storage = yield* Deferred.await(acquired);
      // Control: the same SQL statement works while the environment is live.
      yield* storage.sql`INSERT INTO cleanup_probe VALUES ('live')`;
      expect((yield* storage.sql`SELECT * FROM cleanup_probe`).length).toBe(1);
      yield* Fiber.interrupt(server.fiber);
      const result = yield* Deferred.await(cleaned);
      expect(result).toMatchObject({ _tag: "Success" });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Startup from "../serverRuntimeStartup.ts";
import { plugin } from "@t3tools/plugin-fixture/server";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
it.live.each([false, true])("validates contribution kinds: swapped=%s", (swapped) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = {
        ...(yield* makeReplayServerConfig("pr4-manifest-kind")),
        noBrowser: true,
        traceTimingEnabled: false,
      };
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(
        config.settingsPath,
        JSON.stringify({
          providers: { codex: { enabled: false }, claudeAgent: { enabled: false } },
        }),
      );
      const candidate = swapped
        ? {
            ...plugin,
            manifest: {
              ...plugin.manifest,
              server: {
                ...plugin.manifest.server,
                tools: plugin.manifest.server.api,
                api: plugin.manifest.server.tools,
              },
            },
          }
        : plugin;
      const server = yield* startEnvironment(config, [candidate]);
      yield* Context.get(server.context, Startup.ServerRuntimeStartup).awaitCommandReady;
      const registry = Context.get(server.context, Registry.PluginRegistry);
      const descriptor = (yield* registry.catalog).plugins[0]!;
      const api = yield* registry.api("plugins.fixture.list").pipe(Effect.result);
      expect(descriptor.status).toBe(swapped ? "unavailable" : "available");
      expect(api._tag).toBe(swapped ? "Failure" : "Success");
      expect(yield* registry.tools).toHaveLength(swapped ? 0 : plugin.manifest.server.tools.length);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

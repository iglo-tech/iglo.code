import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { tool, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { startEnvironment } from "./PluginHost.testkit.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

it.live(
  "isolates scalar-output plugins before publication and keeps object-output tools available",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scalar = tool({
          id: "plugin_scalar_query",
          description: "Unsupported scalar",
          input: Schema.Struct({ id: Schema.String }),
          // @ts-expect-error MCP structured results require an encoded JSON object.
          output: Schema.String,
          permission: {
            readOnly: true,
            destructive: false,
            idempotent: true,
            allowInReadOnly: true,
          },
          invoke: () => Effect.succeed("schema-valid scalar"),
        });
        const object = tool({
          id: "plugin_object_query",
          description: "Supported object",
          input: Schema.Struct({ id: Schema.String }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          permission: scalar.permission,
          invoke: () => Effect.succeed({ ok: true }),
        });
        const plugin = (id: string, contribution: typeof scalar): ServerPlugin => ({
          manifest: {
            id,
            displayName: id,
            version: "1",
            hostVersion: 1,
            requiredCapabilities: [],
            server: { tools: [contribution.id], api: [], scheduleTargets: [] },
            web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
          },
          migrations: [],
          acquire: Effect.succeed({
            tools: [contribution],
            api: [],
            scheduleTargets: [],
            attention: Stream.empty,
          }),
        });
        const config = {
          ...(yield* makeReplayServerConfig("plugin-output")),
          noBrowser: true,
          traceTimingEnabled: false,
        };
        const server = yield* startEnvironment(config, [
          plugin("scalar", scalar),
          plugin("object", object),
        ]);
        const registry = Context.get(server.context, Registry.PluginRegistry);
        yield* registry.awaitToolsReady;
        expect((yield* registry.catalog).plugins.map((p) => p.status)).toEqual([
          "unavailable",
          "available",
        ]);
        expect((yield* registry.tools).map((entry) => entry.tool.id)).toEqual([object.id]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

import { Host, type PluginTool } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import * as Registry from "./PluginRegistry.ts";
import * as Invocation from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as PluginTools from "./PluginToolService.ts";
import type * as Scope from "effect/Scope";

const encodeText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

type RegisterTool = (
  tool: PluginTool,
  handle: (
    payload: unknown,
  ) => Effect.Effect<McpSchema.CallToolResult, never, Invocation.McpInvocationContext>,
) => Effect.Effect<void, never, Scope.Scope>;

/** Waits for core recovery; the transport forks registration during startup. */
export const register = (registerTool: RegisterTool) =>
  Effect.gen(function* () {
    const optionalRegistry = yield* Effect.serviceOption(Registry.PluginRegistry);
    if (Option.isNone(optionalRegistry)) return;
    const registry = optionalRegistry.value;
    const optionalHost = yield* Effect.serviceOption(Host);
    if (Option.isNone(optionalHost)) return;
    const host = optionalHost.value;
    const tools = yield* PluginTools.make.pipe(Effect.provideService(Host, host));
    yield* registry.awaitStarted;
    for (const { pluginId, tool } of yield* registry.tools) {
      const invoke = tools.bind(pluginId, tool);
      yield* registerTool(tool, (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(fiber.context, Invocation.McpInvocationContext);
          return invoke(payload, invocation).pipe(
            Effect.flatMap((json) =>
              Effect.gen(function* () {
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: json,
                  content: [{ type: "text", text: yield* encodeText(json) }],
                });
              }),
            ),
            Effect.catchTags({
              PluginError: (error) =>
                Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: true,
                    structuredContent: {
                      error: {
                        code: error.code,
                        pluginId,
                        operation: error.operation,
                        message: error.message,
                      },
                    },
                    content: [{ type: "text", text: error.message }],
                  }),
                ),
            }),
            Effect.orDie,
          );
        }),
      );
    }
  }).pipe(
    Effect.ensuring(
      Effect.serviceOption(Registry.PluginRegistry).pipe(
        Effect.flatMap((registry) =>
          Option.isSome(registry) ? registry.value.markToolsReady : Effect.void,
        ),
      ),
    ),
  );

import { Host } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpServer, McpSchema } from "effect/unstable/ai";

import * as Registry from "./PluginRegistry.ts";
import * as Invocation from "../../../apps/server/src/mcp/McpInvocationContext.ts";
import * as PluginTools from "./PluginToolService.ts";

const encodeText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

const register = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const optionalRegistry = yield* Effect.serviceOption(Registry.PluginRegistry);
  if (Option.isNone(optionalRegistry)) return;
  const registry = optionalRegistry.value;
  const optionalHost = yield* Effect.serviceOption(Host);
  if (Option.isNone(optionalHost)) return;
  const host = optionalHost.value;
  const tools = yield* PluginTools.make.pipe(Effect.provideService(Host, host));
  yield* registry.awaitStarted;
  for (const { pluginId, tool } of yield* registry.tools) {
    const inputSchema = Schema.toJsonSchemaDocument(tool.input);
    const invoke = tools.bind(pluginId, tool);
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.id,
        description: tool.description,
        inputSchema: {
          ...inputSchema.schema,
          ...(Object.keys(inputSchema.definitions).length === 0
            ? {}
            : { $defs: inputSchema.definitions }),
        },
        annotations: {
          readOnlyHint: tool.permission.readOnly,
          destructiveHint: tool.permission.destructive,
          idempotentHint: tool.permission.idempotent,
          openWorldHint: false,
        },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
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
            Effect.catchTag("PluginError", (error) =>
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
            ),
            Effect.orDie,
          );
        }),
    });
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

/** Registration waits for core recovery without delaying creation of the HTTP transport. */
export const layer = Layer.effectDiscard(register.pipe(Effect.forkScoped, Effect.asVoid));

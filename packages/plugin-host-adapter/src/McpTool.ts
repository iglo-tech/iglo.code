import type { PluginTool } from "@t3tools/plugin-host-contract/server";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/unstable/ai";

/** Use the same wire descriptor for guarded validation and MCP publication. */
export const make = (tool: PluginTool) => {
  const input = Schema.toJsonSchemaDocument(tool.input);
  return new McpSchema.Tool({
    name: tool.id,
    description: tool.description,
    inputSchema: {
      // Empty structs omit the object type. Explicit non-object schemas still fail validation.
      type: "object",
      ...input.schema,
      ...(Object.keys(input.definitions).length === 0 ? {} : { $defs: input.definitions }),
    },
    annotations: {
      readOnlyHint: tool.permission.readOnly,
      destructiveHint: tool.permission.destructive,
      idempotentHint: tool.permission.idempotent,
      openWorldHint: false,
    },
  });
};

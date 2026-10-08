import { T3_MCP_TOOL_NAMES } from "@t3tools/shared/t3McpToolPresentation";

// This inventory includes native compatibility aliases and excludes plugin namespaces.
// Policy construction must not load service-bearing toolkits back into provider adapters.
export const coreMcpToolNames = [...T3_MCP_TOOL_NAMES];

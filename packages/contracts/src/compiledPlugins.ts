import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { RpcGroupFixture, apiScopes } from "@t3tools/plugin-fixture/contracts";
import { EnvironmentId, PluginAttention, PluginCatalog, PluginError } from "./pluginHost.ts";
import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";

const error = Schema.Union([PluginError, EnvironmentAuthorizationError]);
export const PluginCatalogRpc = Rpc.make("plugins.catalog", {
  payload: Schema.Struct({ environmentId: EnvironmentId }),
  success: PluginCatalog,
  error,
});
export const PluginAttentionRpc = Rpc.make("plugins.attention", {
  payload: Schema.Struct({ environmentId: EnvironmentId }),
  success: PluginAttention,
  error,
  stream: true,
});

/** The single build-time composition point for compiled plugin client APIs. */
export const CompiledPluginRpcGroup = RpcGroup.make(PluginCatalogRpc, PluginAttentionRpc).merge(
  RpcGroupFixture,
);
export const COMPILED_PLUGIN_RPC_SCOPES = {
  "plugins.catalog": AuthOrchestrationReadScope,
  "plugins.attention": AuthOrchestrationReadScope,
  ...apiScopes,
};

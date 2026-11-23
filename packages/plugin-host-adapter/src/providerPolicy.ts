import type { PluginProviderToolCapability } from "@t3tools/plugin-host-contract/schema";
import * as Predicate from "effect/Predicate";

const EXTERNAL_UNSUPPORTED_REASON =
  "Externally owned provider sessions do not support host-owned plugin tool injection.";
const LEGACY_OPENCODE_UNSUPPORTED_REASON =
  "Plugin tools require managed OpenCode 2. Upgrade OpenCode; the legacy adapter has no isolated tool injection path.";
const ADAPTER_UNSUPPORTED_REASON =
  "This provider adapter does not support host-owned per-thread MCP tool injection.";

export function isExternalProviderConfig(config: unknown): boolean {
  return (
    Predicate.isObject(config) &&
    "serverUrl" in config &&
    typeof config.serverUrl === "string" &&
    config.serverUrl.trim().length > 0
  );
}

export function providerToolCapability(input: {
  readonly driver: string;
  readonly external: boolean;
  readonly supportsHostMcpInjection: boolean;
}): PluginProviderToolCapability {
  if (input.external) {
    return {
      driver: input.driver,
      connectionMode: "external",
      supported: false,
      reason: EXTERNAL_UNSUPPORTED_REASON,
    };
  }
  if (input.supportsHostMcpInjection) {
    return {
      driver: input.driver,
      connectionMode: "managed",
      supported: true,
      reason: null,
    };
  }
  return {
    driver: input.driver,
    connectionMode: "managed",
    supported: false,
    reason:
      input.driver === "opencode" ? LEGACY_OPENCODE_UNSUPPORTED_REASON : ADAPTER_UNSUPPORTED_REASON,
  };
}

export interface ProviderToolCapabilityInput {
  readonly driver: string;
  readonly version: string | null | undefined;
  readonly config: unknown;
  readonly adapterSupportsHostMcpInjection: boolean | undefined;
  readonly hasLiveInstance: boolean;
}

export function resolveProviderToolCapability(input: ProviderToolCapabilityInput): {
  readonly driver: string;
  readonly capability: PluginProviderToolCapability;
} {
  const external = isExternalProviderConfig(input.config);
  const isOpenCodeV2Snapshot =
    input.driver === "opencode" && input.version?.startsWith("2.") === true;
  const driver = isOpenCodeV2Snapshot ? "opencode2" : input.driver;
  // OpenCode 2.x may be hydrated from its status cache before the first live probe runs.
  const supportsHostMcpInjection =
    !external &&
    (input.adapterSupportsHostMcpInjection === true ||
      (isOpenCodeV2Snapshot && input.hasLiveInstance));
  return {
    driver,
    capability: providerToolCapability({ driver, external, supportsHostMcpInjection }),
  };
}

export function deriveProviderToolCapabilities(
  entries: ReadonlyArray<ProviderToolCapabilityInput>,
): ReadonlyArray<PluginProviderToolCapability> {
  const capabilities = new Map<string, PluginProviderToolCapability>();
  const record = (entry: PluginProviderToolCapability) => {
    const key = `${entry.driver}:${entry.connectionMode}`;
    const existing = capabilities.get(key);
    if (existing === undefined || (!existing.supported && entry.supported)) {
      capabilities.set(key, entry);
    }
  };
  for (const entry of entries) {
    const { driver, capability } = resolveProviderToolCapability(entry);
    record(capability);
    record(providerToolCapability({ driver, external: true, supportsHostMcpInjection: false }));
  }
  return [...capabilities.values()];
}

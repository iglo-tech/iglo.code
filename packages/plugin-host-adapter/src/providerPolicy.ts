import type { PluginProviderToolCapability } from "@t3tools/plugin-host-contract/schema";

/** Only adapters with a tested, host-owned injection path may run plugin tools. */
export const PROVIDER_TOOL_MATRIX: ReadonlyArray<PluginProviderToolCapability> = [
  ...["codex", "claudeAgent", "opencode2"].map((driver) => ({
    driver,
    connectionMode: "managed" as const,
    supported: true,
    reason: null,
  })),
  {
    driver: "opencode",
    connectionMode: "managed",
    supported: false,
    reason:
      "Plugin tools require managed OpenCode 2. Upgrade OpenCode; the legacy adapter has no isolated tool injection path.",
  },
  ...["cursor", "grok", "antigravity", "pi", "acp"].map((driver) => ({
    driver,
    connectionMode: "managed" as const,
    supported: false,
    reason: "Plugin tool injection has not been verified for this adapter.",
  })),
  ...[
    "codex",
    "claudeAgent",
    "opencode",
    "opencode2",
    "cursor",
    "grok",
    "antigravity",
    "pi",
    "acp",
  ].map((driver) => ({
    driver,
    connectionMode: "external" as const,
    supported: false,
    reason: "Externally owned provider sessions do not support host-owned plugin tool injection.",
  })),
];

export function providerToolCapability(
  driver: string,
  external: boolean,
): PluginProviderToolCapability {
  return (
    PROVIDER_TOOL_MATRIX.find(
      (item) =>
        item.driver === driver && item.connectionMode === (external ? "external" : "managed"),
    ) ?? {
      driver,
      connectionMode: external ? "external" : "managed",
      supported: false,
      reason: "This provider has no verified plugin tool injection path.",
    }
  );
}

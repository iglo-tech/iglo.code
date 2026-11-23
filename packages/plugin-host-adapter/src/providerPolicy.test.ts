import { describe, expect, it } from "@effect/vitest";

import {
  deriveProviderToolCapabilities,
  isExternalProviderConfig,
  providerToolCapability,
  resolveProviderToolCapability,
} from "./providerPolicy.ts";

describe("providerPolicy", () => {
  it("drives managed support from adapter host-MCP capability without a driver allowlist", () => {
    expect(
      providerToolCapability({
        driver: "futureCustomDriver",
        external: false,
        supportsHostMcpInjection: true,
      }),
    ).toEqual({
      driver: "futureCustomDriver",
      connectionMode: "managed",
      supported: true,
      reason: null,
    });

    expect(
      providerToolCapability({
        driver: "futureNoMcpDriver",
        external: false,
        supportsHostMcpInjection: false,
      }),
    ).toEqual({
      driver: "futureNoMcpDriver",
      connectionMode: "managed",
      supported: false,
      reason: expect.stringContaining("does not support host-owned per-thread MCP tool injection"),
    });
  });

  it("rejects externally owned sessions and legacy OpenCode 1 with clear reasons", () => {
    expect(isExternalProviderConfig({ serverUrl: "http://127.0.0.1:4096" })).toBe(true);
    expect(isExternalProviderConfig({ serverUrl: "   " })).toBe(false);
    expect(isExternalProviderConfig({})).toBe(false);

    expect(
      resolveProviderToolCapability({
        driver: "opencode",
        version: "2.0.18",
        config: { serverUrl: "http://127.0.0.1:4096" },
        adapterSupportsHostMcpInjection: true,
        hasLiveInstance: true,
      }),
    ).toEqual({
      driver: "opencode2",
      capability: {
        driver: "opencode2",
        connectionMode: "external",
        supported: false,
        reason: expect.stringContaining("Externally owned"),
      },
    });

    expect(
      resolveProviderToolCapability({
        driver: "opencode",
        version: "1.9.2",
        config: {},
        adapterSupportsHostMcpInjection: false,
        hasLiveInstance: true,
      }),
    ).toEqual({
      driver: "opencode",
      capability: {
        driver: "opencode",
        connectionMode: "managed",
        supported: false,
        reason: expect.stringContaining("Upgrade OpenCode"),
      },
    });

    expect(
      resolveProviderToolCapability({
        driver: "opencode",
        version: "2.0.18",
        config: {},
        adapterSupportsHostMcpInjection: false,
        hasLiveInstance: true,
      }),
    ).toEqual({
      driver: "opencode2",
      capability: {
        driver: "opencode2",
        connectionMode: "managed",
        supported: true,
        reason: null,
      },
    });
  });

  it("derives deduplicated catalog capabilities from registered providers", () => {
    const capabilities = deriveProviderToolCapabilities([
      {
        driver: "antigravity",
        version: "1.5.8",
        config: {},
        adapterSupportsHostMcpInjection: true,
        hasLiveInstance: true,
      },
      {
        driver: "antigravity",
        version: "1.5.8",
        config: {},
        adapterSupportsHostMcpInjection: true,
        hasLiveInstance: true,
      },
      {
        driver: "customNoMcp",
        version: "1.0.0",
        config: {},
        adapterSupportsHostMcpInjection: false,
        hasLiveInstance: true,
      },
    ]);

    expect(capabilities).toEqual([
      { driver: "antigravity", connectionMode: "managed", supported: true, reason: null },
      {
        driver: "antigravity",
        connectionMode: "external",
        supported: false,
        reason: expect.stringContaining("Externally owned"),
      },
      {
        driver: "customNoMcp",
        connectionMode: "managed",
        supported: false,
        reason: expect.stringContaining(
          "does not support host-owned per-thread MCP tool injection",
        ),
      },
      {
        driver: "customNoMcp",
        connectionMode: "external",
        supported: false,
        reason: expect.stringContaining("Externally owned"),
      },
    ]);
  });
});

import { EnvironmentId, type PluginCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { pageCatalog, pageStatus } from "./pageConnection";

const catalog = (environmentId: EnvironmentId): PluginCatalog => ({
  environmentId,
  hostVersion: 1,
  providerTools: [],
  plugins: [],
});

describe("plugin page connection", () => {
  it("retains only the same environment's catalog while reconciling", () => {
    const first = EnvironmentId.make("first");
    const second = EnvironmentId.make("second");
    const retained = { environmentId: first, catalog: catalog(first) };
    expect(pageCatalog(retained, first, null, true)).toBe(retained.catalog);
    // Switching the page to another environment never shows the first one's plugins.
    expect(pageCatalog(retained, second, null, true)).toBeNull();
    expect(pageCatalog(retained, first, null, false)).toBeNull();
    const fresh = catalog(first);
    expect(pageCatalog(retained, first, fresh, true)).toBe(fresh);
  });

  it("labels offline, unsupported, failed-catalog and reconciling states apart", () => {
    const current = catalog(EnvironmentId.make("first"));
    const base = { connected: true, supported: true, catalogFailed: false, current: null };
    expect(pageStatus({ ...base, connected: false })).toBe("disconnected");
    expect(pageStatus({ ...base, supported: false })).toBe("unsupported");
    expect(pageStatus({ ...base, catalogFailed: true })).toBe("catalog-unavailable");
    expect(pageStatus(base)).toBe("reconciling");
    expect(pageStatus({ ...base, current })).toBe("connected");
  });
});

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

  it("distinguishes offline from connected-but-unreconciled", () => {
    expect(pageStatus(false, null)).toBe("disconnected");
    expect(pageStatus(true, null)).toBe("reconciling");
    expect(pageStatus(true, catalog(EnvironmentId.make("first")))).toBe("connected");
  });
});

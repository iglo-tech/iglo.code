import { EnvironmentId, type PluginCatalog } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { missingPageMessage, pageCatalog, pageStatus } from "./pageConnection";

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
    const base = {
      connected: true,
      support: "supported" as const,
      catalogFailed: false,
      current: null,
    };
    expect(pageStatus({ ...base, connected: false })).toBe("disconnected");
    expect(pageStatus({ ...base, support: "unsupported" })).toBe("unsupported");
    // A reconnect handshake has no configuration yet; that is not "unsupported".
    expect(pageStatus({ ...base, support: "unknown" })).toBe("reconciling");
    expect(pageStatus({ ...base, catalogFailed: true })).toBe("catalog-unavailable");
    expect(pageStatus(base)).toBe("reconciling");
    expect(pageStatus({ ...base, current })).toBe("connected");
  });

  it("explains a missing page by connection state before blaming the build", () => {
    expect(missingPageMessage({ status: "reconciling", descriptor: undefined })).toMatchObject({
      text: "Loading this page from the environment…",
      retry: false,
    });
    expect(missingPageMessage({ status: "disconnected", descriptor: undefined }).text).toContain(
      "loads when it reconnects",
    );
    expect(
      missingPageMessage({ status: "catalog-unavailable", descriptor: undefined }),
    ).toMatchObject({ retry: true });
    expect(missingPageMessage({ status: "unsupported", descriptor: undefined }).text).toBe(
      "This environment does not support plugins.",
    );
    expect(
      missingPageMessage({
        status: "connected",
        descriptor: { status: "available", reason: null },
      }).text,
    ).toBe("This page is not included in this client build.");
    expect(
      missingPageMessage({
        status: "connected",
        descriptor: { status: "incompatible", reason: "Plugin requires host interface 2." },
      }).text,
    ).toBe("Plugin requires host interface 2.");
  });
});

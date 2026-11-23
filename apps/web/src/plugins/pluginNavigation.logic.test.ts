import { EnvironmentId, type PluginCatalog, type PluginDescriptor } from "@t3tools/contracts";
import { manifest } from "@t3tools/plugin-workflows/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pluginNavigationEntries } from "./pluginNavigation.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const navigation = [
  {
    id: "workflows.navigation",
    title: "Workflows",
    icon: "workflow" as const,
    link: { pageId: "workflows.library" },
  },
  // A client-only entry the server's manifest does not publish.
  { id: "workflows.extra", title: "Extra", icon: "puzzle" as const, link: { pageId: "extra" } },
];
const plugins = [{ manifest, navigation }];

const catalog = (
  environmentId: EnvironmentId,
  descriptor: Partial<PluginDescriptor> = {},
): PluginCatalog => ({
  environmentId,
  hostVersion: 1,
  providerTools: [],
  plugins: [{ environmentId, manifest, status: "available", reason: null, ...descriptor }],
});

describe("pluginNavigationEntries", () => {
  it("lists each connected environment's published entries for available, compatible plugins", () => {
    const catalogs = new Map<EnvironmentId, PluginCatalog | null>([
      [local, catalog(local)],
      [remote, catalog(remote)],
      [EnvironmentId.make("down"), catalog(EnvironmentId.make("down"), { status: "unavailable" })],
      [
        EnvironmentId.make("newer"),
        catalog(EnvironmentId.make("newer"), { manifest: { ...manifest, hostVersion: 2 } }),
      ],
      [EnvironmentId.make("loading"), null],
    ]);
    const entries = pluginNavigationEntries(
      [...catalogs.keys()],
      (environmentId) => catalogs.get(environmentId) ?? null,
      plugins,
    );
    expect(
      entries.map((entry) => [
        entry.environmentId,
        entry.pluginId,
        entry.item.id,
        entry.pluginName,
      ]),
    ).toEqual([
      [local, "workflows", "workflows.navigation", "Workflows"],
      [remote, "workflows", "workflows.navigation", "Workflows"],
    ]);
  });
});

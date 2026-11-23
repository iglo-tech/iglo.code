import type { EnvironmentId, PluginCatalog, PluginManifest } from "@t3tools/contracts";
import type { WebPlugin } from "@t3tools/plugin-host-contract/web";

export interface PluginNavigationEntry {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly pluginName: string;
  readonly item: WebPlugin<unknown>["navigation"][number];
}

/** Navigation this client and each environment both contribute, as the sidebar shows it. */
export function pluginNavigationEntries(
  environmentIds: ReadonlyArray<EnvironmentId>,
  catalogFor: (environmentId: EnvironmentId) => PluginCatalog | null,
  plugins: ReadonlyArray<{
    readonly manifest: PluginManifest;
    readonly navigation: WebPlugin<unknown>["navigation"];
  }>,
): ReadonlyArray<PluginNavigationEntry> {
  return environmentIds.flatMap((environmentId) => {
    const catalog = catalogFor(environmentId);
    if (catalog === null) return [];
    return plugins.flatMap((plugin) => {
      const descriptor = catalog.plugins.find(
        (item) =>
          item.manifest.id === plugin.manifest.id &&
          item.status === "available" &&
          item.manifest.hostVersion === plugin.manifest.hostVersion,
      );
      if (descriptor === undefined) return [];
      return plugin.navigation
        .filter((item) => descriptor.manifest.web.navigation.includes(item.id))
        .map((item) => ({
          environmentId,
          pluginId: plugin.manifest.id,
          pluginName: descriptor.manifest.displayName,
          item,
        }));
    });
  });
}

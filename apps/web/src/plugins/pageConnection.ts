import type { EnvironmentId, PluginCatalog } from "@t3tools/contracts";

/** The last catalog a page saw, remembered with the environment it came from. */
export interface RetainedCatalog {
  readonly environmentId: EnvironmentId;
  readonly catalog: PluginCatalog;
}
export type PluginPageStatus = "connected" | "reconciling" | "disconnected";

/** A page may keep its own environment's last catalog while the connection reconciles. */
export function pageCatalog(
  retained: RetainedCatalog | null,
  environmentId: EnvironmentId,
  current: PluginCatalog | null,
  retain: boolean,
): PluginCatalog | null {
  if (current !== null) return current;
  return retain && retained?.environmentId === environmentId ? retained.catalog : null;
}

/** Connected-but-unreconciled differs from offline; both hold mutations. */
export function pageStatus(connected: boolean, current: PluginCatalog | null): PluginPageStatus {
  return !connected ? "disconnected" : current === null ? "reconciling" : "connected";
}

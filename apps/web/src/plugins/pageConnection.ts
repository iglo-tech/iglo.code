import type { EnvironmentId, PluginCatalog } from "@t3tools/contracts";

/** The last catalog a page saw, remembered with the environment it came from. */
export interface RetainedCatalog {
  readonly environmentId: EnvironmentId;
  readonly catalog: PluginCatalog;
}
export type PluginPageStatus =
  | "connected"
  | "reconciling"
  | "disconnected"
  | "unsupported"
  | "catalog-unavailable";

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

/**
 * Connected-but-unreconciled differs from offline, from a server without the plugin host,
 * and from a failed catalog request; all of them hold mutations.
 */
export function pageStatus(input: {
  readonly connected: boolean;
  readonly supported: boolean;
  readonly catalogFailed: boolean;
  readonly current: PluginCatalog | null;
}): PluginPageStatus {
  if (!input.connected) return "disconnected";
  if (!input.supported) return "unsupported";
  if (input.current !== null) return "connected";
  return input.catalogFailed ? "catalog-unavailable" : "reconciling";
}

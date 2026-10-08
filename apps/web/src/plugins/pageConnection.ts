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

export type PluginSupport = "supported" | "unsupported" | "unknown";

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
  /** `unknown` until the session reports its configuration, e.g. during a reconnect. */
  readonly support: PluginSupport;
  readonly catalogFailed: boolean;
  readonly current: PluginCatalog | null;
}): PluginPageStatus {
  if (!input.connected) return "disconnected";
  if (input.support === "unsupported") return "unsupported";
  if (input.current !== null) return "connected";
  return input.catalogFailed ? "catalog-unavailable" : "reconciling";
}

/**
 * What a plugin route shows when it has no page to render: a loading or connection state
 * until the environment's catalog is known, and an incompatibility reason only afterwards.
 */
export function missingPageMessage(input: {
  readonly status: PluginPageStatus;
  readonly descriptor: { readonly status: string; readonly reason: string | null } | undefined;
}): { readonly title: string; readonly text: string; readonly retry: boolean } {
  switch (input.status) {
    case "reconciling":
      return { title: "Loading", text: "Loading this page from the environment…", retry: false };
    case "disconnected":
      return {
        title: "Disconnected",
        text: "Disconnected from this environment. This page loads when it reconnects.",
        retry: false,
      };
    case "unsupported":
      return {
        title: "Plugin unavailable",
        text: "This environment does not support plugins.",
        retry: false,
      };
    case "catalog-unavailable":
      return {
        title: "Plugin unavailable",
        text: "This environment's plugin catalog could not be loaded.",
        retry: true,
      };
    case "connected":
      return {
        title: "Plugin unavailable",
        text:
          input.descriptor?.reason ??
          (input.descriptor?.status === "available"
            ? "This page is not included in this client build."
            : "Connect to the selected environment with a compatible plugin build."),
        retry: false,
      };
  }
}

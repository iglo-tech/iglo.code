import { createContext, useContext } from "react";
import type { PluginPageStatus } from "./pageConnection";

/**
 * What a hosted plugin page's own header needs from the shell: the bar geometry, where the
 * page runs, and the connection notice the host would otherwise show under its title bar.
 */
export interface PluginPageChrome {
  readonly electron: boolean;
  readonly environmentLabel: string;
  /** The environment leads the breadcrumb only when more than one is connected. */
  readonly showEnvironment: boolean;
  readonly status: PluginPageStatus;
  readonly onRetryCatalog?: () => void;
  /** Registers a page-rendered header; returns the release. */
  readonly claimHeader: () => () => void;
}

export const PluginPageChromeContext = createContext<PluginPageChrome | null>(null);
export const usePluginPageChrome = () => useContext(PluginPageChromeContext);

/** Short notices for a page whose environment is not reconciled. Snapshots stay visible. */
export const pageStatusNotice: Record<
  Exclude<PluginPageStatus, "connected">,
  { readonly title: string; readonly detail: string }
> = {
  disconnected: {
    title: "Disconnected",
    detail: "Changes wait until this environment reconnects.",
  },
  reconciling: { title: "Reconnecting", detail: "Changes wait until this environment reconciles." },
  unsupported: { title: "Plugins unsupported", detail: "This environment cannot run plugins." },
  "catalog-unavailable": {
    title: "Plugin catalog unavailable",
    detail: "Changes wait until the catalog loads.",
  },
};

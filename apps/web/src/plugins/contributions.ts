import type { PluginWebContext, WebPlugin } from "@t3tools/plugin-host-contract/web";
import { Suspense, createElement } from "react";

// Plugins may load page modules lazily; the shell shows a textual status meanwhile.
const loading = createElement(
  "p",
  { role: "status", className: "px-6 py-8 text-sm text-muted-foreground" },
  "Loading page…",
);

export function bind<Client>(plugin: WebPlugin<Client>, client: Client) {
  return {
    manifest: plugin.manifest,
    pages: plugin.pages.map((page) => ({
      id: page.id,
      title: page.title,
      render: (context: PluginWebContext) =>
        createElement(
          Suspense,
          { fallback: loading },
          createElement(page.component, { ...context, client }),
        ),
    })),
    navigation: plugin.navigation,
    projectActions: plugin.projectActions,
    attention: plugin.attention ?? null,
    threadContext: plugin.threadContext.map((contribution) => ({
      id: contribution.id,
      render: (context: PluginWebContext) => contribution.render({ ...context, client }),
    })),
  };
}

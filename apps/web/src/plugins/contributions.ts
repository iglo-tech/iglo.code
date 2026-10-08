import type { PluginWebContext, WebPlugin } from "@t3tools/plugin-host-contract/web";
import { createElement } from "react";

export function bind<Client>(plugin: WebPlugin<Client>, client: Client) {
  return {
    manifest: plugin.manifest,
    pages: plugin.pages.map((page) => ({
      id: page.id,
      title: page.title,
      render: (context: PluginWebContext) => createElement(page.component, { ...context, client }),
    })),
    navigation: plugin.navigation,
    projectActions: plugin.projectActions,
    threadContext: plugin.threadContext.map((contribution) => ({
      id: contribution.id,
      render: (context: PluginWebContext) => contribution.render({ ...context, client }),
    })),
  };
}

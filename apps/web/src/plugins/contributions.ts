import type {
  PluginScheduleTargetEditorProps,
  PluginScheduleTargetHistoryProps,
  PluginScheduleTargetSaveInput,
  PluginWebContext,
  WebPlugin,
} from "@t3tools/plugin-host-contract/web";
import { Suspense, createElement } from "react";

// Plugins may load page modules lazily; the shell shows a textual status meanwhile.
const loading = createElement(
  "p",
  { role: "status", className: "px-6 py-8 text-sm text-muted-foreground" },
  "Loading page…",
);
const loadingSection = createElement(
  "p",
  { role: "status", className: "text-sm text-muted-foreground" },
  "Loading…",
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
    scheduleTargets: (plugin.scheduleTargets ?? []).map((target) => ({
      id: target.id,
      title: target.title,
      renderEditor: (context: PluginWebContext, props: PluginScheduleTargetEditorProps) =>
        createElement(
          Suspense,
          { fallback: loadingSection },
          createElement(target.editor, { ...context, ...props, client }),
        ),
      renderHistory: (context: PluginWebContext, props: PluginScheduleTargetHistoryProps) =>
        createElement(
          Suspense,
          { fallback: loadingSection },
          createElement(target.history, { ...context, ...props, client }),
        ),
      save: (input: PluginScheduleTargetSaveInput) => target.save(client, input),
    })),
    threadContext: plugin.threadContext.map((contribution) => ({
      id: contribution.id,
      render: (context: PluginWebContext) => contribution.render({ ...context, client }),
    })),
  };
}

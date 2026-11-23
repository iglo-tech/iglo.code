import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";
import { useConnectedEnvironmentIds, useEnvironments } from "../state/environments";
import { environmentSummaries } from "../state/presentation";
import { compiledWebPlugins } from "./compiled";
import { pluginPageRoute } from "./context";
import { pluginNavigationEntries } from "./pluginNavigation.logic";
import { PluginIcon } from "./pluginIcons";
import { projectFor, useRouteProject } from "./routeProject";
import { availableCatalogAtom } from "./runtime";

const pluginNavigationAtom = Atom.make((get) =>
  pluginNavigationEntries(
    get(environmentSummaries.connectedEnvironmentIdsAtom),
    (environmentId) => get(availableCatalogAtom(environmentId)),
    compiledWebPlugins,
  ),
);

/** Command palette actions that open each connected environment's plugin navigation entries. */
export function usePluginNavigationActions(): ReadonlyArray<CommandPaletteActionItem> {
  const gt = useGT();
  const navigate = useNavigate();
  const route = useRouteProject();
  const { environments } = useEnvironments();
  const labelEnvironment = useConnectedEnvironmentIds().length > 1;
  const entries = useAtomValue(pluginNavigationAtom);
  return entries.map(({ environmentId, pluginId, pluginName, item }) => {
    const environment =
      environments.find((candidate) => candidate.environmentId === environmentId)?.label ??
      environmentId;
    return {
      kind: "action",
      value: `action:plugin:${environmentId}:${pluginId}:${item.id}`,
      searchTerms: [item.title, pluginName, ...(labelEnvironment ? [environment] : [])],
      title: labelEnvironment
        ? gt("Open {title} · {environment}", { title: item.title, environment })
        : gt("Open {title}", { title: item.title }),
      icon: <PluginIcon name={item.icon} className={ITEM_ICON_CLASS} />,
      run: async () => {
        // Like the sidebar entry, it opens in the project the user is in.
        const projectId = projectFor(route, environmentId);
        await navigate(
          pluginPageRoute(
            environmentId,
            pluginId,
            item.link.projectId === undefined && projectId !== undefined
              ? { ...item.link, projectId }
              : item.link,
          ),
        );
      },
    };
  });
}

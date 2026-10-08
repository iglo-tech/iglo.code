import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { PluginPageContent } from "../plugins/PluginPageContent";
import { isElectron } from "../env";
import { usePluginContributions } from "../plugins/PluginSlots";
import { validatePluginSearch } from "../plugins/pageLink";

export const Route = createFileRoute("/_chat/plugins/$environmentId/$pluginId/$pageId")({
  validateSearch: validatePluginSearch,
  component: PluginPage,
});

function PluginPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const environmentId = EnvironmentId.make(params.environmentId);
  const { catalog, contributions, connection } = usePluginContributions(
    environmentId,
    search.pluginProjectId ?? null,
    search.pluginThreadId ?? null,
    {
      ...(search.pluginState === undefined ? {} : { state: search.pluginState }),
      retainWhileDisconnected: true,
    },
  );
  return (
    <PluginPageContent
      catalog={catalog}
      contributions={contributions}
      pluginId={params.pluginId}
      pageId={params.pageId}
      connection={connection}
      electron={isElectron}
    />
  );
}

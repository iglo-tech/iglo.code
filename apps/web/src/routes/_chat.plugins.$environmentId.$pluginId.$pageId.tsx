import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PluginPageContent } from "../plugins/PluginPageContent";
import { isElectron } from "../env";
import { usePluginContributions } from "../plugins/PluginSlots";

const Search = Schema.Struct({
  pluginProjectId: Schema.optional(ProjectId),
  pluginThreadId: Schema.optional(ThreadId),
});
const decodeSearch = Schema.decodeUnknownSync(Search);
export const Route = createFileRoute("/_chat/plugins/$environmentId/$pluginId/$pageId")({
  validateSearch: (input: Record<string, unknown>) => decodeSearch(input),
  component: PluginPage,
});

function PluginPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const environmentId = EnvironmentId.make(params.environmentId);
  const { catalog, contributions } = usePluginContributions(
    environmentId,
    search.pluginProjectId ?? null,
    search.pluginThreadId ?? null,
  );
  return (
    <PluginPageContent
      catalog={catalog}
      contributions={contributions}
      pluginId={params.pluginId}
      pageId={params.pageId}
      electron={isElectron}
    />
  );
}

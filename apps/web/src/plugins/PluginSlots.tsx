import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, PluginPageState, PluginTarget, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";
import type { PluginWebContext } from "@t3tools/plugin-host-contract/web";
import { Button } from "../components/ui/button";
import { useConnectedEnvironmentIds, useEnvironment } from "../state/environments";
import { availableCatalogAtom, attentionAtom, pluginConnectedAtom } from "./runtime";
import { compiledWebPlugins } from "./compiled";
import { createPluginWebContext } from "./context";
import { pageCatalog, pageStatus, type RetainedCatalog } from "./pageConnection";

export function usePluginContributions(
  environmentId: EnvironmentId,
  projectId: ProjectId | null = null,
  threadId: PluginTarget["threadId"] | null = null,
  page: { readonly state?: PluginPageState; readonly retainWhileDisconnected?: boolean } = {},
) {
  const current = useAtomValue(availableCatalogAtom(environmentId));
  const connected = useAtomValue(pluginConnectedAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const navigate = useNavigate();
  // A page keeps its own environment's last catalog while the connection is unreconciled
  // so drafts and snapshots stay visible; plugins gate mutations on `connection`.
  const [retained, setRetained] = useState<RetainedCatalog | null>(null);
  if (
    page.retainWhileDisconnected &&
    current !== null &&
    (retained?.catalog !== current || retained.environmentId !== environmentId)
  )
    setRetained({ environmentId, catalog: current });
  const catalog = pageCatalog(
    retained,
    environmentId,
    current,
    page.retainWhileDisconnected ?? false,
  );
  const status = pageStatus(connected, current);
  const connection: PluginWebContext["connection"] =
    status === "connected" ? "connected" : "disconnected";
  const label = environment?.label ?? environmentId;
  const stateKey = page.state === undefined ? "" : JSON.stringify(page.state);
  const contributions = useMemo(
    () =>
      compiledWebPlugins.flatMap((plugin) => {
        const descriptor = catalog?.plugins.find(
          (item) =>
            item.manifest.id === plugin.manifest.id &&
            item.status === "available" &&
            item.manifest.hostVersion === plugin.manifest.hostVersion,
        );
        if (descriptor === undefined) return [];
        const bound = plugin.bind(environmentId);
        const context = createPluginWebContext({
          environmentId,
          environmentLabel: label,
          descriptor,
          projectId,
          threadId,
          ...(stateKey === "" ? {} : { pageState: JSON.parse(stateKey) as PluginPageState }),
          connection,
          navigate,
        });
        return [{ ...bound, context }];
      }),
    [catalog, connection, environmentId, label, navigate, projectId, stateKey, threadId],
  );
  return { catalog, contributions, connection, status };
}

/** Links to pages this client or server does not contribute stay visible but unavailable. */
const pageAvailable = (
  plugin: ReturnType<typeof usePluginContributions>["contributions"][number],
  pageId: string,
) =>
  plugin.pages.some((page) => page.id === pageId) &&
  plugin.context.descriptor.manifest.web.pages.includes(pageId);

function EnvironmentPluginNavigation({ environmentId }: { environmentId: EnvironmentId }) {
  const { contributions } = usePluginContributions(environmentId);
  const environment = useEnvironment(environmentId);
  const attention = useAtomValue(attentionAtom(environmentId));
  const items = Option.getOrElse(AsyncResult.value(attention), () => []);
  if (contributions.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <p className="px-2 text-xs text-muted-foreground">{environment?.label ?? environmentId}</p>
      {contributions.flatMap((plugin) =>
        plugin.navigation
          .filter((item) => plugin.context.descriptor.manifest.web.navigation.includes(item.id))
          .map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              onClick={() => plugin.context.navigate(item.link)}
            >
              {item.title}
            </Button>
          )),
      )}
      {items.flatMap((summary) => {
        const plugin = contributions.find((item) => item.manifest.id === summary.pluginId);
        return plugin === undefined
          ? []
          : [
              ...(summary.error === undefined
                ? []
                : [
                    <p
                      key={`${summary.pluginId}:error`}
                      role="status"
                      className="px-2 text-xs text-destructive"
                    >
                      {plugin.manifest.displayName}: {summary.error.message}
                    </p>,
                  ]),
              ...summary.items.map((item) => {
                const available = pageAvailable(plugin, item.link.pageId);
                return (
                  <Button
                    key={`${summary.pluginId}:${item.id}`}
                    variant="ghost"
                    size="sm"
                    disabled={!available}
                    title={available ? item.reason : "This page is not available in this client."}
                    onClick={() => plugin.context.navigate(item.link)}
                  >
                    <span className="min-w-0 truncate">{item.summary}</span>
                  </Button>
                );
              }),
            ];
      })}
    </div>
  );
}

export function PluginNavigation() {
  const environmentIds = useConnectedEnvironmentIds();
  return (
    <div className="[app-region:no-drag] max-h-48 shrink-0 overflow-y-auto">
      {environmentIds.map((environmentId) => (
        <EnvironmentPluginNavigation key={environmentId} environmentId={environmentId} />
      ))}
    </div>
  );
}

export function PluginProjectActions({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const { contributions } = usePluginContributions(environmentId, projectId);
  return (
    <div className="[app-region:no-drag] flex shrink-0 gap-1">
      {contributions.flatMap((plugin) =>
        plugin.projectActions
          .filter((item) => plugin.context.descriptor.manifest.web.projectActions.includes(item.id))
          .map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              onClick={() => plugin.context.navigate(item.link(projectId))}
            >
              {item.title}
            </Button>
          )),
      )}
    </div>
  );
}

export function PluginThreadContext({ target }: { target: PluginTarget }) {
  const { contributions } = usePluginContributions(
    target.environmentId,
    target.projectId,
    target.threadId,
  );
  return (
    <div className="[app-region:no-drag] flex shrink-0 gap-1">
      {contributions.flatMap((plugin) =>
        plugin.threadContext
          .filter((item) => plugin.context.descriptor.manifest.web.threadContext.includes(item.id))
          .map((item) => <div key={item.id}>{item.render(plugin.context)}</div>),
      )}
    </div>
  );
}

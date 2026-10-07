import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, PluginTarget, ProjectId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { Button } from "../components/ui/button";
import { useConnectedEnvironmentIds, useEnvironment } from "../state/environments";
import { availableCatalogAtom, attentionAtom } from "./runtime";
import { compiledWebPlugins } from "./compiled";
import { createPluginWebContext } from "./context";

export function usePluginContributions(
  environmentId: EnvironmentId,
  projectId: ProjectId | null = null,
  threadId: PluginTarget["threadId"] | null = null,
) {
  const catalog = useAtomValue(availableCatalogAtom(environmentId));
  const navigate = useNavigate();
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
        const context = createPluginWebContext(
          environmentId,
          descriptor,
          projectId,
          threadId,
          navigate,
        );
        return [{ ...bound, context }];
      }),
    [catalog, environmentId, navigate, projectId, threadId],
  );
  return { catalog, contributions };
}

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
          : summary.items.map((item) => (
              <Button
                key={`${summary.pluginId}:${item.id}`}
                variant="ghost"
                size="sm"
                onClick={() => plugin.context.navigate(item.link)}
              >
                <span className="min-w-0 truncate">{item.summary}</span>
              </Button>
            ));
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

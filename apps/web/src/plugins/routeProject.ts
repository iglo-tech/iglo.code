import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useParams, useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, useThreadProjectId } from "../state/entities";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { useUiStateStore } from "../uiStateStore";
import { railProjectFor } from "./routeProject.logic";

export interface RouteProject {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

// The last project the user worked in, per environment, for entries opened from elsewhere.
const lastProjects = new Map<string, ProjectId>();

/**
 * The project the current route is about: a thread's or draft's project, or a plugin page's
 * project. Plugin navigation opens its page in this project, like project actions do.
 */
export function useRouteProject(): RouteProject | null {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const environmentId = "environmentId" in params ? params.environmentId : undefined;
  const threadId = "threadId" in params ? params.threadId : undefined;
  const draftId = "draftId" in params ? params.draftId : undefined;
  const threadRef =
    environmentId !== undefined && threadId !== undefined
      ? scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId))
      : null;
  const threadProjectId = useThreadProjectId(threadRef);
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId === undefined
      ? null
      : (store.getDraftSession(DraftId.make(draftId))?.environmentId ?? null),
  );
  const draftProjectId = useComposerDraftStore((store) =>
    draftId === undefined
      ? null
      : (store.getDraftSession(DraftId.make(draftId))?.projectId ?? null),
  );
  const pluginProjectId =
    "pluginProjectId" in search && typeof search.pluginProjectId === "string"
      ? search.pluginProjectId
      : undefined;
  // Primitive selections, so a running thread's shell updates do not re-render navigation.
  const [environment, project] =
    threadProjectId !== null && environmentId !== undefined
      ? [EnvironmentId.make(environmentId), threadProjectId]
      : draftEnvironmentId !== null && draftProjectId !== null
        ? [draftEnvironmentId, draftProjectId]
        : environmentId !== undefined && pluginProjectId !== undefined
          ? [EnvironmentId.make(environmentId), ProjectId.make(pluginProjectId)]
          : [undefined, undefined];
  const current: RouteProject | null =
    environment === undefined || project === undefined
      ? null
      : { environmentId: environment, projectId: project };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Records the route's project in the module-level last-used registry.
  useEffect(() => {
    if (environment !== undefined && project !== undefined) lastProjects.set(environment, project);
  }, [environment, project]);
  return current;
}

function readRailProject(environmentId: EnvironmentId): ProjectId | undefined {
  return railProjectFor({
    projects: readProjects(),
    scopeKeys: useUiStateStore.getState().sidebarProjectScopeKeys,
    settings: selectProjectGroupingSettings(getClientSettings()),
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    environmentId,
  });
}

/**
 * The route's project in this environment, else the project scoped alone in the sidebar's
 * project rail, else the last one used there. Read when the user acts, not during render.
 */
export function projectFor(
  route: RouteProject | null,
  environmentId: EnvironmentId,
): ProjectId | undefined {
  if (route?.environmentId === environmentId) return route.projectId;
  return readRailProject(environmentId) ?? lastProjects.get(environmentId);
}

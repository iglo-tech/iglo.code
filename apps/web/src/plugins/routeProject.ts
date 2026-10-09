import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell } from "../state/entities";

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
  const threadRef = useMemo(
    () =>
      environmentId !== undefined && threadId !== undefined
        ? scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId))
        : null,
    [environmentId, threadId],
  );
  const thread = useThreadShell(threadRef);
  const draft = useComposerDraftStore((store) =>
    draftId === undefined ? null : store.getDraftSession(DraftId.make(draftId)),
  );
  const pluginProjectId =
    "pluginProjectId" in search && typeof search.pluginProjectId === "string"
      ? search.pluginProjectId
      : undefined;
  const current: RouteProject | null =
    thread !== null
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : draft !== null
        ? { environmentId: draft.environmentId, projectId: draft.projectId }
        : environmentId !== undefined && pluginProjectId !== undefined
          ? {
              environmentId: EnvironmentId.make(environmentId),
              projectId: ProjectId.make(pluginProjectId),
            }
          : null;
  const environment = current?.environmentId;
  const project = current?.projectId;
  useEffect(() => {
    if (environment !== undefined && project !== undefined) lastProjects.set(environment, project);
  }, [environment, project]);
  return current;
}

/** The route's project in this environment, else the last one used there. */
export function projectFor(
  route: RouteProject | null,
  environmentId: EnvironmentId,
): ProjectId | undefined {
  return route?.environmentId === environmentId ? route.projectId : lastProjects.get(environmentId);
}

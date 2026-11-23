import {
  isPickableProjectMember,
  selectGroupDefaultProject,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  buildSidebarProjectSnapshots,
  resolveSidebarProjectScopeKeys,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";

/** The open project scoped alone in the sidebar's project rail, in this environment. */
export function railProjectFor(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly scopeKeys: ReadonlyArray<string>;
  readonly settings: ProjectGroupingSettings;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentId: EnvironmentId;
}): ProjectId | undefined {
  const groups = buildSidebarProjectSnapshots({
    projects: input.projects,
    groupScratchProjects: true,
    settings: input.settings,
    primaryEnvironmentId: input.primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
  const keys = resolveSidebarProjectScopeKeys({
    groups,
    keys: input.scopeKeys,
    settings: input.settings,
  });
  if (keys.length !== 1) return undefined;
  const group = groups.find((candidate) => candidate.projectKey === keys[0] && !candidate.archived);
  const members =
    group?.memberProjects.filter(
      (member) => member.environmentId === input.environmentId && isPickableProjectMember(member),
    ) ?? [];
  return selectGroupDefaultProject(members)?.id;
}

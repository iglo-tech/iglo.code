import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { LayersIcon, PinIcon, PlusIcon } from "lucide-react";
import { T, useGT } from "gt-react";
import { memo } from "react";

import type { ContextMenuSource, ProjectIconColor } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { projectIconColorClassName } from "../../projectIconColors";
import { deriveProjectIdentity } from "../../projectIdentity";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import {
  groupSidebarRailThreadsByProject,
  resolveSidebarProjectActivity,
  resolveThreadLastVisitedAt,
  useSnoozeWakeClock,
} from "../Sidebar.logic";
import { groupIconFallbacks } from "@t3tools/client-runtime/state/project-grouping";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarProjectSwitcherProps {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly selectedProjectKeys: ReadonlyArray<string>;
  readonly onSelectAll: () => void;
  readonly onSelectProject: (projectKey: string) => void;
  readonly onToggleProject: (projectKey: string) => void;
  readonly onNewProject: () => void;
  readonly onContextMenu?: (
    project: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly delegatedUnderParent: ReadonlySet<string>;
}

/** The colour a project's monogram or icon uses; emoji projects have none. */
function projectTintColor(project: SidebarProjectSnapshot): ProjectIconColor | null {
  const icon = project.projectIcon;
  if (icon?.kind === "monogram" || icon?.kind === "lucide") return icon.color;
  if (icon?.kind === "emoji") return null;
  return deriveProjectIdentity(project.title).color;
}

export const SidebarProjectSwitcher = memo(function SidebarProjectSwitcher({
  projectGroups,
  selectedProjectKeys,
  onSelectAll,
  onSelectProject,
  onToggleProject,
  onNewProject,
  onContextMenu,
  threads,
  delegatedUnderParent,
}: SidebarProjectSwitcherProps) {
  const gt = useGT();
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const snoozeWakeClock = useSnoozeWakeClock(threads);

  const isAllSelected = selectedProjectKeys.length === 0;

  const threadsByProjectKey = groupSidebarRailThreadsByProject(
    threads,
    projectGroups,
    delegatedUnderParent,
    new Date(snoozeWakeClock).toISOString(),
  );

  return (
    <nav
      aria-label={gt("Projects")}
      className="relative flex h-full w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/70 py-2 select-none [-webkit-app-region:no-drag]"
    >
      {/* The phone sheet's only close control, where the chat header's toggle sits. */}
      <div className="flex w-full items-center justify-center pb-2 md:hidden">
        <SidebarTrigger aria-label={gt("Close sidebar")} />
      </div>
      {/* Top: All Projects button (Discord Home / DM style) */}
      <div className="group/item relative flex w-full items-center justify-center py-0.5">
        {/* Discord left indicator pill */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 w-1 rounded-r-full bg-sidebar-foreground transition-[height] duration-200",
            isAllSelected ? "h-10" : "h-0 group-hover/item:h-5",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={gt("All projects")}
                aria-pressed={isAllSelected}
                onClick={onSelectAll}
                className={cn(
                  "relative flex size-10 items-center justify-center transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isAllSelected
                    ? "rounded-2xl bg-primary text-primary-foreground"
                    : "rounded-3xl bg-sidebar-control-surface text-sidebar-foreground/80 hover:rounded-2xl hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                )}
              >
                <LayersIcon className="size-5" />
              </button>
            }
          />
          <TooltipPopup side="right" sideOffset={12}>
            <T>All projects</T>
          </TooltipPopup>
        </Tooltip>
      </div>

      {/* Divider */}
      <div className="my-1.5 h-0.5 w-8 shrink-0 rounded-full bg-sidebar-border" />

      {/* Projects list */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {projectGroups.map((project) => {
          const isSelected = selectedProjectKeys.includes(project.projectKey);

          const tint = projectTintColor(project);
          const projectThreads = threadsByProjectKey.get(project.projectKey) ?? [];
          const activity = resolveSidebarProjectActivity(
            projectThreads.map((thread) => ({
              ...thread,
              lastVisitedAt: resolveThreadLastVisitedAt(
                thread.lastVisitedAt,
                localLastVisitedAtById[
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
                ],
              ),
            })),
          );
          const activityStatus =
            activity.needsYouCount > 0
              ? gt("{count, plural, one {{count} needs you} other {{count} need you}}", {
                  count: activity.needsYouCount,
                })
              : activity.unread
                ? gt("Done")
                : activity.working
                  ? gt("Working")
                  : null;
          const activityLabel = activityStatus ? `, ${activityStatus.toLowerCase()}` : "";

          return (
            <div
              key={project.projectKey}
              className="group/item relative flex w-full items-center justify-center"
            >
              {/* Discord left indicator pill */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 w-1 rounded-r-full bg-sidebar-foreground transition-[height] duration-200",
                  isSelected
                    ? "h-10"
                    : activity.unread
                      ? "h-2 group-hover/item:h-5"
                      : "h-0 group-hover/item:h-5",
                )}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${project.displayName}${activityLabel}`}
                      aria-pressed={isSelected}
                      onClick={(event) => {
                        if (event.shiftKey) {
                          onToggleProject(project.projectKey);
                        } else {
                          onSelectProject(project.projectKey);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && event.shiftKey) {
                          event.preventDefault();
                          onToggleProject(project.projectKey);
                        }
                      }}
                      onContextMenu={(event) => {
                        if (onContextMenu) {
                          event.preventDefault();
                          onContextMenu(
                            project,
                            { x: event.clientX, y: event.clientY },
                            contextMenuSourceOf(event.nativeEvent),
                          );
                        }
                      }}
                      className={cn(
                        "relative flex size-10 items-center justify-center transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected ? "rounded-2xl" : "rounded-3xl hover:rounded-2xl",
                        tint
                          ? // The button carries the monogram's tint, so its own inner tile goes clear.
                            cn(
                              projectIconColorClassName(tint),
                              "[&_[data-slot=project-monogram]_svg]:bg-transparent!",
                            )
                          : isSelected
                            ? "bg-sidebar-row-selected text-sidebar-foreground"
                            : "bg-sidebar-control-surface text-sidebar-foreground hover:bg-sidebar-row-hover",
                      )}
                      style={
                        tint
                          ? {
                              backgroundColor: `color-mix(in srgb, currentColor ${isSelected ? 24 : 14}%, var(--sidebar))`,
                            }
                          : undefined
                      }
                    >
                      <ProjectFavicon
                        project={project}
                        fallbackProjects={groupIconFallbacks(project.memberProjects, project)}
                        className="size-5 shrink-0"
                      />

                      {/* Pin indicator */}
                      {project.pinned ? (
                        <span className="pointer-events-none absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-sidebar ring-1 ring-sidebar-border">
                          <PinIcon className="size-2 rotate-45 text-muted-foreground" />
                        </span>
                      ) : null}

                      {activity.needsYouCount > 0 ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-3xs leading-none font-semibold text-white tabular-nums ring-2 ring-sidebar"
                        >
                          {activity.needsYouCount > 9 ? "9+" : activity.needsYouCount}
                        </span>
                      ) : activity.working ? (
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-info ring-2 ring-sidebar"
                        />
                      ) : null}
                    </button>
                  }
                />
                <TooltipPopup side="right" sideOffset={12}>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{project.displayName}</span>
                      {project.remoteEnvironmentLabels.length > 0 ? (
                        <span className="rounded-xs bg-muted px-1 text-2xs text-muted-foreground">
                          {project.remoteEnvironmentLabels.join(", ")}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-2xs text-muted-foreground">
                      {project.pinned ? `${gt("Pinned")} • ` : ""}
                      {activityStatus ? `${activityStatus} • ` : ""}
                      <T>Click to switch • Shift+click to toggle</T>
                    </span>
                  </div>
                </TooltipPopup>
              </Tooltip>
            </div>
          );
        })}

        {/* Add Project button (Discord style green plus) */}
        <div className="group/item relative flex w-full items-center justify-center pt-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={gt("Add project")}
                  onClick={onNewProject}
                  className="flex size-10 items-center justify-center rounded-3xl bg-sidebar-control-surface text-success transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden hover:rounded-2xl hover:bg-success hover:text-success-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <PlusIcon className="size-5" />
                </button>
              }
            />
            <TooltipPopup side="right" sideOffset={12}>
              <T>Add project</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
});

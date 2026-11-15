import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { LayersIcon, PinIcon, PlusIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ProjectFavicon } from "../ProjectFavicon";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./SidebarProjectFolderHeader";
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
  ) => void;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
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
}: SidebarProjectSwitcherProps) {
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  const isAllSelected = selectedProjectKeys.length === 0;

  // Map project keys to threads for calculating status dots
  const groupKeyByProjectRef = new Map<string, string>();
  for (const group of projectGroups) {
    for (const member of group.memberProjects) {
      groupKeyByProjectRef.set(`${member.environmentId}\0${member.id}`, group.projectKey);
    }
  }
  const threadsByProjectKey = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const projectKey = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (!projectKey) continue;
    const list = threadsByProjectKey.get(projectKey);
    if (list) {
      list.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  return (
    <nav
      aria-label="Projects"
      className="relative flex h-full w-14 shrink-0 flex-col items-center border-r border-sidebar-border bg-sidebar/70 py-2 select-none [-webkit-app-region:no-drag]"
    >
      {/* Top: All Projects button (Discord Home / DM style) */}
      <div className="group/item relative flex w-full items-center justify-center py-0.5">
        {/* Discord left indicator pill */}
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 w-1 rounded-r-full bg-foreground transition-[height,opacity] duration-200",
            isAllSelected
              ? "h-10 opacity-100"
              : "h-0 opacity-0 group-hover/item:h-5 group-hover/item:opacity-100",
          )}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="All projects"
                aria-pressed={isAllSelected}
                onClick={onSelectAll}
                className={cn(
                  "relative flex size-10 items-center justify-center transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isAllSelected
                    ? "rounded-2xl bg-sidebar-row-selected text-sidebar-foreground ring-2 ring-primary ring-inset shadow-xs font-medium"
                    : "rounded-3xl bg-sidebar-control-surface text-sidebar-foreground/80 hover:rounded-2xl hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                )}
              >
                <LayersIcon className="size-5" />
              </button>
            }
          />
          <TooltipPopup side="right" sideOffset={12}>
            All projects
          </TooltipPopup>
        </Tooltip>
      </div>

      {/* Divider */}
      <div className="my-1.5 h-0.5 w-8 shrink-0 rounded-full bg-sidebar-border" />

      {/* Projects list */}
      <div className="scrollbar-gutter-both flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-x-hidden overflow-y-auto py-1">
        {projectGroups.map((project) => {
          const isSelected = selectedProjectKeys.includes(project.projectKey);

          // Status dot calculation
          const projectThreads = threadsByProjectKey.get(project.projectKey) ?? [];
          const dot = resolveSidebarFolderDot(
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

          const remoteLabels = project.memberProjects
            .map((member) => member.environmentLabel)
            .filter((label): label is string => Boolean(label))
            .filter((label, index, all) => all.indexOf(label) === index);

          return (
            <div
              key={project.projectKey}
              className="group/item relative flex w-full items-center justify-center"
            >
              {/* Discord left indicator pill */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 w-1 rounded-r-full bg-foreground transition-[height,opacity] duration-200",
                  isSelected
                    ? "h-10 opacity-100"
                    : "h-0 opacity-0 group-hover/item:h-5 group-hover/item:opacity-100",
                )}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${project.displayName}${dot ? FOLDER_DOT_LABEL[dot] : ""}`}
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
                          onContextMenu(project, { x: event.clientX, y: event.clientY });
                        }
                      }}
                      className={cn(
                        "relative flex size-10 items-center justify-center transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected
                          ? "rounded-2xl bg-sidebar-row-selected text-sidebar-foreground ring-2 ring-primary ring-inset shadow-xs"
                          : "rounded-3xl bg-sidebar-control-surface text-sidebar-foreground hover:rounded-2xl hover:bg-sidebar-row-hover",
                      )}
                    >
                      <ProjectFavicon project={project} className="size-5 shrink-0" />

                      {/* Pin indicator */}
                      {project.pinned ? (
                        <span className="pointer-events-none absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-sidebar ring-1 ring-sidebar-border">
                          <PinIcon className="size-2 rotate-45 text-muted-foreground" />
                        </span>
                      ) : null}

                      {/* Status notification dot */}
                      {dot ? (
                        <span
                          className={cn(
                            "pointer-events-none absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
                            FOLDER_DOT_CLASS_NAME[dot],
                          )}
                        />
                      ) : null}
                    </button>
                  }
                />
                <TooltipPopup side="right" sideOffset={12}>
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{project.displayName}</span>
                      {remoteLabels.length > 0 ? (
                        <span className="rounded-xs bg-muted px-1 text-2xs text-muted-foreground">
                          {remoteLabels.join(", ")}
                        </span>
                      ) : null}
                    </div>
                    <span className="text-2xs text-muted-foreground">
                      {project.pinned ? "Pinned • " : ""}
                      {dot ? `${FOLDER_DOT_LABEL[dot].replace(/^, /, "")} • ` : ""}
                      Click to switch • Shift+click to toggle
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
                  aria-label="Add project"
                  onClick={onNewProject}
                  className="flex size-10 items-center justify-center rounded-3xl bg-sidebar-control-surface text-success transition-[border-radius,background-color,color,box-shadow] duration-200 outline-hidden hover:rounded-2xl hover:bg-success hover:text-success-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <PlusIcon className="size-5" />
                </button>
              }
            />
            <TooltipPopup side="right" sideOffset={12}>
              Add project
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
});

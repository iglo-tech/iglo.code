import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScheduledTask, ScheduledTaskId } from "@t3tools/contracts";
import { CalendarClockIcon } from "lucide-react";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { scheduledRunLabel } from "../settings/scheduledTasksSettings.logic";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SortableSidebarMarker } from "./SidebarListMarkers";

export interface SidebarScheduledEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

function taskStatus(task: ScheduledTask, nowMs: number): string {
  if (task.blockedByPolicy !== undefined) return "Blocked";
  if (!task.enabled) return "Paused";
  if (task.schedule.type === "webhook") return "Listening";
  return scheduledRunLabel(task.nextRunAt, nowMs);
}

const SidebarScheduledRow = memo(function SidebarScheduledRow(props: {
  entry: SidebarScheduledEntry;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  status: string;
  onOpen: (environmentId: EnvironmentId, taskId: ScheduledTaskId) => void;
}) {
  const { environmentId, task } = props.entry;
  const failed = task.lastRunStatus === "failed";
  return (
    <li className="list-none py-0.5">
      <button
        type="button"
        data-sidebar-row={`scheduled:${environmentId}:${task.id}`}
        data-sidebar-parent="shelf:scheduled"
        data-testid="sidebar-scheduled-row"
        aria-label={`${task.title}, scheduled task${props.projectDisplayName ? ` in ${props.projectDisplayName}` : ""}, ${props.status}${failed ? ", last run failed" : ""}`}
        onClick={() => props.onOpen(environmentId, task.id)}
        className="w-full cursor-pointer rounded-md px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5">
          <CalendarClockIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0",
              failed ? "text-destructive" : "text-sidebar-muted-foreground",
            )}
          />
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-secondary-label">
            {props.projectDisplayName}
          </span>
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums",
              task.enabled && task.blockedByPolicy === undefined
                ? "text-sidebar-muted-foreground"
                : "text-sidebar-muted-foreground/60",
            )}
          >
            {props.status}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-sm font-medium",
            task.enabled ? "text-foreground/90" : "text-sidebar-muted-foreground",
          )}
        >
          {task.title}
        </span>
      </button>
    </li>
  );
});

/** Scheduled tasks for the sidebar's project scope, as one block so dragging threads moves it whole. */
export const SidebarScheduledShelf = memo(function SidebarScheduledShelf(props: {
  entries: ReadonlyArray<SidebarScheduledEntry>;
  expanded: boolean;
  onToggle: () => void;
  className: string;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  onOpen: (environmentId: EnvironmentId, taskId: ScheduledTaskId) => void;
}) {
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  return (
    <SortableSidebarMarker
      marker="scheduled-header"
      data-testid="sidebar-scheduled-header"
      className={props.className}
    >
      <div className="relative mx-0.5 h-8">
        <CollapsibleSectionHeader
          data-sidebar-row="shelf:scheduled"
          onClick={props.onToggle}
          expanded={props.expanded}
          tone="muted"
          data-testid="sidebar-scheduled-shelf-toggle"
          accessory={<span className="font-normal tabular-nums">{props.entries.length}</span>}
        >
          Scheduled
        </CollapsibleSectionHeader>
      </div>
      {props.expanded ? (
        <ul className="flex flex-col">
          {props.entries.map((entry) => {
            const projectKey = `${entry.environmentId}:${entry.task.projectId}`;
            return (
              <SidebarScheduledRow
                key={projectKey + ":" + entry.task.id}
                entry={entry}
                project={props.projectByKey.get(projectKey) ?? null}
                projectDisplayName={props.projectDisplayNameByKey.get(projectKey) ?? null}
                status={taskStatus(entry.task, nowMs)}
                onOpen={props.onOpen}
              />
            );
          })}
        </ul>
      ) : null}
    </SortableSidebarMarker>
  );
});

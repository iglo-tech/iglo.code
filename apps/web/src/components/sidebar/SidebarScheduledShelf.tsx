import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScheduledTask, ScheduledTaskId } from "@t3tools/contracts";
import { CalendarClockIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { memo } from "react";
import { useLocation } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { scheduledRunLabel } from "../settings/scheduledTasksSettings.logic";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SortableSidebarMarker } from "./SidebarListMarkers";

export interface SidebarScheduledEntry {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
}

function taskStatus(task: ScheduledTask, nowMs: number, resolve: MessageResolver = m): string {
  if (task.blockedByPolicy !== undefined) return resolve(msg("Blocked"));
  if (!task.enabled) return resolve(msg("Paused"));
  if (task.schedule.type === "webhook") return resolve(msg("Listening"));
  return scheduledRunLabel(task.nextRunAt, nowMs, resolve);
}

const SidebarScheduledRow = memo(function SidebarScheduledRow(props: {
  entry: SidebarScheduledEntry;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  status: string;
  isActive: boolean;
  onOpen: (environmentId: EnvironmentId, taskId: ScheduledTaskId) => void;
}) {
  const { environmentId, task } = props.entry;
  const failed = task.lastRunStatus === "failed";
  const gt = useGT();
  return (
    <li className="list-none py-0.5">
      <button
        type="button"
        data-sidebar-row={`scheduled:${environmentId}:${task.id}`}
        data-sidebar-parent="shelf:scheduled"
        data-testid="sidebar-scheduled-row"
        aria-current={props.isActive ? "page" : undefined}
        aria-label={gt(
          "{title}, scheduled task{project, select, none {} other { in {project}}}, {status}{failed, select, true {, last run failed} other {}}",
          {
            title: task.title,
            project: props.projectDisplayName || "none",
            status: props.status,
            failed: failed ? "true" : "false",
          },
        )}
        onClick={() => props.onOpen(environmentId, task.id)}
        className={cn(
          "w-full cursor-pointer rounded-md px-(--sidebar-row-content-inset) py-(--sidebar-content-inset) text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
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
  const m = useMessages();
  const nowMinute = useNowMinute();
  const nowMs = Date.parse(`${nowMinute}:00.000Z`);
  const pathname = useLocation({ select: (location) => location.pathname });
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
          <T>Scheduled</T>
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
                status={taskStatus(entry.task, nowMs, m)}
                isActive={
                  pathname ===
                  `/scheduled/${encodeURIComponent(entry.environmentId)}/${encodeURIComponent(entry.task.id)}`
                }
                onOpen={props.onOpen}
              />
            );
          })}
        </ul>
      ) : null}
    </SortableSidebarMarker>
  );
});

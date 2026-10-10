import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import type {
  PluginScheduleTargetEditorProps,
  PluginScheduleTargetHistoryProps,
  PluginScheduleTargetSaveInput,
} from "@t3tools/plugin-host-contract/web";
import type { ReactNode } from "react";
import type { PluginPageStatus } from "./pageConnection";

export type PluginSchedulePayload = PluginScheduleTargetSaveInput["payload"];

/** A plugin schedule target the selected environment publishes and this client can edit. */
export interface PluginScheduleTarget {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly renderEditor: (props: PluginScheduleTargetEditorProps) => ReactNode;
  readonly renderHistory: (props: PluginScheduleTargetHistoryProps) => ReactNode;
  readonly save: (input: PluginScheduleTargetSaveInput) => Promise<void>;
}

/** Why a schedule's target has no editor here, worded from the environment's catalog state. */
export function unavailableTargetText(status: PluginPageStatus, targetId: string) {
  switch (status) {
    case "reconciling":
      return "Checking this environment's plugins…";
    case "disconnected":
      return "Disconnected. This schedule's target is checked when the environment reconnects.";
    case "catalog-unavailable":
      return `Could not check whether ${targetId} is available in this environment.`;
    default:
      return `${targetId} is unavailable in this environment or this client. Its settings are kept: you can change its timing, pause it, or delete it.`;
  }
}

/**
 * The plugin and plugin-local identity of a schedule a plugin saved through the host's
 * schedule service, which stores it as `plugin:<pluginId>:<id>`. Null for prompt schedules.
 */
export function pluginScheduleOwner(task: ScheduledTask) {
  if (task.dispatchTarget === undefined) return null;
  const pluginId = task.dispatchTarget.id.split(".")[0] ?? "";
  const prefix = `plugin:${pluginId}:`;
  return {
    targetId: task.dispatchTarget.id,
    pluginId,
    scheduleId: task.id.startsWith(prefix) ? task.id.slice(prefix.length) : null,
  };
}

/** Changes whenever the host's row records another dispatch or edit. */
export const scheduleRevision = (task: ScheduledTask) =>
  [task.updatedAt, task.lastRunAt ?? "", task.lastRunStatus, task.runCount].join("|");

/** Stable for one new schedule; generated without `crypto.randomUUID`, which insecure origins lack. */
export const newPluginScheduleId = () =>
  `schedule-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;

/** Plugin targets run at a time or on an interval; only prompts render a webhook request. */
export const webhookAvailable = (targetId: string | null) => targetId === null;

/**
 * What the schedule editor saves for a plugin target: the host's common fields plus the
 * payload the plugin's fields reported, or the reason it cannot be saved yet.
 */
export function pluginScheduleSubmission(input: {
  readonly scheduleId: string;
  readonly title: string;
  /** Null unless the chosen project is one of the environment's projects. */
  readonly projectId: ProjectId | null;
  readonly schedule: ScheduledTaskUpsertSchedule | null;
  readonly enabled: boolean;
  readonly payload: PluginSchedulePayload | null;
}):
  | { readonly ok: true; readonly input: PluginScheduleTargetSaveInput }
  | { readonly ok: false; readonly title: string; readonly description: string } {
  const title = input.title.trim();
  if (!title || input.projectId === null || input.payload === null)
    return {
      ok: false,
      title: "Scheduled task is incomplete",
      description: "Add a title, project, and what to run.",
    };
  const schedule = input.schedule;
  if (schedule === null || schedule.type === "webhook")
    return {
      ok: false,
      title: "Choose a schedule",
      description: "Run this at a time or on an interval.",
    };
  if (
    schedule.type === "interval" &&
    (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS)
  )
    return {
      ok: false,
      title: "Invalid interval",
      description: "Enter an interval of at least one minute.",
    };
  return {
    ok: true,
    input: {
      id: input.scheduleId,
      title,
      projectId: input.projectId,
      schedule,
      enabled: input.enabled,
      payload: input.payload,
    },
  };
}

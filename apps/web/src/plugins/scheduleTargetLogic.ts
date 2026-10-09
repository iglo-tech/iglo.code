import type { ScheduledTask } from "@t3tools/contracts";
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

import type {
  OrchestrationV2IdleBackgroundWorkStop,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import type { ProjectionSettlementCandidate } from "./ProjectionStore.ts";

const MINUTE_MS = 60_000;

/** Chat activity only: leftover work streaming output does not keep itself alive. */
export function isIdleBackgroundWorkStopDue(
  thread: Pick<
    ProjectionSettlementCandidate,
    | "createdAt"
    | "latestRunId"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestUserMessageAt"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
    | "pendingBackgroundTasks"
  >,
  nowMs: number,
  afterMinutes: number | null,
): boolean {
  if (afterMinutes === null || thread.latestRunId === null) return false;
  if (thread.activityRunStatus != null || thread.pendingRuntimeRequest !== null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  // A pull request watch is T3's own and costs no memory; Stop leaves it on.
  const work = (thread.pendingBackgroundTasks ?? []).filter(
    (task) => !isPullRequestWatchTask(task),
  );
  if (work.length === 0 || backgroundWorkHoldsCompletion(work)) return false;
  const activityAtMs = Math.max(
    ...[
      thread.createdAt,
      thread.latestRunRequestedAt,
      thread.latestRunStartedAt,
      thread.latestRunCompletedAt,
      thread.latestUserMessageAt,
    ].map((value) => (value == null ? Number.NEGATIVE_INFINITY : DateTime.toEpochMillis(value))),
  );
  return activityAtMs <= nowMs - afterMinutes * MINUTE_MS;
}

/** The commands an idle stop ends, with the directory to start each in again when the provider reported it. */
export function idleStoppedCommands(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2IdleBackgroundWorkStop["commands"] {
  return tasks.flatMap((task) => {
    if (task.kind !== "command" && task.kind !== "monitor") return [];
    const nativeId = task.nativeItemId ?? task.taskId;
    const item = turnItems.findLast((candidate) =>
      task.itemId === undefined
        ? (candidate.nativeItemRef?.nativeId || candidate.id) === nativeId
        : candidate.id === task.itemId,
    );
    const commandItem = item?.type === "command_execution" ? item : undefined;
    const command = (task.command ?? commandItem?.input)?.trim();
    if (command === undefined || command.length === 0) return [];
    // Tasks read from a turn item take its title, which adapters fill generically ("Ran command").
    const label = task.description?.trim();
    const described =
      label !== undefined &&
      label.length > 0 &&
      label !== command &&
      label !== commandItem?.title?.trim();
    return [
      {
        command,
        ...(described ? { label } : {}),
        ...(commandItem?.cwd === undefined ? {} : { cwd: commandItem.cwd }),
      },
    ];
  });
}

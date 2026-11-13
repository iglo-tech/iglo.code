import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import {
  derivePendingBackgroundWork,
  isPullRequestWatchTask,
  type PendingBackgroundWorkTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";

const SETTLED_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "waiting",
  "failed",
  "interrupted",
  "cancelled",
]);
const ACTIVE_RUN_STATUSES: ReadonlyArray<OrchestrationV2Run["status"]> = [
  "preparing",
  "starting",
  "running",
];
const AGENT_MESSAGES_BEFORE = 2;

export interface BackgroundWaitCandidate {
  readonly taskId: string;
  readonly command: string;
  readonly description?: string | undefined;
  readonly agentText: string;
}

/**
 * Background commands and monitors nobody has called a wait or not yet. While the run is live
 * only a provider's own roster lists them; once it settles, running command items count too.
 */
export function backgroundWaitCandidates(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "activeProviderThreadId" | "backgroundWaits">;
  readonly latestRun: Pick<OrchestrationV2Run, "id" | "ordinal" | "status">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "id" | "pendingBackgroundTasks">
  >;
  /** The latest run's items. */
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): ReadonlyArray<BackgroundWaitCandidate> {
  const settled = SETTLED_RUN_STATUSES.has(input.latestRun.status);
  // Once the turn settles, a live guess is asked again with the agent's later words.
  const decided = new Set(
    input.thread.backgroundWaits
      ?.filter((wait) => !settled || wait.inferred !== "live")
      .map((wait) => wait.taskId),
  );
  const tasks: ReadonlyArray<PendingBackgroundWorkTask> = settled
    ? derivePendingBackgroundWork({
        latestRun: input.latestRun,
        runs: input.runs,
        providerThreads: input.providerThreads,
        turnItems: input.turnItems,
        activeProviderThreadId: input.thread.activeProviderThreadId,
      })
    : (input.providerThreads.find((thread) => thread.id === input.thread.activeProviderThreadId)
        ?.pendingBackgroundTasks ?? []);
  const items = input.turnItems.toSorted((left, right) => left.ordinal - right.ordinal);
  return tasks.flatMap((task) => {
    if (
      (task.kind !== "command" && task.kind !== "monitor") ||
      task.awaited !== undefined ||
      decided.has(task.taskId) ||
      isPullRequestWatchTask(task)
    ) {
      return [];
    }
    const index = items.findIndex((item) => {
      const nativeId = item.nativeItemRef?.nativeId;
      return (
        item.id === task.itemId ||
        (nativeId != null && (nativeId === task.taskId || nativeId === task.nativeItemId))
      );
    });
    const item = index === -1 ? undefined : items[index];
    const command = (
      task.command ??
      (item?.type === "command_execution" ? item.input : undefined) ??
      task.description ??
      ""
    ).trim();
    if (command.length === 0) return [];
    const isAgentText = (
      candidate: OrchestrationV2TurnItem,
    ): candidate is Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> =>
      candidate.type === "assistant_message" && candidate.text.trim().length > 0;
    const before = (index === -1 ? items : items.slice(0, index))
      .filter(isAgentText)
      .slice(-AGENT_MESSAGES_BEFORE);
    const after =
      index === -1
        ? []
        : items
            .slice(index + 1)
            .filter(isAgentText)
            .slice(0, 1);
    return [
      {
        taskId: task.taskId,
        command,
        ...(task.description === undefined || task.description === command
          ? {}
          : { description: task.description }),
        agentText: [...before, ...after].map((message) => message.text.trim()).join("\n\n"),
      },
    ];
  });
}

/**
 * Marks a background command awaited when the agent's words show it resumes when the command
 * ends but it never said so through t3_background_wait. A failed call leaves the task as it was.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  // While the run is live the agent may still say more, so only a wait is recorded then and the
  // task is asked again once the run settles.
  const asked = new Set<string>();
  const askedKey = (threadId: ThreadId, taskId: string, settled: boolean) =>
    `${threadId}\u0000${taskId}\u0000${settled}`;
  // One pass per thread at a time; events during a pass ask for one more pass after it.
  const running = new Set<ThreadId>();
  const dirty = new Set<ThreadId>();

  // A provider roster changes often, so it triggers a read only for a task not asked about yet.
  const triggersInference = (event: OrchestrationV2DomainEvent): boolean =>
    event.type === "provider-thread.updated"
      ? (event.payload.pendingBackgroundTasks ?? []).some(
          (task) =>
            (task.kind === "command" || task.kind === "monitor") &&
            task.awaited === undefined &&
            !asked.has(askedKey(event.threadId, task.taskId, false)),
        )
      : event.type === "run.updated" && SETTLED_RUN_STATUSES.has(event.payload.status);

  const classify = Effect.fn("BackgroundWaitInference.classify")(function* (
    thread: OrchestrationV2AppThread,
    candidate: BackgroundWaitCandidate,
    settled: boolean,
  ) {
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    const worktreePath = thread.worktreePath;
    const worktreeExists =
      worktreePath !== null &&
      (yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)));
    const { wait } = yield* textGeneration
      .classifyBackgroundTask({
        cwd: worktreeExists ? worktreePath : project.value.workspaceRoot,
        command: candidate.command,
        description: candidate.description,
        agentText: candidate.agentText,
        modelSelection: settings.textGenerationModelSelection,
        projectId: thread.projectId,
      })
      .pipe(Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") }));
    if (!wait && !settled) return;
    const inferred = settled ? "settled" : "live";
    yield* orchestrator.dispatch({
      type: "thread.background-wait.set",
      commandId: CommandId.make(
        `server:background-wait-inferred:${thread.id}:${candidate.taskId}:${inferred}`,
      ),
      threadId: thread.id,
      taskIds: [candidate.taskId],
      awaited: wait,
      inferred,
    });
  });

  const inferForThread = Effect.fn("BackgroundWaitInference.inferForThread")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* orchestrator.getThreadRecords(threadId, ["providerThreads", "runs"], {
      runStatuses: ACTIVE_RUN_STATUSES,
      includeLatestRun: true,
    });
    if (records.thread.deletedAt !== null || records.thread.archivedAt !== null) return;
    const latestRun = records.runs
      .filter((run) => run.status !== "queued")
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .at(-1);
    if (latestRun === undefined) return;
    const { turnItems } = yield* orchestrator.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunId: latestRun.id,
      turnItemTypes: ["assistant_message", "command_execution", "dynamic_tool"],
    });
    const settled = SETTLED_RUN_STATUSES.has(latestRun.status);
    // Bounds memory on a long-running server; at worst a task is asked about twice.
    if (asked.size > 5_000) asked.clear();
    const candidates = backgroundWaitCandidates({
      thread: records.thread,
      latestRun,
      runs: records.runs,
      providerThreads: records.providerThreads,
      turnItems,
    }).filter((candidate) => !asked.has(askedKey(threadId, candidate.taskId, settled)));
    // Decided tasks are no candidates, but their roster updates must not trigger more reads.
    for (const providerThread of records.providerThreads) {
      for (const task of providerThread.pendingBackgroundTasks ?? []) {
        asked.add(askedKey(threadId, task.taskId, false));
      }
    }
    yield* Effect.forEach(
      candidates,
      (candidate) => {
        const key = askedKey(threadId, candidate.taskId, settled);
        asked.add(key);
        return classify(records.thread, candidate, settled).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.sync(() => asked.delete(key)).pipe(
                  Effect.andThen(
                    Effect.logWarning("Could not infer whether background work is awaited", {
                      threadId,
                      taskId: candidate.taskId,
                      cause,
                    }),
                  ),
                ),
          ),
        );
      },
      { concurrency: 4, discard: true },
    );
  });

  /** Starts a pass for the event's thread, or marks one due after the running pass. */
  const observe = (event: OrchestrationV2DomainEvent) =>
    Effect.suspend(() => {
      if (!triggersInference(event)) return Effect.undefined;
      const threadId = event.threadId;
      if (running.has(threadId)) {
        dirty.add(threadId);
        return Effect.undefined;
      }
      running.add(threadId);
      return Effect.suspend(() => {
        dirty.delete(threadId);
        return inferForThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Background wait inference failed", { threadId, cause }),
          ),
        );
      }).pipe(
        // No suspension between the last dirty check and running.delete, so no event is lost.
        Effect.repeat({ while: () => dirty.has(threadId) }),
        Effect.ensuring(Effect.sync(() => running.delete(threadId))),
        Effect.asVoid,
        Effect.forkDetach,
      );
    });

  const start = Effect.fn("BackgroundWaitInference.start")(function* () {
    yield* forkParked(
      orchestrator.streamDomainEvents.pipe(
        Stream.runForEach(observe),
        Effect.catchCause((cause) =>
          Effect.logWarning("Background wait inference event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, observe };
});

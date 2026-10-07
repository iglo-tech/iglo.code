import {
  CommandId,
  MessageId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ProjectId,
  ScheduledTaskDispatchTarget,
  ThreadId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskDispatchTarget));
const encodeTarget = Schema.encodeSync(Schema.fromJsonString(ScheduledTaskDispatchTarget));
const isTaskError = Schema.is(ScheduledTaskError);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly dispatch_target_json: string | null;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly lastOccurrence: (
      id: ScheduledTaskId,
    ) => Effect.Effect<string | null, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

const decodeRow = (row: ScheduledTaskRow) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      ...(row.dispatch_target_json == null
        ? {}
        : { dispatchTarget: yield* decodeTarget(row.dispatch_target_json) }),
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const targets = yield* Effect.serviceOption(ScheduleTargets.ScheduleTargets);
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        dispatch_target_json,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      return yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        dispatch_target_json,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row);
    });

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (task: ScheduledTask, requireExisting: boolean) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          dispatch_target_json,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.dispatchTarget === undefined ? null : encodeTarget(task.dispatchTarget)},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          dispatch_target_json = excluded.dispatch_target_json,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`;
            yield* sql`UPDATE scheduled_task_occurrences SET status = 'failed', error = 'Schedule was deleted.' WHERE task_id = ${id} AND status = 'pending'`;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (id: ScheduledTaskId, startedAtIso: string) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
    }) =>
      sql`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + 1
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately: the dispatch may already have gone out, so next_run_at must
    // advance and run_count must count the attempt.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + 1
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    const resolveOrphan = (occurrenceId: string) =>
      sql`UPDATE scheduled_task_occurrences SET status = 'failed', error = 'Schedule no longer owns this plugin occurrence.' WHERE id = ${occurrenceId} AND status = 'pending'`;

    const runTask = Effect.fn("ScheduledTaskService.runTask")(
      function* (
        task: ScheduledTask,
        trigger: "scheduled" | "manual" | "recovery",
        requestedOccurrenceId?: string,
      ) {
        const reserved = yield* Ref.modify(activeRuns, (active) => {
          if (active.has(task.id)) return [false, active] as const;
          const next = new Set(active);
          next.add(task.id);
          return [true, next] as const;
        });
        if (!reserved) {
          if (trigger === "manual") {
            return yield* taskError("Schedule task is already running.", { taskId: task.id });
          }
          return task;
        }

        return yield* Effect.gen(function* () {
          const startedAt = yield* localNow;
          const startedAtIso = iso(startedAt);

          // The in-memory snapshot may be stale: re-read before touching run
          // state. The task may have been deleted, paused, or postponed since
          // the poll loaded it — none of those may fire.
          const active = yield* findTask(task.id);
          if (active === null) {
            if (trigger === "recovery" && requestedOccurrenceId !== undefined)
              yield* resolveOrphan(requestedOccurrenceId);
            // A manual run on a just-deleted task must fail loudly, not report
            // a successful run that never dispatched.
            if (trigger === "manual") {
              return yield* taskError("Schedule task not found.", { taskId: task.id });
            }
            return task;
          }
          // A next_run_at corrupted between the poll read and this re-read must
          // not defect the poll; an unparseable value is treated as not due.
          const parsedNextRunAt =
            active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
          if (
            trigger === "scheduled" &&
            (!active.enabled ||
              Option.isNone(parsedNextRunAt) ||
              DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
          ) {
            return active;
          }

          // A supplied identity may belong to a retired plugin occurrence even
          // when the current schedule id now names an ordinary prompt.
          if (requestedOccurrenceId !== undefined) {
            const [requested] = yield* sql<{
              task_id: string;
              status: string;
              error: string | null;
            }>`SELECT task_id, status, error FROM scheduled_task_occurrences WHERE id = ${requestedOccurrenceId}`;
            if (requested !== undefined) {
              if (requested.task_id !== active.id)
                return yield* taskError("This occurrence identity belongs to another schedule.", {
                  taskId: active.id,
                });
              if (requested.status === "failed")
                return yield* taskError(requested.error ?? "The scheduled occurrence failed.", {
                  taskId: active.id,
                });
              if (requested.status === "succeeded") return active;
              if (active.dispatchTarget === undefined) {
                yield* resolveOrphan(requestedOccurrenceId);
                return yield* taskError("Schedule no longer owns this plugin occurrence.", {
                  taskId: active.id,
                });
              }
            }
          }

          if (requestedOccurrenceId !== undefined && active.dispatchTarget === undefined)
            return yield* taskError(
              "Occurrence identities are only supported by plugin schedules.",
              {
                taskId: active.id,
              },
            );

          const [pending] =
            active.dispatchTarget === undefined
              ? []
              : yield* sql<{
                  id: string;
                  target_json: string;
                  project_id: string;
                  started_at: string;
                }>`SELECT * FROM scheduled_task_occurrences WHERE task_id = ${active.id} AND status = 'pending' ORDER BY rowid LIMIT 1`;
          if (
            trigger === "recovery" &&
            active.dispatchTarget === undefined &&
            requestedOccurrenceId !== undefined
          )
            yield* resolveOrphan(requestedOccurrenceId);
          // Recovery belongs to the committed plugin occurrence, never a
          // replacement prompt task or a fresh run of a reused schedule id.
          if (
            trigger === "recovery" &&
            (pending === undefined || pending.id !== requestedOccurrenceId)
          )
            return active;
          if (
            pending !== undefined &&
            requestedOccurrenceId !== undefined &&
            pending.id !== requestedOccurrenceId
          )
            return yield* taskError(
              "Another occurrence is pending for this schedule. Retry its original identity before starting a new occurrence.",
              { taskId: active.id },
            );
          const fireKey =
            pending?.id ??
            requestedOccurrenceId ??
            `${active.id}:${trigger === "scheduled" ? active.nextRunAt : DateTime.toEpochMillis(startedAt)}:${trigger}`;
          if (active.dispatchTarget !== undefined) {
            yield* sql`INSERT OR IGNORE INTO scheduled_task_occurrences (id, task_id, project_id, target_json, started_at, status) VALUES (${fireKey}, ${active.id}, ${active.projectId}, ${encodeTarget(active.dispatchTarget)}, ${startedAtIso}, 'pending')`;
            const [receipt] = yield* sql<{
              task_id: string;
              status: string;
              error: string | null;
            }>`SELECT * FROM scheduled_task_occurrences WHERE id = ${fireKey}`;
            if (receipt?.task_id !== active.id)
              return yield* taskError("This occurrence identity belongs to another schedule.", {
                taskId: active.id,
              });
            if (receipt.status === "succeeded") return active;
            if (receipt.status === "failed")
              return yield* taskError(receipt.error ?? "The scheduled occurrence failed.", {
                taskId: active.id,
              });
          }
          yield* markRunning(active.id, startedAtIso);
          yield* notifyChanged;

          const commandId = CommandId.make(`scheduled-task:${fireKey}`);
          const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
          // Dispatch from the fresh row so prompt/model/binding edits made
          // after the poll read are honoured.
          const prompt = active.prompt;

          // Effect.exit (not Effect.result) so defects and interruptions in the
          // dispatch are also captured and recorded as a failed run instead of
          // aborting before markCompleted.
          const dispatchWork = Effect.gen(function* () {
            if (active.dispatchTarget !== undefined) {
              if (Option.isNone(targets))
                return yield* taskError("Schedule dispatch targets are unavailable.", {
                  taskId: active.id,
                });
              const [recorded] = yield* sql<{
                target_json: string;
                project_id: string;
              }>`SELECT * FROM scheduled_task_occurrences WHERE id = ${fireKey}`;
              if (recorded === undefined)
                return yield* taskError("The scheduled occurrence receipt is missing.", {
                  taskId: active.id,
                });
              yield* targets.value.dispatch(
                yield* decodeTarget(recorded.target_json),
                fireKey,
                ProjectId.make(recorded.project_id),
              );
            } else if (active.threadId === null) {
              yield* threadLaunch.launch({
                commandId,
                projectId: active.projectId,
                title: active.title,
                modelSelection: active.modelSelection,
                runtimeMode: active.runtimeMode,
                interactionMode: active.interactionMode,
                workspaceStrategy: active.workspaceStrategy,
                initialMessage: {
                  messageId,
                  scheduledTaskId: active.id,
                  text: prompt,
                  attachments: [],
                },
                createdBy: active.createdBy,
                creationSource: active.creationSource,
              });
            } else {
              yield* threadManagement.sendToThread({
                projectId: active.projectId,
                commandId,
                threadId: ThreadId.make(active.threadId),
                messageId,
                scheduledTaskId: active.id,
                text: prompt,
                attachments: [],
                modelSelection: active.modelSelection,
                // Scheduled prompts must not interrupt tools in the bound thread.
                mode: "queue",
                createdBy: active.createdBy,
                creationSource: active.creationSource,
              });
            }
          });
          const result = yield* Effect.exit(dispatchWork);

          if (
            active.dispatchTarget !== undefined &&
            result._tag === "Failure" &&
            Cause.hasInterruptsOnly(result.cause)
          )
            return yield* Effect.failCause(result.cause);
          const completedAt = yield* localNow;
          const runSucceeded = result._tag === "Success";
          const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
          const lastRunError = runSucceeded ? null : errorMessage(result.cause);
          // Re-read the task so the next run is computed from the schedule as it
          // is *now* (the user may have edited or deleted it while we ran).
          const current = yield* findTask(task.id);
          const scheduleSource = current ?? task;
          const completed: ScheduledTask = {
            ...scheduleSource,
            updatedAt: iso(completedAt),
            lastRunAt: startedAtIso,
            nextRunAt: nextRunAt(scheduleSource, completedAt),
            lastRunStatus,
            lastRunError,
            runCount: scheduleSource.runCount + 1,
          };
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (active.dispatchTarget !== undefined)
                yield* sql`UPDATE scheduled_task_occurrences SET status = ${lastRunStatus}, error = ${lastRunError} WHERE id = ${fireKey}`;
              if (current !== null) {
                // startedAtIso in the guard ensures this writes only to the row this
                // run marked as running — a task deleted mid-run and recreated with
                // the same id (idempotent commandId replay) must not be stamped.
                yield* markCompleted({
                  id: task.id,
                  completedAtIso: completed.updatedAt,
                  nextRunAtIso: completed.nextRunAt,
                  status: lastRunStatus,
                  error: lastRunError,
                  startedAtIso,
                });
              }
            }),
          );
          yield* notifyChanged;
          // A manual plugin operation returns its occurrence result, just as a
          // retry does. Persist the failed receipt before reporting the failure.
          if (trigger === "manual" && active.dispatchTarget !== undefined && !runSucceeded)
            return yield* taskError(lastRunError ?? "The scheduled occurrence failed.", {
              taskId: active.id,
            });
          return completed;
        }).pipe(
          Effect.onError((cause) =>
            task.dispatchTarget !== undefined
              ? Effect.void
              : releaseStuckRun(task, errorMessage(cause)),
          ),
          Effect.ensuring(
            Ref.update(activeRuns, (active) => {
              const next = new Set(active);
              next.delete(task.id);
              return next;
            }),
          ),
        );
      },
      Effect.mapError((cause) =>
        isTaskError(cause) ? cause : taskError("Could not dispatch scheduled work.", { cause }),
      ),
    );

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const pending = yield* sql<{
        id: string;
        task_id: string;
      }>`SELECT id, task_id FROM scheduled_task_occurrences WHERE status = 'pending' ORDER BY rowid`;
      for (const row of pending) {
        const task = yield* findTask(ScheduledTaskId.make(row.task_id));
        if (task === null || task.dispatchTarget === undefined) yield* resolveOrphan(row.id);
        else
          yield* runTask(task, "recovery", row.id).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled target recovery failed", { taskId: task.id, cause }),
            ),
          );
      }
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          (isMissedFixedTimeRun(task.schedule, dueAt, now)
            ? rescheduleMissedRun(task, now)
            : runTask(task, "scheduled")
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running'
    // would otherwise be skipped by the due-task filter forever. The dispatch
    // may already have gone out before the crash, so next_run_at must advance
    // and run_count must count the attempt — otherwise the first poll after
    // every restart re-fires the interrupted task (same rationale as
    // releaseStuckRun). Schedules are JSON, so this is per-row Effect work
    // rather than a single UPDATE.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter(
        (row) => row.last_run_status === "running" && row.dispatch_target_json == null,
      );
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + 1
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    yield* scheduler.register("scheduled-tasks", runDueTasks());

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        // Look up by the *resolved* id so idempotent creates (commandId replays)
        // keep their run history, and so real load failures propagate instead
        // of silently resetting an existing row.
        const existingTask = yield* findTask(id);
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, input.schedule);
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          ...(input.dispatchTarget === undefined && existingTask?.dispatchTarget === undefined
            ? {}
            : { dispatchTarget: input.dispatchTarget ?? existingTask?.dispatchTarget }),
          enabled: input.enabled,
          schedule: input.schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: scheduleUnchanged
            ? existingTask.nextRunAt
            : nextRunAt({ enabled: input.enabled, schedule: input.schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
        };
        yield* saveTask(task, input.requireExisting === true);
        yield* notifyChanged;
        return { task };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(Effect.andThen(notifyChanged), Effect.as({ id: input.id }));

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        const next = yield* runTask(task, "manual", input.occurrenceId).pipe(
          Effect.mapError((cause) =>
            isTaskError(cause)
              ? cause
              : taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    return ScheduledTaskService.of({
      list,
      lastOccurrence: (id) =>
        sql<{
          id: string;
        }>`SELECT id FROM scheduled_task_occurrences WHERE task_id = ${id} ORDER BY rowid DESC LIMIT 1`.pipe(
          Effect.map((rows) => rows[0]?.id ?? null),
          Effect.mapError((cause) =>
            taskError("Could not read the schedule occurrence receipt.", { taskId: id, cause }),
          ),
        ),
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
    });
  }),
);

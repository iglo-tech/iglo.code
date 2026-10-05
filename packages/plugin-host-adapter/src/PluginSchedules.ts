import {
  CommandId,
  DEFAULT_MODEL,
  ProviderInstanceId,
  ScheduledTaskError,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  PluginError,
  type PluginSchedule,
  type PluginScheduleInput,
} from "@t3tools/plugin-host-contract/schema";
import { Schedules, type PluginServices } from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Scheduler from "../../../apps/server/src/scheduling/Scheduler.ts";
import * as ScheduleTargets from "../../../apps/server/src/scheduling/ScheduleTargets.ts";
import * as ScheduledTasks from "../../../apps/server/src/scheduledTasks/ScheduledTaskService.ts";
const isPluginError = Schema.is(PluginError);

export class ScheduleRegistration extends Context.Service<
  ScheduleRegistration,
  {
    readonly pluginId: string;
    readonly targets: () => PluginServices["scheduleTargets"];
  }
>()("@t3tools/plugin-host-adapter/PluginSchedules/ScheduleRegistration") {}

/** Plugin operations use the same persisted schedule controls as prompt schedules. */
export const make = Effect.gen(function* () {
  const { pluginId, targets } = yield* ScheduleRegistration;
  const scheduler = yield* Scheduler.Scheduler;
  const tasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
  const dispatch = yield* Effect.serviceOption(ScheduleTargets.ScheduleTargets);
  const prefix = `plugin:${pluginId}:`;
  const error = (operation: string, cause?: unknown) =>
    new PluginError({
      pluginId,
      code: "service",
      operation,
      message: "Plugin schedules require the environment's persisted schedule service.",
      ...(cause === undefined ? {} : { cause }),
    });
  const service = () =>
    Effect.gen(function* () {
      if (Option.isNone(tasks)) return yield* error("schedules");
      return tasks.value;
    });
  const convert = (task: import("@t3tools/contracts").ScheduledTask) =>
    service().pipe(
      Effect.flatMap((core) => core.lastOccurrence(task.id)),
      Effect.map((lastOccurrenceId): PluginSchedule => ({
        id: task.id.slice(prefix.length),
        target: task.dispatchTarget!.id,
        payload: task.dispatchTarget!.payload,
        title: task.title,
        projectId: task.projectId,
        enabled: task.enabled,
        schedule: task.schedule,
        nextRunAt: task.nextRunAt,
        lastOccurrenceId,
        lastStatus: task.lastRunStatus === "running" ? "pending" : task.lastRunStatus,
        lastError: task.lastRunError,
      })),
    );
  const list = () =>
    service().pipe(
      Effect.flatMap((service) => service.list()),
      Effect.flatMap((result) =>
        Effect.forEach(
          result.tasks.filter(
            (task) =>
              task.id.startsWith(prefix) && task.dispatchTarget?.id.startsWith(`${pluginId}.`),
          ),
          convert,
        ),
      ),
      Effect.mapError((cause) => (isPluginError(cause) ? cause : error("list", cause))),
    );
  const id = (value: string) => ScheduledTaskId.make(`${prefix}${value}`);
  const upsert = (input: PluginScheduleInput) =>
    Effect.gen(function* () {
      if (!targets().some((target) => target.id === input.target))
        return yield* new PluginError({
          pluginId,
          code: "unsupported",
          operation: "schedule",
          message: `Schedule target ${input.target} is unavailable.`,
        });
      const core = yield* service();
      const result = yield* core.upsert({
        id: id(input.id),
        commandId: CommandId.make(`${prefix}${input.id}`),
        title: input.title,
        prompt: "Scheduled plugin operation",
        projectId: input.projectId,
        dispatchTarget: { id: input.target, payload: input.payload },
        enabled: input.enabled,
        schedule: input.schedule,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "server",
      });
      return yield* convert(result.task);
    }).pipe(Effect.mapError((cause) => (isPluginError(cause) ? cause : error("upsert", cause))));
  return {
    service: Schedules.of({
      upsert,
      list,
      delete: (value) =>
        service().pipe(
          Effect.flatMap((service) => service.delete({ id: id(value) })),
          Effect.asVoid,
          Effect.mapError((cause) => error("delete", cause)),
        ),
      runNow: (value, occurrenceId) =>
        service().pipe(
          Effect.flatMap((service) => service.runNow({ id: id(value), occurrenceId })),
          Effect.asVoid,
          Effect.mapError((cause) => error("runNow", cause)),
        ),
      registerDueWork: (run) => scheduler.register(`plugin:${pluginId}`, run),
    }),
    start: Effect.gen(function* () {
      if (targets().length === 0) return;
      if (dispatch._tag === "None") return yield* error("register");
      for (const target of targets())
        yield* dispatch.value.register(target.id, (input) =>
          target.invoke(input).pipe(
            Effect.mapError(
              (cause) =>
                new ScheduledTaskError({
                  message: `Plugin schedule target ${target.id} failed during ${cause.operation} (${cause.code}).`,
                  cause,
                }),
            ),
          ),
        );
    }),
  };
});

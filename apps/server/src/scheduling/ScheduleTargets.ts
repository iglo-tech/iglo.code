import { ProjectId, ScheduledTaskDispatchTarget, ScheduledTaskError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import {
  DispatchModeLimit,
  intersectDispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";

type Invoke = (input: {
  readonly occurrenceId: string;
  readonly projectId: ProjectId;
  readonly payload: ScheduledTaskDispatchTarget["payload"];
}) => Effect.Effect<void, ScheduledTaskError>;

/** The clock and persisted schedule pipeline know only named dispatch targets. */
export class ScheduleTargets extends Context.Service<
  ScheduleTargets,
  {
    readonly register: (
      id: string,
      invoke: Invoke,
    ) => Effect.Effect<void, ScheduledTaskError, Scope.Scope>;
    readonly dispatch: (
      target: ScheduledTaskDispatchTarget,
      occurrenceId: string,
      projectId: ProjectId,
    ) => Effect.Effect<void, ScheduledTaskError>;
  }
>()("t3/scheduling/ScheduleTargets") {}

export const layer = Layer.effect(
  ScheduleTargets,
  Effect.sync(() => {
    const targets = new Map<string, Invoke>();
    return ScheduleTargets.of({
      register: (id, invoke) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            if (targets.has(id))
              return Effect.fail(
                new ScheduledTaskError({ message: `Schedule target ${id} is already registered.` }),
              );
            targets.set(id, invoke);
            return Effect.void;
          }),
          () =>
            Effect.sync(() => {
              if (targets.get(id) === invoke) targets.delete(id);
            }),
        ),
      dispatch: (target, occurrenceId, projectId) =>
        Effect.gen(function* () {
          const invoke = targets.get(target.id);
          if (invoke === undefined)
            return yield* new ScheduledTaskError({
              message: `Schedule target ${target.id} is unavailable in this environment. Its state has been retained.`,
            });
          const ambient = yield* DispatchModeLimit;
          const limits =
            target.dispatchLimits === undefined
              ? ambient
              : ambient === undefined
                ? target.dispatchLimits
                : intersectDispatchModes(target.dispatchLimits, ambient);
          return yield* invoke({ occurrenceId, projectId, payload: target.payload }).pipe(
            Effect.provideService(DispatchModeLimit, limits),
          );
        }),
    });
  }),
);

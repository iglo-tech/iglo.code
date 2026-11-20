import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  OrchestratorDispatchError,
  threadHasUnfinishedWork,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const isOrchestratorDispatchError = Schema.is(OrchestratorDispatchError);

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Moves a thread into another project, where its cwd becomes that project's root.
     * Moving into the thread's current project is a no-op.
     */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const randomId = random.uuidV4();

  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(fail("Could not read the thread.")),
        Effect.filterOrFail(
          (shell) => shell !== null,
          () => new ThreadProjectMoveError({ reason: "Thread not found." }),
        ),
      );
      if (thread.projectId === input.projectId) return;
      const target = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(fail("Could not read the project.")));
      if (Option.isNone(target)) {
        return yield* new ThreadProjectMoveError({ reason: "Project not found." });
      }
      const records = yield* threads
        .getThreadRecords(thread.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail(`Could not read "${thread.title}".`)));
      if (threadHasUnfinishedWork(records)) {
        return yield* new ThreadProjectMoveError({
          reason: `"${thread.title}" is still working. Finish or stop it first.`,
        });
      }

      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          // Tasks move before the dispatch, so a lost race (work starting, or another client moving
          // the thread first) can leave tasks re-pointed while the thread stays. The same-project
          // early return above makes a retry finish the partial task move.
          yield* scheduledTasks
            .moveThreadTasks({ threadIds: [thread.id], projectId: input.projectId })
            .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
          yield* threads
            .dispatch({
              type: "thread.project.move",
              commandId: CommandId.make(`thread-project-move:${yield* randomId}`),
              threadId: thread.id,
              projectId: input.projectId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadProjectMoveError({
                    // Dispatch refusals carry the actionable reason, such as the background-work
                    // message; surface it instead of a retry hint that cannot fix the cause.
                    reason:
                      isOrchestratorDispatchError(cause) && typeof cause.cause === "string"
                        ? cause.cause
                        : `Could not move "${thread.title}". Try again.`,
                    cause,
                  }),
              ),
            );
        }),
      );
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);

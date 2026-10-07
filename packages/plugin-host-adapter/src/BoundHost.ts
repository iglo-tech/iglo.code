import {
  CommandId,
  PluginCommandReceipt,
  PluginError,
  PluginLaunchInput,
  PluginTarget,
} from "@t3tools/plugin-host-contract/schema";
import { Host, Storage } from "@t3tools/plugin-host-contract/server";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as LaunchCancellation from "./LaunchCancellation.ts";
import * as CommandAccess from "./PluginCommandAccess.ts";
import { RuntimeMode, ProviderInteractionMode } from "@t3tools/contracts";
import * as Threads from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  intersectDispatchModes,
} from "../../../apps/server/src/orchestration-v2/DispatchModeLimit.ts";

const Send = PluginTarget.mapFields((fields) => ({
  ...fields,
  commandId: CommandId,
  instruction: Schema.String,
  mode: Schema.Literals(["queue", "auto"]),
}));
const Interrupt = PluginTarget.mapFields((fields) => ({
  ...fields,
  commandId: CommandId,
  runId: Schema.optional(Schema.String),
  preparationId: Schema.optional(Schema.String),
}));
const LaunchRequest = Schema.Struct({ kind: Schema.Literal("launch"), input: PluginLaunchInput });
const SendRequest = Schema.Struct({ kind: Schema.Literal("send"), input: Send });
const Retry = PluginTarget.mapFields((fields) => ({
  ...fields,
  commandId: CommandId,
  runId: Schema.String,
}));
const RetryRequest = Schema.Struct({ kind: Schema.Literal("retry-preparation"), input: Retry });
const IntentMetadata = {
  coreCommandId: Schema.optional(CommandId),
  dispatchLimits: Schema.optional(
    Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
  ),
};
const Request = Schema.Union([
  LaunchRequest,
  SendRequest,
  RetryRequest,
  Schema.Struct({ kind: Schema.Literal("interrupt"), input: Interrupt }),
]);
const Intent = Schema.Union([
  LaunchRequest.mapFields((fields) => ({ ...fields, ...IntentMetadata })),
  SendRequest.mapFields((fields) => ({ ...fields, ...IntentMetadata })),
  RetryRequest.mapFields((fields) => ({ ...fields, ...IntentMetadata })),
  Schema.Struct({
    kind: Schema.Literal("interrupt"),
    ...IntentMetadata,
    input: Interrupt.mapFields((fields) => ({
      ...fields,
      runId: Schema.optional(Schema.NullOr(Schema.String)),
    })),
  }),
]);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Request));
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Request));
const encodeCoreIdentity = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, CommandId])),
);
const encodeIntent = Schema.encodeEffect(Schema.fromJsonString(Intent));
const decodeIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(Intent));
const encodeReceipt = Schema.encodeEffect(
  Schema.fromJsonString(Schema.NullOr(PluginCommandReceipt)),
);
const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.NullOr(PluginCommandReceipt)),
);
const isPluginError = Schema.is(PluginError);

/** Private durable intent bridges plugin SQL and the core command transaction. */
export const make = (pluginId: string) =>
  Effect.gen(function* () {
    const core = yield* Host;
    const threads = yield* Effect.serviceOption(Threads.ThreadManagementService);
    const { sql } = yield* Storage;
    const lock = yield* KeyedLock.make<CommandId>();
    let initializing = true;
    const initializingLaunches = new Map<CommandId, typeof LaunchRequest.Type>();
    const error = (operation: string, message: string, cause?: unknown) =>
      new PluginError({
        pluginId,
        code: "storage",
        operation,
        message,
        ...(cause === undefined ? {} : { cause }),
      });
    yield* sql`CREATE TABLE IF NOT EXISTS host_commands (id TEXT PRIMARY KEY, request TEXT NOT NULL, intent TEXT NOT NULL, result TEXT)`;
    yield* sql`CREATE TABLE IF NOT EXISTS host_cancelled_launches (id TEXT PRIMARY KEY)`;
    // Pending intents written by older hosts must retain their original core receipt identity.
    const coreId = (intent: typeof Intent.Type) =>
      intent.coreCommandId ?? CommandId.make(`plugin:${pluginId}:${intent.input.commandId}`);
    const dispatch = Effect.fn("PluginHost.dispatchIntent")(function* (intent: typeof Intent.Type) {
      if (intent.kind === "interrupt" && intent.input.runId === undefined)
        return yield* new PluginError({
          pluginId,
          code: "conflict",
          operation: "interrupt",
          message:
            "This pending interrupt has no recorded run selection and cannot safely be replayed. Inspect the thread and use a new command identity.",
        });
      const input = { ...intent.input, commandId: coreId(intent) };
      if (initializing && intent.kind === "launch")
        initializingLaunches.set(input.commandId, intent);
      if (intent.kind === "send") {
        // A committed create receipt can precede setup. Keep that barrier after
        // restart or tracker expiry, including a lost final launch acknowledgement.
        const pending = yield* sql<{ intent: string }>`SELECT intent FROM host_commands
          WHERE result IS NULL AND json_extract(intent, '$.kind') = 'launch'
          AND json_extract(intent, '$.input.projectId') = ${intent.input.projectId}`;
        for (const row of pending) {
          const launch = yield* decodeIntent(row.intent);
          if (launch.kind !== "launch" || launch.input.instruction !== undefined) continue;
          const created = yield* core.receipt(coreId(launch));
          if (created?.threadId !== intent.input.threadId) continue;
          const ready = yield* core.receipt(CommandId.make(`${coreId(launch)}:workspace-ready`));
          if (ready?.status !== "accepted")
            return yield* new PluginError({
              pluginId,
              code: "unavailable",
              operation: "send",
              message:
                "Workspace preparation has not released this thread. Retry the launch, then retry this command with the same identity.",
            });
        }
      }
      const result =
        intent.kind === "launch"
          ? yield* core.launch({ ...intent.input, commandId: input.commandId }).pipe(
              Effect.provideService(LaunchCancellation.LaunchCancellation, {
                beforeCancel:
                  sql`INSERT OR IGNORE INTO host_cancelled_launches (id) VALUES (${intent.input.commandId})`.pipe(
                    Effect.as(true),
                    Effect.catch((cause) =>
                      Effect.logWarning("Could not persist plugin launch cancellation", {
                        pluginId,
                        commandId: intent.input.commandId,
                        cause,
                      }).pipe(Effect.as(false)),
                    ),
                  ),
              }),
            )
          : intent.kind === "send"
            ? yield* core.send({ ...intent.input, commandId: input.commandId })
            : intent.kind === "retry-preparation"
              ? yield* core.retryPreparation({ ...intent.input, commandId: input.commandId })
              : intent.input.preparationId !== undefined
                ? yield* core.interrupt({
                    environmentId: intent.input.environmentId,
                    projectId: intent.input.projectId,
                    threadId: intent.input.threadId,
                    commandId: input.commandId,
                    preparationId: intent.input.preparationId,
                  })
                : intent.input.runId === null
                  ? null
                  : yield* core.interrupt({
                      environmentId: intent.input.environmentId,
                      projectId: intent.input.projectId,
                      threadId: intent.input.threadId,
                      commandId: input.commandId,
                      runId: intent.input.runId!,
                    });
      const receipt = result === null ? null : { ...result, commandId: intent.input.commandId };
      const encoded = yield* encodeReceipt(receipt);
      yield* sql`UPDATE host_commands SET result = ${encoded} WHERE id = ${intent.input.commandId}`;
      return receipt;
    });
    const execute = Effect.fn("PluginHost.executeIntent")(
      function* (requested: typeof Request.Type, recovering = false) {
        if (requested.input.environmentId !== core.environmentId)
          return yield* new PluginError({
            pluginId,
            code: "unavailable",
            operation: requested.kind,
            message: "The requested environment is not this server.",
          });
        const access = yield* Effect.serviceOption(CommandAccess.PluginCommandAccess);
        const ambient = yield* DispatchModeLimit;
        const authorized = Option.isNone(access)
          ? undefined
          : yield* access.value.authorize(
              requested.kind === "launch"
                ? { runtimeMode: requested.input.runtimeMode }
                : { threadId: requested.input.threadId },
            );
        const limits =
          authorized === undefined
            ? ambient
            : ambient === undefined
              ? authorized
              : intersectDispatchModes(authorized, ambient);
        const runIntent = (intent: typeof Intent.Type) =>
          dispatch(intent).pipe(
            Effect.provideService(
              DispatchModeLimit,
              intent.dispatchLimits === undefined
                ? limits
                : limits === undefined
                  ? intent.dispatchLimits
                  : intersectDispatchModes(intent.dispatchLimits, limits),
            ),
          );
        const request = yield* encodeRequest(requested);
        const [existing] = yield* sql<{
          request: string;
          intent: string;
          result: string | null;
        }>`SELECT * FROM host_commands WHERE id = ${requested.input.commandId}`;
        if (existing !== undefined) {
          if (existing.request !== request)
            return yield* new PluginError({
              pluginId,
              code: "conflict",
              operation: requested.kind,
              message:
                "This command identity already belongs to a different operation. Retry the original input or use a new identity.",
            });
          if (existing.result !== null) return yield* decodeReceipt(existing.result);
          if (requested.kind === "launch") {
            const [cancelled] =
              yield* sql`SELECT id FROM host_cancelled_launches WHERE id = ${requested.input.commandId}`;
            if (cancelled !== undefined && recovering) return null;
            // A new explicit request resumes the same intent; startup never does.
            yield* sql`DELETE FROM host_cancelled_launches WHERE id = ${requested.input.commandId}`;
          }
          return yield* runIntent(yield* decodeIntent(existing.intent));
        }
        let intent: typeof Intent.Type =
          requested.kind === "launch" && requested.input.workspace.type === "exact-ref"
            ? {
                ...requested,
                input: {
                  ...requested.input,
                  workspace: {
                    ...requested.input.workspace,
                    ref: yield* core.resolveRef(
                      requested.input.projectId,
                      requested.input.workspace.ref,
                    ),
                  },
                },
              }
            : requested;
        const cancelledLaunches: CommandId[] = [];
        if (requested.kind === "interrupt") {
          if (requested.input.runId !== undefined && requested.input.preparationId !== undefined)
            return yield* new PluginError({
              pluginId,
              code: "conflict",
              operation: "interrupt",
              message: "Choose one run or workspace preparation to interrupt.",
            });
          const state = yield* core.inspect(requested.input);
          const activeRun = state.runs.findLast((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
          const preparationId =
            requested.input.preparationId ??
            ((requested.input.runId === undefined && activeRun === undefined) ||
            (activeRun?.status === "preparing" &&
              (requested.input.runId === undefined || requested.input.runId === activeRun.id))
              ? state.preparationId
              : undefined);
          const idleCancellation =
            requested.input.runId === undefined &&
            requested.input.preparationId === undefined &&
            activeRun === undefined;
          if (
            (preparationId !== undefined && preparationId === state.preparationId) ||
            idleCancellation
          ) {
            const pending = yield* sql<{
              id: CommandId;
              intent: string;
            }>`SELECT id, intent FROM host_commands
              WHERE result IS NULL AND json_extract(intent, '$.kind') = 'launch'
              AND json_extract(intent, '$.input.projectId') = ${requested.input.projectId}`;
            for (const row of pending) {
              const launch = yield* decodeIntent(row.intent);
              if ((yield* core.receipt(coreId(launch)))?.threadId === requested.input.threadId)
                cancelledLaunches.push(row.id);
            }
          }
          const active =
            activeRun ??
            (preparationId === undefined && state.outstandingWork.length > 0
              ? state.runs.findLast((run) => run.status !== "queued")
              : undefined);
          intent = {
            ...requested,
            input: {
              ...requested.input,
              runId:
                preparationId === undefined ? (requested.input.runId ?? active?.id ?? null) : null,
              ...(preparationId === undefined ? {} : { preparationId }),
            },
          };
        }
        // A tuple separates public IDs from child-step suffixes and legacy plugin:id prefixes.
        intent = {
          ...intent,
          ...(limits === undefined ? {} : { dispatchLimits: limits }),
          coreCommandId: CommandId.make(
            `plugin:${yield* encodeCoreIdentity([pluginId, requested.input.commandId])}`,
          ),
        };
        const encoded = yield* encodeIntent(intent);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO host_commands (id, request, intent) VALUES (${requested.input.commandId}, ${request}, ${encoded})`;
            // Commit cancellation with its intent, before native I/O or acknowledgement.
            for (const id of cancelledLaunches)
              yield* sql`INSERT OR IGNORE INTO host_cancelled_launches (id) VALUES (${id})`;
          }),
        );
        return yield* runIntent(intent);
      },
      (effect, requested, _recovering = false) => lock.withLock(requested.input.commandId, effect),
      Effect.mapError((cause) =>
        isPluginError(cause)
          ? cause
          : error(
              "command",
              "Could not record or reconcile host command intent. Retry with the same identity.",
              cause,
            ),
      ),
    );
    const required = (result: PluginCommandReceipt | null) =>
      result === null
        ? Effect.fail(error("receipt", "The committed command has no receipt."))
        : Effect.succeed(result);
    const service = Host.of({
      ...core,
      launch: (input) => execute({ kind: "launch", input }).pipe(Effect.flatMap(required)),
      retryPreparation: (input) =>
        execute({ kind: "retry-preparation", input }).pipe(Effect.flatMap(required)),
      send: (input) => execute({ kind: "send", input }).pipe(Effect.flatMap(required)),
      interrupt: (input) => execute({ kind: "interrupt", input }),
      receipt: (id) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{
            result: string | null;
            intent: string;
          }>`SELECT result, intent FROM host_commands WHERE id = ${id}`;
          if (row === undefined) return null;
          if (row.result !== null) return yield* decodeReceipt(row.result);
          const result = yield* core.receipt(coreId(yield* decodeIntent(row.intent)));
          return result === null ? null : { ...result, commandId: id };
        }).pipe(
          Effect.mapError((cause) =>
            isPluginError(cause)
              ? cause
              : error("receipt", "Could not read the host command receipt.", cause),
          ),
        ),
    });
    const recover = Effect.gen(function* () {
      const pending = yield* sql<{
        request: string;
      }>`SELECT request FROM host_commands WHERE result IS NULL ORDER BY rowid`;
      yield* Effect.forEach(
        pending,
        (row) =>
          decodeRequest(row.request).pipe(
            Effect.flatMap((request) => execute(request, true)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Plugin host command remains pending", { pluginId, cause }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }).pipe(
      Effect.mapError((cause) => error("recover", "Could not recover plugin host intents.", cause)),
    );
    const completeInitialization = Effect.sync(() => {
      initializing = false;
      initializingLaunches.clear();
    });
    const rejectInitialization = Effect.suspend(() =>
      Effect.forEach(
        initializingLaunches,
        ([commandId, intent]) =>
          Effect.gen(function* () {
            const created = yield* core.receipt(commandId);
            if (created === null) return;
            const target = {
              environmentId: intent.input.environmentId,
              projectId: intent.input.projectId,
              threadId: created.threadId,
            };
            const state = yield* core.inspect(target);
            const records =
              intent.input.instruction === undefined || Option.isNone(threads)
                ? undefined
                : yield* threads.value.getProjectThreadRecords(target, ["runs"]);
            const initialRun = records?.runs.find(
              (run) => run.userMessageId === `${commandId}:message`,
            );
            if (initialRun === undefined && state.preparationId === undefined) return;
            yield* sql`INSERT OR IGNORE INTO host_cancelled_launches (id) VALUES (${intent.input.commandId})`;
            yield* core.interrupt({
              ...target,
              commandId: CommandId.make(
                `${commandId}:initialization-rejected:${initialRun?.id ?? state.preparationId}`,
              ),
              ...(initialRun === undefined
                ? { preparationId: state.preparationId! }
                : { runId: initialRun.id }),
            });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not cancel rejected plugin launch", {
                pluginId,
                commandId,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    ).pipe(Effect.ensuring(completeInitialization));
    return { service, recover, rejectInitialization, completeInitialization };
  });

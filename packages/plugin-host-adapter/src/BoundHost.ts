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
import * as KeyedLock from "@t3tools/shared/KeyedLock";

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
}));
const LaunchRequest = Schema.Struct({ kind: Schema.Literal("launch"), input: PluginLaunchInput });
const SendRequest = Schema.Struct({ kind: Schema.Literal("send"), input: Send });
const Request = Schema.Union([
  LaunchRequest,
  SendRequest,
  Schema.Struct({ kind: Schema.Literal("interrupt"), input: Interrupt }),
]);
const Intent = Schema.Union([
  LaunchRequest.mapFields((fields) => ({ ...fields, coreCommandId: Schema.optional(CommandId) })),
  SendRequest.mapFields((fields) => ({ ...fields, coreCommandId: Schema.optional(CommandId) })),
  Schema.Struct({
    kind: Schema.Literal("interrupt"),
    coreCommandId: Schema.optional(CommandId),
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
    const { sql } = yield* Storage;
    const lock = yield* KeyedLock.make<CommandId>();
    const error = (operation: string, message: string, cause?: unknown) =>
      new PluginError({
        pluginId,
        code: "storage",
        operation,
        message,
        ...(cause === undefined ? {} : { cause }),
      });
    yield* sql`CREATE TABLE IF NOT EXISTS host_commands (id TEXT PRIMARY KEY, request TEXT NOT NULL, intent TEXT NOT NULL, result TEXT)`;
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
      const result =
        intent.kind === "launch"
          ? yield* core.launch({ ...intent.input, commandId: input.commandId })
          : intent.kind === "send"
            ? yield* core.send({ ...intent.input, commandId: input.commandId })
            : intent.input.runId === null
              ? null
              : yield* core.interrupt({
                  ...intent.input,
                  commandId: input.commandId,
                  runId: intent.input.runId!,
                });
      const receipt = result === null ? null : { ...result, commandId: intent.input.commandId };
      const encoded = yield* encodeReceipt(receipt);
      yield* sql`UPDATE host_commands SET result = ${encoded} WHERE id = ${intent.input.commandId}`;
      return receipt;
    });
    const execute = Effect.fn("PluginHost.executeIntent")(
      function* (requested: typeof Request.Type) {
        if (requested.input.environmentId !== core.environmentId)
          return yield* new PluginError({
            pluginId,
            code: "unavailable",
            operation: requested.kind,
            message: "The requested environment is not this server.",
          });
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
          return yield* dispatch(yield* decodeIntent(existing.intent));
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
        if (requested.kind === "interrupt") {
          const state = yield* core.inspect(requested.input);
          const active =
            state.runs.findLast((run) =>
              ["preparing", "starting", "running", "waiting"].includes(run.status),
            ) ?? (state.outstandingWork.length > 0 ? state.runs.at(-1) : undefined);
          intent = {
            ...requested,
            input: { ...requested.input, runId: requested.input.runId ?? active?.id ?? null },
          };
        }
        // A tuple separates public IDs from child-step suffixes and legacy plugin:id prefixes.
        intent = {
          ...intent,
          coreCommandId: CommandId.make(
            `plugin:${yield* encodeCoreIdentity([pluginId, requested.input.commandId])}`,
          ),
        };
        const encoded = yield* encodeIntent(intent);
        yield* sql`INSERT INTO host_commands (id, request, intent) VALUES (${requested.input.commandId}, ${request}, ${encoded})`;
        return yield* dispatch(intent);
      },
      (effect, requested) => lock.withLock(requested.input.commandId, effect),
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
            Effect.flatMap(execute),
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
    return { service, recover };
  });

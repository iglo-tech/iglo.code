/**
 * OrchestrationCommandReceiptRepository - Repository interface for command receipts.
 *
 * Owns persistence operations for deduplication and status tracking of
 * orchestration command handling.
 *
 * @module OrchestrationCommandReceiptRepository
 */
import { CommandId, IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  toPersistenceSqlError,
  type OrchestrationCommandReceiptRepositoryError,
} from "./Errors.ts";

export const OrchestrationCommandReceipt = Schema.Struct({
  commandId: CommandId,
  aggregateKind: Schema.Literals(["project", "thread"]),
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  commandType: Schema.String,
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: Schema.Literals(["accepted", "rejected"]),
  error: Schema.NullOr(Schema.String),
});
export type OrchestrationCommandReceipt = typeof OrchestrationCommandReceipt.Type;

export const GetByCommandIdInput = Schema.Struct({
  commandId: CommandId,
});
export type GetByCommandIdInput = typeof GetByCommandIdInput.Type;

/**
 * OrchestrationCommandReceiptRepository - Service tag for command receipt persistence.
 */
export class OrchestrationCommandReceiptRepository extends Context.Service<
  OrchestrationCommandReceiptRepository,
  {
    readonly insertIfAbsent: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Insert or replace a command receipt row.
     *
     * Upserts by `commandId` for idempotent command-result tracking.
     */
    readonly upsert: (
      receipt: OrchestrationCommandReceipt,
    ) => Effect.Effect<void, OrchestrationCommandReceiptRepositoryError>;

    /**
     * Read a command receipt by command id.
     */
    readonly getByCommandId: (
      input: GetByCommandIdInput,
    ) => Effect.Effect<
      Option.Option<OrchestrationCommandReceipt>,
      OrchestrationCommandReceiptRepositoryError
    >;
    readonly hasPendingWorkspacePreparation: (
      threadId: ThreadId,
      includeNativePreparations?: boolean,
    ) => Effect.Effect<boolean, OrchestrationCommandReceiptRepositoryError>;
  }
>()("t3/persistence/OrchestrationCommandReceipts/OrchestrationCommandReceiptRepository") {}

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          command_type,
          accepted_at,
          result_sequence,
          status,
          error
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.commandType},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
            aggregate_id = excluded.aggregate_id,
            command_type = excluded.command_type,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceipt,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          command_type AS "commandType",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepository["Service"]["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const insertIfAbsent: OrchestrationCommandReceiptRepository["Service"]["insertIfAbsent"] = (
    receipt,
  ) =>
    sql<{ readonly command_id: string }>`
      INSERT INTO orchestration_command_receipts (
        command_id,
        aggregate_kind,
        aggregate_id,
        command_type,
        accepted_at,
        result_sequence,
        status,
        error
      )
      VALUES (
        ${receipt.commandId},
        ${receipt.aggregateKind},
        ${receipt.aggregateId},
        ${receipt.commandType},
        ${receipt.acceptedAt},
        ${receipt.resultSequence},
        ${receipt.status},
        ${receipt.error}
      )
      ON CONFLICT(command_id) DO NOTHING
      RETURNING command_id
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.insertIfAbsent:query"),
      ),
    );

  const getByCommandId: OrchestrationCommandReceiptRepository["Service"]["getByCommandId"] = (
    input,
  ) =>
    findReceiptByCommandId(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    insertIfAbsent,
    upsert,
    getByCommandId,
    hasPendingWorkspacePreparation: (threadId, includeNativePreparations = false) =>
      sql`
        SELECT 1 AS pending FROM orchestration_command_receipts launch
        WHERE launch.aggregate_kind = 'thread' AND launch.aggregate_id = ${threadId}
          AND launch.command_type = 'thread.create' AND launch.status = 'accepted'
          AND launch.command_id LIKE 'plugin:%'
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_command_receipts ready
            WHERE ready.command_id = launch.command_id || ':workspace-ready'
              AND ready.aggregate_kind = 'thread' AND ready.aggregate_id = launch.aggregate_id
              AND ready.command_type = 'thread.metadata.update' AND ready.status = 'accepted'
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_command_receipts instructed
            WHERE instructed.command_id = launch.command_id || ':initial-message'
              AND instructed.aggregate_kind = 'thread' AND instructed.aggregate_id = launch.aggregate_id
              AND instructed.command_type = 'message.dispatch' AND instructed.status = 'accepted'
          )
        UNION ALL
        SELECT 1 AS pending FROM orchestration_v2_projection_runs preparation
        WHERE preparation.thread_id = ${threadId}
          AND json_type(preparation.payload_json, '$.workspacePreparation') = 'object'
          AND (${includeNativePreparations ? 1 : 0} = 1 OR json_extract(preparation.payload_json, '$.userMessageId') LIKE 'plugin:%:message')
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events released
            WHERE released.aggregate_kind = 'thread' AND released.stream_id = preparation.thread_id
              AND released.application_event_version = 2 AND released.event_type = 'checkpoint-scope.created'
              AND json_extract(released.payload_json, '$.kind') = 'root_run'
              AND json_extract(released.payload_json, '$.runId') = preparation.run_id
          )
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(
          toPersistenceSqlError(
            "OrchestrationCommandReceiptRepository.hasPendingWorkspacePreparation:query",
          ),
        ),
      ),
  } satisfies OrchestrationCommandReceiptRepository["Service"];
});

export const layer = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);

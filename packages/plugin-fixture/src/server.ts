import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PluginError,
  type PluginAttentionItem,
} from "@t3tools/plugin-host-contract/schema";
import {
  Host,
  Storage,
  Schedules,
  tool,
  type PluginServices,
  type PluginToolCaller,
  type ServerPlugin,
} from "@t3tools/plugin-host-contract/server";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ListRpc,
  ResolveRpc,
  SubscribeRpc,
  ScheduleRpc,
  manifest,
  Report,
  ReportInput,
  type ListInput,
  type ResolveInput,
  type ScheduleInput,
} from "./contracts.ts";

const decodeReport = Schema.decodeUnknownEffect(Report);
const error = (operation: string, message: string, cause?: unknown) =>
  new PluginError({
    pluginId: manifest.id,
    code: "service",
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
const isPluginError = Schema.is(PluginError);
const decodeReminder = Schema.decodeUnknownEffect(Schema.Struct({ id: ReportInput.fields.id }));
interface Row {
  readonly id: string;
  readonly summary: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly resolved: number;
}

const acquire = Effect.gen(function* () {
  const host = yield* Host;
  const { sql } = yield* Storage;
  const schedules = yield* Schedules;
  const changes = yield* PubSub.sliding<void>(1);
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  const environment = (environmentId: string) =>
    environmentId === host.environmentId
      ? Effect.void
      : Effect.fail(
          new PluginError({
            pluginId: manifest.id,
            code: "unavailable",
            operation: "target",
            message: "The requested environment is not this server.",
          }),
        );
  const fromRow = (row: Row) =>
    decodeReport({
      id: row.id,
      summary: row.summary,
      environmentId: host.environmentId,
      projectId: row.project_id,
      threadId: row.thread_id,
      resolved: row.resolved === 1,
    });
  const find = (id: string) =>
    sql<Row>`SELECT * FROM reports WHERE id = ${id}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(undefined) : fromRow(rows[0]),
      ),
    );
  const list = Effect.fn("Fixture.list")(
    function* (input: ListInput) {
      yield* environment(input.environmentId);
      const rows =
        yield* sql<Row>`SELECT * FROM reports WHERE (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null}) AND (${input.threadId ?? null} IS NULL OR thread_id = ${input.threadId ?? null}) ORDER BY resolved, id LIMIT 100`;
      return yield* Effect.forEach(rows, fromRow);
    },
    Effect.mapError((cause) =>
      isPluginError(cause) ? cause : error("list", "Could not read reports.", cause),
    ),
  );
  const subscribe = (input: ListInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list(input))),
        );
      }),
    );
  const report = Effect.fn("Fixture.report")(
    function* (input: ReportInput, caller: PluginToolCaller) {
      yield* environment(caller.environmentId);
      // Ownership is the authenticated calling thread, never a tool parameter.
      const target = {
        environmentId: caller.environmentId,
        projectId: caller.projectId,
        threadId: caller.threadId,
      };
      yield* host.inspect(target);
      const accepted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const previous = yield* find(input.id);
          if (previous !== undefined) {
            if (
              previous.projectId !== caller.projectId ||
              previous.threadId !== caller.threadId ||
              previous.summary !== input.summary
            )
              return yield* new PluginError({
                pluginId: manifest.id,
                code: "conflict",
                operation: "report",
                message: "This report identity already belongs to different work.",
              });
            return previous;
          }
          yield* sql`INSERT INTO reports (id, summary, project_id, thread_id, resolved) VALUES (${input.id}, ${input.summary}, ${caller.projectId}, ${caller.threadId}, 0)`;
          return { ...input, ...target, resolved: false };
        }),
      );
      yield* PubSub.publish(changes, undefined);
      return accepted;
    },
    Effect.mapError((cause) =>
      isPluginError(cause) ? cause : error("report", "Could not record report.", cause),
    ),
  );
  const resolve = Effect.fn("Fixture.resolve")(
    function* (input: ResolveInput) {
      yield* environment(input.environmentId);
      const previous = yield* find(input.id);
      if (previous === undefined) return yield* error("resolve", "The report no longer exists.");
      yield* sql`UPDATE reports SET resolved = 1 WHERE id = ${input.id}`;
      yield* PubSub.publish(changes, undefined);
      return { ...previous, resolved: true };
    },
    Effect.mapError((cause) =>
      isPluginError(cause) ? cause : error("resolve", "Could not resolve report.", cause),
    ),
  );
  const schedule = Effect.fn("Fixture.schedule")(
    function* (input: ScheduleInput) {
      yield* environment(input.environmentId);
      const report = yield* find(input.id);
      if (report === undefined) return yield* error("schedule", "The report no longer exists.");
      yield* schedules.upsert({
        id: `reminder:${report.id}`,
        title: report.summary,
        projectId: report.projectId,
        target: "fixture.reminder",
        enabled: true,
        schedule: { type: "interval", everyMs: input.everyMs },
        payload: { id: report.id },
      });
    },
    Effect.mapError((cause) =>
      isPluginError(cause) ? cause : error("schedule", "Could not schedule reminder.", cause),
    ),
  );
  const attention = subscribe({ environmentId: host.environmentId }).pipe(
    Stream.map((reports) =>
      reports
        .filter((report) => !report.resolved)
        .map(
          (report) =>
            ({
              id: report.id,
              summary: report.summary,
              severity: "info",
              reason: "A report needs your review.",
              link: {
                pageId: "fixture.reports",
                projectId: report.projectId,
                threadId: report.threadId,
              },
            }) satisfies PluginAttentionItem,
        ),
    ),
  );
  return {
    tools: [
      tool({
        id: "plugin_fixture_report",
        description:
          "Record a report for the authenticated calling thread. Reuse the report id when retrying. This mutates the plugin's private state and is explicitly allowed in read-only review sessions.",
        input: ReportInput,
        output: Report,
        permission: {
          readOnly: false,
          destructive: false,
          idempotent: true,
          allowInReadOnly: true,
        },
        invoke: report,
      }),
    ],
    api: [
      {
        rpc: ListRpc,
        requiredScope: AuthOrchestrationReadScope,
        invoke: (input) => list(input as ListInput),
      },
      {
        rpc: ResolveRpc,
        requiredScope: AuthOrchestrationOperateScope,
        invoke: (input) => resolve(input as ResolveInput),
      },
      {
        rpc: SubscribeRpc,
        requiredScope: AuthOrchestrationReadScope,
        invoke: (input) => subscribe(input as ListInput),
      },
      {
        rpc: ScheduleRpc,
        requiredScope: AuthOrchestrationOperateScope,
        invoke: (input) => schedule(input as ScheduleInput),
      },
    ],
    scheduleTargets: [
      {
        id: "fixture.reminder",
        invoke: ({ occurrenceId, projectId, payload }) =>
          Effect.gen(function* () {
            const input = yield* decodeReminder(payload).pipe(
              Effect.mapError((cause) => error("reminder", "Invalid reminder payload.", cause)),
            );
            yield* sql
              .withTransaction(
                Effect.gen(function* () {
                  const [receipt] =
                    yield* sql`SELECT id FROM reminder_receipts WHERE id = ${occurrenceId}`;
                  if (receipt !== undefined) return;
                  const report = yield* find(input.id);
                  if (report === undefined || report.projectId !== projectId)
                    return yield* error(
                      "reminder",
                      "The report is unavailable in this schedule's project.",
                    );
                  yield* sql`UPDATE reports SET resolved = 0 WHERE id = ${input.id} AND project_id = ${projectId}`;
                  yield* sql`INSERT INTO reminder_receipts (id) VALUES (${occurrenceId})`;
                }),
              )
              .pipe(
                Effect.mapError((cause) =>
                  error("reminder", "Could not dispatch reminder.", cause),
                ),
              );
            yield* PubSub.publish(changes, undefined);
          }),
      },
    ],
    attention,
  } satisfies PluginServices;
});

export const plugin: ServerPlugin = {
  manifest,
  migrations: [
    {
      id: 1,
      name: "reports",
      run: Effect.gen(function* () {
        const { sql } = yield* Storage;
        yield* sql`CREATE TABLE reports (id TEXT PRIMARY KEY, summary TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, resolved INTEGER NOT NULL)`;
        yield* sql`CREATE TABLE reminder_receipts (id TEXT PRIMARY KEY)`;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PluginError({
              pluginId: manifest.id,
              code: "storage",
              operation: "migrate",
              message: "Could not migrate report storage.",
              cause,
            }),
        ),
      ),
    },
  ],
  acquire,
};

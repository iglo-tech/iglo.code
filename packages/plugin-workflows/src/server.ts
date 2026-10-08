import {
  Storage,
  tool,
  type ServerPlugin,
  type PluginServices,
} from "@t3tools/plugin-host-contract/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { manifest, apiScopes, rpcs, ReportInput, ReportReceipt, StartInput } from "./contracts.ts";
import * as Workflow from "./Workflow.ts";
import * as Catalog from "./Catalog.ts";
import { protect } from "./encoding.ts";

const schedulePayload = Schema.Struct({
  definitionId: Schema.String,
  input: StartInput.fields.input,
});
export const plugin: ServerPlugin = {
  manifest,
  migrations: [
    {
      id: 1,
      name: "workflow-engine",
      run: protect(
        "migrate",
        Effect.gen(function* () {
          const { sql } = yield* Storage;
          yield* sql`CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL)`;
          yield* sql`CREATE INDEX workflow_runs_project ON workflow_runs (project_id, state)`;
          yield* sql`CREATE TABLE workflow_bindings (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), attempt_id TEXT NOT NULL UNIQUE)`;
          yield* sql`CREATE TABLE workflow_reports (attempt_id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL)`;
          yield* sql`CREATE TABLE workflow_commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)`;
          yield* sql`CREATE TABLE workflow_events (run_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, revision))`;
          yield* sql`CREATE TABLE workflow_outbox (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), attempt_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL)`;
        }),
      ),
    },
  ],
  acquire: Effect.gen(function* () {
    const context = yield* Layer.build(Workflow.layer.pipe(Layer.provideMerge(Catalog.layer)));
    const workflows = Context.get(context, Workflow.Workflow);
    const catalog = Context.get(context, Catalog.Catalog);
    const handlers = {
      catalog: (input: typeof rpcs.catalog.payloadSchema.Type) => catalog.list(input),
      validate: (input: typeof rpcs.validate.payloadSchema.Type) =>
        // Authoring feedback reuses cached skill snapshots; save and start rescan.
        catalog.validate(input, input.definition, { fresh: false }),
      save: (input: typeof rpcs.save.payloadSchema.Type) => catalog.save(input),
      library: (input: typeof rpcs.library.payloadSchema.Type) => catalog.library(input),
      read: (input: typeof rpcs.read.payloadSchema.Type) => catalog.read(input),
      replace: (input: typeof rpcs.replace.payloadSchema.Type) => catalog.replace(input),
      capabilities: (input: typeof rpcs.capabilities.payloadSchema.Type) =>
        catalog.capabilities(input),
      skills: (input: typeof rpcs.skills.payloadSchema.Type) => catalog.skills(input),
      projects: (input: typeof rpcs.projects.payloadSchema.Type) => catalog.projects(input),
      start: workflows.start,
      get: workflows.get,
      list: workflows.list,
      subscribe: workflows.subscribe,
      reconcile: workflows.reconcile,
      cancel: workflows.cancel,
      retry: workflows.retry,
      resume: workflows.resume,
      gate: workflows.gate,
      schedule: workflows.schedule,
    };
    return {
      tools: [
        tool({
          id: "plugin_workflows_report",
          description:
            "Submit an immutable typed report for this thread's bound workflow attempt. No run, node or attempt selectors are accepted. Reuse clientRetryKey and the identical payload to retrieve the original receipt. Outcome is an agent claim, not verification. Protocol version 1; 64 KiB encoded envelope, 4,000-character summary, 32 declared primitive fields, 20 evidence references. Exact data/evidence requirements are in the launch instructions.",
          input: ReportInput,
          output: ReportReceipt,
          permission: {
            readOnly: false,
            destructive: false,
            idempotent: true,
            allowInReadOnly: true,
          },
          invoke: workflows.report,
        }),
      ],
      api: Object.entries(rpcs).map(([name, rpc]) => ({
        rpc,
        requiredScope: apiScopes[rpc._tag]!,
        invoke: (input: unknown) => {
          const handler = handlers[name as keyof typeof handlers];
          return handler(input as never);
        },
      })),
      scheduleTargets: [
        {
          id: "workflows.start",
          invoke: ({ occurrenceId, projectId, payload }) =>
            protect(
              "scheduled-start",
              Effect.gen(function* () {
                const input = yield* Schema.decodeUnknownEffect(schedulePayload)(payload);
                // The immutable occurrence receipt is the same idempotency key as a manual start.
                yield* workflows.scheduledStart({
                  projectId,
                  occurrenceId,
                  definitionId: input.definitionId,
                  input: input.input,
                });
              }),
            ),
        },
      ],
      attention: workflows.attention,
    } satisfies PluginServices;
  }),
};

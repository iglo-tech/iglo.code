import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ModelSelection,
  RuntimeMode,
  PluginError,
  PluginPullRequestRef,
  PluginLaunchInput,
  PluginScheduleInput,
  type PluginManifest,
} from "@t3tools/plugin-host-contract/schema";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

/** Protocol bounds apply at save, start and report acceptance. */
export const limits = {
  nodes: 64,
  edges: 256,
  fields: 32,
  predicateDepth: 8,
  predicateTerms: 128,
  definitionBytes: 524_288,
  reportBytes: 65_536,
  summary: 4_000,
  evidence: 20,
  repeats: 20,
  visits: 1_000,
  timeoutMs: { default: 7_200_000, min: 60_000, max: 86_400_000 },
} as const;
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000));
const title = text.check(Schema.isTrimmed());
export const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const key = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const Value = Schema.Union([
  Schema.Boolean,
  Schema.String.check(Schema.isMaxLength(4_000)),
  Schema.Number.check(Schema.isFinite()),
]);
export type Value = typeof Value.Type;
export const Data = Schema.Record(Schema.String, Value).check(
  Schema.isMaxProperties(limits.fields),
);
export const Field = Schema.Struct({
  name: Id,
  type: Schema.Literals(["boolean", "string", "number", "enum"]),
  required: Schema.Boolean,
  values: Schema.optional(Schema.Array(text).check(Schema.isMaxLength(32))),
});
export type Field = typeof Field.Type;
export const ReportContract = Schema.Struct({
  fields: Schema.Array(Field).check(Schema.isMaxLength(limits.fields)),
  evidenceRequired: Schema.optional(Schema.Boolean),
});
export const ReportInput = Schema.Struct({
  version: Schema.Literal(1),
  clientRetryKey: key,
  outcome: Schema.Literals(["completed", "blocked", "failed"]),
  summary: text,
  data: Data,
  evidence: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(["commit", "file", "url", "check"]), reference: text }),
  ).check(Schema.isMaxLength(limits.evidence)),
});
export type ReportInput = typeof ReportInput.Type;
export const ReportReceipt = Schema.Struct({
  id: Schema.String,
  attemptId: Schema.String,
  acceptedAt: Schema.Number,
  digest: Schema.String,
});
export type ReportReceipt = typeof ReportReceipt.Type;
export const AcceptedReport = Schema.Struct({ ...ReportInput.fields, receipt: ReportReceipt });

export interface Predicate {
  readonly op:
    | "eq"
    | "ne"
    | "in"
    | "present"
    | "absent"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "all"
    | "any";
  readonly path?: string;
  readonly value?: Value;
  readonly values?: ReadonlyArray<Value>;
  readonly terms?: ReadonlyArray<Predicate>;
}
const predicateAtDepth = (depth: number): Schema.Codec<Predicate> =>
  Schema.suspend(() =>
    depth > limits.predicateDepth
      ? Schema.Never
      : Schema.Union([
          Schema.Struct({
            op: Schema.Literals(["eq", "ne", "gt", "gte", "lt", "lte"]),
            path: text,
            value: Value,
          }),
          Schema.Struct({
            op: Schema.Literal("in"),
            path: text,
            values: Schema.Array(Value).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
          }),
          Schema.Struct({ op: Schema.Literals(["present", "absent"]), path: text }),
          Schema.Struct({
            op: Schema.Literals(["all", "any"]),
            terms: Schema.Array(predicateAtDepth(depth + 1)).check(
              Schema.isMinLength(1),
              Schema.isMaxLength(limits.predicateTerms),
            ),
          }),
        ]),
  );
export const Predicate = predicateAtDepth(1);
export const Route = Schema.Struct({
  to: Id,
  repeat: Schema.optional(
    Schema.Struct({
      max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limits.repeats })),
      atLimit: Id,
    }),
  ),
});
export type Route = typeof Route.Type;
export const Rule = Schema.Struct({ when: Predicate, route: Route });
const bindings = Schema.Array(
  Schema.Struct({ name: Id, node: Id, path: text, field: Field }),
).check(Schema.isMaxLength(limits.fields));
const timeout = Schema.Int.check(
  Schema.isBetween({ minimum: limits.timeoutMs.min, maximum: limits.timeoutMs.max }),
);
export const Agent = Schema.Struct({
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  instruction: text,
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  skill: Schema.optional(key),
  report: ReportContract,
  bindings: Schema.optional(bindings),
  timeoutMs: Schema.optional(timeout),
  humanTimeoutMs: Schema.optional(timeout),
});
export type Agent = typeof Agent.Type;
const common = { id: Id, title };
export const Node = Schema.Union([
  Schema.Struct({
    ...common,
    kind: Schema.Literal("agent"),
    ...Agent.fields,
    next: Route,
    onUnresolved: Schema.optional(Route),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("check"),
    command: text,
    args: Schema.Array(text).check(Schema.isMaxLength(64)),
    timeoutMs: Schema.optional(timeout),
    next: Route,
    onUnresolved: Schema.optional(Route),
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("decision"),
    source: Id,
    rules: Schema.Array(Rule),
    otherwise: Route,
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("parallel"),
    pullRequest: Schema.Struct({
      repository: text,
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      host: Schema.optional(text),
    }),
    branches: Schema.Array(Schema.Struct({ id: Id, title, ...Agent.fields })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
    next: Id,
  }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("join"),
    fork: Id,
    rules: Schema.Array(Rule),
    otherwise: Route,
  }),
  Schema.Struct({ ...common, kind: Schema.Literal("human"), approve: Route, changes: Route }),
  Schema.Struct({
    ...common,
    kind: Schema.Literal("end"),
    outcome: Schema.Literals(["completed", "failed", "unresolved"]),
  }),
]);
export type Node = typeof Node.Type;
export const Definition = Schema.Struct({
  version: Schema.Literal(1),
  id: Id,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  title,
  entry: Id,
  atLimit: Id,
  maxVisits: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limits.visits })),
  ),
  nodes: Schema.Array(Node).check(Schema.isMinLength(1), Schema.isMaxLength(limits.nodes)),
});
export type Definition = typeof Definition.Type;
export const SkillSnapshot = Schema.Struct({
  invocation: Schema.String,
  name: Schema.String,
  path: Schema.String,
  fingerprint: Schema.NullOr(Schema.String),
  limitation: Schema.NullOr(Schema.String),
});
export const CheckResult = Schema.Struct({
  outcome: Schema.Literals(["completed", "failed", "unresolved"]),
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  interrupted: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
});
export const Attempt = Schema.Struct({
  id: Schema.String,
  nodeId: Id,
  branchId: Schema.NullOr(Id),
  reviewId: Schema.NullOr(Schema.String),
  generation: Schema.Int,
  threadId: Schema.NullOr(ThreadId),
  phase: Schema.Literals([
    "launching",
    "resuming",
    "running",
    "waiting-input",
    "reminding",
    "reported",
    "completed",
    "failed",
    "unresolved",
    "interrupted",
    "canceled",
    "stale",
  ]),
  reason: Schema.NullOr(Schema.String),
  report: Schema.NullOr(AcceptedReport),
  check: Schema.NullOr(CheckResult),
  skill: Schema.NullOr(SkillSnapshot),
  input: Data,
  launch: Schema.NullOr(PluginLaunchInput),
  executionRunId: Schema.NullOr(Schema.String),
  nativeSessionId: Schema.NullOr(Schema.String),
  resumable: Schema.Boolean,
  resumeCount: Schema.Int,
  reminderSent: Schema.Boolean,
  remainingMs: Schema.Number,
  lastActiveAt: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
  waitStartedAt: Schema.NullOr(Schema.Number),
});
export type Attempt = typeof Attempt.Type;
export const Trace = Schema.Struct({
  id: Schema.String,
  nodeId: Id,
  attemptId: Schema.NullOr(Schema.String),
  sourceIds: Schema.Array(Schema.String),
  considered: Schema.Array(Schema.Struct({ predicate: Predicate, matched: Schema.Boolean })),
  chosen: Id,
  reason: Schema.String,
  repeatCount: Schema.NullOr(Schema.Int),
  at: Schema.Number,
});
export const ReviewSet = Schema.Struct({
  id: Schema.String,
  fork: Id,
  generation: Schema.Int,
  head: Schema.String,
  pullRequest: PluginPullRequestRef,
  branches: Schema.Array(Schema.Struct({ id: Id, attemptId: Schema.String })),
  result: Schema.NullOr(
    Schema.Literals(["all_completed", "failed", "unresolved", "canceled", "stale"]),
  ),
  consumed: Schema.Boolean,
});
export const Run = Schema.Struct({
  id: Schema.String,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  definition: Definition,
  digest: Schema.String,
  skills: Schema.Record(Schema.String, SkillSnapshot),
  input: Data,
  state: Schema.Literals([
    "running",
    "awaiting-review",
    "unresolved",
    "completed",
    "failed",
    "canceled",
  ]),
  revision: Schema.Int,
  currentNode: Id,
  visits: Schema.Int,
  automationStopped: Schema.Boolean,
  repeats: Schema.Record(Schema.String, Schema.Int),
  attempts: Schema.Array(Attempt),
  trace: Schema.Array(Trace),
  reviews: Schema.Array(ReviewSet),
  workspace: PluginLaunchInput.fields.workspace,
  workspacePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  gate: Schema.NullOr(
    Schema.Struct({ nodeId: Id, revision: Schema.Int, reviewId: Schema.NullOr(Schema.String) }),
  ),
  allowedActions: Schema.Array(
    Schema.Literals(["cancel", "retry", "resume", "approve", "request-changes"]),
  ),
  createdAt: Schema.Number,
  history: Schema.optional(
    Schema.Struct({
      offset: Schema.Int,
      tail: Schema.Boolean,
      limit: Schema.Int,
      attempts: Schema.Int,
      trace: Schema.Int,
      reviews: Schema.Int,
    }),
  ),
});
export type Run = typeof Run.Type;
/** Compact observation; accepted payloads and full history are paged through get. */
export const RunSummary = Schema.Struct({
  id: Run.fields.id,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  definition: Schema.Struct({ id: Id, revision: Schema.Int, title }),
  state: Run.fields.state,
  revision: Schema.Int,
  currentNode: Id,
  visits: Schema.Int,
  automationStopped: Run.fields.automationStopped,
  reason: Run.fields.reason,
  gate: Run.fields.gate,
  allowedActions: Run.fields.allowedActions,
  createdAt: Schema.Number,
  attempts: Schema.Array(
    Schema.Struct({
      id: Attempt.fields.id,
      nodeId: Id,
      branchId: Attempt.fields.branchId,
      generation: Schema.Int,
      threadId: Attempt.fields.threadId,
      phase: Attempt.fields.phase,
      reason: Attempt.fields.reason,
      reportId: Schema.NullOr(Schema.String),
    }),
  ).check(Schema.isMaxLength(5)),
  trace: Schema.Array(
    Schema.Struct({
      id: Trace.fields.id,
      nodeId: Id,
      attemptId: Trace.fields.attemptId,
      sourceIds: Trace.fields.sourceIds,
      chosen: Id,
      reason: Schema.String,
    }),
  ).check(Schema.isMaxLength(1)),
  reviews: Schema.Array(ReviewSet).check(Schema.isMaxLength(1)),
});
export type RunSummary = typeof RunSummary.Type;
export const RunListInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  before: Schema.optional(Schema.String),
});
export const CatalogEntry = Schema.Struct({
  source: Schema.String,
  definition: Schema.NullOr(Definition),
  runnable: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
});
export type CatalogEntry = typeof CatalogEntry.Type;
export const ScopeInput = Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId });
export const StartInput = Schema.Struct({
  ...ScopeInput.fields,
  clientRequestId: key,
  definition: Definition,
  input: Data,
  workspace: Schema.optional(PluginLaunchInput.fields.workspace),
});
export type StartInput = typeof StartInput.Type;
export const RunInput = Schema.Struct({
  ...ScopeInput.fields,
  runId: Schema.String,
  historyOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const CommandInput = Schema.Struct({
  ...RunInput.fields,
  clientRequestId: key,
  expectedRevision: Schema.Int,
});
export const GateInput = Schema.Struct({
  ...CommandInput.fields,
  decision: Schema.Literals(["approve", "request-changes"]),
});
export const SaveInput = Schema.Struct({
  ...ScopeInput.fields,
  definition: Definition,
  expectedRevision: Schema.NullOr(Schema.Int),
});
export const ScheduleInput = Schema.Struct({
  ...ScopeInput.fields,
  id: key,
  title,
  definitionId: Id,
  input: Data,
  schedule: PluginScheduleInput.fields.schedule,
});

const error = Schema.Union([PluginError, EnvironmentAuthorizationError]);
export const rpcs = {
  catalog: Rpc.make("plugins.workflows.catalog", {
    payload: ScopeInput,
    success: Schema.Array(CatalogEntry),
    error,
  }),
  validate: Rpc.make("plugins.workflows.validate", {
    payload: Schema.Struct({ ...ScopeInput.fields, definition: Definition }),
    success: CatalogEntry,
    error,
  }),
  save: Rpc.make("plugins.workflows.save", { payload: SaveInput, success: CatalogEntry, error }),
  start: Rpc.make("plugins.workflows.start", { payload: StartInput, success: Run, error }),
  get: Rpc.make("plugins.workflows.get", { payload: RunInput, success: Run, error }),
  list: Rpc.make("plugins.workflows.list", {
    payload: RunListInput,
    success: Schema.Array(RunSummary),
    error,
  }),
  subscribe: Rpc.make("plugins.workflows.subscribe", {
    payload: ScopeInput,
    success: Schema.Array(RunSummary),
    error,
    stream: true,
  }),
  reconcile: Rpc.make("plugins.workflows.reconcile", {
    payload: ScopeInput,
    success: Schema.Array(RunSummary),
    error,
  }),
  cancel: Rpc.make("plugins.workflows.cancel", { payload: CommandInput, success: Run, error }),
  retry: Rpc.make("plugins.workflows.retry", { payload: CommandInput, success: Run, error }),
  resume: Rpc.make("plugins.workflows.resume", { payload: CommandInput, success: Run, error }),
  gate: Rpc.make("plugins.workflows.gate", { payload: GateInput, success: Run, error }),
  schedule: Rpc.make("plugins.workflows.schedule", {
    payload: ScheduleInput,
    success: Schema.Void,
    error,
  }),
};
export const WorkflowRpcGroup = RpcGroup.make(...Object.values(rpcs));
export const apiScopes = {
  [rpcs.catalog._tag]: AuthOrchestrationReadScope,
  [rpcs.validate._tag]: AuthOrchestrationReadScope,
  [rpcs.save._tag]: AuthOrchestrationOperateScope,
  [rpcs.start._tag]: AuthOrchestrationOperateScope,
  [rpcs.get._tag]: AuthOrchestrationReadScope,
  [rpcs.list._tag]: AuthOrchestrationReadScope,
  [rpcs.subscribe._tag]: AuthOrchestrationReadScope,
  [rpcs.reconcile._tag]: AuthOrchestrationReadScope,
  [rpcs.cancel._tag]: AuthOrchestrationOperateScope,
  [rpcs.retry._tag]: AuthOrchestrationOperateScope,
  [rpcs.resume._tag]: AuthOrchestrationOperateScope,
  [rpcs.gate._tag]: AuthOrchestrationOperateScope,
  [rpcs.schedule._tag]: AuthOrchestrationOperateScope,
} as const;
export const manifest = {
  id: "workflows",
  displayName: "Workflows",
  version: "1.0.0",
  hostVersion: 1,
  requiredCapabilities: [
    "execution",
    "lifecycle",
    "projects",
    "workspaces",
    "providers",
    "skills",
    "pull-requests",
    "persistence",
    "tools",
    "client-api",
    "schedules",
    "attention",
  ],
  server: {
    tools: ["plugin_workflows_report"],
    api: Object.values(rpcs).map((rpc) => rpc._tag),
    scheduleTargets: ["workflows.start"],
  },
  web: { pages: [], navigation: [], projectActions: [], threadContext: [] },
} satisfies PluginManifest;

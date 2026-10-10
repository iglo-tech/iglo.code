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
  PluginProviderModel,
  ProviderInstanceId,
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
  /** Active attempts listed in a run overview: one per parallel branch plus the main step. */
  activeAttempts: 64,
  /** Routing records of one history page's visits returned beside the route-history page. */
  relatedTrace: 200,
  /** Pending native requests retained per attempt, oldest first. */
  requests: 32,
  /** Runs per attention page, and items listed per run on it. */
  attentionRuns: 25,
  /** Most runs one attention read returns: the host summary and fully loaded pages. */
  attentionRunsMax: 100,
  attentionItems: 64,
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
  /**
   * The thread's pending native requests in native queue order, as last inspected. Absent on
   * attempts recorded before requests were kept.
   */
  requests: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: Schema.String, kind: Schema.String, createdAt: Schema.Number }),
    ).check(Schema.isMaxLength(limits.requests)),
  ),
  /** Every pending native request of the thread, including any beyond the retained list. */
  pendingRequests: Schema.optional(Schema.Int),
});
export type Attempt = typeof Attempt.Type;
/**
 * Stable, server-owned reasons a run needs a person. Clients word them; they never derive
 * them from prose. Ordinary running work is progress and has no reason.
 */
const stopKinds = [
  "interrupted",
  "missing-report",
  "timed-out",
  "failed",
  "review-stale",
  "review-unverifiable",
  "unavailable",
  "unresolved",
] as const;
/** Why an unresolved run stopped; set with the disposition, cleared when the run continues. */
export const StopKind = Schema.Literals(stopKinds);
export type StopKind = typeof StopKind.Type;
export const AttentionKind = Schema.Literals(["needs-review", "needs-input", ...stopKinds]);
export type AttentionKind = typeof AttentionKind.Type;
export const Trace = Schema.Struct({
  id: Schema.String,
  nodeId: Id,
  attemptId: Schema.NullOr(Schema.String),
  sourceIds: Schema.Array(Schema.String),
  considered: Schema.Array(Schema.Struct({ predicate: Predicate, matched: Schema.Boolean })),
  chosen: Id,
  reason: Schema.String,
  repeatCount: Schema.NullOr(Schema.Int),
  /** Inspector control of the authored route that fired (`next`, `rules.0`, `changes`…). */
  route: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  /**
   * The fired route's authored repeat bound and what happened to the repeat: admitted (the
   * counter was spent), limit (exhausted, so the route went to its At limit), or diverted by
   * the whole-run visit limit or stopped automation (the counter was not spent). Absent for
   * ordinary routes and older records.
   */
  repeat: Schema.optional(
    Schema.Struct({
      max: Schema.Int,
      atLimit: Id,
      exhausted: Schema.Boolean,
      /** Absent on records written before outcomes were kept; `exhausted` then decides. */
      outcome: Schema.optional(
        Schema.Literals(["admitted", "limit", "visit-limit", "automation-stopped"]),
      ),
    }),
  ),
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
  /**
   * What decided an aggregate that the branches alone do not explain: the frozen head
   * changed or could not be verified, or a reviewer checkout was unavailable or changed.
   */
  cause: Schema.optional(
    Schema.Literals([
      "head-changed",
      "head-unverifiable",
      "workspace-unavailable",
      "workspace-changed",
    ]),
  ),
});
/** One required reviewer of a review generation, as the server last recorded it. */
export const ReviewBranch = Schema.Struct({
  id: Id,
  attemptId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  phase: Attempt.fields.phase,
  reason: Schema.NullOr(Schema.String),
  report: Schema.NullOr(
    Schema.Struct({
      outcome: ReportInput.fields.outcome,
      acceptedAt: Schema.Number,
    }),
  ),
  deadline: Schema.NullOr(Schema.Number),
  /** The isolated checkout prepared for this reviewer, once its launch was reserved. */
  workspace: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      branch: Schema.NullOr(Schema.String),
      frozenHead: Schema.NullOr(Schema.String),
    }),
  ),
});
export type ReviewBranch = typeof ReviewBranch.Type;
/** How a run was started; retained with its snapshot so later catalog edits cannot rewrite it. */
export const StartSource = Schema.Struct({
  trigger: Schema.Literals(["manual", "schedule"]),
  /** Catalog source the saved snapshot was resolved from; null for a submitted definition. */
  catalogSource: Schema.NullOr(Schema.String),
});
export type StartSource = typeof StartSource.Type;
/** Server-owned targets of the currently allowed recovery actions; clients never derive them. */
export const RecoveryTarget = Schema.Struct({
  /** Step where Retry admits a new attempt (with a new thread). */
  retryNodeId: Schema.NullOr(Id),
  /** Attempt whose retained native session Resume continues. */
  resumeAttemptId: Schema.NullOr(Schema.String),
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
  /** Why an unresolved run stopped. Absent on runs recorded before stop kinds were kept. */
  stop: Schema.optional(
    Schema.NullOr(Schema.Struct({ kind: StopKind, attemptId: Schema.NullOr(Schema.String) })),
  ),
  gate: Schema.NullOr(
    Schema.Struct({ nodeId: Id, revision: Schema.Int, reviewId: Schema.NullOr(Schema.String) }),
  ),
  allowedActions: Schema.Array(
    Schema.Literals(["cancel", "retry", "resume", "approve", "request-changes"]),
  ),
  createdAt: Schema.Number,
  /** Absent on runs persisted before start sources were recorded. */
  source: Schema.optional(StartSource),
  /** Read-time field; present on every displayed run. */
  recovery: Schema.optional(RecoveryTarget),
  /**
   * Read-time field: gate decisions left out of `allowedActions` because their authored route
   * would be diverted, with the step it leads to and why.
   */
  withheld: Schema.optional(
    Schema.Array(
      Schema.Struct({
        action: Schema.Literals(["approve", "request-changes"]),
        to: Id,
        repeat: Schema.Boolean,
        cause: Schema.Literals(["visit-limit", "automation-stopped"]),
      }),
    ).check(Schema.isMaxLength(2)),
  ),
  /** Read-time totals over the complete snapshot, independent of the loaded history page. */
  overview: Schema.optional(
    Schema.Struct({
      visits: Schema.Int,
      completedVisits: Schema.Int,
      activeAttempts: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          nodeId: Id,
          branchId: Schema.NullOr(Id),
          generation: Schema.Int,
          threadId: Schema.NullOr(ThreadId),
          phase: Attempt.fields.phase,
        }),
      ).check(Schema.isMaxLength(limits.activeAttempts)),
      /**
       * The newest review generation with its complete required branch set, so a join's
       * progress never depends on the loaded history page.
       */
      review: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          fork: Id,
          generation: Schema.Int,
          head: Schema.String,
          pullRequest: PluginPullRequestRef,
          required: Schema.Int,
          reported: Schema.Int,
          settled: Schema.Int,
          result: ReviewSet.fields.result,
          cause: ReviewSet.fields.cause,
          branches: Schema.Array(ReviewBranch).check(Schema.isMaxLength(32)),
        }),
      ),
    }),
  ),
  /** Routing records of this page's visits that are not on the loaded route-history page. */
  relatedTrace: Schema.optional(Schema.Array(Trace).check(Schema.isMaxLength(limits.relatedTrace))),
  history: Schema.optional(
    Schema.Struct({
      /** First visit on this page; `tail` when it is the newest page. */
      offset: Schema.Int,
      tail: Schema.Boolean,
      /** Route history pages independently of visits. */
      traceOffset: Schema.optional(Schema.Int),
      traceTail: Schema.optional(Schema.Boolean),
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
  source: Run.fields.source,
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
export const AttentionInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** Only this project's runs; omitted, every project in the environment. */
  projectId: Schema.optional(ProjectId),
  /** Continue after this run (newest first); omitted, the newest page. */
  before: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** Newest runs to return; omitted, one page. Loading older runs raises it. */
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: limits.attentionRunsMax })),
  ),
});
export type AttentionInput = typeof AttentionInput.Type;
/** One thing a person must do for a run, with the exact place to do it. */
export const AttentionItem = Schema.Struct({
  /** Stable while the underlying condition lasts. */
  id: Schema.String,
  kind: AttentionKind,
  /** Step (and reviewer) label from the run's snapshot. */
  title: Schema.String,
  nodeId: Id,
  branchId: Schema.NullOr(Id),
  attemptId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  /** The gate revision a decision is bound to (needs-review only). */
  gateRevision: Schema.NullOr(Schema.Int),
  /** A pending native request and its place in that thread's native queue (1 = answered next). */
  request: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.String,
      position: Schema.Int,
      pending: Schema.Int,
      createdAt: Schema.Number,
    }),
  ),
});
export type AttentionItem = typeof AttentionItem.Type;
export const AttentionRun = Schema.Struct({
  runId: Schema.String,
  projectId: ProjectId,
  workflowTitle: Schema.String,
  state: Run.fields.state,
  revision: Schema.Int,
  createdAt: Schema.Number,
  allowedActions: Run.fields.allowedActions,
  items: Schema.Array(AttentionItem).check(Schema.isMaxLength(limits.attentionItems)),
  /** Items of this run, including any beyond the listed ones. */
  itemTotal: Schema.Int,
});
export type AttentionRun = typeof AttentionRun.Type;
export const AttentionPage = Schema.Struct({
  /** Distinct runs needing attention in scope, independent of this page. */
  total: Schema.Int,
  runs: Schema.Array(AttentionRun).check(Schema.isMaxLength(limits.attentionRunsMax)),
  /** Cursor of the next older page; null on the last page. */
  before: Schema.NullOr(Schema.String),
});
export type AttentionPage = typeof AttentionPage.Type;
/**
 * A located validation result. `control` names the inspector control that repairs it,
 * relative to the node (for example `instruction`, `next` or `report.fields.0`).
 */
export const Problem = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  message: Schema.String,
  nodeId: Schema.optional(Schema.String),
  control: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type Problem = typeof Problem.Type;
export const CatalogEntry = Schema.Struct({
  source: Schema.String,
  definition: Schema.NullOr(Definition),
  runnable: Schema.Boolean,
  /** Blocking reasons, preserved verbatim from the parser and validators. */
  reasons: Schema.Array(Schema.String),
  problems: Schema.optional(Schema.Array(Problem)),
});
export type CatalogEntry = typeof CatalogEntry.Type;
const sourceText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
/** SHA-256 of a catalog source's content; repairs and protected values are bound to it. */
const fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const LibraryInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type LibraryInput = typeof LibraryInput.Type;
export const LibraryEntry = Schema.Struct({
  source: Schema.String,
  packaged: Schema.Boolean,
  fingerprint,
  definitionId: Schema.NullOr(Id),
  title: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(Schema.Int),
  summary: Schema.NullOr(
    Schema.Struct({
      steps: Schema.Int,
      agents: Schema.Int,
      reviewers: Schema.Int,
      checks: Schema.Int,
      decisions: Schema.Int,
      humanGates: Schema.Int,
      ends: Schema.Int,
    }),
  ),
  runnable: Schema.Boolean,
  duplicate: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  problems: Schema.Array(Problem),
});
export type LibraryEntry = typeof LibraryEntry.Type;
export const LibraryPage = Schema.Struct({
  entries: Schema.Array(LibraryEntry),
  /** Entries matching the query across the entire catalog, not only this page. */
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});
export type LibraryPage = typeof LibraryPage.Type;
/**
 * Authoring view of one source. Authored text the host would redact is replaced by a
 * whole-string placeholder bound to the source fingerprint; saving restores it on the server.
 */
export const AuthoringEntry = Schema.Struct({
  source: Schema.String,
  packaged: Schema.Boolean,
  fingerprint,
  definition: Schema.NullOr(Definition),
  runnable: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  problems: Schema.Array(Problem),
  duplicate: Schema.Boolean,
  /** Canonical YAML of the authoring definition, or the file text when it is invalid. */
  text: Schema.String,
  protectedValues: Schema.Int,
  /** False when protected text could not be represented by placeholders (unparseable YAML). */
  lossless: Schema.Boolean,
});
export type AuthoringEntry = typeof AuthoringEntry.Type;
export const ReadInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  source: sourceText,
});
export type ReadInput = typeof ReadInput.Type;
/** Replace exactly one authored file whose content still has the observed fingerprint. */
export const ReplaceInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  source: sourceText,
  fingerprint,
  definition: Definition,
});
export type ReplaceInput = typeof ReplaceInput.Type;
export const ProviderCapability = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  /** Whether this provider can submit the structured report every graph agent requires. */
  reporting: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  runtimeModes: Schema.Array(RuntimeMode),
  models: Schema.Array(PluginProviderModel),
});
export type ProviderCapability = typeof ProviderCapability.Type;
export const NodeKind = Schema.Literals([
  "agent",
  "check",
  "decision",
  "parallel",
  "join",
  "human",
  "end",
]);
export type NodeKind = typeof NodeKind.Type;
export const Capabilities = Schema.Struct({
  /** Node kinds this backend validates and executes. */
  nodeKinds: Schema.Array(NodeKind),
  providers: Schema.Array(ProviderCapability),
  discoveryError: Schema.NullOr(Schema.String),
});
export type Capabilities = typeof Capabilities.Type;
export const SkillsInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
});
export const Skill = Schema.Struct({
  name: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  description: Schema.NullOr(Schema.String),
  enabled: Schema.Boolean,
});
export type Skill = typeof Skill.Type;
export const ProjectSummary = Schema.Struct({ id: ProjectId, title: Schema.String });
export type ProjectSummary = typeof ProjectSummary.Type;
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
  /** First visit of a history page; omitted, the newest page (or `attemptId`'s page). */
  historyOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Opens the visit page containing this attempt when no offset is given. */
  attemptId: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  /** First entry of a route-history page; omitted, the newest entries. */
  traceOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type RunInput = typeof RunInput.Type;
/** Bounded free-form task text recorded as the run input; the server owns its field name. */
export const taskLimit = 4_000;
export const StartSavedInput = Schema.Struct({
  ...ScopeInput.fields,
  /** One immutable identity per start intent; retries return the run it created. */
  clientRequestId: key,
  definitionId: Id,
  /** The saved revision the user reviewed; a different current revision is a conflict. */
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  task: Schema.String.check(Schema.isMaxLength(taskLimit)),
  workspace: Schema.Literals(["new-worktree", "current"]),
});
export type StartSavedInput = typeof StartSavedInput.Type;
export const PreviewInput = Schema.Struct({ ...ScopeInput.fields, definitionId: Id });
export type PreviewInput = typeof PreviewInput.Type;
/** What a start would run: the saved snapshot's identity, providers and workspace. */
export const StartPreview = Schema.Struct({
  definitionId: Id,
  title: Schema.String,
  revision: Schema.Int,
  source: Schema.String,
  packaged: Schema.Boolean,
  runnable: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  agents: Schema.Array(
    Schema.Struct({
      nodeId: Id,
      branchId: Schema.NullOr(Id),
      title: Schema.String,
      providerInstanceId: Schema.String,
      providerName: Schema.NullOr(Schema.String),
      model: Schema.String,
      runtimeMode: RuntimeMode,
      interactionMode: Schema.Literals(["default", "plan"]),
      skill: Schema.NullOr(Schema.String),
    }),
  ).check(Schema.isMaxLength(limits.nodes * 32)),
  workspace: Schema.Struct({
    path: Schema.String,
    branch: Schema.NullOr(Schema.String),
    head: Schema.NullOr(Schema.String),
  }),
});
export type StartPreview = typeof StartPreview.Type;
export const ThreadInput = Schema.Struct({ ...ScopeInput.fields, threadId: ThreadId });
export type ThreadInput = typeof ThreadInput.Type;
/** Historical owner of a native thread: the exact run and attempt it was launched for. */
export const ThreadLink = Schema.Struct({
  runId: Schema.String,
  attemptId: Schema.String,
  nodeId: Id,
  branchId: Schema.NullOr(Id),
  generation: Schema.Int,
  workflowTitle: Schema.String,
  nodeTitle: Schema.String,
  runState: Run.fields.state,
  phase: Attempt.fields.phase,
  reportAccepted: Schema.Boolean,
});
export type ThreadLink = typeof ThreadLink.Type;
export const CommandInput = Schema.Struct({
  ...RunInput.fields,
  clientRequestId: key,
  expectedRevision: Schema.Int,
});
export type CommandInput = typeof CommandInput.Type;
export const GateInput = Schema.Struct({
  ...CommandInput.fields,
  decision: Schema.Literals(["approve", "request-changes"]),
});
export type GateInput = typeof GateInput.Type;
export const SaveInput = Schema.Struct({
  ...ScopeInput.fields,
  definition: Definition,
  expectedRevision: Schema.NullOr(Schema.Int),
  /** Observed content of the authored source; an external edit since then conflicts. */
  fingerprint: Schema.optional(fingerprint),
});
export type SaveInput = typeof SaveInput.Type;
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
  save: Rpc.make("plugins.workflows.save", { payload: SaveInput, success: AuthoringEntry, error }),
  library: Rpc.make("plugins.workflows.library", {
    payload: LibraryInput,
    success: LibraryPage,
    error,
  }),
  read: Rpc.make("plugins.workflows.read", { payload: ReadInput, success: AuthoringEntry, error }),
  replace: Rpc.make("plugins.workflows.replace", {
    payload: ReplaceInput,
    success: AuthoringEntry,
    error,
  }),
  capabilities: Rpc.make("plugins.workflows.capabilities", {
    payload: ScopeInput,
    success: Capabilities,
    error,
  }),
  skills: Rpc.make("plugins.workflows.skills", {
    payload: SkillsInput,
    success: Schema.Array(Skill),
    error,
  }),
  projects: Rpc.make("plugins.workflows.projects", {
    payload: Schema.Struct({ environmentId: EnvironmentId }),
    success: Schema.Array(ProjectSummary),
    error,
  }),
  start: Rpc.make("plugins.workflows.start", { payload: StartInput, success: Run, error }),
  preview: Rpc.make("plugins.workflows.preview", {
    payload: PreviewInput,
    success: StartPreview,
    error,
  }),
  launch: Rpc.make("plugins.workflows.launch", {
    payload: StartSavedInput,
    success: Run,
    error,
  }),
  watch: Rpc.make("plugins.workflows.watch", {
    payload: RunInput,
    success: Run,
    error,
    stream: true,
  }),
  thread: Rpc.make("plugins.workflows.thread", {
    payload: ThreadInput,
    success: Schema.NullOr(ThreadLink),
    error,
    stream: true,
  }),
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
  attention: Rpc.make("plugins.workflows.attention", {
    payload: AttentionInput,
    success: AttentionPage,
    error,
    stream: true,
  }),
  // One-shot read of the same model for agents, scripts and tests; pages use `attention`.
  attentionPage: Rpc.make("plugins.workflows.attention-page", {
    payload: AttentionInput,
    success: AttentionPage,
    error,
  }),
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
  [rpcs.library._tag]: AuthOrchestrationReadScope,
  [rpcs.read._tag]: AuthOrchestrationReadScope,
  [rpcs.replace._tag]: AuthOrchestrationOperateScope,
  [rpcs.capabilities._tag]: AuthOrchestrationReadScope,
  [rpcs.skills._tag]: AuthOrchestrationReadScope,
  [rpcs.projects._tag]: AuthOrchestrationReadScope,
  [rpcs.start._tag]: AuthOrchestrationOperateScope,
  [rpcs.preview._tag]: AuthOrchestrationReadScope,
  [rpcs.launch._tag]: AuthOrchestrationOperateScope,
  [rpcs.watch._tag]: AuthOrchestrationReadScope,
  [rpcs.thread._tag]: AuthOrchestrationReadScope,
  [rpcs.get._tag]: AuthOrchestrationReadScope,
  [rpcs.list._tag]: AuthOrchestrationReadScope,
  [rpcs.subscribe._tag]: AuthOrchestrationReadScope,
  [rpcs.reconcile._tag]: AuthOrchestrationReadScope,
  [rpcs.cancel._tag]: AuthOrchestrationOperateScope,
  [rpcs.retry._tag]: AuthOrchestrationOperateScope,
  [rpcs.resume._tag]: AuthOrchestrationOperateScope,
  [rpcs.gate._tag]: AuthOrchestrationOperateScope,
  [rpcs.attention._tag]: AuthOrchestrationReadScope,
  [rpcs.attentionPage._tag]: AuthOrchestrationReadScope,
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
    "pages",
    "navigation",
    "project-actions",
  ],
  server: {
    tools: ["plugin_workflows_report"],
    api: Object.values(rpcs).map((rpc) => rpc._tag),
    scheduleTargets: ["workflows.start"],
  },
  web: {
    pages: ["workflows.library", "workflows.editor", "workflows.runs", "workflows.attention"],
    navigation: ["workflows.navigation", "workflows.attention-navigation"],
    projectActions: ["workflows.project", "workflows.project-run"],
    threadContext: ["workflows.thread"],
  },
} satisfies PluginManifest;

export interface WorkflowPermissions {
  readonly save: boolean;
  readonly replace: boolean;
  readonly start: boolean;
  readonly cancel: boolean;
  readonly retry: boolean;
  readonly resume: boolean;
  readonly gate: boolean;
}
export type RunCommand = Omit<CommandInput, "environmentId">;
type Scoped<I> = Omit<I, "environmentId">;
/** Environment-bound client the host supplies to workflow pages; rejections carry `_tag`/`message`. */
export interface WorkflowClient {
  readonly subscribePermissions: (
    onPermissions: (permissions: WorkflowPermissions) => void,
  ) => () => void;
  readonly projects: () => Promise<ReadonlyArray<ProjectSummary>>;
  readonly library: (input: Scoped<LibraryInput>) => Promise<LibraryPage>;
  readonly read: (input: Scoped<ReadInput>) => Promise<AuthoringEntry>;
  readonly validate: (input: {
    readonly projectId: ProjectId;
    readonly definition: Definition;
  }) => Promise<CatalogEntry>;
  readonly save: (input: Scoped<SaveInput>) => Promise<AuthoringEntry>;
  readonly replace: (input: Scoped<ReplaceInput>) => Promise<AuthoringEntry>;
  readonly capabilities: (projectId: ProjectId) => Promise<Capabilities>;
  readonly skills: (input: {
    readonly projectId: ProjectId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Promise<ReadonlyArray<Skill>>;
  readonly preview: (input: Scoped<PreviewInput>) => Promise<StartPreview>;
  readonly startSaved: (input: Scoped<StartSavedInput>) => Promise<Run>;
  readonly runs: (input: Scoped<typeof RunListInput.Type>) => Promise<ReadonlyArray<RunSummary>>;
  /** Latest runs of one project, live; returns the unsubscribe function. */
  readonly subscribeRuns: (
    projectId: ProjectId,
    onRuns: (runs: ReadonlyArray<RunSummary>) => void,
    onError: (message: string) => void,
  ) => () => void;
  /** One run, live, whether or not it is among the latest; returns the unsubscribe function. */
  readonly watchRun: (
    input: Scoped<RunInput>,
    onRun: (run: Run) => void,
    onError: (message: string) => void,
  ) => () => void;
  /** The thread's owning run and attempt, live; returns the unsubscribe function. */
  readonly watchThread: (
    input: Scoped<ThreadInput>,
    onLink: (link: ThreadLink | null) => void,
    onError: (message: string) => void,
  ) => () => void;
  /** The newest `limit` runs needing attention, live; returns the unsubscribe function. */
  readonly subscribeAttention: (
    input: { readonly projectId: ProjectId | null; readonly limit: number },
    onPage: (page: AttentionPage) => void,
    onError: (message: string) => void,
  ) => () => void;
  readonly cancel: (input: RunCommand) => Promise<Run>;
  readonly retry: (input: RunCommand) => Promise<Run>;
  readonly resume: (input: RunCommand) => Promise<Run>;
  readonly gate: (
    input: RunCommand & { readonly decision: "approve" | "request-changes" },
  ) => Promise<Run>;
}

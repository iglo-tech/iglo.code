import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ScheduledTaskSchedule, ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ModelSelection,
  RuntimeMode,
  ScheduledTaskSchedule,
};

export const PLUGIN_HOST_VERSION = 1;
export const PluginId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/));
export const PluginContributionId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z][a-z0-9_.-]{0,127}$/),
);
export const PluginHostCapability = Schema.Literals([
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
  "pages",
  "navigation",
  "project-actions",
  "thread-context",
  "attention",
]);
export type PluginHostCapability = typeof PluginHostCapability.Type;

export const PluginManifest = Schema.Struct({
  id: PluginId,
  displayName: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  hostVersion: Schema.Int,
  requiredCapabilities: Schema.Array(PluginHostCapability),
  server: Schema.Struct({
    tools: Schema.Array(PluginContributionId),
    api: Schema.Array(PluginContributionId),
    scheduleTargets: Schema.Array(PluginContributionId),
  }),
  web: Schema.Struct({
    pages: Schema.Array(PluginContributionId),
    navigation: Schema.Array(PluginContributionId),
    projectActions: Schema.Array(PluginContributionId),
    threadContext: Schema.Array(PluginContributionId),
  }),
});
export type PluginManifest = typeof PluginManifest.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  pluginId: Schema.String,
  code: Schema.Literals([
    "validation",
    "unsupported",
    "unauthorized",
    "unavailable",
    "conflict",
    "service",
    "storage",
  ]),
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const PluginProviderToolCapability = Schema.Struct({
  driver: Schema.String,
  connectionMode: Schema.Literals(["managed", "external"]),
  supported: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type PluginProviderToolCapability = typeof PluginProviderToolCapability.Type;

export const PluginDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  manifest: PluginManifest,
  status: Schema.Literals(["available", "unavailable", "incompatible"]),
  reason: Schema.NullOr(Schema.String),
});
export type PluginDescriptor = typeof PluginDescriptor.Type;
export const PluginCatalog = Schema.Struct({
  environmentId: EnvironmentId,
  hostVersion: Schema.Int,
  plugins: Schema.Array(PluginDescriptor),
  providerTools: Schema.Array(PluginProviderToolCapability),
});
export type PluginCatalog = typeof PluginCatalog.Type;

export const PluginProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  isCustom: Schema.Boolean,
  optionDescriptors: Schema.Array(ProviderOptionDescriptor),
});
export type PluginProviderModel = typeof PluginProviderModel.Type;
/** Environment-owned provider capability; `toolsSupported` means plugin reporting can be injected. */
export const PluginProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: Schema.String,
  displayName: Schema.optional(Schema.String),
  toolsSupported: Schema.Boolean,
  available: Schema.optional(Schema.Boolean),
  reason: Schema.NullOr(Schema.String),
  runtimeModes: Schema.Array(RuntimeMode),
  models: Schema.optional(Schema.Array(PluginProviderModel)),
});
export type PluginProvider = typeof PluginProvider.Type;

export const PluginTarget = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type PluginTarget = typeof PluginTarget.Type;
export const PluginPullRequestRef = Schema.Struct({
  projectId: ProjectId,
  repository: TrimmedNonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  host: Schema.optional(TrimmedNonEmptyString),
});
export type PluginPullRequestRef = typeof PluginPullRequestRef.Type;
/** Small selection carried by server and client links; each plugin validates its meaning. */
export const PluginPageState = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/)),
  Schema.String.check(Schema.isMaxLength(256)),
).check(Schema.isMaxProperties(8));
export type PluginPageState = typeof PluginPageState.Type;
export const PluginPageLink = Schema.Struct({
  pageId: PluginContributionId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  state: Schema.optional(PluginPageState),
});
export type PluginPageLink = typeof PluginPageLink.Type;
export const PluginAttentionItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  severity: Schema.Literals(["info", "warning", "error"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  link: PluginPageLink,
});
export type PluginAttentionItem = typeof PluginAttentionItem.Type;
/** A plugin's bounded newest-first items with its own count of everything needing attention. */
export const PluginAttentionSummary = Schema.Struct({
  items: Schema.Array(PluginAttentionItem).check(Schema.isMaxLength(100)),
  total: NonNegativeInt,
});
export type PluginAttentionSummary = typeof PluginAttentionSummary.Type;
export const PluginAttention = Schema.Struct({
  environmentId: EnvironmentId,
  pluginId: PluginId,
  items: Schema.Array(PluginAttentionItem).check(Schema.isMaxLength(100)),
  /** Everything needing attention; absent when the plugin reports only its capped items. */
  total: Schema.optional(NonNegativeInt),
  error: Schema.optional(PluginError),
});
export type PluginAttention = typeof PluginAttention.Type;

export const PluginThreadState = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: Schema.String,
  runtimeMode: Schema.optional(RuntimeMode),
  workspacePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  preparationId: Schema.optional(Schema.String),
  nativeSession: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: Schema.String, canResume: Schema.Boolean })),
  ),
  /** Native execution order; held submissions can execute after newer runs. */
  runs: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      startedAt: Schema.optional(Schema.NullOr(Schema.Number)),
      queueHeld: Schema.optional(Schema.Boolean),
      interruptRequested: Schema.optional(Schema.Boolean),
      /** Monitor-only executions do not determine an owned operation's result. */
      resultRelevant: Schema.optional(Schema.Boolean),
      /** Correlates launch/send receipts with the execution they admitted. */
      admissionCommandId: Schema.optional(CommandId),
    }),
  ),
  resultRunId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Latest persisted completion among the native work represented by a settled result. */
  settledAt: Schema.optional(Schema.NullOr(Schema.Number)),
  outstandingWork: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  requests: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      kind: Schema.String,
      createdAt: Schema.Number,
      resolvedAt: Schema.NullOr(Schema.Number),
    }),
  ),
  checkpoints: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      commit: Schema.NullOr(Schema.String),
      /** Unknown ownership remains relevant; explicit ownership scopes recovery. */
      runId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
export type PluginThreadState = typeof PluginThreadState.Type;
export const PluginLifecycleScope = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
  afterCursor: Schema.optional(NonNegativeInt),
});
export type PluginLifecycleScope = typeof PluginLifecycleScope.Type;
export const PluginLifecycleItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    cursor: NonNegativeInt,
    replayGap: Schema.Boolean,
    threads: Schema.Array(PluginThreadState),
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    cursor: NonNegativeInt,
    projectId: ProjectId,
    threadId: ThreadId,
    event: Schema.Literals([
      "turn-settled",
      "work-changed",
      "provider-interrupted",
      "request-changed",
      "checkpoint",
      "thread-changed",
    ]),
  }),
]);
export type PluginLifecycleItem = typeof PluginLifecycleItem.Type;

export const PluginLaunchInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  commandId: CommandId,
  threadId: Schema.optional(ThreadId),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
  workspace: Schema.Union([
    Schema.Struct({ type: Schema.Literal("current") }),
    Schema.Struct({
      type: Schema.Literal("existing"),
      path: TrimmedNonEmptyString,
      branch: Schema.NullOr(Schema.String),
      // Require this commit and clean input before the first launch commits, including recovery.
      frozenHead: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({
      type: Schema.Literal("exact-ref"),
      ref: TrimmedNonEmptyString,
      branch: Schema.optional(TrimmedNonEmptyString),
    }),
  ]),
  instruction: Schema.optional(TrimmedNonEmptyString),
});
export type PluginLaunchInput = typeof PluginLaunchInput.Type;
export const PluginCommandReceipt = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  status: Schema.Literals(["accepted", "rejected"]),
  cursor: NonNegativeInt,
  error: Schema.NullOr(Schema.String),
});
export type PluginCommandReceipt = typeof PluginCommandReceipt.Type;

export const PluginScheduleInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  target: PluginContributionId,
  title: TrimmedNonEmptyString,
  projectId: ProjectId,
  schedule: ScheduledTaskUpsertSchedule,
  enabled: Schema.Boolean,
  payload: Schema.Json,
});
export type PluginScheduleInput = typeof PluginScheduleInput.Type;
export const PluginSchedule = Schema.Struct({
  ...PluginScheduleInput.fields,
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(Schema.String),
  lastOccurrenceId: Schema.NullOr(Schema.String),
  lastStatus: Schema.Literals(["never", "pending", "succeeded", "failed"]),
  lastError: Schema.NullOr(Schema.String),
});
export type PluginSchedule = typeof PluginSchedule.Type;

import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ScheduledTaskSchedule, ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export {
  CommandId,
  EnvironmentId,
  ProjectId,
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
export const PluginPageLink = Schema.Struct({
  pageId: PluginContributionId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
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
export const PluginAttention = Schema.Struct({
  environmentId: EnvironmentId,
  pluginId: PluginId,
  items: Schema.Array(PluginAttentionItem).check(Schema.isMaxLength(100)),
});
export type PluginAttention = typeof PluginAttention.Type;

export const PluginThreadState = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: Schema.String,
  workspacePath: Schema.String,
  branch: Schema.NullOr(Schema.String),
  runs: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  outstandingWork: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  requests: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String, kind: Schema.String }),
  ),
  checkpoints: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      commit: Schema.NullOr(Schema.String),
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
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  workspace: Schema.Union([
    Schema.Struct({ type: Schema.Literal("current") }),
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

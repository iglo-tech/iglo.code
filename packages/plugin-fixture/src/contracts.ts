import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  PluginError,
  EnvironmentAuthorizationError,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type PluginManifest,
} from "@t3tools/plugin-host-contract/schema";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export const manifest = {
  id: "fixture",
  displayName: "Reports",
  version: "1.0.0",
  hostVersion: 1,
  requiredCapabilities: [
    "tools",
    "client-api",
    "persistence",
    "schedules",
    "pages",
    "navigation",
    "project-actions",
    "attention",
    "thread-context",
  ],
  server: {
    tools: ["plugin_fixture_report"],
    api: [
      "plugins.fixture.list",
      "plugins.fixture.resolve",
      "plugins.fixture.subscribe",
      "plugins.fixture.schedule",
    ],
    scheduleTargets: ["fixture.reminder"],
  },
  web: {
    pages: ["fixture.reports"],
    navigation: ["fixture.navigation"],
    projectActions: ["fixture.reports-action"],
    threadContext: ["fixture.thread-reports"],
  },
} satisfies PluginManifest;

export const ReportInput = Schema.Struct({
  id: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  summary: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(240)),
});
export type ReportInput = typeof ReportInput.Type;
export const Report = Schema.Struct({
  ...ReportInput.fields,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  resolved: Schema.Boolean,
});
export type Report = typeof Report.Type;
export const ListInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  threadId: Schema.optional(ThreadId),
});
export type ListInput = typeof ListInput.Type;
export const Reports = Schema.Array(Report);
export const ResolveInput = Schema.Struct({
  environmentId: EnvironmentId,
  id: ReportInput.fields.id,
});
export type ResolveInput = typeof ResolveInput.Type;
export const ScheduleInput = Schema.Struct({
  environmentId: EnvironmentId,
  id: ReportInput.fields.id,
  everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
});
export type ScheduleInput = typeof ScheduleInput.Type;
const error = Schema.Union([PluginError, EnvironmentAuthorizationError]);
export const ListRpc = Rpc.make("plugins.fixture.list", {
  payload: ListInput,
  success: Reports,
  error,
});
export const ResolveRpc = Rpc.make("plugins.fixture.resolve", {
  payload: ResolveInput,
  success: Report,
  error,
});
export const SubscribeRpc = Rpc.make("plugins.fixture.subscribe", {
  payload: ListInput,
  success: Reports,
  error,
  stream: true,
});
export const ScheduleRpc = Rpc.make("plugins.fixture.schedule", {
  payload: ScheduleInput,
  success: Schema.Void,
  error,
});
export const RpcGroupFixture = RpcGroup.make(ListRpc, ResolveRpc, SubscribeRpc, ScheduleRpc);
export const apiScopes = {
  "plugins.fixture.list": AuthOrchestrationReadScope,
  "plugins.fixture.resolve": AuthOrchestrationOperateScope,
  "plugins.fixture.subscribe": AuthOrchestrationReadScope,
  "plugins.fixture.schedule": AuthOrchestrationOperateScope,
};

export interface FixtureClient {
  readonly list: (input: Omit<ListInput, "environmentId">) => Promise<ReadonlyArray<Report>>;
  readonly resolve: (id: string) => Promise<Report>;
  readonly schedule: (id: string, everyMs: number) => Promise<void>;
  readonly subscribe: (
    input: Omit<ListInput, "environmentId">,
    onReports: (reports: ReadonlyArray<Report>) => void,
    onError: (message: string) => void,
  ) => () => void;
}

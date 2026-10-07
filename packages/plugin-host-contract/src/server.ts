import type {
  AuthEnvironmentScope,
  Project,
  ProviderInstanceId,
  ServerProviderSkill,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Rpc from "effect/rpc/Rpc";

import type {
  PluginAttentionItem,
  PluginCommandReceipt,
  PluginError,
  PluginLaunchInput,
  PluginLifecycleItem,
  PluginLifecycleScope,
  PluginManifest,
  PluginSchedule,
  PluginScheduleInput,
  PluginTarget,
  PluginThreadState,
  EnvironmentId,
  ProjectId,
  CommandId,
} from "./schema.ts";

export interface PluginToolCaller {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: PluginTarget["threadId"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: string;
  readonly runtimeMode: RuntimeMode;
}

export class Host extends Context.Service<
  Host,
  {
    readonly environmentId: EnvironmentId;
    readonly projects: () => Effect.Effect<
      ReadonlyArray<Pick<Project, "id" | "title" | "workspaceRoot">>,
      PluginError
    >;
    readonly launch: (input: PluginLaunchInput) => Effect.Effect<PluginCommandReceipt, PluginError>;
    /** Retry a failed preparation run; use a new identity for each attempt and reuse it after a lost acknowledgement. */
    readonly retryPreparation: (
      input: PluginTarget & { readonly commandId: CommandId; readonly runId: string },
    ) => Effect.Effect<PluginCommandReceipt, PluginError>;
    readonly receipt: (
      commandId: CommandId,
    ) => Effect.Effect<PluginCommandReceipt | null, PluginError>;
    readonly inspect: (target: PluginTarget) => Effect.Effect<PluginThreadState, PluginError>;
    /** Unreleased preparation returns unavailable; retry a failed run with retryPreparation, or a preparation-only launch with launch. */
    readonly send: (
      input: PluginTarget & {
        readonly commandId: CommandId;
        readonly instruction: string;
        readonly mode: "queue" | "auto";
      },
    ) => Effect.Effect<PluginCommandReceipt, PluginError>;
    /** Cancellation stops setup and retires this plugin's pending launches when idle; explicit targets stay pinned. Recovered checkouts retain their files. */
    readonly interrupt: (
      input: PluginTarget & {
        readonly commandId: CommandId;
        readonly runId?: string;
        readonly preparationId?: string;
      },
    ) => Effect.Effect<PluginCommandReceipt | null, PluginError>;
    readonly lifecycle: (
      input: PluginLifecycleScope,
    ) => Stream.Stream<PluginLifecycleItem, PluginError>;
    readonly reconcile: (
      input: PluginLifecycleScope,
    ) => Effect.Effect<Extract<PluginLifecycleItem, { kind: "snapshot" }>, PluginError>;
    readonly providers: () => Effect.Effect<
      ReadonlyArray<{
        readonly instanceId: ProviderInstanceId;
        readonly driver: string;
        readonly toolsSupported: boolean;
        readonly reason: string | null;
        readonly runtimeModes: ReadonlyArray<RuntimeMode>;
      }>,
      PluginError
    >;
    readonly skills: (input: {
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<ReadonlyArray<ServerProviderSkill>, PluginError>;
    readonly workspace: (
      projectId: ProjectId,
    ) => Effect.Effect<
      { readonly path: string; readonly branch: string | null; readonly head: string | null },
      PluginError
    >;
    readonly resolveRef: (projectId: ProjectId, ref: string) => Effect.Effect<string, PluginError>;
    readonly verifyPullRequestHead: (
      input: import("./schema.ts").PluginPullRequestRef,
    ) => Effect.Effect<{ readonly head: string; readonly branch: string }, PluginError>;
  }
>()("@t3tools/plugin-host-contract/server/Host") {}

/** This SQL client belongs exclusively to the plugin's separate database. */
export class Storage extends Context.Service<
  Storage,
  {
    readonly directory: string;
    readonly sql: SqlClient.SqlClient;
  }
>()("@t3tools/plugin-host-contract/server/Storage") {}

export interface PluginTool {
  readonly id: string;
  readonly description: string;
  readonly input: Schema.Top & {
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  };
  readonly output: Schema.Top & {
    readonly Encoded: Schema.JsonObject;
    readonly DecodingServices: never;
    readonly EncodingServices: never;
  };
  readonly permission: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    /** Explicit permission to report private plugin state from a read-only agent. */
    readonly allowInReadOnly: boolean;
  };
  readonly invoke: (
    input: unknown,
    caller: PluginToolCaller,
  ) => Effect.Effect<unknown, PluginError>;
}

/** Erases types only after binding each schema to its typed handler. */
export const tool = <I, O, E extends Schema.JsonObject>(definition: {
  readonly id: string;
  readonly description: string;
  readonly input: Schema.Codec<I>;
  readonly output: Schema.Codec<O, E>;
  readonly permission: PluginTool["permission"];
  readonly invoke: (input: I, caller: PluginToolCaller) => Effect.Effect<O, PluginError>;
}): PluginTool => ({
  ...definition,
  invoke: (input, caller) => definition.invoke(input as I, caller),
});

export interface PluginApi {
  readonly rpc: Rpc.Any;
  readonly requiredScope: AuthEnvironmentScope;
  readonly invoke: (
    input: unknown,
  ) => Effect.Effect<unknown, PluginError> | Stream.Stream<unknown, PluginError>;
}

export interface PluginMigration {
  readonly id: number;
  readonly name: string;
  readonly run: Effect.Effect<void, PluginError, Storage>;
}

export interface PluginServices {
  readonly tools: ReadonlyArray<PluginTool>;
  readonly api: ReadonlyArray<PluginApi>;
  readonly scheduleTargets: ReadonlyArray<{
    readonly id: string;
    readonly invoke: (input: {
      readonly occurrenceId: string;
      readonly projectId: ProjectId;
      readonly payload: Schema.Json;
    }) => Effect.Effect<void, PluginError>;
  }>;
  readonly attention: Stream.Stream<ReadonlyArray<PluginAttentionItem>, PluginError>;
}

export class Schedules extends Context.Service<
  Schedules,
  {
    readonly upsert: (input: PluginScheduleInput) => Effect.Effect<PluginSchedule, PluginError>;
    readonly list: () => Effect.Effect<ReadonlyArray<PluginSchedule>, PluginError>;
    readonly delete: (id: string) => Effect.Effect<void, PluginError>;
    /** The retry identity is private to this plugin; dispatch receives a host-scoped id. */
    readonly runNow: (id: string, occurrenceId: string) => Effect.Effect<void, PluginError>;
    readonly registerDueWork: (
      run: Effect.Effect<void, PluginError>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/plugin-host-contract/server/Schedules") {}

export interface ServerPlugin {
  readonly manifest: PluginManifest;
  readonly migrations: ReadonlyArray<PluginMigration>;
  readonly acquire: Effect.Effect<
    PluginServices,
    PluginError,
    Host | Storage | Schedules | Scope.Scope
  >;
}

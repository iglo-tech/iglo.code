import {
  CommandId,
  MessageId,
  RunId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type VcsRef,
} from "@t3tools/contracts";
import { Host } from "@t3tools/plugin-host-contract/server";
import {
  PluginError,
  type PluginCommandReceipt,
  type PluginLifecycleItem,
  type PluginLifecycleScope,
  type PluginTarget,
  type PluginThreadState,
} from "@t3tools/plugin-host-contract/schema";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../../../apps/server/src/environment/ServerEnvironment.ts";
import * as Projects from "../../../apps/server/src/project/ProjectService.ts";
import * as Setup from "../../../apps/server/src/project/WorktreeSetupTracker.ts";
import * as Threads from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../../../apps/server/src/orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../../../apps/server/src/orchestration-v2/CommandReceiptStore.ts";
import * as Events from "../../../apps/server/src/persistence/OrchestrationEventStore.ts";
import * as Providers from "../../../apps/server/src/provider/ProviderRegistry.ts";
import * as Settings from "../../../apps/server/src/serverSettings.ts";
import * as Git from "../../../apps/server/src/vcs/GitVcsDriver.ts";
import * as PullRequests from "../../../apps/server/src/pullRequest/PullRequestService.ts";
import { deriveProviderInstanceConfigMap } from "../../../apps/server/src/provider/ProviderInstanceRegistryHydration.ts";
import { providerToolCapability } from "./providerPolicy.ts";
import * as LaunchCancellation from "./LaunchCancellation.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
} from "../../../apps/server/src/orchestration-v2/DispatchModeLimit.ts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestUnheldRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { delegatedTaskProgress } from "../../../apps/server/src/orchestration-v2/SubagentProjection.ts";
import * as ProcessRunner from "../../../apps/server/src/processRunner.ts";
import * as McpSessions from "../../../apps/server/src/mcp/McpProviderSession.ts";

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const fail = (operation: string, message: string, cause?: unknown) =>
  new PluginError({
    pluginId: "host",
    code: "service",
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
const normalizedEvent = (
  event: OrchestrationV2DomainEvent,
): Extract<PluginLifecycleItem, { kind: "event" }>["event"] | null => {
  switch (event.type) {
    case "run.updated":
      return ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        event.payload.status,
      )
        ? "turn-settled"
        : "work-changed";
    case "provider-turn.updated":
      return event.payload.status === "interrupted" ? "provider-interrupted" : null;
    case "runtime-request.updated":
      return "request-changed";
    case "checkpoint.captured":
      return "checkpoint";
    case "provider-thread.updated":
    case "node.updated":
    case "subagent.updated":
      return "work-changed";
    case "turn-item.updated":
      return ["command_execution", "dynamic_tool", "subagent"].includes(event.payload.type)
        ? "work-changed"
        : null;
    default:
      return event.type.startsWith("thread.") ? "thread-changed" : null;
  }
};

const make = Effect.gen(function* () {
  const environmentId = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const projects = yield* Projects.ProjectService;
  const threads = yield* Threads.ThreadManagementService;
  const launch = yield* Launch.ThreadLaunchService;
  const setup = yield* Setup.WorktreeSetupTracker;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const events = yield* Events.OrchestrationEventStore;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const git = yield* Git.GitVcsDriver;
  const pullRequests = yield* PullRequests.PullRequestService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const environment = (id: string) =>
    id === environmentId
      ? Effect.void
      : Effect.fail(
          new PluginError({
            pluginId: "host",
            code: "unavailable",
            operation: "target",
            message: "The requested environment is not this server. Reconnect to that environment.",
          }),
        );
  const project = Effect.fn("PluginHost.project")(function* (projectId: ProjectId) {
    const found = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError((cause) => fail("project", "Could not read the project.", cause)));
    if (Option.isNone(found))
      return yield* new PluginError({
        pluginId: "host",
        code: "unavailable",
        operation: "project",
        message: "The project is absent from the selected environment.",
      });
    return found.value;
  });
  const receipt = Effect.fn("PluginHost.receipt")(function* (
    commandId: CommandId,
  ): Effect.fn.Return<PluginCommandReceipt | null, PluginError> {
    const result = yield* receipts
      .getByCommandId(commandId)
      .pipe(
        Effect.mapError((cause) =>
          fail("receipt", "Could not reconcile the command receipt.", cause),
        ),
      );
    return Option.isNone(result)
      ? null
      : {
          commandId,
          threadId: result.value.threadId,
          status: result.value.status,
          cursor: result.value.resultSequence,
          error: result.value.error,
        };
  });
  const committed = Effect.fn("PluginHost.committed")(function* (commandId: CommandId) {
    const result = yield* receipt(commandId);
    if (result === null)
      return yield* fail(
        "receipt",
        "Command intent has no committed receipt. Retry with the same command identity.",
      );
    return result;
  });
  const hasNewerPreparation = (threadId: PluginTarget["threadId"], runId: string, cursor: number) =>
    sql`
      SELECT sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND sequence > ${cursor} AND application_event_version = 2
        AND event_type = 'run.updated'
        AND json_extract(payload_json, '$.id') = ${runId}
        AND json_extract(payload_json, '$.status') = 'preparing'
      LIMIT 1
    `.pipe(Effect.map((rows) => rows.length > 0));
  const inspect = Effect.fn("PluginHost.inspect")(function* (
    target: PluginTarget,
  ): Effect.fn.Return<PluginThreadState, PluginError> {
    yield* environment(target.environmentId);
    const workspace = yield* project(target.projectId);
    const records = yield* threads
      .getProjectThreadRecords(
        target,
        [
          "runs",
          "nodes",
          "messages",
          "subagents",
          "providerThreads",
          "turnItems",
          "runtimeRequests",
          "checkpoints",
        ],
        { messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PluginError({
              pluginId: "host",
              operation: "inspect",
              code:
                cause._tag === "ThreadManagementThreadNotFoundError" ? "unavailable" : "service",
              message: "The thread is unavailable in this project.",
              cause,
            }),
        ),
      );
    const runs = records.runs.toSorted((left, right) => left.ordinal - right.ordinal);
    const abandoned = new Set(
      runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
    );
    const background = derivePendingBackgroundWork({
      latestRun: latestUnheldRun(runs),
      runs,
      providerThreads: records.providerThreads,
      turnItems: records.turnItems,
      activeProviderThreadId: records.thread.activeProviderThreadId,
      pullRequests: records.thread.pullRequests,
    });
    const preparation = yield* setup.get(target.threadId);
    const preparationId =
      preparation?.phase === "running" &&
      !preparation.stages.some((stage) => stage.id === "agent" && stage.status !== "pending")
        ? preparation.preparationId
        : undefined;
    // Aggregate readiness uses the same live-work view as the normalized roster.
    const progress = delegatedTaskProgress({
      ...records,
      subagents: records.subagents.filter(
        (task) => task.runId === null || !abandoned.has(task.runId),
      ),
      providerThreads: [{ pendingBackgroundTasks: background }],
    });
    const monitorRuns = new Set(
      records.messages
        .filter((message) => message.notification?.source.kind === "monitor")
        .map((message) => message.runId),
    );
    // A stopped follow-up or rollback still invalidates an earlier result.
    const failedFollowUp = records.runs
      .filter(
        (run) =>
          !monitorRuns.has(run.id) &&
          ["failed", "cancelled", "interrupted", "rolled_back"].includes(run.status),
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    const resultRun =
      failedFollowUp && failedFollowUp.ordinal > (progress.resultRun?.ordinal ?? 0)
        ? failedFollowUp
        : progress.resultRun;
    return {
      ...target,
      resultRunId: resultRun?.id ?? null,
      title: records.thread.title,
      workspacePath: records.thread.worktreePath ?? workspace.workspaceRoot,
      branch: records.thread.branch,
      ...(preparationId === undefined ? {} : { preparationId }),
      runs: runs.map((run) => ({ id: run.id, status: run.status })),
      nativeSession: (() => {
        const current = records.providerThreads.find(
          (thread) => thread.id === records.thread.activeProviderThreadId,
        );
        return current?.nativeThreadRef?.nativeId
          ? {
              id: current.nativeThreadRef.nativeId,
              canResume: !["closed", "archived", "error"].includes(current.status),
            }
          : null;
      })(),
      outstandingWork: [
        ...(preparationId === undefined ? [] : [{ id: preparationId, status: "running" }]),
        ...(progress.state !== "result_available" &&
        runs.some((run) => !monitorRuns.has(run.id) && !abandoned.has(run.id))
          ? [{ id: `${target.threadId}:core-work`, status: progress.state }]
          : []),
        ...records.nodes
          .filter(
            (node) =>
              (node.runId === null || !abandoned.has(node.runId)) &&
              ["pending", "running", "waiting"].includes(node.status),
          )
          .map((node) => ({ id: node.id, status: node.status })),
        ...background.map((task) => ({ id: task.taskId, status: "running" })),
      ],
      requests: records.runtimeRequests.map((request) => ({
        id: request.id,
        status: request.status,
        kind: request.kind,
        createdAt: DateTime.toEpochMillis(request.createdAt),
        resolvedAt: request.resolvedAt === null ? null : DateTime.toEpochMillis(request.resolvedAt),
      })),
      checkpoints: records.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        status: checkpoint.status,
        commit: checkpoint.ref,
      })),
    };
  });
  const reconcile = Effect.fn("PluginHost.reconcile")(function* (
    input: PluginLifecycleScope,
  ): Effect.fn.Return<Extract<PluginLifecycleItem, { kind: "snapshot" }>, PluginError> {
    yield* environment(input.environmentId);
    const cursor = yield* events.latestApplicationSequence.pipe(
      Effect.mapError((cause) => fail("reconcile", "Could not read the lifecycle cursor.", cause)),
    );
    const shells = yield* threads
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => fail("reconcile", "Could not reconcile threads.", cause)));
    const matching = [...shells.threads, ...shells.archivedThreads].filter(
      (thread) =>
        (input.projectId === undefined || thread.projectId === input.projectId) &&
        (input.threadId === undefined || thread.id === input.threadId),
    );
    const snapshots = yield* Effect.forEach(matching, (thread) =>
      inspect({ environmentId, projectId: thread.projectId, threadId: thread.id }),
    );
    return { kind: "snapshot", cursor, replayGap: false, threads: snapshots };
  });
  const lifecycle: Host["Service"]["lifecycle"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const high = yield* events.latestApplicationSequence;
        const after = input.afterCursor ?? high;
        const stats = yield* events.getReplayStats({ afterSequence: after, throughSequence: high });
        const gap =
          after > high ||
          stats.eventCount > 1024 ||
          stats.rawPayloadBytes > 1_048_576 ||
          stats.eventCount < high - after;
        const snapshot = input.afterCursor === undefined || gap ? yield* reconcile(input) : null;
        const from = snapshot?.cursor ?? after;
        let deliveredCursor = from;
        const live = events
          .streamProjectedApplicationEvents({
            afterSequence: from,
            project: (event) => ({
              sequence: event.sequence,
              event:
                "event" in event
                  ? { threadId: event.event.threadId, event: normalizedEvent(event.event) }
                  : null,
            }),
          })
          .pipe(
            Stream.filter(
              (item) =>
                item.event !== null &&
                item.event.event !== null &&
                (input.threadId === undefined || item.event.threadId === input.threadId),
            ),
            Stream.mapEffect((item) =>
              Effect.gen(function* () {
                if (
                  item.event === null ||
                  item.event.event === null ||
                  item.sequence <= deliveredCursor
                )
                  return null;
                const shell = yield* Effect.result(threads.getThreadShell(item.event.threadId));
                if (shell._tag === "Failure") return yield* shell.failure;
                if (shell.success === null) {
                  // A deleted thread has no visible shell. Be explicit about the lost ownership rather than dropping its events.
                  const snapshot = yield* reconcile(input);
                  deliveredCursor = snapshot.cursor;
                  return { ...snapshot, replayGap: true } satisfies PluginLifecycleItem;
                }
                deliveredCursor = item.sequence;
                if (input.projectId !== undefined && shell.success.projectId !== input.projectId)
                  return null;
                return {
                  kind: "event",
                  cursor: item.sequence,
                  projectId: shell.success.projectId,
                  threadId: item.event.threadId,
                  event: item.event.event,
                } satisfies PluginLifecycleItem;
              }),
            ),
            Stream.filter((item) => item !== null),
            Stream.map((item): PluginLifecycleItem => item),
          );
        return snapshot === null
          ? live
          : Stream.concat(Stream.succeed({ ...snapshot, replayGap: gap }), live);
      }),
    ).pipe(
      Stream.mapError((cause) =>
        fail(
          "lifecycle",
          "Lifecycle subscription ended. Reconcile and resume with its cursor.",
          cause,
        ),
      ),
    );
  const providerList = Effect.fn("PluginHost.providers")(
    function* () {
      const current = yield* providers.getProviders;
      const configuration = yield* settings.getSettings;
      const configured = deriveProviderInstanceConfigMap(configuration);
      return current.map((provider) => {
        const config = configured[provider.instanceId]?.config;
        const external =
          (provider.driver === "opencode" || provider.driver === "opencode2") &&
          Predicate.isObject(config) &&
          "serverUrl" in config &&
          typeof config.serverUrl === "string" &&
          config.serverUrl.length > 0;
        const driver =
          provider.driver === "opencode" && provider.version?.startsWith("2.")
            ? "opencode2"
            : provider.driver;
        const capability = providerToolCapability(driver, external);
        return {
          instanceId: provider.instanceId,
          driver,
          toolsSupported: capability.supported,
          available:
            provider.enabled &&
            provider.installed &&
            provider.availability !== "unavailable" &&
            !["error", "disabled"].includes(provider.status) &&
            provider.auth.status !== "unauthenticated",
          reason:
            capability.reason ??
            (!provider.enabled
              ? "The provider is disabled."
              : !provider.installed
                ? "The provider is not installed."
                : provider.availability === "unavailable"
                  ? (provider.unavailableReason ?? "The provider driver is unavailable.")
                  : ["error", "disabled"].includes(provider.status) ||
                      provider.auth.status === "unauthenticated"
                    ? (provider.message ?? "The provider is not ready.")
                    : null),
          runtimeModes: provider.supportedRuntimeModes ?? [
            "approval-required",
            "auto-accept-edits",
            "auto",
            "full-access",
          ],
        };
      });
    },
    Effect.mapError((cause) => fail("providers", "Could not read provider capabilities.", cause)),
  );
  const resolveWorkspaceRef = (workspaceRoot: string, ref: string) =>
    git.resolveCommit({ cwd: workspaceRoot, revision: ref }).pipe(
      Effect.map((result) => result.commitSha),
      Effect.mapError((cause) =>
        fail("prepare", "The requested exact ref could not be resolved.", cause),
      ),
    );
  const findWorkspaceRef = Effect.fnUntraced(function* (
    cwd: string,
    matches: (ref: VcsRef) => boolean,
    query?: string,
  ) {
    let cursor: number | undefined;
    do {
      const page = yield* git.listRefs({
        cwd,
        refKind: "local",
        ...(query ? { query } : {}),
        ...(cursor === undefined ? { refresh: true } : { cursor }),
      });
      const found = page.refs.find(matches);
      if (found) return found;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return null;
  });
  const ownedWorkspace = Effect.fnUntraced(function* (input: {
    projectId: ProjectId;
    path: string;
  }) {
    const workspace = yield* project(input.projectId);
    const path = yield* fs.realPath(input.path);
    if (path === (yield* fs.realPath(workspace.workspaceRoot))) return;
    const owned = yield* findWorkspaceRef(
      workspace.workspaceRoot,
      (ref) => ref.worktreePath === path,
    );
    if (!owned) return yield* fail("workspace", "The workspace does not belong to this project.");
  });
  const verifyWorkspace = Effect.fnUntraced(
    function* (input: { projectId: ProjectId; path: string }) {
      yield* ownedWorkspace(input);
      const head = yield* git.resolveCommit({ cwd: input.path, revision: "HEAD" });
      const status = yield* git.status({ cwd: input.path });
      return { head: head.commitSha, clean: !status.hasWorkingTreeChanges };
    },
    Effect.mapError((cause) => fail("workspace", "Could not verify the workspace.", cause)),
  );
  return Host.of({
    environmentId,
    // Durable plugin intents belong to BoundHost, not the core adapter.
    cancelPending: () => Effect.void,
    redact: (input) =>
      Effect.gen(function* () {
        const configuration = yield* settings.getSettings;
        const secrets = new Set<string>();
        const collect = (value: unknown) => {
          if (!value || typeof value !== "object") return;
          for (const [name, item] of Object.entries(value)) {
            if (
              typeof item === "string" &&
              item.length >= 8 &&
              /(?:token|password|secret|credential|key)$/i.test(name)
            )
              secrets.add(item);
            else if (item && typeof item === "object") collect(item);
          }
          if (
            "secret" in value &&
            value.secret === true &&
            "value" in value &&
            typeof value.value === "string" &&
            value.value.length >= 8
          )
            secrets.add(value.value);
        };
        collect(configuration);
        for (const threadId of input.threadIds) {
          const session = McpSessions.readMcpProviderSession(threadId);
          if (session) {
            secrets.add(session.authorizationHeader);
            secrets.add(session.authorizationHeader.replace(/^Bearer /, ""));
          }
        }
        let text = input.text;
        for (const secret of secrets) {
          text = text.replaceAll(encodeString(secret).slice(1, -1), "[redacted]");
          text = text.replaceAll(secret, "[redacted]");
        }
        return text;
      }).pipe(Effect.mapError((cause) => fail("redact", "Could not redact known secrets.", cause))),
    receipt,
    inspect,
    reconcile,
    lifecycle,
    projects: () =>
      projects.snapshot.pipe(
        Effect.map((snapshot) =>
          snapshot.projects.map(({ id, title, workspaceRoot }) => ({ id, title, workspaceRoot })),
        ),
        Effect.mapError((cause) => fail("projects", "Could not discover projects.", cause)),
      ),
    providers: providerList,
    skills: (input) =>
      Effect.gen(function* () {
        const workspace = yield* project(input.projectId);
        const snapshots = yield* providers.refreshWorkspaceSnapshot({
          instanceId: input.providerInstanceId,
          cwd: workspace.workspaceRoot,
          fresh: true,
        });
        const found = snapshots.find(
          (provider) => provider.instanceId === input.providerInstanceId,
        );
        if (found === undefined)
          return yield* new PluginError({
            pluginId: "host",
            code: "unavailable",
            operation: "skills",
            message: "The provider is absent from this environment.",
          });
        return (
          found.workspaceSnapshots?.find((snapshot) => snapshot.cwd === workspace.workspaceRoot)
            ?.skills ?? found.skills
        );
      }),
    workspace: (projectId) =>
      project(projectId).pipe(
        Effect.flatMap((project) =>
          Effect.gen(function* () {
            const status = yield* git.status({ cwd: project.workspaceRoot });
            if (!status.isRepo) return { path: project.workspaceRoot, branch: null, head: null };
            const head = yield* git.execute({
              operation: "PluginHost.workspace.head",
              cwd: project.workspaceRoot,
              args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
              allowNonZeroExit: true,
            });
            if (head.exitCode !== 0 && head.exitCode !== 1)
              return yield* fail("workspace", "Could not read workspace revision.", head.stderr);
            return {
              path: project.workspaceRoot,
              branch: status.refName,
              head: head.exitCode === 0 ? head.stdout.trim() : null,
            };
          }),
        ),
        Effect.mapError((cause) => fail("workspace", "Could not read workspace metadata.", cause)),
      ),
    resolveRef: (projectId, ref) =>
      project(projectId).pipe(
        Effect.flatMap((project) => resolveWorkspaceRef(project.workspaceRoot, ref)),
      ),
    prepareWorkspace: (input) =>
      Effect.gen(function* () {
        const workspace = yield* project(input.projectId);
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.key))
          return yield* fail("prepare", "Invalid workspace identity.");
        const branch = `t3code/plugin-${input.key}`;
        const existing = yield* findWorkspaceRef(
          workspace.workspaceRoot,
          (ref) => ref.name === branch && ref.worktreePath !== null,
          branch,
        );
        const path =
          existing?.worktreePath ??
          (yield* git.createWorktree({
            cwd: workspace.workspaceRoot,
            refName: input.ref,
            newRefName: branch,
            path: null,
          })).worktree.path;
        const head = yield* git.resolveCommit({ cwd: path, revision: "HEAD" });
        return { path: yield* fs.realPath(path), branch, head: head.commitSha };
      }).pipe(
        Effect.mapError((cause) =>
          fail("prepare", "Could not prepare the owned workspace.", cause),
        ),
      ),
    verifyWorkspace,
    execute: (input) =>
      Effect.gen(function* () {
        yield* ownedWorkspace(input);
        const result = yield* processRunner.run({
          command: input.command,
          args: input.args,
          cwd: input.path,
          timeout: input.timeoutMs,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: 16_384,
          outputMode: "truncate",
        });
        return {
          exitCode: result.code,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }).pipe(Effect.mapError((cause) => fail("execute", "Could not execute the command.", cause))),
    verifyPullRequestHead: (input) =>
      pullRequests
        .verifyHead(input)
        .pipe(
          Effect.mapError((cause) =>
            fail("pull-request-head", "Could not verify the current pull request head.", cause),
          ),
        ),
    launch: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const limit = yield* DispatchModeLimit;
        if (
          limit !== undefined &&
          exceededDispatchModeLimit(limit, {
            runtimeMode: input.runtimeMode,
            interactionMode: limit.interactionMode,
          }) !== undefined
        )
          return yield* new PluginError({
            pluginId: "host",
            code: "unauthorized",
            operation: "launch",
            message: "The requested runtime mode is broader than the command's permission ceiling.",
          });
        const existing = yield* receipt(input.commandId);
        if (existing !== null) {
          if (existing.status !== "accepted") return existing;
          const shell = yield* threads
            .getThreadShell(existing.threadId)
            .pipe(
              Effect.mapError((cause) =>
                fail("launch", "Could not reconcile the launched thread.", cause),
              ),
            );
          // Deleted or archived targets still own their committed acknowledgement.
          // Live launches continue through preparation replay below.
          if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
            return existing;
          if (input.instruction !== undefined) {
            const records = yield* threads
              .getThreadRecords(existing.threadId, ["runs"])
              .pipe(
                Effect.mapError((cause) =>
                  fail("launch", "Could not reconcile launch preparation.", cause),
                ),
              );
            const original = records.runs.find(
              (run) => run.userMessageId === `${input.commandId}:message`,
            );
            if (
              original !== undefined &&
              (yield* hasNewerPreparation(existing.threadId, original.id, existing.cursor).pipe(
                Effect.mapError((cause) =>
                  fail("launch", "Could not reconcile launch preparation.", cause),
                ),
              ))
            )
              return existing;
          }
        }
        const workspace = yield* project(input.projectId);
        if (
          existing === null &&
          input.workspace.type === "existing" &&
          input.workspace.frozenHead !== undefined
        ) {
          const evidence = yield* verifyWorkspace({
            projectId: input.projectId,
            path: input.workspace.path,
          });
          if (evidence.head !== input.workspace.frozenHead || !evidence.clean)
            return yield* new PluginError({
              pluginId: "host",
              operation: "launch",
              code: "conflict",
              message: "The checkout differs from its frozen launch input.",
            });
        }
        const ref =
          input.workspace.type === "exact-ref"
            ? yield* resolveWorkspaceRef(workspace.workspaceRoot, input.workspace.ref)
            : null;
        const cancellation = yield* Effect.serviceOption(LaunchCancellation.LaunchCancellation);
        const launched = yield* launch
          .launch({
            commandId: input.commandId,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode:
              input.interactionMode === "plan" || limit?.interactionMode === "plan"
                ? "plan"
                : (input.interactionMode ?? limit?.interactionMode ?? "default"),
            workspaceStrategy:
              input.workspace.type === "current"
                ? { type: "root" }
                : input.workspace.type === "existing"
                  ? {
                      type: "existing_worktree",
                      worktreePath: input.workspace.path,
                      ...(input.workspace.branch === null
                        ? {}
                        : { branch: input.workspace.branch }),
                    }
                  : {
                      type: "worktree",
                      baseRef: ref!,
                      ...(input.workspace.branch === undefined
                        ? {}
                        : { branch: input.workspace.branch }),
                    },
            ...(input.instruction === undefined
              ? {}
              : {
                  initialMessage: {
                    text: input.instruction,
                    attachments: [],
                    messageId: MessageId.make(`${input.commandId}:message`),
                  },
                }),
            createdBy: "agent",
            creationSource: "mcp",
            ...(Option.isNone(cancellation)
              ? {}
              : { beforeCancel: cancellation.value.beforeCancel }),
          })
          .pipe(
            Effect.mapError((cause) =>
              fail(
                "launch",
                "Could not commit thread launch intent. Retry with the same command identity.",
                cause,
              ),
            ),
          );
        // Preparation owns the checkout until it releases the agent stage. Async setup
        // may continue afterward, but a cancellable checkout cannot own a final receipt.
        if (input.instruction === undefined) {
          const workspaceReady = () =>
            receipts.getByCommandId(CommandId.make(`${input.commandId}:workspace-ready`)).pipe(
              Effect.map(
                (stored) =>
                  Option.isSome(stored) &&
                  stored.value.status === "accepted" &&
                  stored.value.commandType === "thread.metadata.update" &&
                  stored.value.threadId === launched.threadId,
              ),
              Effect.mapError((cause) =>
                fail("launch", "Could not reconcile workspace preparation.", cause),
              ),
            );
          const current = yield* setup.get(launched.threadId);
          const completed =
            !(yield* workspaceReady()) ||
            (input.workspace.type === "exact-ref" &&
              launched.projection.thread.worktreePath === null) ||
            current?.phase === "running"
              ? yield* setup.stream(launched.threadId).pipe(
                  Stream.filter(
                    (snapshot) =>
                      snapshot !== null &&
                      (snapshot.phase !== "running" ||
                        snapshot.stages.some(
                          (stage) => stage.id === "agent" && stage.status === "done",
                        )),
                  ),
                  Stream.runHead,
                )
              : Option.fromNullishOr(current);
          const prepared = yield* threads
            .getThreadShell(launched.threadId)
            .pipe(
              Effect.mapError((cause) =>
                fail("launch", "Could not reconcile workspace preparation.", cause),
              ),
            );
          const cancelledBeforeRelease =
            Option.isSome(completed) &&
            completed.value?.phase === "cancelled" &&
            !completed.value.stages.some(
              (stage) => stage.id === "agent" && stage.status === "done",
            );
          if (
            !(yield* workspaceReady()) ||
            (input.workspace.type === "exact-ref" && prepared?.worktreePath == null) ||
            cancelledBeforeRelease
          )
            return yield* fail(
              "launch",
              Option.isSome(completed)
                ? (completed.value?.error ??
                    "The requested workspace was not prepared. Retry with the same identity.")
                : "The requested workspace was not prepared. Retry with the same identity.",
            );
        }
        return yield* committed(input.commandId);
      }),
    send: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const existing = yield* receipt(input.commandId);
        if (existing !== null) return existing;
        const preparation = yield* setup.get(input.threadId);
        const trackedBeforeRelease =
          preparation !== null &&
          !preparation.stages.some((stage) => stage.id === "agent" && stage.status === "done") &&
          !(yield* threads
            .getThreadRecords(input.threadId, ["runs"])
            .pipe(
              Effect.mapError((cause) =>
                fail("send", "Could not inspect workspace preparation.", cause),
              ),
            )).runs.some((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
        if (
          trackedBeforeRelease ||
          (yield* receipts
            .hasPendingWorkspacePreparation(input.threadId, input.commandId, true)
            .pipe(
              Effect.mapError((cause) =>
                fail("send", "Could not reconcile workspace preparation.", cause),
              ),
            ))
        )
          return yield* new PluginError({
            pluginId: "host",
            code: "unavailable",
            operation: "send",
            message:
              "Workspace preparation has not released this thread. Retry workspace preparation before sending more instructions.",
          });
        yield* threads
          .sendToThread({
            projectId: input.projectId,
            threadId: input.threadId,
            commandId: input.commandId,
            messageId: MessageId.make(`${input.commandId}:message`),
            text: input.instruction,
            attachments: [],
            mode: input.mode,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError((cause) => fail("send", "Could not commit instructions.", cause)));
        return yield* committed(input.commandId);
      }),
    retryPreparation: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        // Native retry reconciles a committed acknowledgement and schedules a
        // preparing run again after restart, without duplicating its instruction.
        yield* threads
          .getProjectThreadRecords(input, ["runs"])
          .pipe(
            Effect.mapError((cause) =>
              fail("retry-preparation", "The thread is unavailable in this project.", cause),
            ),
          );
        const existing = yield* receipt(input.commandId);
        if (existing !== null) {
          // An old acknowledgement cannot schedule a newer preparation attempt.
          // Its own transition remains replayable after restart until superseded.
          const superseding = yield* hasNewerPreparation(
            input.threadId,
            input.runId,
            existing.cursor,
          ).pipe(
            Effect.mapError((cause) =>
              fail("retry-preparation", "Could not reconcile the preparation attempt.", cause),
            ),
          );
          if (superseding) return existing;
        }
        yield* launch
          .retryPreparation({
            commandId: input.commandId,
            threadId: input.threadId,
            runId: RunId.make(input.runId),
          })
          .pipe(
            Effect.mapError((cause) =>
              fail("retry-preparation", "Could not retry workspace preparation.", cause),
            ),
          );
        return yield* committed(input.commandId);
      }),
    interrupt: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const existing = yield* receipt(input.commandId);
        if (existing !== null) return existing;
        const state = yield* inspect(input);
        if (input.runId !== undefined && input.preparationId !== undefined)
          return yield* fail("interrupt", "Choose one run or workspace preparation to interrupt.");
        const activeRun = state.runs.findLast((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        );
        const preparationId =
          input.preparationId ??
          ((input.runId === undefined && activeRun === undefined) ||
          (activeRun?.status === "preparing" &&
            (input.runId === undefined || input.runId === activeRun.id))
            ? state.preparationId
            : undefined);
        if (preparationId !== undefined) {
          if (state.preparationId === preparationId && activeRun?.status === "preparing") {
            yield* threads
              .dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(`${input.commandId}:preparing-run`),
                threadId: input.threadId,
                runId: RunId.make(activeRun.id),
                holdQueue: true,
              })
              .pipe(
                Effect.mapError((cause) =>
                  fail("interrupt", "Could not interrupt the preparing run.", cause),
                ),
              );
          }
          const cancelled = yield* setup.cancel(input.threadId, preparationId);
          if (!cancelled) {
            const current = yield* setup.get(input.threadId);
            if (
              current?.phase === "running" &&
              current.preparationId === preparationId &&
              !current.stages.some((stage) => stage.id === "agent" && stage.status !== "pending")
            )
              return yield* new PluginError({
                pluginId: "host",
                code: "unavailable",
                operation: "interrupt",
                message:
                  "Workspace cancellation could not be persisted. Retry with the same command identity.",
              });
          }
          yield* threads
            .dispatch({
              type: "thread.metadata.update",
              commandId: input.commandId,
              threadId: input.threadId,
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("interrupt", "Could not acknowledge workspace cancellation.", cause),
              ),
            );
          return yield* receipt(input.commandId);
        }
        const selected =
          input.runId === undefined
            ? (state.runs.findLast((run) =>
                ["preparing", "starting", "running", "waiting"].includes(run.status),
              ) ??
              (state.outstandingWork.length > 0
                ? state.runs.findLast((run) => run.status !== "queued")
                : undefined))
            : state.runs.find((run) => run.id === input.runId);
        if (selected === undefined) {
          if (input.runId !== undefined)
            return yield* fail("interrupt", "The requested run is not in this thread.");
          return null;
        }
        if (!["preparing", "starting", "running", "waiting"].includes(selected.status)) {
          if (
            selected.id !== state.runs.findLast((run) => run.status !== "queued")?.id ||
            selected.status === "rolled_back"
          )
            return null;
          const records = yield* threads
            .getProjectThreadRecords(input, ["runs", "providerThreads", "turnItems"])
            .pipe(
              Effect.mapError((cause) =>
                fail("interrupt", "Could not reconcile background work.", cause),
              ),
            );
          // Queued nodes remain outstanding, but only native background work
          // makes a settled run interruptible.
          if (
            derivePendingBackgroundWork({
              latestRun: records.runs.find((run) => run.id === selected.id),
              runs: records.runs,
              providerThreads: records.providerThreads,
              turnItems: records.turnItems,
              activeProviderThreadId: records.thread.activeProviderThreadId,
            }).length === 0
          )
            return null;
        }
        yield* threads
          .dispatch({
            type: "run.interrupt",
            threadId: input.threadId,
            commandId: input.commandId,
            runId: RunId.make(selected.id),
            holdQueue: true,
          })
          .pipe(
            Effect.mapError((cause) => fail("interrupt", "Could not interrupt the thread.", cause)),
          );
        return yield* receipt(input.commandId);
      }),
  });
});

export const layer = Layer.effect(Host, make).pipe(Layer.provide(ProcessRunner.layer));

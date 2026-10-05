import {
  CommandId,
  MessageId,
  RunId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import * as Environment from "../../../apps/server/src/environment/ServerEnvironment.ts";
import * as Projects from "../../../apps/server/src/project/ProjectService.ts";
import * as Threads from "../../../apps/server/src/orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../../../apps/server/src/orchestration-v2/ThreadLaunchService.ts";
import * as Receipts from "../../../apps/server/src/orchestration-v2/CommandReceiptStore.ts";
import * as Events from "../../../apps/server/src/persistence/Services/OrchestrationEventStore.ts";
import * as Providers from "../../../apps/server/src/provider/Services/ProviderRegistry.ts";
import * as Settings from "../../../apps/server/src/serverSettings.ts";
import * as Git from "../../../apps/server/src/vcs/GitVcsDriver.ts";
import * as PullRequests from "../../../apps/server/src/pullRequest/PullRequestService.ts";
import { deriveProviderInstanceConfigMap } from "../../../apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts";
import { providerToolCapability } from "./providerPolicy.ts";

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
    default:
      return event.type.startsWith("thread.") ? "thread-changed" : null;
  }
};

const make = Effect.gen(function* () {
  const environmentId = yield* (yield* Environment.ServerEnvironmentIdentity).getEnvironmentId;
  const projects = yield* Projects.ProjectService;
  const threads = yield* Threads.ThreadManagementService;
  const launch = yield* Launch.ThreadLaunchService;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const events = yield* Events.OrchestrationEventStore;
  const providers = yield* Providers.ProviderRegistry;
  const settings = yield* Settings.ServerSettingsService;
  const git = yield* Git.GitVcsDriver;
  const pullRequests = yield* PullRequests.PullRequestService;
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
  const inspect = Effect.fn("PluginHost.inspect")(function* (
    target: PluginTarget,
  ): Effect.fn.Return<PluginThreadState, PluginError> {
    yield* environment(target.environmentId);
    const workspace = yield* project(target.projectId);
    const records = yield* threads
      .getProjectThreadRecords(target, [
        "runs",
        "nodes",
        "providerThreads",
        "runtimeRequests",
        "checkpoints",
      ])
      .pipe(
        Effect.mapError((cause) =>
          fail("inspect", "The thread is unavailable in this project.", cause),
        ),
      );
    return {
      ...target,
      title: records.thread.title,
      workspacePath: records.thread.worktreePath ?? workspace.workspaceRoot,
      branch: records.thread.branch,
      runs: records.runs
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .map((run) => ({ id: run.id, status: run.status })),
      outstandingWork: [
        ...records.nodes
          .filter((node) => ["pending", "running", "waiting"].includes(node.status))
          .map((node) => ({ id: node.id, status: node.status })),
        ...records.providerThreads.flatMap((thread) =>
          (thread.pendingBackgroundTasks ?? []).map((task) => ({
            id: task.taskId,
            status: "running",
          })),
        ),
      ],
      requests: records.runtimeRequests.map((request) => ({
        id: request.id,
        status: request.status,
        kind: request.kind,
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
          reason: capability.reason,
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
  return Host.of({
    environmentId,
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
          Effect.all({
            status: git.status({ cwd: project.workspaceRoot }),
            head: git.resolveCommit({ cwd: project.workspaceRoot, revision: "HEAD" }),
          }).pipe(
            Effect.map(({ status, head }) => ({
              path: project.workspaceRoot,
              branch: status.refName,
              head: head.commitSha,
            })),
          ),
        ),
        Effect.mapError((cause) => fail("workspace", "Could not read workspace metadata.", cause)),
      ),
    resolveRef: (projectId, ref) =>
      project(projectId).pipe(
        Effect.flatMap((project) => resolveWorkspaceRef(project.workspaceRoot, ref)),
      ),
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
        }
        const workspace = yield* project(input.projectId);
        const ref =
          input.workspace.type === "exact-ref"
            ? yield* resolveWorkspaceRef(workspace.workspaceRoot, input.workspace.ref)
            : null;
        yield* launch
          .launch({
            commandId: input.commandId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: "default",
            workspaceStrategy:
              input.workspace.type === "current"
                ? { type: "root" }
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
        return yield* committed(input.commandId);
      }),
    send: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const existing = yield* receipt(input.commandId);
        if (existing !== null) return existing;
        yield* inspect(input);
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
    interrupt: (input) =>
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const existing = yield* receipt(input.commandId);
        if (existing !== null) return existing;
        yield* inspect(input);
        yield* threads
          .interruptThread({
            projectId: input.projectId,
            threadId: input.threadId,
            commandId: input.commandId,
            ...(input.runId === undefined ? {} : { runId: RunId.make(input.runId) }),
          })
          .pipe(
            Effect.mapError((cause) => fail("interrupt", "Could not interrupt the thread.", cause)),
          );
        return yield* receipt(input.commandId);
      }),
  });
});

export const layer = Layer.effect(Host, make);

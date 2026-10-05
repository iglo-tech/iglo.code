import * as NodeServices from "@effect/platform-node/NodeServices";
import { Host } from "@t3tools/plugin-host-contract/server";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PluginThreadState,
  type PluginLifecycleItem,
  type PluginCommandReceipt,
  PluginError,
  type PluginLaunchInput,
} from "@t3tools/plugin-host-contract/schema";
import { ProviderInstanceId } from "@t3tools/contracts";
import { plugin } from "@t3tools/plugin-workflows/server";
import {
  Run,
  RunSummary,
  ReportReceipt,
  rpcs,
  apiScopes,
  Definition,
  type ReportInput,
} from "@t3tools/plugin-workflows/contracts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduleTargets from "../scheduling/ScheduleTargets.ts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";

const decodeRun = Schema.decodeUnknownEffect(Run);
const decodeRuns = Schema.decodeUnknownEffect(Schema.Array(RunSummary));

/** Script the execution boundary; the registered plugin and private SQLite store are real. */
export const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "workflow-domain-" });
  const environmentId = EnvironmentId.make("workflow-test");
  const projectId = ProjectId.make("workflow-project");
  const threads = new Map<string, PluginThreadState>();
  const receipts = new Map<string, PluginCommandReceipt>();
  const launches: PluginLaunchInput[] = [];
  yield* fs.writeFileString(`${directory}/SKILL.md`, "# Code review\nReview the frozen input.");
  let skillPath = `${directory}/SKILL.md`;
  let head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  let dirty = false;
  let providerAvailable = true;
  let lostAcknowledgement = false;
  let checkExecution = Effect.succeed({
    exitCode: 0,
    timedOut: false,
    stdout: "checks pass",
    stderr: "",
  });
  const commands: string[] = [];
  const sendStarted = yield* Deferred.make<void>();
  const sendReleased = yield* Deferred.make<void>();
  let holdSend = false;
  const checkStarts = yield* Queue.unbounded<string>();
  yield* Effect.addFinalizer(() => Queue.shutdown(checkStarts));
  const host = Host.of({
    environmentId,
    cancelPending: () => Effect.void,
    redact: (input) => Effect.succeed(input.text),
    projects: () =>
      Effect.succeed([{ id: projectId, title: "Workflow", workspaceRoot: directory }]),
    providers: () =>
      Effect.succeed([
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          toolsSupported: true,
          available: providerAvailable,
          reason: null,
          runtimeModes: ["approval-required", "full-access"],
        },
      ]),
    skills: () => Effect.succeed([{ name: "code-review", path: skillPath, enabled: true }]),
    workspace: () => Effect.succeed({ path: directory, branch: "main", head }),
    resolveRef: () => Effect.succeed(head),
    prepareWorkspace: (input) =>
      Effect.succeed({ path: `${directory}/${input.key}`, branch: input.key, head: input.ref }),
    verifyWorkspace: () => Effect.succeed({ head, clean: !dirty }),
    execute: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        yield* Queue.offer(checkStarts, input.command);
        return yield* checkExecution;
      }),
    verifyPullRequestHead: () => Effect.succeed({ head, branch: "feature" }),
    receipt: (id) => Effect.succeed(receipts.get(id) ?? null),
    launch: (input) =>
      Effect.gen(function* () {
        const previous = receipts.get(input.commandId);
        if (previous) return previous;
        if (!input.threadId) return yield* Effect.die("Missing reserved thread");
        launches.push(input);
        threads.set(input.threadId, {
          environmentId,
          projectId,
          threadId: input.threadId,
          title: input.title,
          workspacePath: input.workspace.type === "existing" ? input.workspace.path : directory,
          branch: "feature",
          runs: [{ id: `${input.threadId}:run`, status: "running" }],
          outstandingWork: [],
          requests: [],
          checkpoints: [],
          nativeSession: { id: `${input.threadId}:native`, canResume: true },
        });
        const receipt: PluginCommandReceipt = {
          commandId: input.commandId,
          threadId: input.threadId,
          cursor: 1,
          status: "accepted",
          error: null,
        };
        receipts.set(input.commandId, receipt);
        if (lostAcknowledgement) {
          lostAcknowledgement = false;
          return yield* new PluginError({
            pluginId: "host",
            code: "service",
            operation: "launch",
            message: "Lost acknowledgement",
          });
        }
        return receipt;
      }),
    inspect: (target) =>
      Effect.suspend(() => {
        const state = threads.get(target.threadId);
        return state
          ? Effect.succeed(state)
          : Effect.fail(
              new PluginError({
                pluginId: "host",
                code: "unavailable",
                operation: "inspect",
                message: "Thread is unavailable",
              }),
            );
      }),
    send: (input) =>
      Effect.gen(function* () {
        const receipt = receipts.get(input.commandId);
        if (receipt) return receipt;
        if (holdSend) {
          yield* Deferred.succeed(sendStarted, undefined);
          yield* Deferred.await(sendReleased);
        }
        const state = threads.get(input.threadId)!;
        threads.set(input.threadId, {
          ...state,
          runs: [...state.runs, { id: `${input.commandId}:run`, status: "running" }],
        });
        const accepted = {
          commandId: input.commandId,
          threadId: input.threadId,
          cursor: 2,
          status: "accepted" as const,
          error: null,
        };
        receipts.set(input.commandId, accepted);
        return accepted;
      }),
    interrupt: (input) =>
      Effect.sync(() => {
        const state = threads.get(input.threadId);
        if (state)
          threads.set(input.threadId, {
            ...state,
            runs: state.runs.map((run) =>
              input.runId === undefined || input.runId === run.id
                ? { ...run, status: "interrupted" }
                : run,
            ),
          });
        return null;
      }),
    lifecycle: () => Stream.never,
    reconcile: () =>
      Effect.succeed({
        kind: "snapshot",
        cursor: 1,
        replayGap: true,
        threads: [...threads.values()],
      } satisfies PluginLifecycleItem),
  });
  const boot = Effect.fnUntraced(function* () {
    const lifetime = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(lifetime, Exit.void));
    const context = yield* Layer.build(
      Registry.layer({
        environmentId,
        directory: `${directory}/plugins`,
        plugins: [plugin],
        clientApis: new Map(
          Object.values(rpcs).map((rpc) => [
            rpc._tag,
            { rpc, requiredScope: apiScopes[rpc._tag]! },
          ]),
        ),
      }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            NodeServices.layer,
            Scheduler.layer,
            ScheduleTargets.layer,
            Layer.succeed(Host, host),
          ),
        ),
      ),
    ).pipe(Scope.provide(lifetime));
    const registry = Context.get(context, Registry.PluginRegistry);
    yield* registry.start;
    return { registry, context, close: Scope.close(lifetime, Exit.void) };
  });
  let runtime = yield* boot();
  const invoke = Effect.fnUntraced(function* (method: string, input: unknown) {
    const api = yield* runtime.registry.api(`plugins.workflows.${method}`);
    const result = api.invoke(input);
    if (!Effect.isEffect(result)) return yield* Effect.die("Expected request");
    return yield* result;
  });
  const query = (runId: string) =>
    invoke("get", { environmentId, projectId, runId }).pipe(Effect.flatMap(decodeRun));
  const reconcile = invoke("reconcile", { environmentId, projectId }).pipe(Effect.asVoid);
  const report = Effect.fnUntraced(function* (threadId: string, input: ReportInput) {
    const registered = (yield* runtime.registry.tools).find(
      (item) => item.tool.id === "plugin_workflows_report",
    )!;
    return yield* registered.tool
      .invoke(input, {
        environmentId,
        projectId,
        threadId: ThreadId.make(threadId),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: "native-session",
        runtimeMode: "approval-required",
      })
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(ReportReceipt)));
  });
  const start = (definition: Definition, clientRequestId = "start") =>
    invoke("start", {
      environmentId,
      projectId,
      clientRequestId,
      definition,
      input: {},
      workspace: { type: "current" },
    }).pipe(Effect.flatMap(decodeRun));
  return {
    environmentId,
    projectId,
    directory,
    registry: runtime.registry,
    start,
    query,
    reconcile,
    invoke,
    report,
    launches,
    commands,
    setSkillPath: (path: string) => {
      skillPath = path;
    },
    holdSend: () => {
      holdSend = true;
    },
    sendStarted: Deferred.await(sendStarted),
    releaseSend: Deferred.succeed(sendReleased, undefined),
    nextCheck: Queue.take(checkStarts),
    holdCheck: () => {
      checkExecution = Effect.never;
    },
    threads,
    restart: Effect.gen(function* () {
      yield* runtime.close;
      runtime = yield* boot();
    }),
    scheduled: (occurrenceId: string, definitionId = "sequence") =>
      Context.get(runtime.context, ScheduleTargets.ScheduleTargets).dispatch(
        { id: "workflows.start", payload: { definitionId, input: {} } },
        occurrenceId,
        projectId,
      ),
    wait: (runId: string, predicate: (run: Run) => boolean) =>
      Stream.unwrap(
        runtime.registry.api("plugins.workflows.subscribe").pipe(
          Effect.map((api) => {
            const stream = api.invoke({ environmentId, projectId });
            if (!Stream.isStream(stream)) throw new Error("Expected subscription");
            return stream;
          }),
        ),
      ).pipe(
        Stream.mapEffect((value) => decodeRuns(value)),
        Stream.flatMap((runs) => Stream.fromArray(runs)),
        Stream.filter((run) => run.id === runId),
        Stream.mapEffect(() => query(runId)),
        Stream.filter(predicate),
        Stream.take(1),
        Stream.runCollect,
        Effect.map((runs) => runs[0]!),
      ),
    setProviderAvailable: (value: boolean) => {
      providerAvailable = value;
    },
    setHead: (value: string) => {
      head = value;
    },
    setDirty: (value: boolean) => {
      dirty = value;
    },
    loseAcknowledgement: () => {
      lostAcknowledgement = true;
    },
    settle: (
      threadId: string,
      status = "completed",
      outstandingWork: PluginThreadState["outstandingWork"] = [],
    ) => {
      const state = threads.get(threadId)!;
      threads.set(threadId, {
        ...state,
        runs: state.runs.map((run) => ({ ...run, status })),
        outstandingWork,
      });
    },
  };
});
export const sequence = Schema.decodeUnknownSync(Definition)({
  version: 1,
  id: "sequence",
  revision: 1,
  title: "Sequence",
  entry: "implement",
  atLimit: "review",
  nodes: [
    {
      id: "implement",
      kind: "agent",
      title: "Implement",
      modelSelection: { instanceId: "codex", model: "fixture" },
      runtimeMode: "approval-required",
      instruction: "Implement",
      report: { fields: [{ name: "ready", type: "boolean", required: true }] },
      next: { to: "review" },
    },
    {
      id: "review",
      kind: "human",
      title: "Review",
      approve: { to: "done" },
      changes: { to: "implement", repeat: { max: 1, atLimit: "review" } },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
  ],
});
export const completed: ReportInput = {
  version: 1,
  clientRetryKey: "report",
  outcome: "completed",
  summary: "Ready",
  data: { ready: true },
  evidence: [],
};

export const parallel = Schema.decodeUnknownSync(Definition)({
  version: 1,
  id: "parallel",
  revision: 1,
  title: "Frozen review",
  entry: "reviews",
  atLimit: "review",
  nodes: [
    {
      id: "reviews",
      title: "Reviewers",
      kind: "parallel",
      pullRequest: { repository: "test/repo", number: 1 },
      branches: [
        {
          id: "code",
          title: "Code",
          skill: "code-review",
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          instruction: "Review code",
          report: {
            fields: [
              { name: "verdict", type: "enum", required: true, values: ["pass", "changes"] },
            ],
          },
        },
        {
          id: "security",
          title: "Security",
          skill: "code-review",
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          instruction: "Review security",
          report: {
            fields: [
              { name: "verdict", type: "enum", required: true, values: ["pass", "changes"] },
            ],
          },
        },
        {
          id: "ux",
          title: "UX",
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          interactionMode: "plan",
          instruction: "Review UX",
          report: {
            fields: [
              { name: "verdict", type: "enum", required: true, values: ["pass", "changes"] },
            ],
          },
        },
      ],
      next: "join",
    },
    {
      id: "join",
      title: "Wait for all",
      kind: "join",
      fork: "reviews",
      rules: [
        { when: { op: "eq", path: "result", value: "all_completed" }, route: { to: "review" } },
      ],
      otherwise: { to: "unresolved" },
    },
    {
      id: "review",
      kind: "human",
      title: "Human review",
      approve: { to: "done" },
      changes: { to: "reviews", repeat: { max: 1, atLimit: "review" } },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
    { id: "unresolved", kind: "end", title: "Unresolved", outcome: "unresolved" },
  ],
});

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { Host, type PluginServices, type ServerPlugin } from "@t3tools/plugin-host-contract/server";
import {
  PluginError,
  type PluginCommandReceipt,
  type PluginLifecycleItem,
  type PluginThreadState,
} from "@t3tools/plugin-host-contract/schema";
import { plugin as workflowPlugin } from "@t3tools/plugin-workflows/server";
import type { Run, ScheduleHistory } from "@t3tools/plugin-workflows/contracts";
import * as Registry from "@t3tools/plugin-host-adapter/registry";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Yaml from "yaml";

import * as Config from "../config.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Tasks from "../scheduledTasks/ScheduledTaskService.ts";
import { makeReplayServerConfig } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeClient, startEnvironment } from "./PluginHost.testkit.ts";

const HEAD = "a".repeat(40);
const projectId = ProjectId.make("scheduled-project");
const sequence = (revision: number, title: string) => ({
  version: 1,
  id: "sequence",
  revision,
  title,
  entry: "work",
  atLimit: "review",
  nodes: [
    {
      id: "work",
      kind: "agent",
      title: "Work",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      instruction: "Do the work",
      report: { fields: [{ name: "ready", type: "boolean", required: true }] },
      next: { to: "review" },
    },
    {
      id: "review",
      kind: "human",
      title: "Human review",
      approve: { to: "done" },
      changes: { to: "work", repeat: { max: 1, atLimit: "review" } },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
  ],
});
const reviewer = (id: string, title: string) => ({
  id,
  title,
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  instruction: `Review ${title}`,
  report: {
    fields: [{ name: "verdict", type: "enum", required: true, values: ["pass", "changes"] }],
  },
});
/** A parallel review graph, authored as in the parallel editor; scheduling does not depend on it. */
const parallelReview = {
  version: 1,
  id: "review",
  revision: 1,
  title: "Parallel review",
  entry: "reviews",
  atLimit: "gate",
  nodes: [
    {
      id: "reviews",
      kind: "parallel",
      title: "Reviewers",
      pullRequest: { repository: "test/repo", number: 1 },
      branches: [reviewer("code", "Code"), reviewer("security", "Security")],
      next: "join",
    },
    {
      id: "join",
      kind: "join",
      title: "Wait for all",
      fork: "reviews",
      rules: [
        { when: { op: "eq", path: "result", value: "all_completed" }, route: { to: "gate" } },
      ],
      otherwise: { to: "stop" },
    },
    {
      id: "gate",
      kind: "human",
      title: "Human review",
      approve: { to: "done" },
      changes: { to: "done" },
    },
    { id: "done", kind: "end", title: "Done", outcome: "completed" },
    { id: "stop", kind: "end", title: "Stopped", outcome: "unresolved" },
  ],
};

// Provider turns are replayed at the execution boundary; the scheduler, occurrence receipts,
// plugin, catalog, persistence, authorization and RPC transport are real.
const threads = new Map<string, PluginThreadState>();
const receipts = new Map<string, PluginCommandReceipt>();
type Delivery = Parameters<PluginServices["scheduleTargets"][number]["invoke"]>[0];
const deliveries: Array<Delivery> = [];
let interruptNextDispatch = false;
/** The plugin's own target, to redeliver an occurrence exactly as the host would. */
let redeliver: ((input: (typeof deliveries)[number]) => Effect.Effect<void, PluginError>) | null =
  null;
const replayed: ServerPlugin = {
  ...workflowPlugin,
  acquire: Effect.gen(function* () {
    const host = yield* Host;
    const services = yield* workflowPlugin.acquire.pipe(
      Effect.provideService(
        Host,
        Host.of({
          ...host,
          providers: () =>
            Effect.succeed([
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: "codex",
                displayName: "Codex",
                toolsSupported: true,
                available: true,
                reason: null,
                runtimeModes: ["approval-required", "full-access"],
                models: [
                  { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, optionDescriptors: [] },
                ],
              },
            ]),
          skills: () => Effect.succeed([]),
          workspace: (id) =>
            host
              .workspace(id)
              .pipe(Effect.map((value) => ({ ...value, branch: "main", head: HEAD }))),
          resolveRef: () => Effect.succeed(HEAD),
          prepareWorkspace: (input) =>
            host
              .workspace(input.projectId)
              .pipe(Effect.map((value) => ({ path: value.path, branch: input.key, head: HEAD }))),
          verifyWorkspace: () => Effect.succeed({ head: HEAD, clean: true }),
          verifyPullRequestHead: () => Effect.succeed({ head: HEAD, branch: "feature" }),
          cancelPending: () => Effect.void,
          receipt: (id) => Effect.sync(() => receipts.get(id) ?? null),
          launch: (input) =>
            Effect.sync(() => {
              const previous = receipts.get(input.commandId);
              if (previous) return previous;
              threads.set(input.threadId!, {
                environmentId: input.environmentId,
                projectId: input.projectId,
                threadId: input.threadId!,
                title: input.title,
                runtimeMode: input.runtimeMode,
                workspacePath:
                  input.workspace.type === "existing" ? input.workspace.path : "/replayed",
                branch: "main",
                runs: [{ id: `${input.threadId}:run`, status: "running" }],
                outstandingWork: [],
                requests: [],
                checkpoints: [],
                nativeSession: { id: `${input.threadId}:native`, canResume: true },
              });
              const receipt: PluginCommandReceipt = {
                commandId: input.commandId,
                threadId: input.threadId!,
                cursor: 1,
                status: "accepted",
                error: null,
              };
              receipts.set(input.commandId, receipt);
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
          interrupt: () => Effect.succeed(null),
          lifecycle: () => Stream.never,
          reconcile: () =>
            Effect.succeed({
              kind: "snapshot",
              cursor: 1,
              replayGap: true,
              threads: [...threads.values()],
            } satisfies PluginLifecycleItem),
        }),
      ),
    );
    return {
      ...services,
      // Records each delivery; one can be cut off after the plugin committed, as a crash would.
      scheduleTargets: services.scheduleTargets.map((target) => ({
        ...target,
        invoke: (input) => {
          redeliver = target.invoke;
          deliveries.push(input);
          const delivered = target.invoke(input);
          if (!interruptNextDispatch) return delivered;
          interruptNextDispatch = false;
          return delivered.pipe(Effect.andThen(Effect.interrupt));
        },
      })),
    };
  }),
};

const connect = (server: Effect.Success<ReturnType<typeof startEnvironment>>) =>
  Effect.gen(function* () {
    const environmentId = Context.get(server.context, Host).environmentId;
    const registry = Context.get(server.context, Registry.PluginRegistry);
    const reader = yield* makeClient(server.context, [AuthOrchestrationReadScope]);
    const writer = yield* makeClient(server.context, [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    const scope = { environmentId, projectId };
    return {
      environmentId,
      registry,
      reader,
      writer,
      scope,
      tasks: Context.get(server.context, Tasks.ScheduledTaskService),
      history: (scheduleId: string) =>
        reader["plugins.workflows.schedule-history"]({ ...scope, scheduleId }),
      runs: reader["plugins.workflows.list"](scope),
      get: (runId: string) => reader["plugins.workflows.get"]({ ...scope, runId }),
      reconcile: reader["plugins.workflows.reconcile"](scope),
    };
  });
const decision = (history: ScheduleHistory) =>
  history.occurrences.map((item) => [item.dispatch, item.run?.state ?? null]);

it.live(
  "schedules saved workflows through the host's controls and links each occurrence to its run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const make = (name: string) =>
          Effect.gen(function* () {
            const config: Config.ServerConfig["Service"] = {
              ...(yield* makeReplayServerConfig(name)),
              noBrowser: true,
              traceTimingEnabled: false,
            };
            const server = yield* startEnvironment(config, [replayed]);
            yield* Context.get(server.context, Projects.ProjectService).create({
              commandId: CommandId.make("scheduled-project"),
              projectId,
              title: "Same name",
              workspaceRoot: config.baseDir,
            });
            return { config, server };
          });
        const first = yield* make("workflow-scheduling");
        // A second environment with a similarly named project; nothing may reach it.
        const other = yield* make("workflow-scheduling-other");
        const directory = `${first.config.baseDir}/.t3code/workflows`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/sequence.yaml`,
          Yaml.stringify(sequence(1, "Implement and review")),
        );
        yield* fs.writeFileString(`${directory}/review.yaml`, Yaml.stringify(parallelReview));
        const scheduleId = ScheduledTaskId.make("plugin:workflows:nightly");
        const request = {
          id: "nightly",
          title: "Nightly",
          definitionId: "sequence",
          task: "Ship the release notes",
          workspace: "current" as const,
          enabled: true,
          schedule: { type: "interval" as const, everyMs: 3_600_000 },
        };
        let firstRunId = "";

        yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* connect(first.server);
            const b = yield* connect(other.server);

            // A normal prompt schedule shares the controls and keeps its own path.
            const prompt = yield* a.writer["scheduledTasks.upsert"]({
              title: "Prompt",
              prompt: "Summarize yesterday",
              enabled: true,
              schedule: { type: "interval", everyMs: 3_600_000 },
              projectId,
              workspaceStrategy: { type: "root" },
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_MODEL,
              },
              runtimeMode: "approval-required",
              interactionMode: "default",
            });
            expect(prompt.task.dispatchTarget).toBeUndefined();

            // Destination authorization: a read-only pairing cannot schedule, and a request
            // naming another environment is refused rather than redirected.
            expect(
              yield* a.reader["plugins.workflows.schedule"]({ ...a.scope, ...request }).pipe(
                Effect.flip,
              ),
            ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
            expect(
              yield* a.writer["plugins.workflows.schedule"]({
                ...request,
                environmentId: b.environmentId,
                projectId,
              }).pipe(Effect.flip),
            ).toMatchObject({ code: "unavailable" });
            expect(
              yield* b.writer["plugins.workflows.schedule"]({
                ...request,
                environmentId: b.environmentId,
                projectId,
              }).pipe(Effect.flip),
            ).toMatchObject({ code: "unavailable" });
            expect((yield* b.reader["scheduledTasks.list"]({})).tasks).toEqual([]);
            expect(
              (yield* a.reader["scheduledTasks.list"]({})).tasks.map((task) => task.id),
            ).toEqual([prompt.task.id]);

            // Create, then edit the same schedule: one row in the host's controls.
            yield* a.writer["plugins.workflows.schedule"]({ ...a.scope, ...request });
            yield* a.writer["plugins.workflows.schedule"]({
              ...a.scope,
              ...request,
              title: "Nightly notes",
              enabled: false,
            });
            const listed = (yield* a.reader["scheduledTasks.list"]({})).tasks;
            expect(listed.map((task) => task.id).sort()).toEqual(
              [prompt.task.id, scheduleId].sort(),
            );
            const saved = listed.find((task) => task.id === scheduleId)!;
            expect(saved).toMatchObject({
              title: "Nightly notes",
              enabled: false,
              nextRunAt: null,
              dispatchTarget: {
                id: "workflows.start",
                payload: {
                  definitionId: "sequence",
                  task: "Ship the release notes",
                  workspace: "current",
                },
              },
            });
            // Resume through the host's ordinary control.
            expect(
              (yield* a.writer["scheduledTasks.setEnabled"]({ id: scheduleId, enabled: true })).task
                .enabled,
            ).toBe(true);
            const empty = yield* a.history("nightly");
            expect(empty).toMatchObject({
              schedule: {
                id: "nightly",
                title: "Nightly notes",
                payload: { definitionId: "sequence", task: "Ship the release notes" },
              },
              current: { title: "Implement and review", revision: 1, runnable: true },
              occurrences: [],
              more: false,
            });
            // The other environment owns no such schedule.
            expect(
              (yield* b.reader["plugins.workflows.schedule-history"]({
                ...b.scope,
                scheduleId: "nightly",
              })).schedule,
            ).toBeNull();

            // Run now: one occurrence, one run started through the saved-workflow start.
            yield* a.writer["scheduledTasks.runNow"]({ id: scheduleId });
            const once = yield* a.history("nightly");
            expect(decision(once)).toEqual([["succeeded", "running"]]);
            const started = (yield* a.get(once.occurrences[0]!.run!.id)) as Run;
            firstRunId = started.id;
            expect(started.source).toEqual({
              trigger: "schedule",
              catalogSource: ".t3code/workflows/sequence.yaml",
            });
            expect(started.input).toEqual({ task: "Ship the release notes" });
            expect(started.workspace).toEqual({ type: "current" });
            expect(started.definition.revision).toBe(1);

            // A retried request for the same occurrence and a redelivered dispatch return it.
            yield* a.writer["scheduledTasks.runNow"]({ id: scheduleId, occurrenceId: "retry-1" });
            yield* a.writer["scheduledTasks.runNow"]({ id: scheduleId, occurrenceId: "retry-1" });
            const redelivered = deliveries.at(-1)!;
            expect(redelivered.occurrenceId).toBe("retry-1");
            yield* redeliver!(redelivered);
            const twice = yield* a.history("nightly");
            expect(twice.occurrences.map((item) => item.id)).toEqual([
              "retry-1",
              once.occurrences[0]!.id,
            ]);
            expect(new Set(twice.occurrences.map((item) => item.run?.id)).size).toBe(2);
            expect(yield* a.runs).toHaveLength(2);

            // The saved workflow changes between occurrences: the next occurrence resolves the
            // revision saved at dispatch, earlier runs keep their own snapshots.
            yield* fs.writeFileString(
              `${directory}/sequence.yaml`,
              Yaml.stringify(sequence(2, "Implement and review v2")),
            );
            // A dispatch is cut off after the plugin committed its run: the receipt stays
            // pending, and retrying its identity yields that run instead of a second one.
            interruptNextDispatch = true;
            const cut = yield* Effect.exit(
              a.tasks.runNow({ id: scheduleId, occurrenceId: "lost-ack" }),
            );
            expect(cut._tag).toBe("Failure");
            const pending = yield* a.history("nightly");
            expect(pending.occurrences[0]).toMatchObject({
              id: "lost-ack",
              dispatch: "pending",
              run: { state: "running", definition: { revision: 2 } },
            });
            expect(pending.current).toMatchObject({
              revision: 2,
              title: "Implement and review v2",
            });
            yield* a.writer["scheduledTasks.runNow"]({ id: scheduleId, occurrenceId: "lost-ack" });
            const recovered = yield* a.history("nightly");
            expect(recovered.occurrences[0]).toMatchObject({
              id: "lost-ack",
              dispatch: "succeeded",
              run: { id: pending.occurrences[0]!.run!.id },
            });
            expect(recovered.occurrences.map((item) => item.run?.definition.revision)).toEqual([
              2, 1, 1,
            ]);
            expect(yield* a.runs).toHaveLength(3);
            expect(((yield* a.get(firstRunId)) as Run).definition.revision).toBe(1);

            // The scheduled run uses the ordinary run, thread, evidence and gate paths.
            yield* a.reconcile;
            const running = (yield* a.get(firstRunId)) as Run;
            const threadId = running.attempts[0]!.threadId!;
            const link = yield* a.reader["plugins.workflows.thread"]({
              ...a.scope,
              threadId: ThreadId.make(threadId),
            }).pipe(Stream.runHead);
            expect(link._tag === "Some" ? link.value?.runId : null).toBe(firstRunId);
            const report = (yield* a.registry.tools).find(
              (item) => item.tool.id === "plugin_workflows_report",
            )!;
            yield* report.tool.invoke(
              {
                version: 1,
                clientRetryKey: "report",
                outcome: "completed",
                summary: "Notes drafted",
                data: { ready: true },
                evidence: [{ kind: "file", reference: "NOTES.md" }],
              },
              {
                environmentId: a.environmentId,
                projectId,
                threadId: ThreadId.make(threadId),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerSessionId: "native-session",
                runtimeMode: "approval-required",
              },
            );
            const state = threads.get(threadId)!;
            threads.set(threadId, {
              ...state,
              runs: state.runs.map((run) => ({ ...run, status: "completed" })),
            });
            yield* a.reconcile;
            const waiting = (yield* a.get(firstRunId)) as Run;
            expect(waiting.state).toBe("awaiting-review");
            expect(waiting.attempts[0]!.report?.summary).toBe("Notes drafted");
            expect(waiting.allowedActions).toContain("approve");
            const settled = yield* a.writer["plugins.workflows.gate"]({
              ...a.scope,
              runId: firstRunId,
              clientRequestId: "approve",
              expectedRevision: waiting.revision,
              decision: "approve",
            });
            expect(settled.state).toBe("completed");
            // Dispatch and workflow outcome stay separate facts.
            expect(decision(yield* a.history("nightly")).at(-1)).toEqual([
              "succeeded",
              "completed",
            ]);

            // A parallel review graph schedules through the same target and forks reviewers.
            yield* a.writer["plugins.workflows.schedule"]({
              ...a.scope,
              ...request,
              id: "reviews",
              title: "Reviews",
              definitionId: "review",
              task: "",
              workspace: "new-worktree",
            });
            yield* a.writer["scheduledTasks.runNow"]({
              id: ScheduledTaskId.make("plugin:workflows:reviews"),
            });
            const reviews = yield* a.history("reviews");
            yield* a.reconcile;
            const forked = (yield* a.get(reviews.occurrences[0]!.run!.id)) as Run;
            expect(forked.source?.trigger).toBe("schedule");
            expect(forked.input).toEqual({});
            expect(forked.attempts.map((attempt) => attempt.branchId).sort()).toEqual([
              "code",
              "security",
            ]);
            expect(forked.attempts.every((attempt) => attempt.threadId !== null)).toBe(true);

            // The prompt schedule still pauses and runs through its own launch path.
            yield* a.writer["scheduledTasks.setEnabled"]({ id: prompt.task.id, enabled: false });
            const ranPrompt = yield* a.writer["scheduledTasks.runNow"]({ id: prompt.task.id });
            expect(ranPrompt.task).toMatchObject({ lastRunStatus: "succeeded" });
            expect(ranPrompt.task.dispatchTarget).toBeUndefined();
            expect(
              (yield* a.reader["plugins.workflows.schedule-history"]({
                ...a.scope,
                scheduleId: prompt.task.id,
              })).schedule,
            ).toBeNull();
          }),
        );

        // Restart: the history, links and snapshot revisions are read from persisted state.
        yield* Fiber.interrupt(first.server.fiber);
        const restarted = yield* startEnvironment(first.config, [replayed]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* connect(restarted);
            const history = yield* a.history("nightly");
            expect(history.occurrences.map((item) => item.id)).toEqual([
              "lost-ack",
              "retry-1",
              expect.any(String),
            ]);
            expect(decision(history).at(-1)).toEqual(["succeeded", "completed"]);
            expect(history.occurrences.at(-1)!.run).toMatchObject({
              id: firstRunId,
              definition: { revision: 1, title: "Implement and review" },
            });
          }),
        );

        // Without the plugin the schedule is retained with an actionable unavailable target.
        yield* Fiber.interrupt(restarted.fiber);
        const removed = yield* startEnvironment(first.config, []);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const writer = yield* makeClient(removed.context, [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            const failed = yield* writer["scheduledTasks.runNow"]({ id: scheduleId }).pipe(
              Effect.flip,
            );
            expect(failed.message).toContain("Schedule target workflows.start is unavailable");
            const retained = (yield* writer["scheduledTasks.list"]({})).tasks.find(
              (task) => task.id === scheduleId,
            )!;
            expect(retained.dispatchTarget?.payload).toMatchObject({ definitionId: "sequence" });
            expect(retained.lastRunError).toContain("Its state has been retained.");
            // The host's own controls still pause it.
            expect(
              (yield* writer["scheduledTasks.setEnabled"]({ id: scheduleId, enabled: false })).task
                .enabled,
            ).toBe(false);
          }),
        );
        yield* Fiber.interrupt(removed.fiber);
        const reinstalled = yield* startEnvironment(first.config, [replayed]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const a = yield* connect(reinstalled);
            const history = yield* a.history("nightly");
            expect(history.schedule?.enabled).toBe(false);
            expect(history.occurrences[0]).toMatchObject({ dispatch: "failed", run: null });
            expect(history.occurrences[0]!.error).toContain("unavailable");
            expect(history.occurrences.slice(1).map((item) => item.run?.id)).toContain(firstRunId);
            // Delete is the host's ordinary control; runs stay in the workflow run history.
            yield* a.writer["scheduledTasks.delete"]({ id: scheduleId });
            expect((yield* a.history("nightly")).schedule).toBeNull();
            expect((yield* a.runs).map((run) => run.id)).toContain(firstRunId);
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);

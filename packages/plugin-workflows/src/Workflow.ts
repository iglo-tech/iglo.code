import {
  Host,
  Storage,
  Schedules,
  type PluginToolCaller,
} from "@t3tools/plugin-host-contract/server";
import {
  PluginError,
  type ProjectId,
  type PluginThreadState,
  type PluginTarget,
  type PluginAttentionItem,
} from "@t3tools/plugin-host-contract/schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Run,
  RunSummary,
  RunListInput,
  StartInput,
  ReportInput,
  ReportReceipt,
  CommandInput,
  GateInput,
  ScopeInput,
  RunInput,
  ScheduleInput,
  limits,
  type Attempt,
} from "./contracts.ts";
import * as Catalog from "./Catalog.ts";
import { error, protect, canonical, digest } from "./encoding.ts";
import { agents, dataProblems } from "./definition.ts";
import {
  draft,
  admit,
  reserveAttempt,
  transition,
  choose,
  unresolved,
  latestAttempt,
  terminalAttempt,
  agentFor,
  reportValues,
  reviewFromFlow,
  joinValues,
  launchInstruction,
  commandId,
  allowedActions,
  recoveryNode,
  type State,
} from "./graph.ts";

export class Workflow extends Context.Service<
  Workflow,
  {
    readonly attention: Stream.Stream<ReadonlyArray<PluginAttentionItem>, PluginError>;
    readonly start: (input: StartInput) => Effect.Effect<Run, PluginError>;
    readonly get: (input: typeof RunInput.Type) => Effect.Effect<Run, PluginError>;
    readonly list: (
      input: typeof RunListInput.Type,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, PluginError>;
    readonly subscribe: (
      input: typeof ScopeInput.Type,
    ) => Stream.Stream<ReadonlyArray<RunSummary>, PluginError>;
    readonly reconcile: (
      input: typeof ScopeInput.Type,
    ) => Effect.Effect<ReadonlyArray<RunSummary>, PluginError>;
    readonly report: (
      input: ReportInput,
      caller: PluginToolCaller,
    ) => Effect.Effect<ReportReceipt, PluginError>;
    readonly cancel: (input: typeof CommandInput.Type) => Effect.Effect<Run, PluginError>;
    readonly retry: (input: typeof CommandInput.Type) => Effect.Effect<Run, PluginError>;
    readonly resume: (input: typeof CommandInput.Type) => Effect.Effect<Run, PluginError>;
    readonly gate: (input: typeof GateInput.Type) => Effect.Effect<Run, PluginError>;
    readonly schedule: (input: typeof ScheduleInput.Type) => Effect.Effect<void, PluginError>;
    readonly scheduledStart: (input: {
      readonly projectId: ProjectId;
      readonly occurrenceId: string;
      readonly definitionId: string;
      readonly input: StartInput["input"];
    }) => Effect.Effect<Run, PluginError>;
  }
>()("@t3tools/plugin-workflows/Workflow") {}

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(Run));
const encodeRun = Schema.encodeEffect(Schema.fromJsonString(Run));
const decodeReport = Schema.decodeUnknownEffect(ReportInput);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(ReportReceipt));
const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(RunSummary));
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(RunSummary));
const decodeStart = Schema.decodeUnknownEffect(StartInput);
const activeRun = (state: PluginThreadState) =>
  state.runs.findLast((run) =>
    ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
  );
const target = (run: Run, attempt: Attempt): PluginTarget => ({
  environmentId: run.environmentId,
  projectId: run.projectId,
  threadId: attempt.threadId!,
});

/** Probe every owned admission; a busy receipt keeps settlement and cleanup pending. */
const admissionIds = (attempt: Attempt) => [
  commandId(attempt, "launch"),
  commandId(attempt, "reminder"),
  ...(attempt.resumeCount > 0 ? [commandId(attempt, "resume", attempt.resumeCount)] : []),
];

/** Charge only execution time between observations, excluding overlapping native input waits. */
const executionElapsed = (requests: PluginThreadState["requests"], from: number, until: number) => {
  let cursor = from;
  let elapsed = 0;
  for (const request of requests.toSorted((left, right) => left.createdAt - right.createdAt)) {
    const start = Math.max(from, request.createdAt);
    const end = Math.min(
      until,
      request.resolvedAt ??
        (["pending", "waiting"].includes(request.status) ? until : request.createdAt),
    );
    if (end <= cursor || start >= until) continue;
    elapsed += Math.max(0, start - cursor);
    cursor = Math.max(cursor, end);
  }
  return elapsed + Math.max(0, until - cursor);
};

const make = Effect.gen(function* () {
  const host = yield* Host;
  const { sql } = yield* Storage;
  const schedules = yield* Schedules;
  const catalog = yield* Catalog.Catalog;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const drainLock = yield* Semaphore.make(1);
  const changes = yield* PubSub.sliding<void>(1);
  let mutation = 0;
  let reconcileAfter = 0;
  let outboxAfter = 0;
  const projectVersions = new Map<string, number>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  const checks = new Map<string, Fiber.Fiber<void, PluginError>>();
  const environment = (environmentId: string) =>
    environmentId === host.environmentId
      ? Effect.void
      : Effect.fail(
          error("target", "The requested environment is not this server.", "unavailable"),
        );
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const interruptId = (attempt: Attempt) => `${attempt.id}:interrupt:${attempt.resumeCount}`;
  const load = Effect.fnUntraced(function* (id: string) {
    const [row] = yield* sql<{ data: string }>`SELECT data FROM workflow_runs WHERE id = ${id}`;
    if (!row) return yield* error("get", "The workflow run is unavailable.", "unavailable");
    return draft(yield* decodeRun(row.data));
  });
  const enqueue = Effect.fnUntraced(function* (
    run: Run,
    id: string,
    kind: string,
    attemptId: string | null = null,
  ) {
    yield* sql`INSERT OR IGNORE INTO workflow_outbox (id, run_id, attempt_id, kind, status) VALUES (${id}, ${run.id}, ${attemptId}, ${kind}, 'pending')`;
  });
  const cleanupPending = Effect.fnUntraced(function* (runId: string) {
    const [item] =
      yield* sql`SELECT id FROM workflow_outbox WHERE run_id = ${runId} AND kind = 'interrupt' AND status = 'pending' LIMIT 1`;
    return item !== undefined;
  });
  const persist = Effect.fnUntraced(function* (run: State) {
    run.revision++;
    run.allowedActions = allowedActions(run);
    if (run.gate) run.gate = { ...run.gate, revision: run.revision };
    const encoded = yield* encodeRun(run);
    yield* sql`INSERT INTO workflow_runs (id, project_id, data, state) VALUES (${run.id}, ${run.projectId}, ${encoded}, ${run.state}) ON CONFLICT(id) DO UPDATE SET data = excluded.data, state = excluded.state`;
    yield* sql`INSERT INTO workflow_events (run_id, revision, data) VALUES (${run.id}, ${run.revision}, ${canonical({ state: run.state, currentNode: run.currentNode, traceId: run.trace.at(-1)?.id ?? null, reportIds: run.attempts.filter((attempt) => attempt.report).map((attempt) => attempt.report!.receipt.id) })})`;
    for (const attempt of run.attempts)
      if (attempt.threadId)
        yield* sql`INSERT OR IGNORE INTO workflow_bindings (thread_id, run_id, attempt_id) VALUES (${attempt.threadId}, ${run.id}, ${attempt.id})`;
    if (run.state === "running") {
      for (const attempt of run.attempts)
        if (attempt.phase === "launching")
          yield* enqueue(run, `${attempt.id}:launch`, "launch", attempt.id);
      const node = run.definition.nodes.find((node) => node.id === run.currentNode)!;
      if (["decision", "parallel", "join"].includes(node.kind))
        yield* enqueue(run, `${run.id}:node:${run.visits}`, "node");
    }
    for (const attempt of run.attempts) {
      // A disposition and its pending host authority share the same private transaction.
      if (terminalAttempt(attempt) && attempt.threadId)
        yield* host.cancelPending(target(run, attempt));
      if (attempt.phase === "reminding" && !attempt.reminderSent)
        yield* enqueue(run, `${attempt.id}:reminder`, "reminder", attempt.id);
      if (["canceled", "interrupted", "unresolved", "stale"].includes(attempt.phase))
        yield* enqueue(run, interruptId(attempt), "interrupt", attempt.id);
    }
    mutation++;
    projectVersions.set(run.projectId, (projectVersions.get(run.projectId) ?? 0) + 1);
    return run;
  });
  const transaction = <A, E, R>(operation: string, action: Effect.Effect<A, E, R>) =>
    protect(
      operation,
      Effect.gen(function* () {
        const before = mutation;
        const result = yield* sql.withTransaction(action);
        if (mutation !== before) yield* notify;
        return result;
      }).pipe(lock.withPermits(1)),
    );
  const get = (input: typeof RunInput.Type) =>
    protect(
      "get",
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const run = yield* load(input.runId);
        if (run.projectId !== input.projectId)
          return yield* error("get", "The run is unavailable in this project.", "unavailable");
        return run;
      }),
    );
  // Queries page durable history; routing always reads the complete private snapshot.
  const display = Effect.fnUntraced(function* (run: Run, offset = 0, limit = 50, tail = false) {
    const page = {
      ...run,
      attempts: tail ? run.attempts.slice(-limit) : run.attempts.slice(offset, offset + limit),
      trace: tail ? run.trace.slice(-limit) : run.trace.slice(offset, offset + limit),
      reviews: tail ? run.reviews.slice(-limit) : run.reviews.slice(offset, offset + limit),
      history: {
        offset,
        tail,
        limit,
        attempts: run.attempts.length,
        trace: run.trace.length,
        reviews: run.reviews.length,
      },
    };
    const redacted = yield* host.redact({
      text: yield* encodeRun(page),
      threadIds: run.attempts.flatMap((attempt) => (attempt.threadId ? [attempt.threadId] : [])),
    });
    return yield* decodeRun(redacted).pipe(
      Effect.mapError((cause) =>
        error("display", "The redacted run could not be displayed.", "service", cause),
      ),
    );
  });
  const summarize = Effect.fnUntraced(function* (run: Run) {
    const summary = {
      id: run.id,
      environmentId: run.environmentId,
      projectId: run.projectId,
      definition: {
        id: run.definition.id,
        revision: run.definition.revision,
        title: run.definition.title.slice(0, 240).trim(),
      },
      state: run.state,
      revision: run.revision,
      currentNode: run.currentNode,
      visits: run.visits,
      automationStopped: run.automationStopped,
      reason: run.reason?.slice(0, 500) ?? null,
      gate: run.gate,
      allowedActions: run.allowedActions,
      createdAt: run.createdAt,
      attempts: run.attempts.slice(-5).map((attempt) => ({
        id: attempt.id,
        nodeId: attempt.nodeId,
        branchId: attempt.branchId,
        generation: attempt.generation,
        threadId: attempt.threadId,
        phase: attempt.phase,
        reason: attempt.reason?.slice(0, 500) ?? null,
        reportId: attempt.report?.receipt.id ?? null,
      })),
      trace: run.trace.slice(-1).map(({ id, nodeId, attemptId, sourceIds, chosen, reason }) => ({
        id,
        nodeId,
        attemptId,
        sourceIds,
        chosen,
        reason: reason.slice(0, 500),
      })),
      reviews: run.reviews.slice(-1),
    };
    return yield* decodeSummary(
      yield* host.redact({
        text: yield* encodeSummary(summary),
        threadIds: run.attempts.flatMap((attempt) => (attempt.threadId ? [attempt.threadId] : [])),
      }),
    );
  });
  const list = (input: typeof RunListInput.Type) =>
    protect(
      "list",
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM workflow_runs WHERE project_id = ${input.projectId} AND (${input.before ?? null} IS NULL OR rowid < (SELECT rowid FROM workflow_runs WHERE id = ${input.before ?? null} AND project_id = ${input.projectId})) ORDER BY rowid DESC LIMIT 20`;
        return yield* Effect.forEach(rows, (row) =>
          decodeRun(row.data).pipe(Effect.flatMap(summarize)),
        );
      }),
    );
  const subscribe = (input: typeof ScopeInput.Type) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const subscription = yield* PubSub.subscribe(changes);
        let observedVersion = projectVersions.get(input.projectId) ?? 0;
        return Stream.concat(
          Stream.fromEffect(list(input)),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter(() => {
              const version = projectVersions.get(input.projectId) ?? 0;
              if (version === observedVersion) return false;
              observedVersion = version;
              return true;
            }),
            Stream.mapEffect(() => list(input)),
          ),
        );
      }),
    );
  const attentionItems = protect(
    "attention",
    Effect.gen(function* () {
      const rows = yield* sql<{
        data: string;
      }>`SELECT data FROM workflow_runs WHERE state IN ('awaiting-review', 'unresolved') OR (state = 'running' AND EXISTS (SELECT 1 FROM json_each(workflow_runs.data, '$.attempts') WHERE json_extract(value, '$.phase') = 'waiting-input')) ORDER BY rowid LIMIT 100`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const run = yield* decodeRun(row.data);
          const threadIds = run.attempts.flatMap((attempt) =>
            attempt.threadId ? [attempt.threadId] : [],
          );
          const reason = yield* host.redact({
            text:
              run.reason ??
              (run.state === "awaiting-review"
                ? "The workflow needs a human decision."
                : "Native execution requires your input."),
            threadIds,
          });
          const summary = yield* host.redact({ text: run.definition.title, threadIds });
          const relatedThread =
            run.attempts.find((attempt) => attempt.phase === "waiting-input")?.threadId ??
            run.attempts.at(-1)?.threadId;
          return {
            id: run.id,
            summary: summary.slice(0, 240).trim(),
            severity: "warning" as const,
            reason: reason.slice(0, 500).trim(),
            link: {
              pageId: "workflows.runs",
              projectId: run.projectId,
              ...(relatedThread ? { threadId: relatedThread } : {}),
            },
          };
        }),
      );
    }),
  );
  const attention = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(attentionItems),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => attentionItems)),
      );
    }),
  );
  const snapshots = Effect.fnUntraced(function* (
    projectId: ProjectId,
    definition: Run["definition"],
  ) {
    const result: Record<string, Run["skills"][string]> = {};
    const providers = yield* host.providers();
    for (const agent of agents(definition))
      if (agent.skill) {
        const skill = (yield* host.skills({
          projectId,
          providerInstanceId: agent.modelSelection.instanceId,
        })).find((skill) => skill.name === agent.skill && skill.enabled);
        if (!skill) return yield* error("skill", `Skill ${agent.skill} is unavailable.`);
        const file = yield* fs.readFileString(skill.path).pipe(Effect.result);
        result[`${agent.modelSelection.instanceId}:${agent.skill}`] = {
          name: skill.name,
          invocation:
            providers.find((provider) => provider.instanceId === agent.modelSelection.instanceId)
              ?.driver === "claudeAgent"
              ? `/${skill.name}`
              : providers.find(
                    (provider) => provider.instanceId === agent.modelSelection.instanceId,
                  )?.driver === "opencode2"
                ? `Call your native skill tool with name ${skill.name}.`
                : `$${skill.name}`,
          path: skill.path,
          fingerprint: file._tag === "Success" ? digest(file.success) : null,
          limitation:
            file._tag === "Success"
              ? null
              : "The provider exposes no readable source fingerprint; this is an input snapshot, not a version lock.",
        };
      }
    return result;
  });
  const verifyProvider = Effect.fnUntraced(function* (
    run: Run,
    attempt: Attempt,
    operation: "launch" | "resume",
  ) {
    const agent = agentFor(run, attempt)!;
    const providers = yield* host.providers();
    if (
      !providers.some(
        (provider) =>
          provider.instanceId === agent.modelSelection.instanceId &&
          provider.toolsSupported &&
          provider.available === true &&
          provider.runtimeModes.includes(agent.runtimeMode),
      )
    )
      return yield* error(operation, "Reporting-tool capability is unavailable.", "unsupported");
  });
  const verifyResumeSession = Effect.fnUntraced(function* (run: Run, attempt: Attempt) {
    const native = yield* host.inspect(target(run, attempt));
    if (!native.nativeSession?.canResume || native.nativeSession.id !== attempt.nativeSessionId)
      return yield* error(
        "resume",
        "The retained native session changed or cannot resume.",
        "unsupported",
      );
  });
  const verifySkill = Effect.fnUntraced(function* (
    run: Run,
    attempt: Attempt,
    operation: "launch" | "resume",
  ) {
    if (!attempt.skill) return;
    const agent = agentFor(run, attempt)!;
    const skills = yield* host.skills({
      projectId: run.projectId,
      providerInstanceId: agent.modelSelection.instanceId,
    });
    const current = skills.find((skill) => skill.name === attempt.skill!.name && skill.enabled);
    const contents = current ? yield* fs.readFileString(current.path).pipe(Effect.result) : null;
    if (
      !current ||
      current.path !== attempt.skill.path ||
      (attempt.skill.fingerprint &&
        (contents?._tag !== "Success" || digest(contents.success) !== attempt.skill.fingerprint))
    )
      return yield* error(
        operation,
        "The selected skill changed or became unavailable.",
        "unsupported",
      );
  });
  const start = Effect.fn("Workflows.start")(function* (requested: StartInput) {
    const input = yield* decodeStart(requested);
    yield* environment(input.environmentId);
    const id = `workflow-${digest([input.environmentId, input.projectId, input.clientRequestId]).slice(0, 32)}`;
    const requestDigest = digest(input);
    const [previous] = yield* sql<{
      digest: string;
      result: string;
    }>`SELECT digest, result FROM workflow_commands WHERE id = ${id}`;
    if (previous) {
      if (previous.digest !== requestDigest)
        return yield* error("start", "This retry identity belongs to different input.", "conflict");
      return yield* decodeRun(previous.result);
    }
    const validation = yield* catalog.validate(input, input.definition);
    if (!validation.runnable)
      return yield* error("start", validation.reasons.join(" "), "unsupported");
    for (const agent of agents(input.definition)) {
      const names = new Set([
        ...Object.keys(input.input),
        ...(agent.bindings ?? []).map((binding) => binding.name),
      ]);
      if (names.size > limits.fields)
        return yield* error(
          "start",
          `Run input and agent bindings exceed ${limits.fields} fields.`,
        );
    }
    const skills = yield* snapshots(input.projectId, input.definition);
    const base = yield* host.workspace(input.projectId);
    const workspace = input.workspace ?? { type: "exact-ref" as const, ref: base.head ?? "HEAD" };
    if (workspace.type === "existing")
      yield* host.verifyWorkspace({ projectId: input.projectId, path: workspace.path });
    const resolvedWorkspace =
      workspace.type === "exact-ref"
        ? { ...workspace, ref: yield* host.resolveRef(input.projectId, workspace.ref) }
        : workspace;
    const now = yield* Clock.currentTimeMillis;
    return yield* transaction(
      "start",
      Effect.gen(function* () {
        const [previous] = yield* sql<{
          digest: string;
          result: string;
        }>`SELECT digest, result FROM workflow_commands WHERE id = ${id}`;
        if (previous) {
          if (previous.digest !== requestDigest)
            return yield* error(
              "start",
              "This retry identity belongs to different input.",
              "conflict",
            );
          return yield* decodeRun(previous.result);
        }
        const run: State = {
          id,
          environmentId: host.environmentId,
          projectId: input.projectId,
          definition: input.definition,
          digest: digest(input.definition),
          skills,
          input: input.input,
          state: "running",
          revision: 0,
          currentNode: input.definition.entry,
          visits: 0,
          repeats: {},
          automationStopped: false,
          attempts: [],
          trace: [],
          reviews: [],
          workspace: resolvedWorkspace,
          workspacePath:
            workspace.type === "current"
              ? base.path
              : workspace.type === "existing"
                ? workspace.path
                : null,
          branch:
            workspace.type === "current"
              ? base.branch
              : workspace.type === "existing"
                ? workspace.branch
                : null,
          reason: null,
          gate: null,
          allowedActions: [],
          createdAt: now,
        };
        yield* sql`INSERT INTO workflow_runs (id, project_id, data, state) VALUES (${run.id}, ${run.projectId}, ${yield* encodeRun(run)}, ${run.state})`;
        if (resolvedWorkspace.type === "exact-ref")
          yield* enqueue(run, `${id}:workspace`, "workspace");
        admit(run, input.definition.entry, now);
        yield* persist(run);
        yield* sql`INSERT INTO workflow_commands (id, digest, result) VALUES (${id}, ${requestDigest}, ${yield* encodeRun(run)})`;
        return run;
      }),
    );
  });
  const report = Effect.fn("Workflows.report")(function* (
    requested: ReportInput,
    caller: PluginToolCaller,
  ) {
    yield* environment(caller.environmentId);
    const input = yield* decodeReport(requested);
    if (new TextEncoder().encode(canonical(input)).byteLength > limits.reportBytes)
      return yield* error("report", "Report exceeds the 64 KiB protocol limit.");
    const payloadDigest = digest(input);
    const now = yield* Clock.currentTimeMillis;
    return yield* transaction(
      "report",
      Effect.gen(function* () {
        const [binding] = yield* sql<{
          run_id: string;
          attempt_id: string;
        }>`SELECT run_id, attempt_id FROM workflow_bindings WHERE thread_id = ${caller.threadId}`;
        if (!binding)
          return yield* error(
            "report",
            "This thread does not own a workflow attempt.",
            "unauthorized",
          );
        const run = yield* load(binding.run_id);
        const attempt = run.attempts.find((attempt) => attempt.id === binding.attempt_id)!;
        const agent = agentFor(run, attempt);
        if (
          run.projectId !== caller.projectId ||
          agent?.modelSelection.instanceId !== caller.providerInstanceId ||
          agent.runtimeMode !== caller.runtimeMode
        )
          return yield* error(
            "report",
            "The caller does not match the bound attempt.",
            "unauthorized",
          );
        if (attempt.report) {
          if (
            attempt.report.clientRetryKey !== input.clientRetryKey ||
            attempt.report.receipt.digest !== payloadDigest
          )
            return yield* error(
              "report",
              "An immutable report already exists for this attempt. Retry the exact payload and key.",
              "conflict",
            );
          return attempt.report.receipt;
        }
        if (run.state !== "running" || terminalAttempt(attempt))
          return yield* error("report", "This attempt is no longer accepting reports.", "conflict");
        const problems = dataProblems(agent.report.fields, input.data);
        if (agent.report.evidenceRequired && input.evidence.length === 0)
          problems.push("evidence requires at least one reference.");
        if (problems.length) return yield* error("report", problems.join(" "));
        const receipt: ReportReceipt = {
          id: `${attempt.id}:report`,
          attemptId: attempt.id,
          acceptedAt: now,
          digest: payloadDigest,
        };
        // Revoke undispatched follow-up work atomically with the immutable report receipt.
        yield* host.cancelPending(target(run, attempt));
        attempt.report = { ...input, receipt };
        attempt.phase = attempt.waitStartedAt === null ? "reported" : "waiting-input";
        yield* sql`INSERT INTO workflow_reports (attempt_id, digest, receipt) VALUES (${attempt.id}, ${payloadDigest}, ${yield* encodeReceipt(receipt)})`;
        yield* persist(run);
        return receipt;
      }),
    );
  });
  const mutate = Effect.fnUntraced(function* (
    operation: string,
    input: typeof CommandInput.Type,
    action: (run: State, now: number) => Effect.Effect<void, PluginError | SqlError>,
  ) {
    yield* environment(input.environmentId);
    const id = `${input.runId}:command:${input.clientRequestId}`;
    const requestDigest = digest([operation, input]);
    const now = yield* Clock.currentTimeMillis;
    return yield* transaction(
      operation,
      Effect.gen(function* () {
        const [previous] = yield* sql<{
          digest: string;
          result: string;
        }>`SELECT digest, result FROM workflow_commands WHERE id = ${id}`;
        if (previous) {
          if (previous.digest !== requestDigest)
            return yield* error(
              operation,
              "The retry identity belongs to a different decision.",
              "conflict",
            );
          return yield* decodeRun(previous.result);
        }
        const run = yield* load(input.runId);
        if (run.projectId !== input.projectId)
          return yield* error(operation, "The run is unavailable in this project.", "unavailable");
        if (run.revision !== input.expectedRevision)
          return yield* error(
            operation,
            "The run revision changed. Reload before deciding.",
            "conflict",
          );
        yield* action(run, now);
        yield* persist(run);
        yield* sql`INSERT INTO workflow_commands (id, digest, result) VALUES (${id}, ${requestDigest}, ${yield* encodeRun(run)})`;
        return run;
      }),
    );
  });
  const cancel = (input: typeof CommandInput.Type) =>
    mutate("cancel", input, (run) =>
      Effect.gen(function* () {
        if (!run.allowedActions.includes("cancel"))
          return yield* error("cancel", "The run is already terminal.", "conflict");
        run.state = "canceled";
        run.reason = "Canceled by the user.";
        run.gate = null;
        for (const review of run.reviews) if (!review.result) review.result = "canceled";
        for (const attempt of run.attempts)
          if (!terminalAttempt(attempt)) {
            attempt.phase = "canceled";
            attempt.reason = run.reason;
          }
        yield* sql`UPDATE workflow_outbox SET status = 'canceled' WHERE run_id = ${run.id} AND status = 'pending' AND kind <> 'interrupt'`;
        for (const attempt of run.attempts)
          if (attempt.threadId) yield* host.cancelPending(target(run, attempt));
      }),
    );
  const retry = (input: typeof CommandInput.Type) =>
    mutate("retry", input, (run, now) =>
      Effect.gen(function* () {
        if (!run.allowedActions.includes("retry"))
          return yield* error("retry", "This run cannot admit a new attempt.", "conflict");
        run.reason = null;
        // New attempts always receive a new thread; old reports never transfer authority.
        const retryNode = recoveryNode(run)!;
        for (const attempt of run.attempts)
          if (!terminalAttempt(attempt)) {
            attempt.phase = "canceled";
            attempt.reason = "Superseded by an explicit retry.";
          }
        for (const attempt of run.attempts)
          if (attempt.threadId) yield* host.cancelPending(target(run, attempt));
        admit(run, retryNode, now);
      }),
    );
  const resume = (input: typeof CommandInput.Type) =>
    mutate("resume", input, (run, now) =>
      Effect.gen(function* () {
        const attempt = run.attempts.findLast(
          (attempt) => attempt.nodeId === run.currentNode && attempt.resumable && !attempt.report,
        );
        if (!run.allowedActions.includes("resume") || !attempt)
          return yield* error(
            "resume",
            "No retained native session can safely resume this attempt.",
            "unsupported",
          );
        attempt.resumeCount++;
        attempt.phase = "resuming";
        attempt.reason = null;
        attempt.lastActiveAt = now;
        attempt.executionRunId = null;
        attempt.resumable = false;
        run.state = "running";
        run.reason = null;
        yield* enqueue(run, `${attempt.id}:resume:${attempt.resumeCount}`, "resume", attempt.id);
      }),
    );
  const gate = Effect.fn("Workflows.gate")(function* (input: typeof GateInput.Type) {
    const observed = yield* get(input);
    const review = observed.reviews.find((review) => review.id === observed.gate?.reviewId);
    const freshness = review
      ? yield* host.verifyPullRequestHead(review.pullRequest).pipe(Effect.result)
      : null;
    return yield* mutate("gate", input, (run, now) =>
      Effect.gen(function* () {
        if (run.state !== "awaiting-review" || run.gate?.revision !== input.expectedRevision)
          return yield* error("gate", "This human gate is no longer current.", "conflict");
        if (!run.allowedActions.includes(input.decision))
          return yield* error(
            "gate",
            "The exhausted automation bound forbids that decision.",
            "conflict",
          );
        if (review && (freshness?._tag !== "Success" || freshness.success.head !== review.head)) {
          unresolved(
            run,
            freshness?._tag === "Success"
              ? "The pull request head changed after review."
              : "The reviewed pull request head cannot be verified.",
          );
          return;
        }
        const node = run.definition.nodes.find((node) => node.id === run.currentNode)!;
        if (node.kind !== "human") return yield* error("gate", "This node is not a human gate.");
        transition(run, node.id, input.decision === "approve" ? node.approve : node.changes, now, {
          sourceIds: review ? [review.id] : [],
          reason: `Human decision: ${input.decision}.`,
        });
      }),
    );
  });

  const settle = Effect.fnUntraced(
    function* (runId: string, attemptId: string) {
      const run = yield* load(runId);
      const attempt = run.attempts.find((attempt) => attempt.id === attemptId)!;
      if (
        run.state !== "running" ||
        terminalAttempt(attempt) ||
        ["launching", "resuming"].includes(attempt.phase)
      )
        return;
      for (const id of admissionIds(attempt)) yield* host.receipt(id);
      // Read native work after admission settles, under the same lock as owner decisions.
      const state = yield* host.inspect(target(run, attempt));
      const now = yield* Clock.currentTimeMillis;
      const before = mutation;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const active = activeRun(state);
          const pendingRequests = state.requests.filter((request) =>
            ["pending", "waiting"].includes(request.status),
          );
          const request = pendingRequests.length > 0;
          const pending =
            active ||
            state.outstandingWork.length > 0 ||
            state.checkpoints.some((checkpoint) =>
              ["pending", "capturing", "running"].includes(checkpoint.status),
            );
          // The persisted result and report end the execution clock before delayed recovery.
          const until =
            !pending && !request && attempt.report && state.settledAt != null
              ? Math.min(
                  now,
                  Math.max(
                    attempt.lastActiveAt,
                    state.settledAt,
                    attempt.report.receipt.acceptedAt,
                  ),
                )
              : now;
          const agent = agentFor(run, attempt)!;
          const accountingFrom = Math.max(
            attempt.lastActiveAt,
            attempt.waitStartedAt ?? attempt.lastActiveAt,
          );
          const humanExpired =
            agent.humanTimeoutMs !== undefined &&
            state.requests.some((request) => {
              const end =
                request.resolvedAt ??
                (["pending", "waiting"].includes(request.status) ? until : request.createdAt);
              return end > accountingFrom && end - request.createdAt >= agent.humanTimeoutMs!;
            });
          attempt.nativeSessionId = state.nativeSession?.id ?? null;
          if (attempt.deadline !== null && until >= attempt.deadline) {
            attempt.phase = "unresolved";
            attempt.reason = "The review branch deadline expired.";
          } else if (humanExpired) {
            attempt.phase = "unresolved";
            attempt.reason = "The human-response deadline expired.";
          } else if (request) {
            const waitStartedAt = Math.min(
              now,
              ...pendingRequests.map((request) => request.createdAt),
            );
            const enteredWait = attempt.waitStartedAt !== waitStartedAt;
            if (enteredWait) {
              const until = Math.max(accountingFrom, waitStartedAt);
              attempt.remainingMs = Math.max(
                0,
                attempt.remainingMs - executionElapsed(state.requests, accountingFrom, until),
              );
              attempt.lastActiveAt = until;
              attempt.waitStartedAt = waitStartedAt;
              attempt.phase = "waiting-input";
            }
            if (attempt.remainingMs === 0) {
              attempt.phase = "unresolved";
              attempt.reason = "The execution timeout expired.";
            } else {
              if (enteredWait) yield* persist(run);
              return;
            }
          } else {
            if (
              attempt.waitStartedAt !== null ||
              state.requests.some(
                (request) => request.resolvedAt !== null && request.resolvedAt > accountingFrom,
              )
            ) {
              attempt.remainingMs = Math.max(
                0,
                attempt.remainingMs - executionElapsed(state.requests, accountingFrom, until),
              );
              attempt.waitStartedAt = null;
              attempt.lastActiveAt = until;
              attempt.phase = attempt.report ? "reported" : "running";
              yield* persist(run);
            }
            if (
              executionElapsed(state.requests, attempt.lastActiveAt, until) >= attempt.remainingMs
            ) {
              attempt.phase = "unresolved";
              attempt.reason = "The execution timeout expired.";
            } else if (
              active ||
              state.outstandingWork.length > 0 ||
              state.checkpoints.some((checkpoint) =>
                ["pending", "capturing", "running"].includes(checkpoint.status),
              )
            )
              return;
            else {
              const execution = state.runs.findLast(
                (run) => state.resultRunId === undefined || run.id === state.resultRunId,
              );
              if (!execution) return;
              if (["interrupted", "cancelled", "rolled_back"].includes(execution.status)) {
                attempt.phase = "interrupted";
                attempt.resumable =
                  state.nativeSession?.canResume === true &&
                  !attempt.report &&
                  attempt.remainingMs > now - attempt.lastActiveAt &&
                  (attempt.deadline === null || attempt.deadline > now);
                attempt.remainingMs = Math.max(
                  0,
                  attempt.remainingMs - (now - attempt.lastActiveAt),
                );
                attempt.reason = "Native execution was explicitly interrupted.";
              } else if (
                execution.status === "failed" ||
                state.checkpoints.some((checkpoint) =>
                  ["failed", "missing", "error", "stale"].includes(checkpoint.status),
                )
              ) {
                attempt.phase = "failed";
                attempt.reason = "Native execution or checkpoint failed.";
              } else if (execution.status !== "completed") return;
              else if (!attempt.report) {
                if (!attempt.reminderSent) {
                  attempt.phase = "reminding";
                  yield* persist(run);
                  return;
                }
                attempt.phase = "unresolved";
                attempt.reason = "Execution settled after one reminder without an accepted report.";
              } else
                attempt.phase =
                  attempt.report.outcome === "completed"
                    ? "completed"
                    : attempt.report.outcome === "failed"
                      ? "failed"
                      : "unresolved";
            }
          }
          if (attempt.branchId === null) {
            const node = run.definition.nodes.find((node) => node.id === attempt.nodeId)!;
            if (node.kind === "agent") {
              if (attempt.phase === "completed")
                transition(run, node.id, node.next, now, {
                  attemptId,
                  sourceIds: [attempt.report!.receipt.id],
                });
              else if (node.onUnresolved)
                transition(run, node.id, node.onUnresolved, now, {
                  attemptId,
                  reason: attempt.reason ?? "The agent reported unsuccessful execution.",
                });
              else unresolved(run, attempt.reason ?? "The agent reported unsuccessful execution.");
            }
          } else yield* enqueue(run, `${run.id}:join:${attempt.id}`, "node");
          yield* persist(run);
        }),
      );
      if (mutation !== before) yield* notify;
    },
    (effect) => protect("settlement", effect.pipe(lock.withPermits(1))),
  );
  const expireAdmission = Effect.fnUntraced(function* (run: Run, attempt: Attempt) {
    const now = yield* Clock.currentTimeMillis;
    if (now < (attempt.deadline ?? attempt.lastActiveAt + attempt.remainingMs)) return true;
    yield* transaction(
      "launch-timeout",
      Effect.gen(function* () {
        const current = yield* load(run.id);
        const owned = current.attempts.find((item) => item.id === attempt.id)!;
        if (current.state !== "running" || !["launching", "resuming"].includes(owned.phase)) return;
        const resuming = owned.phase === "resuming";
        owned.phase = "unresolved";
        owned.reason = resuming
          ? "The execution resume deadline expired."
          : "The execution launch deadline expired.";
        if (owned.branchId) yield* enqueue(current, `${current.id}:join:${owned.id}`, "node");
        else unresolved(current, owned.reason);
        yield* persist(current);
      }),
    );
    return false;
  });
  const reconcileAttempts = Effect.fnUntraced(function* () {
    const rows = yield* sql<{
      id: string;
      rowid: number;
    }>`SELECT id, rowid FROM workflow_runs WHERE state = 'running' AND rowid > ${reconcileAfter} ORDER BY rowid LIMIT 100`;
    reconcileAfter = rows.length === 100 ? rows.at(-1)!.rowid : 0;
    for (const row of rows) {
      const run = yield* load(row.id);
      // A previously stranded join can have a completed node effect, so also reconcile its disposition.
      if (
        run.definition.nodes.find((node) => node.id === run.currentNode)?.kind === "join" &&
        !(yield* cleanupPending(run.id))
      )
        yield* nodeWork(run.id);
      for (const attempt of run.attempts) {
        if (!attempt.threadId && attempt.phase === "running" && !checks.has(attempt.id))
          yield* completeCheck(run.id, attempt.id, {
            outcome: "unresolved",
            exitCode: null,
            timedOut: false,
            interrupted: true,
            stdout: "",
            stderr:
              "Execution ended without retaining the check result. Explicit retry is required.",
          });
        if (["launching", "resuming"].includes(attempt.phase)) yield* expireAdmission(run, attempt);
        if (
          attempt.threadId &&
          !terminalAttempt(attempt) &&
          !["launching", "resuming"].includes(attempt.phase)
        ) {
          const settlement = yield* settle(run.id, attempt.id).pipe(Effect.result);
          if (settlement._tag === "Failure" && settlement.failure.code === "unavailable")
            yield* transaction(
              "reconcile",
              Effect.gen(function* () {
                const state = yield* load(run.id);
                const current = state.attempts.find((item) => item.id === attempt.id)!;
                if (terminalAttempt(current) || state.state !== "running") return;
                current.phase = "unresolved";
                current.reason = "The owning native thread is unavailable.";
                if (!current.branchId) unresolved(state, current.reason);
                else yield* enqueue(state, `${state.id}:join:${current.id}`, "node");
                yield* persist(state);
              }),
            );
        }
      }
    }
  });

  const completeCheck = Effect.fnUntraced(function* (
    runId: string,
    attemptId: string,
    result: Attempt["check"],
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* transaction(
      "check",
      Effect.gen(function* () {
        const run = yield* load(runId);
        const attempt = run.attempts.find((attempt) => attempt.id === attemptId)!;
        if (run.state !== "running" || terminalAttempt(attempt)) return;
        attempt.check = result;
        attempt.phase =
          result!.outcome === "completed"
            ? "completed"
            : result!.outcome === "failed"
              ? "failed"
              : "unresolved";
        const node = run.definition.nodes.find((node) => node.id === attempt.nodeId)!;
        if (node.kind !== "check") return;
        if (result!.outcome !== "unresolved")
          transition(run, node.id, node.next, now, {
            attemptId,
            sourceIds: [attempt.id],
            reason: "Recorded deterministic check result.",
          });
        else if (node.onUnresolved)
          transition(run, node.id, node.onUnresolved, now, {
            attemptId,
            reason: "The check was interrupted or timed out.",
          });
        else unresolved(run, "The check result is unresolved. An explicit retry is required.");
        yield* persist(run);
      }),
    );
  });
  const nodeWork = Effect.fnUntraced(function* (runId: string) {
    const observed = yield* load(runId);
    if (observed.state !== "running") return;
    const node = observed.definition.nodes.find((node) => node.id === observed.currentNode)!;
    const now = yield* Clock.currentTimeMillis;
    if (node.kind === "decision") {
      const source = observed.definition.nodes.find((item) => item.id === node.source);
      const review =
        source?.kind === "join"
          ? observed.reviews.findLast((review) => review.fork === source.fork)
          : null;
      const freshness = review
        ? yield* host.verifyPullRequestHead(review.pullRequest).pipe(Effect.result)
        : null;
      if (review && (freshness?._tag !== "Success" || freshness.success.head !== review.head)) {
        yield* transaction(
          "stale-input",
          Effect.gen(function* () {
            const run = yield* load(runId);
            if (run.state !== "running" || run.currentNode !== node.id) return;
            run.currentNode = review.fork;
            unresolved(run, "The reviewed pull request head changed or cannot be verified.");
            yield* persist(run);
          }),
        );
        return;
      }
      yield* transaction(
        "decision",
        Effect.gen(function* () {
          const run = yield* load(runId);
          if (run.state !== "running" || run.currentNode !== node.id) return;
          const source = run.definition.nodes.find((item) => item.id === node.source);
          const attempt = latestAttempt(run, node.source);
          const review =
            source?.kind === "join"
              ? run.reviews.findLast((review) => review.fork === source.fork)
              : null;
          if (!review?.result && !attempt?.check && !attempt?.report) {
            unresolved(run, `Decision input ${node.source} is unavailable.`);
            yield* persist(run);
            return;
          }
          const selected = choose(
            node.rules,
            node.otherwise,
            source?.kind === "join" ? joinValues(run, source.fork) : reportValues(attempt),
          );
          const flowReview = reviewFromFlow(run);
          transition(run, node.id, selected.route, now, {
            ...selected,
            sourceIds: [
              ...(review ? [review.id] : [attempt?.report?.receipt.id ?? attempt!.id]),
              ...(flowReview ? [flowReview.id] : []),
            ],
          });
          yield* persist(run);
        }),
      );
    }
    if (node.kind === "parallel") {
      const pullRequest = { ...node.pullRequest, projectId: observed.projectId };
      const freshness = yield* host.verifyPullRequestHead(pullRequest).pipe(Effect.result);
      const commit =
        freshness._tag === "Success"
          ? yield* host.resolveRef(observed.projectId, freshness.success.head).pipe(Effect.result)
          : null;
      yield* transaction(
        "fork",
        Effect.gen(function* () {
          const run = yield* load(runId);
          if (run.state !== "running" || run.currentNode !== node.id) return;
          if (freshness._tag !== "Success" || commit?._tag !== "Success") {
            unresolved(run, "The intended committed pull request head cannot be verified.");
            yield* persist(run);
            return;
          }
          if (run.visits + node.branches.length + 1 > (run.definition.maxVisits ?? 100)) {
            run.automationStopped = true;
            transition(run, node.id, { to: run.definition.atLimit }, now, {
              reason: "Insufficient remaining visits for the entire fork.",
            });
            yield* persist(run);
            return;
          }
          const generation = run.reviews.filter((review) => review.fork === node.id).length + 1;
          const branches: { id: string; attemptId: string }[] = [];
          for (const branch of node.branches) {
            run.visits++;
            reserveAttempt(run, node, now, branch, generation);
            branches.push({ id: branch.id, attemptId: run.attempts.at(-1)!.id });
          }
          run.reviews.push({
            id: `${run.id}:review:${node.id}:${generation}`,
            fork: node.id,
            generation,
            head: commit.success,
            pullRequest,
            branches,
            result: null,
            consumed: false,
          });
          run.visits++;
          run.currentNode = node.next;
          yield* persist(run);
        }),
      );
    }
    if (node.kind === "join") {
      const review = observed.reviews.findLast((review) => review.fork === node.fork);
      if (!review || review.result || review.consumed) {
        yield* transaction(
          "join-admission",
          Effect.gen(function* () {
            const run = yield* load(runId);
            if (run.state !== "running" || run.currentNode !== node.id) return;
            const current = run.reviews.findLast((review) => review.fork === node.fork);
            if (current && !current.result && !current.consumed) return;
            unresolved(run, `Join ${node.id} has no fresh, unconsumed fork generation.`);
            yield* persist(run);
          }),
        );
        return;
      }
      if (
        review.branches.some(
          (branch) =>
            !terminalAttempt(observed.attempts.find((attempt) => attempt.id === branch.attemptId)!),
        )
      )
        return;
      const freshness = yield* host.verifyPullRequestHead(review.pullRequest).pipe(Effect.result);
      const workspaceEvidence = yield* Effect.forEach(review.branches, (branch) =>
        Effect.gen(function* () {
          const attempt = observed.attempts.find((attempt) => attempt.id === branch.attemptId)!;
          if (!attempt.threadId || attempt.launch?.workspace.type !== "existing")
            return yield* error("join", "The reviewer workspace is unavailable.", "unavailable");
          const native = yield* host.inspect(target(observed, attempt));
          if (!native.workspacePath)
            return yield* error("join", "The reviewer workspace is unavailable.", "unavailable");
          const workspace = yield* host.verifyWorkspace({
            projectId: observed.projectId,
            path: native.workspacePath,
          });
          return {
            valid:
              native.workspacePath === attempt.launch.workspace.path &&
              workspace.head === review.head &&
              workspace.clean,
          };
        }).pipe(Effect.result),
      );
      yield* transaction(
        "join",
        Effect.gen(function* () {
          const run = yield* load(runId);
          const current = run.reviews.find((item) => item.id === review.id)!;
          if (run.state !== "running" || run.currentNode !== node.id || current.result) return;
          const attempts = current.branches.map((branch) =>
            run.attempts.find((attempt) => attempt.id === branch.attemptId)!,
          );
          if (attempts.some((attempt) => !terminalAttempt(attempt))) return;
          for (const [index, attempt] of attempts.entries()) {
            const evidence = workspaceEvidence[index];
            if (evidence?._tag === "Success" && !evidence.success.valid) {
              attempt.phase = "stale";
              attempt.reason = "The reviewer checkout changed from its frozen input.";
            }
          }
          current.result =
            freshness._tag !== "Success"
              ? "unresolved"
              : freshness.success.head !== current.head
                ? "stale"
                : workspaceEvidence.some((item) => item?._tag !== "Success")
                  ? "unresolved"
                  : workspaceEvidence.some((item) => item._tag === "Success" && !item.success.valid)
                    ? "stale"
                    : attempts.some((attempt) => attempt.phase === "canceled")
                      ? "canceled"
                      : attempts.some((attempt) => attempt.phase === "stale")
                        ? "stale"
                        : attempts.some((attempt) => attempt.phase === "failed")
                          ? "failed"
                          : attempts.some(
                                (attempt) =>
                                  attempt.phase === "unresolved" ||
                                  attempt.phase === "interrupted" ||
                                  !attempt.report,
                              )
                            ? "unresolved"
                            : "all_completed";
          current.consumed = true;
          const selected = choose(node.rules, node.otherwise, joinValues(run, node.fork));
          transition(run, node.id, selected.route, now, {
            ...selected,
            sourceIds: [
              current.id,
              ...attempts.flatMap((attempt) => (attempt.report ? [attempt.report.receipt.id] : [])),
            ],
          });
          yield* persist(run);
        }),
      );
    }
  });

  const followUp = Effect.fnUntraced(function* (
    runId: string,
    attemptId: string,
    kind: "reminder" | "resume",
    instruction: string,
  ) {
    yield* protect(
      kind,
      Effect.gen(function* () {
        const run = yield* load(runId);
        const attempt = run.attempts.find((attempt) => attempt.id === attemptId)!;
        if (
          run.state !== "running" ||
          terminalAttempt(attempt) ||
          (kind === "reminder" && (attempt.reminderSent || attempt.report))
        )
          return;
        const id = commandId(attempt, kind, kind === "resume" ? attempt.resumeCount : undefined);
        const receipt =
          (yield* host.receipt(id)) ??
          (yield* host.send({ ...target(run, attempt), commandId: id, mode: "auto", instruction }));
        const state =
          receipt.status === "accepted"
            ? yield* host.inspect(target(run, attempt)).pipe(Effect.result)
            : null;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // The command lock remains held until the new owned execution is retained.
            attempt.executionRunId =
              state?._tag === "Success" ? (state.success.runs.at(-1)?.id ?? null) : null;
            if (kind === "reminder") attempt.reminderSent = true;
            attempt.phase = attempt.report ? "reported" : "running";
            if (receipt.status === "rejected") {
              attempt.phase = "unresolved";
              attempt.reason = receipt.error ?? "The follow-up was rejected.";
              if (attempt.branchId) yield* enqueue(run, `${run.id}:join:${attempt.id}`, "node");
              else unresolved(run, attempt.reason);
            }
            yield* persist(run);
          }),
        );
        yield* notify;
      }).pipe(lock.withPermits(1)),
    );
  });

  const verifyReviewFreshness = Effect.fnUntraced(function* (observed: Run, attempt: Attempt) {
    if (!attempt.reviewId) return true;
    const review = observed.reviews.find((review) => review.id === attempt.reviewId);
    const freshness = review
      ? yield* host.verifyPullRequestHead(review.pullRequest).pipe(Effect.result)
      : null;
    if (review && freshness?._tag === "Success" && freshness.success.head === review.head)
      return true;
    yield* transaction(
      "stale-input",
      Effect.gen(function* () {
        const run = yield* load(observed.id);
        const current = run.attempts.find((item) => item.id === attempt.id)!;
        if (run.state !== "running" || terminalAttempt(current)) return;
        if (current.threadId) yield* host.cancelPending(target(run, current));
        current.phase = "stale";
        current.reason =
          "The reviewed pull request head changed or cannot be verified before execution.";
        run.currentNode = review?.fork ?? current.nodeId;
        unresolved(run, current.reason);
        yield* persist(run);
      }),
    );
    return false;
  });

  const dispatch = Effect.fnUntraced(function* (item: {
    id: string;
    run_id: string;
    attempt_id: string | null;
    kind: string;
  }) {
    const observed = yield* load(item.run_id);
    if (item.kind === "interrupt") {
      const attempt = observed.attempts.find((attempt) => attempt.id === item.attempt_id)!;
      const isCurrent = (attempt: Attempt) =>
        ["canceled", "interrupted", "unresolved", "stale"].includes(attempt.phase) &&
        (item.id === interruptId(attempt) ||
          (attempt.resumeCount === 0 && item.id === `${attempt.id}:interrupt`));
      if (!isCurrent(attempt)) return;
      const check = checks.get(attempt.id);
      if (check) {
        yield* Fiber.interrupt(check);
        checks.delete(attempt.id);
      }
      yield* Effect.gen(function* () {
        const run = yield* load(item.run_id);
        const current = run.attempts.find((attempt) => attempt.id === item.attempt_id)!;
        if (!isCurrent(current) || !current.threadId) return;
        yield* host.cancelPending(target(run, current));
        const [launched] = yield* Effect.forEach(admissionIds(current), (id) => host.receipt(id));
        if (!current.launch || !launched || launched.status !== "accepted") return;
        // Hold the command lock so an explicit Resume cannot race an older interruption.
        const inspected = yield* host.inspect(target(run, current)).pipe(Effect.result);
        if (inspected._tag === "Failure") {
          if (inspected.failure.code === "unavailable") return;
          return yield* inspected.failure;
        }
        const active = inspected.success.runs.filter(
          (execution, index, runs) =>
            ["preparing", "queued", "starting", "running", "waiting"].includes(execution.status) ||
            (index === runs.length - 1 && inspected.success.outstandingWork.length > 0),
        );
        for (const execution of active)
          yield* host.interrupt({
            ...target(run, current),
            commandId: commandId(current, `interrupt-${digest(execution.id).slice(0, 16)}`),
            runId: execution.id,
          });
        const stopped = yield* host.inspect(target(run, current));
        if (activeRun(stopped) || stopped.outstandingWork.length > 0)
          return yield* error("cleanup", "Owned native work has not stopped yet.", "service");
      }).pipe(lock.withPermits(1));
      return;
    }
    if (item.kind === "workspace") {
      if (["completed", "failed", "canceled"].includes(observed.state)) return;
      if (observed.workspace.type !== "exact-ref" || observed.workspacePath) return;
      const workspace = yield* host.prepareWorkspace({
        projectId: observed.projectId,
        key: digest(observed.id).slice(0, 32),
        ref: observed.workspace.ref,
      });
      yield* transaction(
        "workspace",
        Effect.gen(function* () {
          const run = yield* load(observed.id);
          if (["completed", "failed", "canceled"].includes(run.state)) return;
          run.workspacePath = workspace.path;
          run.branch = workspace.branch;
          yield* persist(run);
        }),
      );
      return;
    }
    if (observed.state !== "running") return;
    // Keep automated continuation pending across cleanup failures and server restarts.
    if (yield* cleanupPending(observed.id))
      return yield* error("cleanup", "Owned execution cleanup is still pending.", "service");
    if (item.kind === "node") {
      yield* nodeWork(observed.id);
      return;
    }
    const attempt = observed.attempts.find((attempt) => attempt.id === item.attempt_id)!;
    if (terminalAttempt(attempt)) return;
    if (["launch", "resume"].includes(item.kind) && !(yield* expireAdmission(observed, attempt)))
      return;
    if (item.kind === "reminder") {
      if (attempt.reminderSent || attempt.report) return;
      yield* followUp(
        observed.id,
        attempt.id,
        "reminder",
        "Your execution settled without an accepted workflow report. Call plugin_workflows_report now using the report contract in your launch instructions. This is the only protocol reminder.",
      );
      return;
    }
    if (item.kind === "resume") {
      if (attempt.phase !== "resuming" || item.id !== `${attempt.id}:resume:${attempt.resumeCount}`)
        return;
      if (!(yield* verifyReviewFreshness(observed, attempt))) return;
      const committed = yield* host.receipt(commandId(attempt, "resume", attempt.resumeCount));
      const agent = agentFor(observed, attempt)!;
      if (committed?.status !== "accepted") {
        const validation = yield* catalog.validate(
          { environmentId: observed.environmentId, projectId: observed.projectId },
          observed.definition,
        );
        if (!validation.runnable)
          return yield* error("resume", "Required capabilities changed.", "unsupported");
        yield* verifyResumeSession(observed, attempt);
        yield* verifySkill(observed, attempt, "resume");
      }
      yield* followUp(observed.id, attempt.id, "resume", launchInstruction(agent, attempt));
      return;
    }
    if (item.kind !== "launch") return;
    if (!(yield* verifyReviewFreshness(observed, attempt))) return;
    if (!observed.workspacePath)
      return yield* error("launch", "The primary workspace is not prepared.", "service");
    const node = observed.definition.nodes.find((node) => node.id === attempt.nodeId)!;
    if (node.kind === "check") {
      if (attempt.phase !== "launching") return;
      yield* transaction(
        "check-start",
        Effect.gen(function* () {
          const run = yield* load(observed.id);
          const current = run.attempts.find((item) => item.id === attempt.id)!;
          if (run.state !== "running" || current.phase !== "launching") return;
          current.phase = "running";
          yield* persist(run);
        }),
      );
      const execution = host
        .execute({
          projectId: observed.projectId,
          path: observed.workspacePath,
          command: node.command,
          args: node.args,
          timeoutMs: node.timeoutMs ?? limits.timeoutMs.default,
        })
        .pipe(
          Effect.result,
          Effect.flatMap((result) =>
            completeCheck(
              observed.id,
              attempt.id,
              result._tag === "Success"
                ? {
                    ...result.success,
                    outcome: result.success.timedOut
                      ? "unresolved"
                      : result.success.exitCode === 0
                        ? "completed"
                        : "failed",
                    interrupted: false,
                  }
                : {
                    outcome: "unresolved",
                    exitCode: null,
                    timedOut: false,
                    interrupted: true,
                    stdout: "",
                    stderr: "The command result could not be retained.",
                  },
            ),
          ),
          Effect.ensuring(Effect.sync(() => checks.delete(attempt.id))),
        );
      yield* Effect.gen(function* () {
        const current = yield* load(observed.id);
        if (
          current.state !== "running" ||
          terminalAttempt(current.attempts.find((item) => item.id === attempt.id)!)
        )
          return;
        const fiber = yield* execution.pipe(Effect.forkIn(scope));
        checks.set(attempt.id, fiber);
      }).pipe(lock.withPermits(1));
      return;
    }
    const agent = agentFor(observed, attempt)!;
    yield* verifyProvider(observed, attempt, "launch");
    yield* verifySkill(observed, attempt, "launch");
    let launch = attempt.launch;
    if (!launch) {
      const review = attempt.branchId
        ? observed.reviews.find(
            (review) => review.generation === attempt.generation && review.fork === attempt.nodeId,
          )!
        : null;
      const workspace = review
        ? yield* host.prepareWorkspace({
            projectId: observed.projectId,
            key: digest(attempt.id).slice(0, 32),
            ref: review.head,
          })
        : { path: observed.workspacePath, branch: observed.branch, head: "" };
      launch = {
        environmentId: observed.environmentId,
        projectId: observed.projectId,
        threadId: attempt.threadId!,
        commandId: commandId(attempt, "launch"),
        title: `${node.title}${attempt.branchId ? ` / ${attempt.branchId}` : ""}`,
        modelSelection: agent.modelSelection,
        runtimeMode: agent.runtimeMode,
        interactionMode: agent.interactionMode ?? "default",
        workspace: {
          type: "existing",
          path: workspace.path,
          branch: workspace.branch,
          ...(review ? { frozenHead: review.head } : {}),
        },
        instruction: launchInstruction(agent, attempt, review?.head),
      };
      const reservedLaunch = launch;
      yield* transaction(
        "launch-intent",
        Effect.gen(function* () {
          const run = yield* load(observed.id);
          const current = run.attempts.find((item) => item.id === attempt.id)!;
          if (run.state !== "running" || terminalAttempt(current)) return;
          current.launch = reservedLaunch;
          yield* persist(run);
        }),
      );
    }
    const launchInput = launch;
    const receipt = yield* Effect.gen(function* () {
      const current = yield* load(observed.id);
      if (
        current.state !== "running" ||
        terminalAttempt(current.attempts.find((item) => item.id === attempt.id)!)
      )
        return null;
      return yield* host.launch(launchInput);
    }).pipe(lock.withPermits(1));
    if (!receipt) return;
    const inspection =
      receipt.status === "accepted"
        ? yield* host.inspect(target(observed, attempt)).pipe(Effect.result)
        : null;
    yield* transaction(
      "launch-receipt",
      Effect.gen(function* () {
        const run = yield* load(observed.id);
        const current = run.attempts.find((item) => item.id === attempt.id)!;
        if (run.state !== "running" || terminalAttempt(current)) return;
        if (receipt.status === "rejected" || receipt.threadId !== current.threadId) {
          current.phase = "unresolved";
          current.reason = receipt.error ?? "The launch receipt did not match the bound thread.";
          if (!current.branchId) unresolved(run, current.reason);
          else yield* enqueue(run, `${run.id}:join:${current.id}`, "node");
        } else {
          current.phase = current.report ? "reported" : "running";
          current.executionRunId =
            inspection?._tag === "Success" ? (inspection.success.runs.at(-1)?.id ?? null) : null;
        }
        yield* persist(run);
      }),
    );
  });
  const drain = protect(
    "drain",
    Effect.gen(function* () {
      // Finite batches yield to cancellation; the scheduler drains any remaining durable work.
      for (let count = 0; count < 256; count++) {
        const [item] = yield* sql<{
          id: string;
          run_id: string;
          attempt_id: string | null;
          kind: string;
          rowid: number;
        }>`SELECT rowid, * FROM workflow_outbox WHERE status = 'pending' AND rowid > ${outboxAfter} ORDER BY rowid LIMIT 1`;
        if (!item) {
          outboxAfter = 0;
          break;
        }
        outboxAfter = item.rowid;
        const result = yield* protect("dispatch", dispatch(item)).pipe(Effect.result);
        if (result._tag === "Failure") {
          if (["service", "storage"].includes(result.failure.code)) continue;
          yield* transaction(
            "effect-failure",
            Effect.gen(function* () {
              const run = yield* load(item.run_id);
              if (run.state !== "running") return;
              if (item.attempt_id) {
                const attempt = run.attempts.find((attempt) => attempt.id === item.attempt_id)!;
                attempt.phase = "unresolved";
                attempt.reason = result.failure.message;
                if (!attempt.branchId) unresolved(run, result.failure.message);
                else yield* enqueue(run, `${run.id}:join:${attempt.id}`, "node");
              } else unresolved(run, result.failure.message);
              yield* persist(run);
            }),
          );
        }
        yield* sql`UPDATE workflow_outbox SET status = 'done' WHERE id = ${item.id} AND status = 'pending'`;
        if (item.kind === "interrupt") yield* notify;
      }
      yield* reconcileAttempts();
    }).pipe(drainLock.withPermits(1)),
  );
  const recoverAttempts = protect(
    "recover",
    Effect.gen(function* () {
      const rows = yield* sql<{ id: string }>`SELECT id FROM workflow_runs`;
      for (const row of rows) {
        const run = yield* load(row.id);
        for (const attempt of run.attempts) {
          // Repair authority retained by older dispositions before generic host replay.
          if (terminalAttempt(attempt) && attempt.threadId)
            yield* host.cancelPending(target(run, attempt));
          if (run.state !== "running") continue;
          // Older snapshots called an undelivered Resume running. Recover its admission state.
          if (attempt.resumeCount > 0 && attempt.phase === "running" && !attempt.executionRunId) {
            const [pending] =
              yield* sql`SELECT id FROM workflow_outbox WHERE id = ${`${attempt.id}:resume:${attempt.resumeCount}`} AND kind = 'resume' AND status = 'pending'`;
            if (pending) {
              yield* transaction(
                "recover-resume",
                Effect.gen(function* () {
                  const current = yield* load(run.id);
                  const owned = current.attempts.find((item) => item.id === attempt.id)!;
                  if (
                    current.state !== "running" ||
                    owned.phase !== "running" ||
                    owned.executionRunId
                  )
                    return;
                  owned.phase = "resuming";
                  yield* persist(current);
                }),
              );
              attempt.phase = "resuming";
            }
          }
          if (["launching", "resuming"].includes(attempt.phase))
            yield* expireAdmission(run, attempt);
          // Plugin acquisition precedes host recovery; revoke stale authority before its replay.
          if (["launching", "resuming"].includes(attempt.phase) && attempt.reviewId)
            yield* verifyReviewFreshness(run, attempt);
          if (["launching", "resuming"].includes(attempt.phase) && attempt.threadId) {
            const operation = attempt.phase === "resuming" ? "resume" : "launch";
            const id = commandId(
              attempt,
              operation,
              operation === "resume" ? attempt.resumeCount : undefined,
            );
            const committed = yield* host.receipt(id);
            if (committed?.status !== "accepted") {
              const validation = yield* verifyProvider(run, attempt, operation).pipe(
                Effect.andThen(verifySkill(run, attempt, operation)),
                Effect.andThen(
                  operation === "resume" ? verifyResumeSession(run, attempt) : Effect.void,
                ),
                Effect.result,
              );
              if (validation._tag === "Failure")
                yield* transaction(
                  "recover-admission",
                  Effect.gen(function* () {
                    const current = yield* load(run.id);
                    const owned = current.attempts.find((item) => item.id === attempt.id)!;
                    if (current.state !== "running" || terminalAttempt(owned)) return;
                    owned.phase = "unresolved";
                    owned.reason = validation.failure.message;
                    if (owned.branchId)
                      yield* enqueue(current, `${current.id}:join:${owned.id}`, "node");
                    else unresolved(current, owned.reason);
                    yield* persist(current);
                  }),
                );
            }
          }
          // Running checks have no replay guarantee. Retain their ambiguity across restart.
          if (!attempt.threadId && attempt.phase === "running")
            yield* completeCheck(run.id, attempt.id, {
              outcome: "unresolved",
              exitCode: null,
              timedOut: false,
              interrupted: true,
              stdout: "",
              stderr:
                "The server restarted before retaining the command result. Explicit retry is required.",
            });
        }
      }
    }),
  );
  yield* recoverAttempts;
  yield* schedules.registerDueWork(drain);
  const events = yield* PubSub.subscribe(changes);
  yield* Stream.fromSubscription(events).pipe(
    Stream.runForEach(() => drain),
    Effect.forkScoped,
  );
  yield* host.lifecycle({ environmentId: host.environmentId }).pipe(
    Stream.runForEach(() => drain),
    Effect.catch(() => Effect.void),
    Effect.forkScoped,
  );
  const reconcile = (input: typeof ScopeInput.Type) => drain.pipe(Effect.andThen(list(input)));
  const schedule = (input: typeof ScheduleInput.Type) =>
    protect(
      "schedule",
      Effect.gen(function* () {
        yield* environment(input.environmentId);
        const entries = yield* catalog.list(input);
        const entry = entries.find(
          (entry) => entry.definition?.id === input.definitionId && entry.runnable,
        );
        if (!entry) return yield* error("schedule", "The workflow is unavailable or not runnable.");
        yield* schedules.upsert({
          id: input.id,
          title: input.title,
          projectId: input.projectId,
          target: "workflows.start",
          enabled: true,
          schedule: input.schedule,
          payload: { definitionId: input.definitionId, input: input.input },
        });
      }),
    );
  const scheduledStart = Effect.fn("Workflows.scheduledStart")(function* (input: {
    readonly projectId: ProjectId;
    readonly occurrenceId: string;
    readonly definitionId: string;
    readonly input: StartInput["input"];
  }) {
    const clientRequestId = `schedule:${digest(input.occurrenceId)}`;
    const id = `workflow-${digest([host.environmentId, input.projectId, clientRequestId]).slice(0, 32)}`;
    // Receipts retained by older versions used the raw occurrence identity.
    const legacyId = `workflow-${digest([host.environmentId, input.projectId, input.occurrenceId]).slice(0, 32)}`;
    const [previous] = yield* sql<{
      result: string;
    }>`SELECT result FROM workflow_commands WHERE id IN (${id}, ${legacyId})`;
    if (previous) return yield* decodeRun(previous.result);
    const entries = yield* catalog.list({
      environmentId: host.environmentId,
      projectId: input.projectId,
    });
    const entry = entries.find(
      (entry) => entry.definition?.id === input.definitionId && entry.runnable,
    );
    if (!entry?.definition)
      return yield* error(
        "scheduled-start",
        "The scheduled workflow is unavailable or invalid.",
        "unavailable",
      );
    return yield* start({
      environmentId: host.environmentId,
      projectId: input.projectId,
      clientRequestId,
      definition: entry.definition,
      input: input.input,
    });
  });
  return Workflow.of({
    attention,
    start: (input) => protect("start", start(input).pipe(Effect.flatMap((run) => display(run)))),
    get: (input) =>
      protect("get", get(input).pipe(Effect.flatMap((run) => display(run, input.historyOffset)))),
    list,
    subscribe,
    reconcile,
    report: (input, caller) => protect("report", report(input, caller)),
    cancel: (input) => protect("cancel", cancel(input).pipe(Effect.flatMap((run) => display(run)))),
    retry: (input) => protect("retry", retry(input).pipe(Effect.flatMap((run) => display(run)))),
    resume: (input) => protect("resume", resume(input).pipe(Effect.flatMap((run) => display(run)))),
    gate: (input) => protect("gate", gate(input).pipe(Effect.flatMap((run) => display(run)))),
    schedule,
    scheduledStart: (input) =>
      protect("scheduled-start", scheduledStart(input).pipe(Effect.flatMap((run) => display(run)))),
  });
});
export const layer = Layer.effect(Workflow, make);

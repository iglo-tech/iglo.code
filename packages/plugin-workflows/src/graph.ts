import { CommandId, ThreadId } from "@t3tools/plugin-host-contract/schema";
import {
  limits,
  type Run,
  type Attempt,
  type Agent,
  type Route,
  type Predicate,
  type Value,
  type Node,
} from "./contracts.ts";
import { dataProblems, evaluate } from "./definition.ts";
import { canonical } from "./encoding.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type State = Omit<
  Mutable<Run>,
  "attempts" | "trace" | "reviews" | "repeats" | "allowedActions"
> & {
  attempts: Mutable<Attempt>[];
  trace: Run["trace"][number][];
  reviews: Mutable<Run["reviews"][number]>[];
  repeats: Record<string, number>;
  allowedActions: Run["allowedActions"][number][];
};
export const draft = (run: Run): State => ({
  ...run,
  attempts: run.attempts.map((attempt) => ({ ...attempt })),
  trace: [...run.trace],
  reviews: run.reviews.map((review) => ({ ...review })),
  repeats: { ...run.repeats },
  allowedActions: [...run.allowedActions],
});
export const terminalAttempt = (attempt: Attempt) =>
  ["completed", "failed", "unresolved", "interrupted", "canceled", "stale"].includes(attempt.phase);
export const latestAttempt = <A extends Run["attempts"][number]>(
  run: { readonly attempts: ReadonlyArray<A> },
  nodeId: string,
) => run.attempts.findLast((attempt) => attempt.nodeId === nodeId && attempt.branchId === null);
export function agentFor(run: Run, attempt: Attempt): Agent | undefined {
  const node = run.definition.nodes.find((node) => node.id === attempt.nodeId);
  return node?.kind === "agent"
    ? node
    : node?.kind === "parallel"
      ? node.branches.find((branch) => branch.id === attempt.branchId)
      : undefined;
}
export function reportValues(attempt: Attempt | undefined): Record<string, Value> {
  if (attempt?.check) {
    const { outcome, exitCode, timedOut, interrupted } = attempt.check;
    return { outcome, timedOut, interrupted, ...(exitCode === null ? {} : { exitCode }) };
  }
  if (!attempt?.report) return {};
  return {
    outcome: attempt.report.outcome,
    version: attempt.report.version,
    clientRetryKey: attempt.report.clientRetryKey,
    summary: attempt.report.summary,
    ...Object.fromEntries(
      Object.entries(attempt.report.data).map(([name, value]) => [`data.${name}`, value]),
    ),
  };
}
export function joinValues(run: Run, fork: string): Record<string, Value> {
  const review = run.reviews.findLast((review) => review.fork === fork);
  if (!review?.result) return {};
  return {
    result: review.result,
    ...Object.fromEntries(
      review.branches.flatMap((branch) =>
        Object.entries(
          reportValues(run.attempts.find((attempt) => attempt.id === branch.attemptId)),
        ).map(([name, value]) => [`branches.${branch.id}.${name}`, value]),
      ),
    ),
  };
}
/** Recovery admits fresh work at the source of an unresolved disposition, never another end. */
export function recoveryNode(run: Run): string | undefined {
  const node = run.definition.nodes.find((node) => node.id === run.currentNode)!;
  if (["agent", "check", "parallel"].includes(node.kind)) return node.id;
  if (node.kind === "join") return node.fork;
  const review = run.reviews.find(
    (review) => review.id === run.gate?.reviewId || run.trace.at(-1)?.sourceIds.includes(review.id),
  );
  if (review) return review.fork;
  const source =
    node.kind === "end"
      ? run.definition.nodes.find((node) => node.id === run.trace.at(-1)?.nodeId)
      : node;
  if (source?.kind === "agent" || source?.kind === "check" || source?.kind === "parallel")
    return source.id;
  if (source?.kind === "decision") {
    const input = run.definition.nodes.find((node) => node.id === source.source);
    if (input?.kind === "agent" || input?.kind === "check") return input.id;
    if (input?.kind === "join") return input.fork;
  }
  return undefined;
}
export type RouteOutcome = "admitted" | "limit" | "visit-limit" | "automation-stopped";
/**
 * Where an authored route leads now, without changing the run. Transition follows it, and
 * allowed gate decisions are exactly those it would admit as authored (including a repeat's
 * own At limit), so the client is never offered a decision the server would divert.
 */
export function settleRoute(
  run: Pick<Run, "definition" | "visits" | "automationStopped" | "repeats">,
  nodeId: string,
  route: Route,
): { readonly target: string; readonly outcome: RouteOutcome; readonly count: number | null } {
  const count = route.repeat ? (run.repeats[`${nodeId}:${route.to}`] ?? 0) : null;
  const limited = route.repeat !== undefined && count! >= route.repeat.max;
  const terminal = (id: string) =>
    ["human", "end"].includes(run.definition.nodes.find((node) => node.id === id)!.kind);
  const target = limited ? route.repeat!.atLimit : route.to;
  if (terminal(target)) return { target, outcome: limited ? "limit" : "admitted", count };
  if (run.visits >= (run.definition.maxVisits ?? 100))
    return { target: run.definition.atLimit, outcome: "visit-limit", count };
  if (run.automationStopped)
    return { target: run.definition.atLimit, outcome: "automation-stopped", count };
  return { target, outcome: "admitted", count };
}
const gateRoutes = (node: Extract<Node, { kind: "human" }>) =>
  [
    ["approve", node.approve],
    ["request-changes", node.changes],
  ] as const;
/** Gate decisions withheld because their authored route would be diverted, and why. */
export function withheldDecisions(run: Run) {
  const node = run.definition.nodes.find((node) => node.id === run.currentNode);
  if (run.state !== "awaiting-review" || node?.kind !== "human") return [];
  return gateRoutes(node).flatMap(([action, route]) => {
    const { outcome } = settleRoute(run, node.id, route);
    return outcome === "visit-limit" || outcome === "automation-stopped"
      ? [{ action, to: route.to, repeat: route.repeat !== undefined, cause: outcome }]
      : [];
  });
}
export function allowedActions(run: Run): State["allowedActions"] {
  if (["completed", "failed", "canceled"].includes(run.state)) return [];
  if (run.state === "awaiting-review") {
    const node = run.definition.nodes.find((node) => node.id === run.currentNode)!;
    if (node.kind !== "human") return ["cancel", "approve", "request-changes"];
    const withheld = new Set(withheldDecisions(run).map((item) => item.action));
    return [
      "cancel",
      ...gateRoutes(node).flatMap(([action]) => (withheld.has(action) ? [] : [action])),
    ];
  }
  if (run.state === "unresolved") {
    // Review recovery admits a fresh fork; consumed branches cannot continue individually.
    const attempt = latestAttempt(run, run.currentNode);
    return [
      "cancel",
      ...(!run.automationStopped &&
      run.visits < (run.definition.maxVisits ?? 100) &&
      recoveryNode(run)
        ? ["retry" as const]
        : []),
      ...(!run.automationStopped && attempt?.resumable && !attempt.report
        ? ["resume" as const]
        : []),
    ];
  }
  return ["cancel"];
}
export function unresolved(run: State, reason: string) {
  run.state = "unresolved";
  run.reason = reason;
}
export function admit(run: State, id: string, now: number) {
  let node = run.definition.nodes.find((node) => node.id === id)!;
  if (run.visits >= (run.definition.maxVisits ?? 100) && !["human", "end"].includes(node.kind)) {
    run.automationStopped = true;
    node = run.definition.nodes.find((node) => node.id === run.definition.atLimit)!;
    run.reason = "The whole-run visit limit was reached.";
  }
  if (run.automationStopped && !["human", "end"].includes(node.kind)) {
    node = run.definition.nodes.find((node) => node.id === run.definition.atLimit)!;
    run.reason = "The exhausted automation bound permits only human gates or an end.";
  }
  run.currentNode = node.id;
  run.state = "running";
  run.gate = null;
  run.visits++;
  if (node.kind === "end") {
    run.state = node.outcome;
    return;
  }
  if (node.kind === "human") {
    run.state = "awaiting-review";
    run.gate = {
      nodeId: node.id,
      revision: run.revision + 1,
      reviewId: run.reviews.findLast((review) => review.consumed)?.id ?? null,
    };
    return;
  }
  if (node.kind === "agent" || node.kind === "check") reserveAttempt(run, node, now);
}
/** Checks and decisions carry review authority; an admitted agent consumes it. */
export const reviewFromFlow = (run: Run) =>
  run.reviews.findLast(
    (review) =>
      run.trace.at(-1)?.sourceIds.includes(review.id) ||
      run.attempts.some(
        (source) =>
          source.reviewId === review.id &&
          run.definition.nodes.some((node) => node.id === source.nodeId && node.kind === "check") &&
          (source.id === run.trace.at(-1)?.attemptId ||
            run.trace.at(-1)?.sourceIds.includes(source.id)),
      ),
  );
export function reserveAttempt(
  run: State,
  node: Extract<Node, { kind: "agent" | "check" | "parallel" }>,
  now: number,
  branch?: Extract<Node, { kind: "parallel" }>["branches"][number],
  generation = 0,
) {
  const agent = node.kind === "agent" ? node : branch;
  const attemptId = `${run.id}:${run.visits}:${branch?.id ?? node.id}`;
  let input: Record<string, Value> = { ...run.input };
  let bindingReason: string | null = null;
  if (agent?.bindings?.length) {
    for (const binding of agent.bindings) {
      delete input[binding.name];
      const source = run.definition.nodes.find((node) => node.id === binding.node);
      const values =
        source?.kind === "join"
          ? joinValues(run, source.fork)
          : reportValues(latestAttempt(run, binding.node));
      if (Object.hasOwn(values, binding.path)) input[binding.name] = values[binding.path]!;
    }
    const problems = dataProblems(
      agent.bindings.map((binding) => binding.field),
      Object.fromEntries(
        agent.bindings
          .filter((binding) => Object.hasOwn(input, binding.name))
          .map((binding) => [binding.name, input[binding.name]!]),
      ),
    );
    if (problems.length) {
      bindingReason = problems.join(" ");
    }
  }
  // Previously persisted runs must also recover without an unencodable attempt snapshot.
  if (Object.keys(input).length > limits.fields) {
    bindingReason = `Resolved input exceeds ${limits.fields} fields.`;
    input = { ...run.input };
  }
  if (bindingReason && !branch) unresolved(run, bindingReason);
  const timeoutMs =
    agent?.timeoutMs ??
    (node.kind === "check" ? node.timeoutMs : undefined) ??
    limits.timeoutMs.default;
  run.attempts.push({
    id: attemptId,
    nodeId: node.id,
    branchId: branch?.id ?? null,
    reviewId: branch
      ? null
      : (reviewFromFlow(run)?.id ??
        run.reviews.findLast((review) =>
          agent?.bindings?.some(
            (binding) =>
              latestAttempt(run, binding.node)?.reviewId === review.id ||
              run.definition.nodes.some(
                (node) =>
                  node.id === binding.node && node.kind === "join" && node.fork === review.fork,
              ),
          ),
        )?.id ??
        null),
    generation,
    threadId: agent ? ThreadId.make(`workflow:${attemptId}`) : null,
    phase: bindingReason ? "unresolved" : "launching",
    reason: bindingReason,
    report: null,
    check: null,
    skill: agent?.skill
      ? (run.skills[`${agent.modelSelection.instanceId}:${agent.skill}`] ?? null)
      : null,
    input,
    launch: null,
    executionRunId: null,
    nativeSessionId: null,
    resumable: false,
    resumeCount: 0,
    reminderSent: false,
    remainingMs: timeoutMs,
    lastActiveAt: now,
    deadline: branch ? now + timeoutMs : null,
    waitStartedAt: null,
  });
}
export function transition(
  run: State,
  nodeId: string,
  route: Route,
  now: number,
  input: {
    attemptId?: string;
    sourceIds?: ReadonlyArray<string>;
    considered?: ReadonlyArray<{ predicate: Predicate; matched: boolean }>;
    reason?: string;
    /** Inspector control of the authored route, recorded so evidence never infers it. */
    control?: string;
  } = {},
) {
  const identity = `${nodeId}:${route.to}`;
  const { target, outcome, count } = settleRoute(run, nodeId, route);
  if (outcome === "limit" || outcome === "visit-limit") run.automationStopped = true;
  const reason =
    outcome === "limit"
      ? "The repeat limit was reached."
      : outcome === "visit-limit"
        ? "The whole-run visit limit was reached."
        : outcome === "automation-stopped"
          ? "The exhausted automation bound permits only human gates or an end."
          : route.repeat
            ? "Admitted a bounded repeat."
            : (input.reason ?? "Unconditional route.");
  // A repeat is spent only when it is admitted; a diverted repeat did not happen.
  if (route.repeat && outcome === "admitted") run.repeats[identity] = count! + 1;
  run.trace.push({
    id: `${run.id}:edge:${run.trace.length}`,
    nodeId,
    attemptId: input.attemptId ?? null,
    sourceIds: input.sourceIds ?? [],
    considered: input.considered ?? [],
    chosen: target,
    reason,
    repeatCount: route.repeat ? (run.repeats[identity] ?? 0) : null,
    ...(input.control === undefined ? {} : { route: input.control }),
    ...(route.repeat
      ? {
          repeat: {
            max: route.repeat.max,
            atLimit: route.repeat.atLimit,
            exhausted: outcome === "limit",
            outcome,
          },
        }
      : {}),
    at: now,
  });
  admit(run, target, now);
}
export function choose(
  rules: Extract<Node, { kind: "decision" | "join" }>["rules"],
  otherwise: Route,
  values: Record<string, Value>,
) {
  const considered: { predicate: Predicate; matched: boolean }[] = [];
  for (const [index, rule] of rules.entries()) {
    const matched = evaluate(rule.when, values);
    considered.push({ predicate: rule.when, matched });
    if (matched)
      return {
        route: rule.route,
        considered,
        reason: "First matching rule.",
        control: `rules.${index}`,
      };
  }
  return { route: otherwise, considered, reason: "Otherwise route.", control: "otherwise" };
}
export function launchInstruction(agent: Agent, attempt: Attempt, head?: string): string {
  const invocation = attempt.skill
    ? `Use the installed skill ${attempt.skill.name} at ${attempt.skill.path} through your native skill invocation. ${attempt.skill.invocation}\n`
    : "";
  return `${invocation}${agent.instruction}\n\nWorkflow input snapshot: ${canonical(attempt.input)}\n${head ? `Review the frozen commit ${head}. Do not change tracked files or perform external actions.\n` : ""}Before finishing, call plugin_workflows_report with version 1, a stable clientRetryKey, outcome (completed, blocked or failed), summary, data and evidence. The exact data contract is ${canonical(agent.report)}. An accepted report is a claim; checks and human review are separate. Do not print a transcript marker in place of the tool.`;
}
export const commandId = (attempt: Attempt, kind: string, revision = 0) =>
  CommandId.make(`${attempt.id}:${kind}:${revision}`);

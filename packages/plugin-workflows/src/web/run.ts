import type { Attempt, Definition, Node, Predicate, Run, RunSummary, Value } from "../contracts.ts";
import { routeControls } from "../definition.ts";

/** Presentation of server-owned run state. Nothing here evaluates routes or recovery rules. */
export const runStateLabels: Record<Run["state"], string> = {
  running: "Running",
  "awaiting-review": "Needs your decision",
  unresolved: "Unresolved",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};
export const runStateVariant = (state: Run["state"]) =>
  state === "completed"
    ? ("success" as const)
    : state === "failed"
      ? ("error" as const)
      : state === "running"
        ? ("info" as const)
        : state === "canceled"
          ? ("secondary" as const)
          : ("warning" as const);

/** Execution status of one visit, independent of whether a report was accepted. */
export const phaseLabels: Record<Attempt["phase"], string> = {
  launching: "Launching",
  resuming: "Resuming",
  running: "Running",
  "waiting-input": "Waiting for your input",
  reminding: "Reminded to report",
  reported: "Execution still running",
  completed: "Completed",
  failed: "Failed",
  unresolved: "Unresolved",
  interrupted: "Interrupted",
  canceled: "Canceled",
  stale: "Stale",
};
export const terminalPhases: ReadonlyArray<Attempt["phase"]> = [
  "completed",
  "failed",
  "unresolved",
  "interrupted",
  "canceled",
  "stale",
];
export const isActive = (attempt: Pick<Attempt, "phase">) =>
  !terminalPhases.includes(attempt.phase);

/** Whether the backend accepted a report; a claim, never proof the work passed. */
export function reportStatus(attempt: Pick<Attempt, "phase" | "report" | "check">): string {
  if (attempt.check !== null) return "Check result recorded";
  if (attempt.report !== null) return `Report accepted (${attempt.report.outcome} claim)`;
  return isActive(attempt) ? "No report yet" : "No accepted report";
}

export const nodeTitle = (definition: Definition, id: string) =>
  definition.nodes.find((node) => node.id === id)?.title ?? id;
export const attemptTitle = (
  definition: Definition,
  attempt: Pick<Attempt, "nodeId" | "branchId">,
) => {
  const node = definition.nodes.find((node) => node.id === attempt.nodeId);
  const branch =
    node?.kind === "parallel"
      ? node.branches.find((branch) => branch.id === attempt.branchId)
      : undefined;
  return branch ? `${node!.title} · ${branch.title}` : (node?.title ?? attempt.nodeId);
};

const value = (input: Value) => (typeof input === "string" ? `"${input}"` : String(input));
const comparisons: Record<string, string> = {
  eq: "equals",
  ne: "does not equal",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
};
/** The recorded predicate spelled out; its match result comes from the persisted trace. */
export function predicateText(predicate: Predicate): string {
  switch (predicate.op) {
    case "all":
    case "any":
      return `${predicate.op === "all" ? "all of" : "any of"} (${(predicate.terms ?? [])
        .map(predicateText)
        .join("; ")})`;
    case "present":
      return `${predicate.path} is present`;
    case "absent":
      return `${predicate.path} is absent`;
    case "in":
      return `${predicate.path} is one of ${(predicate.values ?? []).map(value).join(", ")}`;
    default:
      return `${predicate.path} ${comparisons[predicate.op]} ${value(predicate.value!)}`;
  }
}

/**
 * The authored repeat route behind a recorded edge (`to` is its normal destination), so a
 * counter can be shown against its limit and an at-limit exit told apart.
 */
export function repeatLimit(definition: Definition, from: string, to: string) {
  const node = definition.nodes.find((node) => node.id === from);
  if (node === undefined) return null;
  const routes = routesOf(node);
  // An exhausted repeat records its at-limit destination as the chosen edge.
  return (
    routes.flatMap((route) =>
      route.repeat && (route.to === to || route.repeat.atLimit === to)
        ? [{ ...route.repeat, to: route.to }]
        : [],
    )[0] ?? null
  );
}
function routesOf(node: Node) {
  switch (node.kind) {
    case "agent":
    case "check":
      return [node.next, ...(node.onUnresolved ? [node.onUnresolved] : [])];
    case "decision":
    case "join":
      return [...node.rules.map((rule) => rule.route), node.otherwise];
    case "human":
      return [node.approve, node.changes];
    default:
      return [];
  }
}

/** What the user can do next, read from the server's state and allowed actions. */
export function nextAction(
  run: Run | RunSummary,
  active: ReadonlyArray<Pick<Attempt, "phase">> = run.attempts,
): string | null {
  const actions = run.allowedActions;
  if (run.state === "awaiting-review")
    return actions.includes("approve") || actions.includes("request-changes")
      ? "Decide on the human gate"
      : "Gate waiting · no decision allowed";
  if (run.state === "unresolved") {
    const recovery = [
      actions.includes("resume") ? "resume" : null,
      actions.includes("retry") ? "retry" : null,
    ].filter((item) => item !== null);
    return recovery.length ? `Inspect, then ${recovery.join(" or ")}` : "Cancel to close";
  }
  if (run.state === "running")
    return active.some((attempt) => attempt.phase === "waiting-input")
      ? "Answer the request in the step's thread"
      : null;
  return null;
}

/** How a step or reviewer lane is painted on a run's graph. */
export type StepStatus = "pending" | "running" | "reported" | "completed" | "failed" | "stopped";
export interface StepState {
  readonly status: StepStatus;
  /** Textual status, also the accessible one. */
  readonly label: string;
  /** One short word for tight places such as a graph card. */
  readonly word: string;
  /** Visits on the loaded history page. */
  readonly visits: number;
}
export const statusWords: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  reported: "Reported",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};
export const phaseStatus = (phase: Attempt["phase"]): StepStatus => {
  switch (phase) {
    case "reported":
      return "reported";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "unresolved":
    case "interrupted":
    case "canceled":
    case "stale":
      return "stopped";
    default:
      return "running";
  }
};
const statusRank: Record<StepStatus, number> = {
  running: 5,
  reported: 4,
  failed: 3,
  stopped: 2,
  completed: 1,
  pending: 0,
};

/**
 * Each graph box's state (keyed by step id, or `step/branch` for a reviewer lane) from the
 * loaded visits and route history. Presentation only: the latest recorded visit wins, and
 * routing steps count the routing records the server persisted.
 */
export function stepStates(run: {
  readonly definition: Definition;
  readonly state: Run["state"];
  readonly currentNode: string;
  readonly attempts: ReadonlyArray<Pick<Attempt, "nodeId" | "branchId" | "phase" | "generation">>;
  readonly trace: ReadonlyArray<Pick<Run["trace"][number], "nodeId">>;
}): ReadonlyMap<string, StepState> {
  const states = new Map<string, StepState>();
  const latest = new Map<string, (typeof run.attempts)[number]>();
  const visits = new Map<string, number>();
  for (const attempt of run.attempts) {
    const box =
      attempt.branchId === null ? attempt.nodeId : `${attempt.nodeId}/${attempt.branchId}`;
    latest.set(box, attempt);
    visits.set(box, (visits.get(box) ?? 0) + 1);
  }
  for (const [box, attempt] of latest)
    states.set(box, {
      status: phaseStatus(attempt.phase),
      word: statusWords[phaseStatus(attempt.phase)],
      label: phaseLabels[attempt.phase],
      visits: visits.get(box) ?? 0,
    });
  const finished = !["running", "awaiting-review"].includes(run.state);
  for (const node of run.definition.nodes) {
    if (node.kind === "parallel") {
      // A review group is as far along as its least settled lane.
      const lanes = node.branches.flatMap((branch) => {
        const state = states.get(`${node.id}/${branch.id}`);
        return state === undefined ? [] : [state];
      });
      if (lanes.length === 0) continue;
      const status = lanes.reduce<StepStatus>(
        (worst, lane) => (statusRank[lane.status] > statusRank[worst] ? lane.status : worst),
        "pending",
      );
      const generations = new Set(
        run.attempts.filter((item) => item.nodeId === node.id).map((item) => item.generation),
      ).size;
      states.set(node.id, {
        status,
        word: statusWords[status],
        label: `${lanes.filter((lane) => lane.status === "completed").length} of ${node.branches.length} settled`,
        visits: generations,
      });
      continue;
    }
    if (states.has(node.id)) continue;
    const routed = run.trace.filter((item) => item.nodeId === node.id).length;
    const current = run.currentNode === node.id;
    if (current && node.kind === "end") {
      const status: StepStatus =
        run.state === "completed" ? "completed" : run.state === "failed" ? "failed" : "stopped";
      states.set(node.id, {
        status,
        word: statusWords[status],
        label: runStateLabels[run.state],
        visits: 1,
      });
    } else if (current && !finished)
      states.set(node.id, {
        status: "running",
        word: run.state === "awaiting-review" ? "Waiting" : "Current",
        label: run.state === "awaiting-review" ? "Waiting for decision" : "Current",
        visits: routed + 1,
      });
    // A run that stopped here (unresolved or canceled at a gate) shows where and how it stopped.
    else if (current) {
      const status: StepStatus = run.state === "failed" ? "failed" : "stopped";
      states.set(node.id, {
        status,
        word: statusWords[status],
        label: runStateLabels[run.state],
        visits: routed + 1,
      });
    } else if (routed > 0)
      states.set(node.id, { status: "completed", word: "Done", label: "Routed", visits: routed });
  }
  return states;
}

/**
 * The drawn edges (by `flowGraph` edge id) that recorded routing decisions took. The trace
 * names the step and destination; a decision's rule is identified by the first matching
 * condition it recorded (rules are evaluated in order), so two rules to the same step stay
 * distinct. Other steps' routes are told apart by destination, as that is all the trace keeps.
 */
export function takenEdges(
  definition: Definition,
  trace: ReadonlyArray<Pick<Run["trace"][number], "nodeId" | "chosen" | "considered">>,
): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const item of trace) {
    const node = definition.nodes.find((candidate) => candidate.id === item.nodeId);
    if (node === undefined) continue;
    let controls = routeControls(node);
    if ((node.kind === "decision" || node.kind === "join") && item.considered.length > 0) {
      const matched = item.considered.findIndex((choice) => choice.matched);
      const control =
        matched >= 0
          ? `rules.${matched}`
          : item.considered.length === node.rules.length
            ? "otherwise"
            : null;
      controls = controls.filter((candidate) => candidate.control === control);
    }
    for (const { control, route } of controls) {
      if (route.to === item.chosen) taken.add(`${node.id}:${control}`);
      // An exhausted repeat records its At limit destination.
      else if (route.repeat?.atLimit === item.chosen) taken.add(`${node.id}:${control}.repeat`);
    }
  }
  return taken;
}

/** "just now", "5 min ago", "3 h ago", then the date. */
export function relativeTime(at: number, now = Date.now()): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
}
export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { timeStyle: "short" });
export const formatTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const short = (value: string) => (value.length > 12 ? value.slice(0, 12) : value);

/** The workspace in a few words; `workspaceText` is the full description. */
export function workspaceShort(run: Pick<Run, "workspace" | "branch">): string {
  const branch = run.branch ?? (run.workspace.type === "existing" ? run.workspace.branch : null);
  const leaf = branch?.split("/").at(-1) ?? null;
  const clipped = leaf != null && leaf.length > 24 ? `${leaf.slice(0, 23)}…` : leaf;
  const kind =
    run.workspace.type === "current"
      ? "Current checkout"
      : run.workspace.type === "existing"
        ? "Existing worktree"
        : "New worktree";
  return clipped == null ? kind : `${kind} · ${clipped}`;
}
export function workspaceText(run: Pick<Run, "workspace" | "workspacePath" | "branch">): string {
  const where = [run.workspacePath, run.branch ? `branch ${run.branch}` : null]
    .filter((part) => part !== null)
    .join(" · ");
  switch (run.workspace.type) {
    case "current":
      return `Current checkout${where ? ` (${where})` : ""}`;
    case "existing":
      return `Existing worktree ${run.workspace.path}${run.workspace.branch ? ` · branch ${run.workspace.branch}` : ""}`;
    case "exact-ref":
      return `New worktree from ${short(run.workspace.ref)}${where ? ` (${where})` : run.workspacePath === null ? " · being prepared" : ""}`;
  }
}

/** How a run started and the file name it was resolved from. */
export function sourceShort(source: Run["source"]): string {
  if (source === undefined) return "Not recorded";
  const file = source.catalogSource?.split("/").at(-1) ?? "submitted";
  return `${source.trigger === "schedule" ? "Scheduled" : "Manual"} · ${file}`;
}
export function sourceText(source: Run["source"]): string {
  if (source === undefined) return "Not recorded";
  return `${source.trigger === "schedule" ? "Scheduled" : "Manual"} · ${
    source.catalogSource ?? "submitted definition"
  }`;
}

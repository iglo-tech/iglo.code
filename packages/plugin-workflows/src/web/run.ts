import type { Attempt, Definition, Run, RunSummary } from "../contracts.ts";
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
export function reportStatus(
  attempt: Pick<Attempt, "phase" | "report" | "check" | "threadId">,
): string {
  // The server records an interrupted placeholder when execution ended without a result.
  if (attempt.check?.interrupted && attempt.check.exitCode === null)
    return "No check result was retained; the check was interrupted, so it is neither a pass nor a failure";
  if (attempt.check !== null)
    return attempt.check.outcome === "unresolved"
      ? "Check result unresolved; it is not a pass or a failure"
      : `Check result recorded (${attempt.check.outcome})`;
  // Checks are commands without a native thread; agents always have one.
  if (attempt.threadId === null)
    return isActive(attempt)
      ? "Check is running; no result yet"
      : "No check result was retained; routing stopped at this visit";
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

type TraceItem = Run["trace"][number];
/**
 * What happened to a recorded repeat, as a short badge with its detail on hover. The bound
 * and outcome are what the server recorded; records from before they were kept show the
 * counter alone rather than guessing the route.
 */
export function repeatEvidence(
  definition: Definition,
  item: Pick<TraceItem, "repeatCount" | "repeat" | "chosen">,
): { readonly label: string; readonly limit: boolean; readonly detail: string } | null {
  if (item.repeatCount === null) return null;
  if (item.repeat === undefined)
    return { label: `repeat ${item.repeatCount}`, limit: false, detail: "Repeat counter" };
  const { max, atLimit, exhausted } = item.repeat;
  const used = `${item.repeatCount}/${max}`;
  switch (item.repeat.outcome ?? (exhausted ? "limit" : "admitted")) {
    case "limit":
      return {
        label: "at limit",
        limit: true,
        detail: `${used} repeats used · at limit → ${nodeTitle(definition, atLimit)}`,
      };
    case "visit-limit":
      return {
        label: "not repeated",
        limit: true,
        detail: `Run visit limit reached · ${used} repeats used · → ${nodeTitle(definition, item.chosen)}`,
      };
    case "automation-stopped":
      return {
        label: "not repeated",
        limit: true,
        detail: `Automation stopped · ${used} repeats used · → ${nodeTitle(definition, item.chosen)}`,
      };
    case "admitted":
      return {
        label: `repeat ${used}`,
        limit: false,
        detail: `Visit ${item.repeatCount + 1} of up to ${max + 1} · at limit → ${nodeTitle(definition, atLimit)}`,
      };
  }
}

const routeNames: Record<string, string> = {
  next: "next",
  onUnresolved: "unresolved",
  otherwise: "otherwise",
  approve: "approve",
  changes: "changes",
};
/** The authored route a trace record says fired (`rule 1`, `otherwise`…), when recorded. */
export function routeLabel(item: Pick<TraceItem, "route">): string | null {
  if (item.route === undefined) return null;
  const rule = /^rules\.(\d+)$/.exec(item.route);
  return rule ? `rule ${Number(rule[1]) + 1}` : (routeNames[item.route] ?? item.route);
}

/**
 * A gate decision the server withheld, from the reason it recorded with the run. The
 * remaining choices are the allowed actions; no route is evaluated here.
 */
export function withheldNotice(
  definition: Definition,
  item: NonNullable<Run["withheld"]>[number],
): { readonly title: string; readonly detail: string } {
  return {
    title: `${item.action === "approve" ? "Approve" : "Request changes"} unavailable`,
    detail: `${item.repeat ? "↩" : "→"} ${nodeTitle(definition, item.to)} · ${
      item.cause === "visit-limit" ? "run visit limit reached" : "automation stopped"
    }`,
  };
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
 * The drawn edges (by `flowGraph` edge id) that recorded routing decisions took. Records name
 * the authored route that fired, so it is matched exactly; a repeat that hit its limit took
 * its At limit edge, and one diverted by the run's own bound took no drawn edge. Records from
 * before routes were kept fall back to the first matching rule, then the destination.
 */
export function takenEdges(
  definition: Definition,
  trace: ReadonlyArray<
    Pick<TraceItem, "nodeId" | "chosen" | "considered" | "repeatCount" | "route" | "repeat">
  >,
): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const item of trace) {
    const node = definition.nodes.find((candidate) => candidate.id === item.nodeId);
    if (node === undefined) continue;
    if (item.route !== undefined) {
      const route = routeControls(node).find((candidate) => candidate.control === item.route);
      if (route === undefined) continue;
      const outcome =
        item.repeat === undefined
          ? null
          : (item.repeat.outcome ?? (item.repeat.exhausted ? "limit" : "admitted"));
      if (outcome === "limit") taken.add(`${node.id}:${item.route}.repeat`);
      // A route the run's visit bound diverted went to the run's At limit, not its own target.
      else if ((outcome ?? "admitted") === "admitted" && route.route.to === item.chosen)
        taken.add(`${node.id}:${item.route}`);
      continue;
    }
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
      // The engine records a repeat count exactly when the chosen route repeats, so a
      // non-repeating route never lights a repeat route's At limit edge and vice versa.
      if ((item.repeatCount === null) !== (route.repeat === undefined)) continue;
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

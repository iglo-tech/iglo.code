import * as Schema from "effect/Schema";
import * as Yaml from "yaml";
import type { ProviderInstanceId } from "@t3tools/plugin-host-contract/schema";
import {
  Definition,
  Id,
  type Agent,
  type Capabilities,
  type Field,
  type Node,
  type Predicate,
  type Problem,
  type Route,
  type Value,
} from "../contracts.ts";
import { definitionDiagnostics, routeControls, sourceFields } from "../definition.ts";
import { inValueLimit, readsAs } from "./decisions.ts";

type AgentNode = Extract<Node, { kind: "agent" }>;
type ParallelNode = Extract<Node, { kind: "parallel" }>;
type JoinNode = Extract<Node, { kind: "join" }>;
export type Branch = ParallelNode["branches"][number];
/** Kinds the palette adds; a Join is added with each Parallel group. */
export type EditableKind = "agent" | "check" | "decision" | "parallel" | "human" | "end";
/** Kinds whose controls this client authors. */
export const editableKinds: ReadonlyArray<Node["kind"]> = [
  "agent",
  "check",
  "decision",
  "parallel",
  "join",
  "human",
  "end",
];
export const kindLabels: Record<Node["kind"], string> = {
  agent: "Agent step",
  check: "Check",
  decision: "Decision",
  parallel: "Parallel group",
  join: "Join",
  human: "Human gate",
  end: "End",
};
const decodeDefinition = Schema.decodeUnknownResult(Definition);
const isId = Schema.is(Id);
export const protectedPattern = /⟦protected:[a-f0-9]{12}:\d+⟧/;
export const isProtected = (value: string) => protectedPattern.test(value);

/** A workflow identity derived from its name; users can still edit it before the first save. */
export function slug(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return /^[a-z]/.test(base) ? base : `workflow-${base}`.replace(/-+$/, "").slice(0, 60);
}

export function newDefinition(name: string): Definition {
  const title = name.trim() || "Untitled workflow";
  return {
    version: 1,
    id: slug(title),
    revision: 1,
    title,
    entry: "done",
    atLimit: "done",
    nodes: [{ id: "done", kind: "end", title: "Done", outcome: "completed" }],
  };
}

const uniqueId = (definition: Definition, prefix: string) => {
  const ids = new Set(definition.nodes.map((node) => node.id));
  for (let index = 1; ; index++) if (!ids.has(`${prefix}-${index}`)) return `${prefix}-${index}`;
};

/** Default agent provider: the first one that can report, preferring available ones. */
export function defaultAgent(capabilities: Capabilities | null): Agent {
  const providers = capabilities?.providers ?? [];
  const provider =
    providers.find((item) => item.reporting && item.available) ??
    providers.find((item) => item.reporting) ??
    providers[0];
  return {
    modelSelection: {
      instanceId: (provider?.instanceId ?? "codex") as ProviderInstanceId,
      model: provider?.models[0]?.slug ?? "default",
    },
    runtimeMode: provider?.runtimeModes.includes("approval-required")
      ? "approval-required"
      : (provider?.runtimeModes[0] ?? "approval-required"),
    instruction: "",
    report: { fields: [] },
  };
}

/**
 * A reviewer branch: the canonical review permission policy (native plan mode, asking before
 * external actions) and a typed verdict later routes can read.
 */
export function newBranch(capabilities: Capabilities | null, id: string, title: string): Branch {
  return {
    ...defaultAgent(capabilities),
    id,
    title,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    report: {
      fields: [{ name: "verdict", type: "enum", required: true, values: ["pass", "changes"] }],
    },
  };
}
const uniqueBranchId = (node: ParallelNode) => {
  const ids = new Set(node.branches.map((branch) => branch.id));
  for (let index = node.branches.length + 1; ; index++)
    if (!ids.has(`reviewer-${index}`)) return `reviewer-${index}`;
};
/** Add a reviewer with a new stable identity; existing identities never change. */
export function addBranch(
  definition: Definition,
  nodeId: string,
  capabilities: Capabilities | null,
): Definition {
  return updateNode(definition, nodeId, (node) => {
    if (node.kind !== "parallel") return node;
    const id = uniqueBranchId(node);
    return {
      ...node,
      branches: [
        ...node.branches,
        newBranch(capabilities, id, `Reviewer ${node.branches.length + 1}`),
      ],
    };
  });
}
/** Reading order only; identities, and the predicates that use them, are unchanged. */
export function moveBranch(
  definition: Definition,
  nodeId: string,
  index: number,
  offset: -1 | 1,
): Definition {
  return updateNode(definition, nodeId, (node) => {
    if (node.kind !== "parallel") return node;
    const destination = index + offset;
    if (destination < 0 || destination >= node.branches.length) return node;
    const branches = [...node.branches];
    const [branch] = branches.splice(index, 1);
    branches.splice(destination, 0, branch!);
    return { ...node, branches };
  });
}
/** Predicates and inputs that read a removed reviewer stay, so validation shows each one. */
export function removeBranch(definition: Definition, nodeId: string, index: number): Definition {
  return updateNode(definition, nodeId, (node) =>
    node.kind === "parallel" && node.branches.length > 1
      ? { ...node, branches: node.branches.filter((_, position) => position !== index) }
      : node,
  );
}
export const joinOf = (definition: Definition, fork: string) =>
  definition.nodes.find((node): node is JoinNode => node.kind === "join" && node.fork === fork);

/** The route a step continues through; a step inserted after it takes over this route. */
function primaryRoute(node: Node): { readonly control: string; readonly route: Route } | null {
  switch (node.kind) {
    case "agent":
    case "check":
      return { control: "next", route: node.next };
    case "decision":
    case "join":
      return { control: "otherwise", route: node.otherwise };
    case "human":
      return { control: "approve", route: node.approve };
    default:
      return null;
  }
}
function withPrimary(node: Node, route: Route): Node {
  switch (node.kind) {
    case "agent":
    case "check":
      return { ...node, next: route };
    case "decision":
    case "join":
      return { ...node, otherwise: route };
    case "human":
      return { ...node, approve: route };
    default:
      return node;
  }
}

/**
 * Add a step after `after` (or before the entry when nothing is selected) and keep the
 * sequence connected: the new step inherits the previous step's continuing route. A new
 * decision reads the step it follows when that step publishes report or check fields.
 */
export function addStep(
  definition: Definition,
  kind: EditableKind,
  after: string | null,
  capabilities: Capabilities | null,
): { readonly definition: Definition; readonly id: string } {
  if (kind === "end") {
    const id = uniqueId(definition, "end");
    const node: Node = { id, kind: "end", title: "End", outcome: "completed" };
    return { definition: { ...definition, nodes: [...definition.nodes, node] }, id };
  }
  const id = uniqueId(definition, kind);
  const count = definition.nodes.filter((node) => node.kind === kind).length + 1;
  const selected = definition.nodes.find((node) => node.id === after);
  // A step after a parallel group follows its join, so the fork/join pair stays together.
  const previous =
    selected?.kind === "parallel" ? (joinOf(definition, selected.id) ?? selected) : selected;
  after = previous?.id ?? null;
  const inherited = previous === undefined ? null : primaryRoute(previous);
  const target =
    previous === undefined
      ? definition.entry
      : inherited !== null && !inherited.route.repeat
        ? inherited.route.to
        : (definition.nodes.find((node) => node.kind === "end")?.id ?? definition.entry);
  const title = `${kindLabels[kind]} ${count}`;
  const index = previous ? definition.nodes.indexOf(previous) + 1 : 0;
  const connect = (inserted: ReadonlyArray<Node>) => {
    const nodes = [...definition.nodes];
    nodes.splice(index, 0, ...inserted);
    return {
      ...definition,
      entry: previous === undefined ? id : definition.entry,
      nodes: nodes.map((item) =>
        item.id === after && inherited !== null && !inherited.route.repeat
          ? withPrimary(item, { to: id })
          : item,
      ),
    };
  };
  if (kind === "parallel") {
    // A parallel group and its Wait for all join are added, and removed, together.
    const joinId = uniqueId(definition, "join");
    const fork: Node = {
      id,
      kind,
      title: `Reviews ${count}`,
      pullRequest: { repository: "", number: 1 },
      branches: [newBranch(capabilities, "reviewer-1", "Reviewer 1")],
      next: joinId,
    };
    const join: Node = {
      id: joinId,
      kind: "join",
      title: "Wait for all",
      fork: id,
      rules: [],
      otherwise: { to: target },
    };
    return { id, definition: connect([fork, join]) };
  }
  const node: Node =
    kind === "agent"
      ? ({
          id,
          kind,
          title,
          ...defaultAgent(capabilities),
          next: { to: target },
        } satisfies AgentNode)
      : kind === "check"
        ? { id, kind, title, command: "", args: [], next: { to: target } }
        : kind === "decision"
          ? {
              id,
              kind,
              title,
              // The step it follows runs before it; after another decision, share its source.
              source:
                previous !== undefined && sourceFields(previous, definition).size > 0
                  ? previous.id
                  : previous?.kind === "decision"
                    ? previous.source
                    : "",
              rules: [],
              otherwise: { to: target },
            }
          : { id, kind, title, approve: { to: target }, changes: { to: target } };
  return { id, definition: connect([node]) };
}

/** Reading order only; routes, not list position, decide execution. */
export function moveStep(definition: Definition, id: string, offset: -1 | 1): Definition {
  const index = definition.nodes.findIndex((node) => node.id === id);
  const destination = index + offset;
  if (index < 0 || destination < 0 || destination >= definition.nodes.length) return definition;
  const nodes = [...definition.nodes];
  const [node] = nodes.splice(index, 1);
  nodes.splice(destination, 0, node!);
  return { ...definition, nodes };
}

/**
 * Removing an agent reconnects its incoming routes to its next step. Anything else that
 * pointed at the removed step stays dangling so validation can show the route to repair.
 */
export function removeStep(definition: Definition, id: string): Definition {
  const removed = definition.nodes.find((node) => node.id === id);
  if (!removed || definition.nodes.length === 1) return definition;
  // A fork and its join are one group: removing either removes both, and routes into the
  // group continue where its join's Otherwise went.
  const fork =
    removed.kind === "parallel"
      ? removed
      : removed.kind === "join"
        ? definition.nodes.find((node) => node.id === removed.fork && node.kind === "parallel")
        : undefined;
  const join = fork ? joinOf(definition, fork.id) : undefined;
  if (fork && join) {
    const ids = new Set([fork.id, join.id]);
    if (definition.nodes.every((node) => ids.has(node.id))) return definition;
    const pruned = { ...definition, nodes: definition.nodes.filter((node) => node.id !== join.id) };
    return removeStepWith(pruned, fork.id, join.otherwise.repeat ? null : join.otherwise.to);
  }
  return removeStepWith(
    definition,
    id,
    (removed.kind === "agent" || removed.kind === "check") && !removed.next.repeat
      ? removed.next.to
      : null,
  );
}
function removeStepWith(
  definition: Definition,
  id: string,
  replacement: string | null,
): Definition {
  // Repeat routes, At limit destinations and decision sources stay dangling on purpose.
  const reroute = (route: Route): Route =>
    replacement !== null && route.to === id && !route.repeat
      ? { ...route, to: replacement }
      : route;
  return {
    ...definition,
    entry: definition.entry === id && replacement !== null ? replacement : definition.entry,
    nodes: definition.nodes
      .filter((node) => node.id !== id)
      .map((node): Node => {
        switch (node.kind) {
          case "agent":
          case "check":
            return {
              ...node,
              next: reroute(node.next),
              ...(node.onUnresolved ? { onUnresolved: reroute(node.onUnresolved) } : {}),
            };
          case "decision":
          case "join":
            return {
              ...node,
              rules: node.rules.map((rule) => ({ ...rule, route: reroute(rule.route) })),
              otherwise: reroute(node.otherwise),
            };
          case "human":
            return { ...node, approve: reroute(node.approve), changes: reroute(node.changes) };
          default:
            return node;
        }
      }),
  };
}

export function updateNode(definition: Definition, id: string, update: (node: Node) => Node) {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => (node.id === id ? update(node) : node)),
  };
}

/** Upstream declared fields a binding may read; mirrors the server's typed binding rule. */
export function upstreamFields(
  definition: Definition,
  nodeId: string,
): ReadonlyArray<{ readonly node: Node; readonly path: string; readonly field: Field }> {
  return definition.nodes.flatMap((node) =>
    node.id === nodeId
      ? []
      : [...sourceFields(node, definition)].map(([path, field]) => ({ node, path, field })),
  );
}

/** Local feedback while typing; the server remains authoritative for publication. */
export function localProblems(definition: Definition): ReadonlyArray<Problem> {
  const problems: Problem[] = [];
  const add = (message: string, nodeId?: string, control?: string) =>
    problems.push({
      severity: "error",
      message,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(control === undefined ? {} : { control }),
    });
  if (!definition.title.trim()) add("Name the workflow.", undefined, "title");
  if (!isId(definition.id))
    add(
      "The workflow ID must start with a letter and use letters, digits, - or _.",
      undefined,
      "id",
    );
  for (const node of definition.nodes) {
    if (!node.title.trim()) add(`${node.id}: add a label.`, node.id, "title");
    if (node.kind === "check") {
      if (!node.command.trim()) add(`${node.id}: add a command.`, node.id, "command");
      if (node.args.some((arg) => arg === ""))
        add(`${node.id}: remove empty arguments.`, node.id, "args");
    }
    if (node.kind === "parallel") {
      if (!node.pullRequest.repository.trim())
        add(
          `${node.id}: enter the pull request's repository (owner/name).`,
          node.id,
          "pullRequest.repository",
        );
      node.branches.forEach((branch, index) => {
        if (!branch.title.trim())
          add(`${node.id}: label reviewer ${index + 1}.`, node.id, `branches.${index}.title`);
        if (!branch.instruction.trim())
          add(
            `${node.id}: give ${branch.title || `reviewer ${index + 1}`} its focus and instructions.`,
            node.id,
            `branches.${index}.instruction`,
          );
      });
    }
    if (node.kind === "decision" || node.kind === "join")
      node.rules.forEach((rule, index) => {
        const visit = (predicate: Predicate, path: ReadonlyArray<number>) => {
          if (predicate.op === "all" || predicate.op === "any")
            predicate.terms?.forEach((term, position) => visit(term, [...path, position]));
          else if (predicate.op === "in" && !predicate.values?.length)
            add(
              `${node.id}: choose at least one value.`,
              node.id,
              [`rules.${index}.when`, ...path].join("."),
            );
          else if (predicate.op === "in" && predicate.values!.length > inValueLimit)
            add(
              `${node.id}: "is one of" accepts at most ${inValueLimit} values.`,
              node.id,
              [`rules.${index}.when`, ...path].join("."),
            );
        };
        visit(rule.when, []);
      });
    if (node.kind !== "agent") continue;
    if (!node.instruction.trim()) add(`${node.id}: add instructions.`, node.id, "instruction");
    node.report.fields.forEach((field, index) => {
      if (!isId(field.name))
        add(
          `${node.id}: report field ${index + 1} needs a name starting with a letter.`,
          node.id,
          `report.fields.${index}`,
        );
    });
    (node.bindings ?? []).forEach((binding, index) => {
      if (!isId(binding.name))
        add(`${node.id}: input ${index + 1} needs a valid name.`, node.id, `bindings.${index}`);
    });
  }
  const decoded = decodeDefinition(definition);
  if (decoded._tag === "Failure" && problems.length === 0)
    add(`The workflow does not match the schema: ${decoded.failure.message.slice(0, 500)}`);
  // Graph rules only read structure, so they still guide an incomplete draft.
  return [...problems, ...definitionDiagnostics(definition)];
}

/** Canonical YAML import: a failure leaves the caller's current draft untouched. */
export function importYaml(text: string):
  | { readonly _tag: "Success"; readonly definition: Definition }
  | {
      readonly _tag: "Failure";
      readonly message: string;
    } {
  let parsed: unknown;
  try {
    parsed = Yaml.parse(text, { maxAliasCount: 32 });
  } catch (cause) {
    return {
      _tag: "Failure",
      message: `Invalid workflow YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const decoded = decodeDefinition(parsed);
  return decoded._tag === "Success"
    ? { _tag: "Success", definition: decoded.success }
    : {
        _tag: "Failure",
        message: `This YAML is not a workflow definition: ${decoded.failure.message.slice(0, 800)}`,
      };
}

export function exportYaml(definition: Definition): {
  readonly text: string;
  readonly protectedValues: number;
} {
  const text = Yaml.stringify(definition);
  return { text, protectedValues: new Set(text.match(new RegExp(protectedPattern, "g"))).size };
}

const operators: Partial<Record<Predicate["op"], string>> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};
const shortPath = (path: string | undefined) => (path ?? "").split(".").at(-1) ?? "";
const valueText = (value: Value | undefined) =>
  typeof value === "string" ? value : value === undefined ? "" : String(value);

/** A compact reading of a rule's predicate for an edge label, e.g. `verdict = changes`. */
export function predicateSummary(predicate: Predicate): string {
  switch (predicate.op) {
    case "all":
    case "any": {
      const terms = predicate.terms ?? [];
      const first = terms[0] === undefined ? "" : predicateSummary(terms[0]);
      return terms.length > 1
        ? `${first} ${predicate.op === "all" ? "and" : "or"} +${terms.length - 1}`
        : first;
    }
    case "in":
      return `${shortPath(predicate.path)} ∈ ${(predicate.values ?? []).map(valueText).join(", ")}`;
    case "present":
      return `${shortPath(predicate.path)} present`;
    case "absent":
      return `${shortPath(predicate.path)} absent`;
    default:
      return `${shortPath(predicate.path)} ${operators[predicate.op] ?? predicate.op} ${valueText(predicate.value)}`;
  }
}

/** A human-readable description of every route in reading order, for the Route list. */
export function routeList(definition: Definition): ReadonlyArray<{
  readonly from: Node;
  readonly control: string;
  readonly label: string;
  readonly to: string;
  readonly repeat: Route["repeat"];
  /** Reads-as text of a decision rule's saved predicate; null for other routes. */
  readonly condition: string | null;
}> {
  const labels: Record<string, string> = {
    next: "Next",
    onUnresolved: "If unresolved",
    otherwise: "Otherwise",
    approve: "Approve",
    changes: "Request changes",
  };
  return definition.nodes.flatMap((from) => {
    const fields =
      from.kind === "decision" || from.kind === "join"
        ? sourceFields(
            from.kind === "join" ? from : definition.nodes.find((node) => node.id === from.source),
            definition,
          )
        : null;
    return routeControls(from).map(({ control, route }) => {
      const rule = control.startsWith("rules.") ? Number(control.split(".")[1] ?? 0) : null;
      const predicate =
        rule !== null && (from.kind === "decision" || from.kind === "join")
          ? from.rules[rule]?.when
          : undefined;
      return {
        from,
        control,
        label: labels[control] ?? `Rule ${(rule ?? 0) + 1}`,
        to: route.to,
        repeat: route.repeat,
        condition: predicate === undefined ? null : readsAs(predicate, fields),
      };
    });
  });
}

const titleOf = (definition: Definition, id: string) =>
  definition.nodes.find((node) => node.id === id)?.title || `${id} (missing)`;
/**
 * One route on one line. A repeat route names its backward direction, its maximum with the
 * total visits it allows (repeat once is two visits) and its At limit destination.
 */
export function routeText(
  definition: Definition,
  route: Pick<ReturnType<typeof routeList>[number], "label" | "to" | "repeat" | "condition">,
): string {
  const when = route.condition === null ? "" : ` (if ${route.condition})`;
  if (!route.repeat) return `${route.label}${when} → ${titleOf(definition, route.to)}`;
  return `${route.label}${when} ↩ ${titleOf(definition, route.to)} · ${repeatBadge(route.repeat)} · at limit → ${titleOf(definition, route.repeat.atLimit)}`;
}
/** `repeat ×1 (2 visits)`: the maximum counts repeats after the first visit. */
export const repeatBadge = (repeat: NonNullable<Route["repeat"]>) =>
  `repeat ×${repeat.max} (${repeat.max + 1} visits)`;

export const sameDefinition = (left: Definition | null, right: Definition | null) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Minimal shape check for a locally persisted draft; full validation happens on use. */
export function isDefinitionLike(value: unknown): value is Definition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; id?: unknown; nodes?: unknown };
  return (
    candidate.version === 1 &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.nodes) &&
    candidate.nodes.every(
      (node: unknown) =>
        typeof node === "object" &&
        node !== null &&
        typeof (node as { id?: unknown }).id === "string" &&
        typeof (node as { kind?: unknown }).kind === "string",
    )
  );
}

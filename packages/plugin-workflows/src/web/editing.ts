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
  type Problem,
  type Route,
} from "../contracts.ts";
import { definitionDiagnostics, routeControls, sourceFields } from "../definition.ts";

type AgentNode = Extract<Node, { kind: "agent" }>;
export type EditableKind = "agent" | "end";
/** Kinds whose controls this client authors; other kinds stay preserved and read-only. */
export const editableKinds: ReadonlyArray<EditableKind> = ["agent", "end"];
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
 * Add a step after `after` (or before the entry when nothing is selected) and keep the
 * sequence connected: the new step inherits the previous outgoing route.
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
  const id = uniqueId(definition, "agent");
  const count = definition.nodes.filter((node) => node.kind === "agent").length + 1;
  const previous = definition.nodes.find((node) => node.id === after);
  const target =
    previous?.kind === "agent" || previous?.kind === "check"
      ? previous.next.to
      : previous === undefined
        ? definition.entry
        : (definition.nodes.find((node) => node.kind === "end")?.id ?? definition.entry);
  const node: AgentNode = {
    id,
    kind: "agent",
    title: `Agent step ${count}`,
    ...defaultAgent(capabilities),
    next: { to: target },
  };
  const index = previous ? definition.nodes.indexOf(previous) + 1 : 0;
  const nodes = [...definition.nodes];
  nodes.splice(index, 0, node);
  return {
    id,
    definition: {
      ...definition,
      entry: previous === undefined ? id : definition.entry,
      nodes: nodes.map((item) =>
        item.id === after && (item.kind === "agent" || item.kind === "check") && !item.next.repeat
          ? { ...item, next: { to: id } }
          : item,
      ),
    },
  };
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
  const replacement = removed.kind === "agent" && !removed.next.repeat ? removed.next.to : null;
  const reroute = (route: Route): Route =>
    replacement !== null && route.to === id && !route.repeat
      ? { ...route, to: replacement }
      : route;
  return {
    ...definition,
    entry: definition.entry === id && replacement !== null ? replacement : definition.entry,
    nodes: definition.nodes
      .filter((node) => node.id !== id)
      .map((node) =>
        node.kind === "agent" && node.id !== id
          ? {
              ...node,
              next: reroute(node.next),
              ...(node.onUnresolved ? { onUnresolved: reroute(node.onUnresolved) } : {}),
            }
          : node,
      ),
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

/** A human-readable description of every route in reading order, for the Route list. */
export function routeList(definition: Definition): ReadonlyArray<{
  readonly from: Node;
  readonly control: string;
  readonly label: string;
  readonly to: string;
  readonly repeat: Route["repeat"];
}> {
  const labels: Record<string, string> = {
    next: "Next",
    onUnresolved: "If unresolved",
    otherwise: "Otherwise",
    approve: "Approve",
    changes: "Request changes",
  };
  return definition.nodes.flatMap((from) =>
    routeControls(from).map(({ control, route }) => ({
      from,
      control,
      label: labels[control] ?? `Rule ${Number(control.split(".")[1] ?? 0) + 1}`,
      to: route.to,
      repeat: route.repeat,
    })),
  );
}

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

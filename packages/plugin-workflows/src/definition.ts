import type { Definition, Node, Agent, Field, Predicate, Route, Value } from "./contracts.ts";
import { limits } from "./contracts.ts";

export function routes(node: Node): ReadonlyArray<Route> {
  switch (node.kind) {
    case "agent":
    case "check":
      return [node.next, ...(node.onUnresolved ? [node.onUnresolved] : [])];
    case "decision":
    case "join":
      return [...node.rules.map((rule) => rule.route), node.otherwise];
    case "human":
      return [node.approve, node.changes];
    case "parallel":
      return [{ to: node.next }];
    case "end":
      return [];
  }
}
export function agents(definition: Definition): ReadonlyArray<Agent> {
  return definition.nodes.flatMap((node) =>
    node.kind === "agent" ? [node] : node.kind === "parallel" ? node.branches : [],
  );
}
export function matchesField(field: Field, value: unknown): boolean {
  return field.type === "enum"
    ? typeof value === "string" && (field.values?.includes(value) ?? false)
    : field.type === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : typeof value === field.type;
}
export function dataProblems(
  fields: ReadonlyArray<Field>,
  data: Readonly<Record<string, Value>>,
): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(data, field.name)) {
      if (field.required) errors.push(`data.${field.name} is required.`);
    } else if (!matchesField(field, data[field.name]))
      errors.push(`data.${field.name} must be ${field.type}.`);
  }
  for (const name of Object.keys(data))
    if (!fields.some((field) => field.name === name)) errors.push(`data.${name} is not declared.`);
  return errors;
}
function reportFields(agent: Agent): Map<string, Field> {
  return new Map([
    ["version", { name: "version", type: "number", required: true }],
    ["clientRetryKey", { name: "clientRetryKey", type: "string", required: true }],
    [
      "outcome",
      { name: "outcome", type: "enum", required: true, values: ["completed", "blocked", "failed"] },
    ],
    ["summary", { name: "summary", type: "string", required: true }],
    ...agent.report.fields.map((field) => [`data.${field.name}`, field] as const),
  ]);
}
function sourceFields(node: Node | undefined, definition: Definition): Map<string, Field> {
  if (node?.kind === "agent") return reportFields(node);
  if (node?.kind === "check")
    return new Map([
      [
        "outcome",
        {
          name: "outcome",
          type: "enum",
          required: true,
          values: ["completed", "failed", "unresolved"],
        },
      ],
      ["exitCode", { name: "exitCode", type: "number", required: false }],
      ["timedOut", { name: "timedOut", type: "boolean", required: true }],
      ["interrupted", { name: "interrupted", type: "boolean", required: true }],
    ]);
  if (node?.kind === "join") {
    const fields = new Map<string, Field>([
      [
        "result",
        {
          name: "result",
          type: "enum",
          required: true,
          values: ["all_completed", "failed", "unresolved", "canceled", "stale"],
        },
      ],
    ]);
    const fork = definition.nodes.find((item) => item.id === node.fork);
    if (fork?.kind === "parallel")
      for (const branch of fork.branches)
        for (const [name, field] of reportFields(branch))
          fields.set(`branches.${branch.id}.${name}`, field);
    return fields;
  }
  return new Map();
}
export function definitionProblems(definition: Definition): string[] {
  const errors: string[] = [];
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  if (nodes.size !== definition.nodes.length) errors.push("Node identities must be unique.");
  if (!nodes.has(definition.entry)) errors.push("The entry node does not exist.");
  const terminal = (id: string) => ["end", "human"].includes(nodes.get(id)?.kind ?? "");
  if (!terminal(definition.atLimit))
    errors.push("The run At limit destination must be an end or human gate.");
  let edges = 0;
  for (const node of definition.nodes) {
    for (const route of routes(node)) {
      edges++;
      if (!nodes.has(route.to)) errors.push(`${node.id}: unknown route target ${route.to}.`);
      if (route.repeat) {
        edges++;
        if (!terminal(route.repeat.atLimit))
          errors.push(`${node.id}: repeat At limit must be an end or human gate.`);
      }
    }
    if (node.kind === "parallel") {
      if (new Set(node.branches.map((branch) => branch.id)).size !== node.branches.length)
        errors.push(`${node.id}: duplicate branch identity.`);
      if (
        nodes.get(node.next)?.kind !== "join" ||
        (nodes.get(node.next) as Extract<Node, { kind: "join" }>).fork !== node.id
      )
        errors.push(`${node.id}: the next node must join this fork.`);
      for (const branch of node.branches)
        if (branch.interactionMode !== "plan" || branch.runtimeMode !== "approval-required")
          errors.push(
            `${node.id}/${branch.id}: reviewers require native plan mode with approval-required external actions.`,
          );
    }
    if (node.kind === "join" && nodes.get(node.fork)?.kind !== "parallel")
      errors.push(`${node.id}: unknown fork.`);
    if (node.kind === "decision" || node.kind === "join") {
      const fields = sourceFields(node.kind === "join" ? node : nodes.get(node.source), definition);
      if (fields.size === 0)
        errors.push(`${node.id}: decisions require a report, check or join source.`);
      let terms = 0;
      const visit = (predicate: Predicate, depth: number) => {
        terms++;
        if (depth > limits.predicateDepth) {
          errors.push(`${node.id}: predicate nesting exceeds ${limits.predicateDepth}.`);
          return;
        }
        if (predicate.op === "all" || predicate.op === "any") {
          for (const term of predicate.terms ?? []) visit(term, depth + 1);
          return;
        }
        const field = fields.get(predicate.path ?? "");
        if (!field) {
          errors.push(`${node.id}: unknown predicate path ${predicate.path}.`);
          return;
        }
        if (["gt", "gte", "lt", "lte"].includes(predicate.op) && field.type !== "number")
          errors.push(`${node.id}: numeric comparison requires a number field.`);
        if (predicate.op === "in" && !["string", "enum"].includes(field.type))
          errors.push(`${node.id}: membership requires a string or enum.`);
        for (const value of predicate.values ??
          (predicate.value === undefined ? [] : [predicate.value]))
          if (!matchesField(field, value))
            errors.push(`${node.id}: predicate operand is incompatible with ${predicate.path}.`);
      };
      for (const rule of node.rules) visit(rule.when, 1);
      if (terms > limits.predicateTerms) errors.push(`${node.id}: too many predicate terms.`);
    }
  }
  if (edges > limits.edges) errors.push(`At most ${limits.edges} edges are allowed.`);
  for (const agent of agents(definition)) {
    if (new Set(agent.report.fields.map((field) => field.name)).size !== agent.report.fields.length)
      errors.push("Report field names must be unique.");
    for (const field of agent.report.fields)
      if (
        field.type === "enum"
          ? !field.values?.length || new Set(field.values).size !== field.values.length
          : field.values !== undefined
      )
        errors.push(`Field ${field.name} has an invalid enum contract.`);
    for (const binding of agent.bindings ?? []) {
      const field = sourceFields(nodes.get(binding.node), definition).get(binding.path);
      if (
        !field ||
        field.type !== binding.field.type ||
        binding.name !== binding.field.name ||
        (field.type === "enum" &&
          field.values?.some((value) => !binding.field.values?.includes(value)))
      )
        errors.push(`Invalid input binding ${binding.name}.`);
    }
    if (
      new Set(agent.bindings?.map((binding) => binding.name)).size !== (agent.bindings?.length ?? 0)
    )
      errors.push("Input names must be unique.");
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) {
      errors.push("Every cycle must cross a bounded repeat route.");
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const route of routes(nodes.get(id)!))
      if (!route.repeat && nodes.has(route.to)) walk(route.to);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) walk(id);
  const canReachTerminal = (id: string, seen = new Set<string>()): boolean => {
    if (terminal(id)) return true;
    if (seen.has(id) || !nodes.has(id)) return false;
    seen.add(id);
    return routes(nodes.get(id)!).some(
      (route) =>
        canReachTerminal(route.to, new Set(seen)) ||
        (route.repeat !== undefined && terminal(route.repeat.atLimit)),
    );
  };
  for (const id of nodes.keys()) if (!canReachTerminal(id)) errors.push(`${id}: no terminal path.`);
  return errors;
}
export function evaluate(predicate: Predicate, values: Readonly<Record<string, Value>>): boolean {
  if (predicate.op === "all") return predicate.terms!.every((term) => evaluate(term, values));
  if (predicate.op === "any") return predicate.terms!.some((term) => evaluate(term, values));
  const present = Object.hasOwn(values, predicate.path!);
  if (predicate.op === "present") return present;
  if (predicate.op === "absent") return !present;
  if (!present) return false;
  const value = values[predicate.path!];
  switch (predicate.op) {
    case "eq":
      return value === predicate.value;
    case "ne":
      return value !== predicate.value;
    case "in":
      return predicate.values!.includes(value!);
    case "gt":
      return typeof value === "number" && value > Number(predicate.value);
    case "gte":
      return typeof value === "number" && value >= Number(predicate.value);
    case "lt":
      return typeof value === "number" && value < Number(predicate.value);
    case "lte":
      return typeof value === "number" && value <= Number(predicate.value);
  }
}

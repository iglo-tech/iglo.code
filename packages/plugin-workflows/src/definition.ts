import type {
  Definition,
  Node,
  Agent,
  Field,
  Predicate,
  Problem,
  Route,
  Value,
} from "./contracts.ts";
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
/** Declared fields a decision, binding or predicate may read from a source node. */
export function sourceFields(node: Node | undefined, definition: Definition): Map<string, Field> {
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
/** Each outgoing route with the inspector control that owns it. */
export function routeControls(node: Node): ReadonlyArray<{ control: string; route: Route }> {
  switch (node.kind) {
    case "agent":
    case "check":
      return [
        { control: "next", route: node.next },
        ...(node.onUnresolved ? [{ control: "onUnresolved", route: node.onUnresolved }] : []),
      ];
    case "decision":
    case "join":
      return [
        ...node.rules.map((rule, index) => ({ control: `rules.${index}`, route: rule.route })),
        { control: "otherwise", route: node.otherwise },
      ];
    case "human":
      return [
        { control: "approve", route: node.approve },
        { control: "changes", route: node.changes },
      ];
    case "parallel":
      return [{ control: "next", route: { to: node.next } }];
    case "end":
      return [];
  }
}
const routeNames: Record<string, string> = {
  next: "Next",
  onUnresolved: "If unresolved",
  otherwise: "Otherwise",
  approve: "Approve",
  changes: "Request changes",
};
const routeName = (control: string) =>
  control.startsWith("rules.")
    ? `Rule ${Number(control.split(".")[1]) + 1}`
    : (routeNames[control] ?? control);
/** Located validation results; errors block publication, warnings never do. */
export function definitionDiagnostics(definition: Definition): Problem[] {
  const problems: Problem[] = [];
  const add = (
    message: string,
    location: { readonly nodeId?: string; readonly control?: string } = {},
    severity: Problem["severity"] = "error",
  ) => problems.push({ severity, message, ...location });
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  if (nodes.size !== definition.nodes.length) add("Node identities must be unique.");
  if (!nodes.has(definition.entry)) add("The entry node does not exist.", { control: "entry" });
  if (nodes.get(definition.entry)?.kind === "join")
    add("The entry node cannot be a join; start at its fork.", { control: "entry" });
  const terminal = (id: string) => ["end", "human"].includes(nodes.get(id)?.kind ?? "");
  if (!terminal(definition.atLimit))
    add("The run At limit destination must be an end or human gate.", { control: "atLimit" });
  let edges = 0;
  for (const node of definition.nodes) {
    // Repeat counters are keyed by step and Return to, so two such routes would share one.
    const repeatTargets = new Map<string, string>();
    for (const { control, route } of routeControls(node)) {
      edges++;
      if (route.repeat) {
        const first = repeatTargets.get(route.to);
        if (first === undefined) repeatTargets.set(route.to, control);
        else
          add(
            `${node.id}: ${routeName(first)} already repeats back to ${route.to}, and repeats from one step to the same step share one counter. Return to a different step or keep a single repeat route.`,
            { nodeId: node.id, control: `${control}.repeat` },
          );
      }
      if (!nodes.has(route.to))
        add(`${node.id}: unknown route target ${route.to}.`, { nodeId: node.id, control });
      const target = nodes.get(route.to);
      if (target?.kind === "join" && (node.kind !== "parallel" || node.id !== target.fork))
        add(`${node.id}: join ${target.id} must be entered through fork ${target.fork}.`, {
          nodeId: node.id,
          control,
        });
      if (route.repeat) {
        edges++;
        if (!terminal(route.repeat.atLimit))
          add(`${node.id}: repeat At limit must be an end or human gate.`, {
            nodeId: node.id,
            control: `${control}.repeat`,
          });
      }
    }
    if (node.kind === "parallel") {
      if (new Set(node.branches.map((branch) => branch.id)).size !== node.branches.length)
        add(`${node.id}: duplicate branch identity.`, { nodeId: node.id, control: "branches" });
      if (
        nodes.get(node.next)?.kind !== "join" ||
        (nodes.get(node.next) as Extract<Node, { kind: "join" }>).fork !== node.id
      )
        add(`${node.id}: the next node must join this fork.`, { nodeId: node.id, control: "next" });
      node.branches.forEach((branch, index) => {
        if (branch.interactionMode !== "plan" || branch.runtimeMode !== "approval-required")
          add(
            `${node.id}/${branch.id}: reviewers require native plan mode with approval-required external actions.`,
            { nodeId: node.id, control: `branches.${index}` },
          );
      });
    }
    if (node.kind === "join" && nodes.get(node.fork)?.kind !== "parallel")
      add(`${node.id}: unknown fork.`, { nodeId: node.id, control: "fork" });
    if (node.kind === "decision" || node.kind === "join") {
      const fields = sourceFields(node.kind === "join" ? node : nodes.get(node.source), definition);
      if (fields.size === 0)
        add(`${node.id}: decisions require a report, check or join source.`, {
          nodeId: node.id,
          control: node.kind === "join" ? "fork" : "source",
        });
      let terms = 0;
      const visit = (predicate: Predicate, depth: number, control: string) => {
        terms++;
        if (depth > limits.predicateDepth) {
          add(`${node.id}: predicate nesting exceeds ${limits.predicateDepth}.`, {
            nodeId: node.id,
            control,
          });
          return;
        }
        if (predicate.op === "all" || predicate.op === "any") {
          // Each term is located by its index path, so a problem names the exact condition.
          (predicate.terms ?? []).forEach((term, index) =>
            visit(term, depth + 1, `${control}.${index}`),
          );
          return;
        }
        const field = fields.get(predicate.path ?? "");
        if (!field) {
          // A join rule that reads a removed reviewer names it, so the dangling rule is obvious.
          const reviewer =
            node.kind === "join"
              ? /^branches\.([^.]+)\./.exec(predicate.path ?? "")?.[1]
              : undefined;
          const fork = node.kind === "join" ? nodes.get(node.fork) : undefined;
          add(
            reviewer !== undefined &&
              fork?.kind === "parallel" &&
              !fork.branches.some((branch) => branch.id === reviewer)
              ? `${node.id}: a rule reads reviewer ${reviewer}, which is no longer in ${fork.id}. Choose another field or remove the condition.`
              : `${node.id}: unknown predicate path ${predicate.path}.`,
            { nodeId: node.id, control },
          );
          return;
        }
        if (["gt", "gte", "lt", "lte"].includes(predicate.op) && field.type !== "number")
          add(`${node.id}: numeric comparison requires a number field.`, {
            nodeId: node.id,
            control,
          });
        if (predicate.op === "in" && !["string", "enum"].includes(field.type))
          add(`${node.id}: membership requires a string or enum.`, { nodeId: node.id, control });
        for (const value of predicate.values ??
          (predicate.value === undefined ? [] : [predicate.value]))
          if (!matchesField(field, value))
            add(`${node.id}: predicate operand is incompatible with ${predicate.path}.`, {
              nodeId: node.id,
              control,
            });
      };
      node.rules.forEach((rule, index) => visit(rule.when, 1, `rules.${index}.when`));
      if (terms > limits.predicateTerms)
        add(`${node.id}: too many predicate terms.`, { nodeId: node.id, control: "rules" });
    }
  }
  if (edges > limits.edges) add(`At most ${limits.edges} edges are allowed.`);
  for (const { nodeId, prefix, agent } of agentLocations(definition)) {
    if (new Set(agent.report.fields.map((field) => field.name)).size !== agent.report.fields.length)
      add("Report field names must be unique.", { nodeId, control: `${prefix}report.fields` });
    agent.report.fields.forEach((field, index) => {
      if (
        field.type === "enum"
          ? !field.values?.length || new Set(field.values).size !== field.values.length
          : field.values !== undefined
      )
        add(`Field ${field.name} has an invalid enum contract.`, {
          nodeId,
          control: `${prefix}report.fields.${index}`,
        });
    });
    (agent.bindings ?? []).forEach((binding, index) => {
      const field = sourceFields(nodes.get(binding.node), definition).get(binding.path);
      if (
        !field ||
        field.type !== binding.field.type ||
        binding.name !== binding.field.name ||
        (field.type === "enum" &&
          field.values?.some((value) => !binding.field.values?.includes(value)))
      )
        add(`Invalid input binding ${binding.name}.`, {
          nodeId,
          control: `${prefix}bindings.${index}`,
        });
    });
    if (
      new Set(agent.bindings?.map((binding) => binding.name)).size !== (agent.bindings?.length ?? 0)
    )
      add("Input names must be unique.", { nodeId, control: `${prefix}bindings` });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visiting.has(id)) {
      add("Every cycle must cross a bounded repeat route.", { nodeId: id });
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
  const destinations = (node: Node) =>
    routes(node).flatMap((route) => [
      route.to,
      ...(route.repeat && terminal(route.repeat.atLimit) ? [route.repeat.atLimit] : []),
    ]);
  const predecessors = new Map<string, string[]>();
  for (const node of nodes.values())
    for (const destination of destinations(node)) {
      const previous = predecessors.get(destination) ?? [];
      previous.push(node.id);
      predecessors.set(destination, previous);
    }
  // A decision can only read a source that runs before it on some path.
  for (const node of definition.nodes) {
    if (node.kind !== "decision" || !nodes.has(node.source)) continue;
    const before = upstreamOf(definition, node.id);
    if (!before.has(node.source))
      add(
        `${node.id}: ${node.source} never runs before this decision, so there is no result to decide on. Choose an earlier step.`,
        { nodeId: node.id, control: "source" },
      );
  }
  const reachable = new Set([...nodes.keys()].filter(terminal));
  const pending = [...reachable];
  for (let index = 0; index < pending.length; index++)
    for (const predecessor of predecessors.get(pending[index]!) ?? [])
      if (!reachable.has(predecessor)) {
        reachable.add(predecessor);
        pending.push(predecessor);
      }
  for (const id of nodes.keys())
    if (!reachable.has(id)) add(`${id}: no terminal path.`, { nodeId: id });
  // The engine also routes to the run At limit destination when the visit bound is reached.
  const entered = new Set(nodes.has(definition.entry) ? [definition.entry] : []);
  if (nodes.has(definition.atLimit)) entered.add(definition.atLimit);
  const frontier = [...entered];
  for (let index = 0; index < frontier.length; index++)
    for (const destination of destinations(nodes.get(frontier[index]!)!))
      if (nodes.has(destination) && !entered.has(destination)) {
        entered.add(destination);
        frontier.push(destination);
      }
  for (const node of definition.nodes)
    if (node.kind === "end" && !entered.has(node.id))
      add(
        `${node.id}: this end is unreachable from the entry step.`,
        { nodeId: node.id },
        "warning",
      );
  return problems;
}
/** Steps that run before `id` on some path, following every route and repeat At limit. */
export function upstreamOf(definition: Definition, id: string): Set<string> {
  const predecessors = new Map<string, string[]>();
  for (const node of definition.nodes)
    for (const route of routes(node))
      for (const to of [route.to, ...(route.repeat ? [route.repeat.atLimit] : [])])
        predecessors.set(to, [...(predecessors.get(to) ?? []), node.id]);
  const before = new Set<string>();
  const queue = [id];
  for (let index = 0; index < queue.length; index++)
    for (const predecessor of predecessors.get(queue[index]!) ?? [])
      if (!before.has(predecessor)) {
        before.add(predecessor);
        queue.push(predecessor);
      }
  return before;
}
export function definitionProblems(definition: Definition): string[] {
  return definitionDiagnostics(definition)
    .filter((problem) => problem.severity === "error")
    .map((problem) => problem.message);
}
/** Agents with the node and inspector-control prefix that owns them. */
export function agentLocations(definition: Definition) {
  return definition.nodes.flatMap((node) =>
    node.kind === "agent"
      ? [{ nodeId: node.id, prefix: "", agent: node as Agent }]
      : node.kind === "parallel"
        ? node.branches.map((branch, index) => ({
            nodeId: node.id,
            prefix: `branches.${index}.`,
            agent: branch as Agent,
          }))
        : [],
  );
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

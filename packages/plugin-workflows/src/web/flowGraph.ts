import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { Definition, Node } from "../contracts.ts";
import { routeControls } from "../definition.ts";
import { predicateSummary, repeatBadge } from "./editing.ts";

/** A drawn box: a step, one reviewer lane of a parallel group, or a route target that is gone. */
export interface FlowNode {
  readonly id: string;
  /** The definition step that owns the box; selecting the box selects this step. */
  readonly stepId: string;
  readonly kind: Node["kind"] | "branch" | "missing";
  readonly title: string;
  readonly detail: string | null;
  readonly entry: boolean;
  /** The run's At limit destination for the whole-run visit bound. */
  readonly runLimit: boolean;
}
export type FlowEdgeKind =
  | "next"
  | "unresolved"
  | "rule"
  | "otherwise"
  | "approve"
  | "changes"
  | "fork"
  | "join"
  | "repeat"
  | "atLimit";
export interface FlowEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: FlowEdgeKind;
  /** Short drawn label; a repeat's has two lines (route, then bound). */
  readonly label: string;
  /** The full route text, shown on hover. */
  readonly title: string;
  /** A repeat route back to an earlier step; drawn beside the flow instead of through it. */
  readonly back: boolean;
  /** The step and inspector control that own the route; null for reviewer lane edges. */
  readonly route: { readonly stepId: string; readonly control: string } | null;
  /** Points at a step that no longer exists; drawn as an error until repaired. */
  readonly dangling: boolean;
}
export interface FlowGraph {
  readonly nodes: ReadonlyArray<FlowNode>;
  readonly edges: ReadonlyArray<FlowEdge>;
}

const clip = (text: string, length = 34) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function routeLabel(
  node: Node,
  control: string,
): { kind: FlowEdgeKind; label: string; title: string } {
  if (control === "next") return { kind: "next", label: "next", title: "next" };
  if (control === "onUnresolved")
    return { kind: "unresolved", label: "unresolved", title: "unresolved" };
  if (control === "otherwise") return { kind: "otherwise", label: "otherwise", title: "otherwise" };
  if (control === "approve") return { kind: "approve", label: "approve", title: "approve" };
  if (control === "changes") return { kind: "changes", label: "changes", title: "changes" };
  const index = Number(control.split(".")[1] ?? 0);
  const rule = node.kind === "decision" || node.kind === "join" ? node.rules[index] : undefined;
  const summary = rule === undefined ? control : predicateSummary(rule.when);
  return { kind: "rule", label: clip(summary, 24), title: summary };
}

function detailOf(node: Node): string | null {
  switch (node.kind) {
    case "agent":
      return node.skill ?? null;
    case "check":
      return clip([node.command, ...node.args].join(" "), 32);
    case "parallel":
      return `${node.branches.length} reviewer${node.branches.length === 1 ? "" : "s"}`;
    case "join":
      return "wait for all";
    case "end":
      return node.outcome;
    default:
      return null;
  }
}

/**
 * Every node and route the canonical schema can express, as boxes and labelled edges. Parallel
 * reviewers become sibling boxes between their fork and join; a repeat route is a back edge
 * plus a dashed edge to its At limit destination; a route to a missing step points at a
 * placeholder so the dangling route stays visible.
 */
export function flowGraph(definition: Definition): FlowGraph {
  const ids = new Set(definition.nodes.map((node) => node.id));
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const missing = new Set<string>();
  const target = (id: string) => {
    if (ids.has(id)) return id;
    missing.add(id);
    return `missing:${id}`;
  };
  for (const node of definition.nodes) {
    nodes.push({
      id: node.id,
      stepId: node.id,
      kind: node.kind,
      title: node.title || node.id,
      detail: detailOf(node),
      entry: definition.entry === node.id,
      runLimit: definition.atLimit === node.id,
    });
    if (node.kind === "parallel") {
      for (const branch of node.branches) {
        const id = `${node.id}/${branch.id}`;
        nodes.push({
          id,
          stepId: node.id,
          kind: "branch",
          title: branch.title || branch.id,
          detail: branch.skill ?? null,
          entry: false,
          runLimit: false,
        });
        edges.push({
          id: `${node.id}->${id}`,
          source: node.id,
          target: id,
          kind: "fork",
          label: "",
          title: "",
          back: false,
          route: null,
          dangling: false,
        });
        edges.push({
          id: `${id}->${node.next}`,
          source: id,
          target: target(node.next),
          kind: "join",
          label: "",
          title: "",
          back: false,
          route: null,
          dangling: !ids.has(node.next),
        });
      }
      if (node.branches.length > 0) continue;
    }
    const controls = routeControls(node);
    const repeats = controls.filter(({ route }) => route.repeat !== undefined).length;
    for (const { control, route } of controls) {
      const { kind, label, title } = routeLabel(node, control);
      const owner = { stepId: node.id, control };
      if (route.repeat === undefined) {
        edges.push({
          id: `${node.id}:${control}`,
          source: node.id,
          target: target(route.to),
          kind,
          label,
          title,
          back: false,
          route: owner,
          dangling: !ids.has(route.to),
        });
        continue;
      }
      // The back edge names its direction and bound; its At limit is a separate dashed edge,
      // prefixed with the route only when the step has more than one repeat to tell apart.
      const prefix = kind === "next" ? "" : `${label} · `;
      const bound = `↩ ×${route.repeat.max} · ${route.repeat.max + 1} visits`;
      edges.push({
        id: `${node.id}:${control}`,
        source: node.id,
        target: target(route.to),
        kind: "repeat",
        label: kind === "next" ? bound : `${label}\n${bound}`,
        title: `${kind === "next" ? "" : `${title} · `}↩ ${repeatBadge(route.repeat)}`,
        back: true,
        route: owner,
        dangling: !ids.has(route.to),
      });
      edges.push({
        id: `${node.id}:${control}.repeat`,
        source: node.id,
        target: target(route.repeat.atLimit),
        kind: "atLimit",
        label: repeats > 1 ? `${prefix}at limit` : "at limit",
        title: `${kind === "next" ? "" : `${title} · `}at limit after ${repeatBadge(route.repeat)}`,
        back: false,
        route: { stepId: node.id, control: `${control}.repeat` },
        dangling: !ids.has(route.repeat.atLimit),
      });
    }
  }
  for (const id of missing)
    nodes.push({
      id: `missing:${id}`,
      stepId: id,
      kind: "missing",
      title: id,
      detail: "missing",
      entry: false,
      runLimit: false,
    });
  return { nodes, edges };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface FlowLayout {
  /** Top-left corner of each box. */
  readonly positions: ReadonlyMap<string, Point>;
  readonly sizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  /** Routed points and label centre for each forward edge; back edges are drawn beside the flow. */
  readonly routes: ReadonlyMap<
    string,
    { readonly points: ReadonlyArray<Point>; readonly label: Point | null }
  >;
}

export const nodeSize = (node: FlowNode) =>
  node.kind === "branch"
    ? { width: 200, height: 52 }
    : node.kind === "missing"
      ? { width: 176, height: 44 }
      : { width: 232, height: 60 };

/**
 * Everything the layout reads: box identities and kinds (sizes) and each edge's ends, label and
 * direction. Titles, details and markers are not in it, so typing a name never relays out.
 */
export function layoutSignature(graph: FlowGraph): string {
  return JSON.stringify([
    graph.nodes.map((node) => [node.id, node.kind]),
    graph.edges.map((edge) => [edge.id, edge.source, edge.target, edge.label, edge.back]),
  ]);
}

/** Approximate drawn width of an edge label (11px medium text plus padding), by its longest line. */
export const labelWidth = (label: string) =>
  Math.max(...label.split("\n").map((line) => line.length)) * 6.5 + 16;
/** Approximate drawn height of an edge label: 18px per line plus its border. */
export const labelHeight = (label: string) => label.split("\n").length * 18 + 2;

/** Top-to-bottom layered layout. Repeat routes are left out so they never push steps around. */
export function layoutFlow(graph: FlowGraph): FlowLayout {
  const layout = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  layout.setGraph({
    rankdir: "TB",
    nodesep: 40,
    ranksep: 56,
    edgesep: 24,
    marginx: 16,
    marginy: 16,
  });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) layout.setNode(node.id, { ...nodeSize(node) });
  for (const edge of graph.edges) {
    if (edge.back) continue;
    layout.setEdge(
      edge.source,
      edge.target,
      edge.label === ""
        ? { minlen: 1 }
        : {
            minlen: 1,
            width: labelWidth(edge.label),
            height: labelHeight(edge.label),
            labelpos: "c",
          },
      edge.id,
    );
  }
  dagre.layout(layout);
  const positions = new Map<string, Point>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    const placed = layout.node(node.id);
    const size = nodeSize(node);
    sizes.set(node.id, size);
    positions.set(node.id, {
      x: (placed?.x ?? 0) - size.width / 2,
      y: (placed?.y ?? 0) - size.height / 2,
    });
  }
  const routes = new Map<string, { points: ReadonlyArray<Point>; label: Point | null }>();
  for (const edge of graph.edges) {
    if (edge.back) continue;
    const routed = layout.edge({ v: edge.source, w: edge.target, name: edge.id });
    if (routed?.points === undefined) continue;
    routes.set(edge.id, {
      points: routed.points.map((point: Point) => ({ x: point.x, y: point.y })),
      label:
        edge.label === "" || routed.x === undefined || routed.y === undefined
          ? null
          : { x: routed.x, y: routed.y },
    });
  }
  return { positions, sizes, routes };
}

/** A smooth path through routed points (uniform B-spline, as d3's curveBasis). */
export function splinePath(points: ReadonlyArray<Point>): string {
  if (points.length === 0) return "";
  const [first] = points;
  if (points.length < 3)
    return points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
      .join(" ");
  let path = `M${first!.x},${first!.y}`;
  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))]!;
  path += ` L${(5 * at(0).x + at(1).x) / 6},${(5 * at(0).y + at(1).y) / 6}`;
  for (let index = 1; index < points.length - 1; index++) {
    const previous = at(index - 1);
    const current = at(index);
    const next = at(index + 1);
    path += ` C${(2 * previous.x + current.x) / 3},${(2 * previous.y + current.y) / 3} ${(previous.x + 2 * current.x) / 3},${(previous.y + 2 * current.y) / 3} ${(previous.x + 4 * current.x + next.x) / 6},${(previous.y + 4 * current.y + next.y) / 6}`;
  }
  const last = at(points.length - 1);
  const before = at(points.length - 2);
  path += ` C${(2 * before.x + last.x) / 3},${(2 * before.y + last.y) / 3} ${(before.x + 2 * last.x) / 3},${(before.y + 2 * last.y) / 3} ${last.x},${last.y}`;
  return path;
}

export interface RepeatLoop {
  /** The x of the loop's vertical run. */
  readonly x: number;
  /** Vertical centre of the loop, where its label sits. */
  readonly y: number;
  readonly labelWidth: number;
}

/**
 * Where each repeat back edge runs: right of every box, forward-edge label and earlier loop
 * (with its label) in the ranks it spans, so the loop and its label never touch a card.
 */
export function repeatLoops(graph: FlowGraph, layout: FlowLayout): ReadonlyMap<string, RepeatLoop> {
  const loops = new Map<string, RepeatLoop & { top: number; bottom: number }>();
  const labels = new Map(graph.edges.map((edge) => [edge.id, edge.label]));
  for (const edge of graph.edges) {
    if (!edge.back) continue;
    const source = layout.positions.get(edge.source);
    const target = layout.positions.get(edge.target);
    const sourceSize = layout.sizes.get(edge.source);
    const targetSize = layout.sizes.get(edge.target);
    if (!source || !target || !sourceSize || !targetSize) continue;
    const top = Math.min(source.y, target.y);
    const bottom = Math.max(source.y + sourceSize.height, target.y + targetSize.height);
    let right = Math.max(source.x + sourceSize.width, target.x + targetSize.width);
    for (const [id, position] of layout.positions) {
      const size = layout.sizes.get(id)!;
      if (position.y < bottom && position.y + size.height > top)
        right = Math.max(right, position.x + size.width);
    }
    for (const [id, route] of layout.routes)
      if (route.label !== null && route.label.y > top - 12 && route.label.y < bottom + 12)
        right = Math.max(right, route.label.x + labelWidth(labels.get(id) ?? "") / 2);
    for (const loop of loops.values())
      if (loop.top < bottom && loop.bottom > top)
        right = Math.max(right, loop.x + 6 + loop.labelWidth);
    loops.set(edge.id, {
      x: right + 32,
      y: (source.y + sourceSize.height / 2 + target.y + targetSize.height / 2) / 2,
      labelWidth: edge.label === "" ? 0 : labelWidth(edge.label),
      top,
      bottom,
    });
  }
  return loops;
}

/** A rounded loop out to `x` and back, entering the target from the side. */
export function loopPath(source: Point, target: Point, x: number): string {
  const direction = target.y < source.y ? -1 : 1;
  const radius = Math.max(
    0,
    Math.min(12, Math.abs(target.y - source.y) / 2, x - source.x, x - target.x),
  );
  return [
    `M${source.x},${source.y}`,
    `L${x - radius},${source.y}`,
    `Q${x},${source.y} ${x},${source.y + direction * radius}`,
    `L${x},${target.y - direction * radius}`,
    `Q${x},${target.y} ${x - radius},${target.y}`,
    `L${target.x},${target.y}`,
  ].join(" ");
}

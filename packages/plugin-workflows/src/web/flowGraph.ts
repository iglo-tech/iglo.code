import { getViewportForBounds } from "@xyflow/react";
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { Definition, Node } from "../contracts.ts";
import { routeControls } from "../definition.ts";
import { predicateSummary } from "./editing.ts";

/** A drawn box: a step, one reviewer lane of a parallel group, or a route target that is gone. */
export interface FlowNode {
  readonly id: string;
  /** The definition step that owns the box; selecting the box selects this step. */
  readonly stepId: string;
  readonly kind: Node["kind"] | "branch" | "missing";
  readonly title: string;
  readonly detail: string | null;
  /** Position of a reviewer lane within its group, matching `branches.<index>` problem controls. */
  readonly lane?: number;
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
  readonly label: string;
  /** The unshortened label, for its tooltip. */
  readonly fullLabel: string;
  /** A repeat route back to an earlier step; drawn beside the flow instead of through it. */
  readonly back: boolean;
}
export interface FlowGraph {
  readonly nodes: ReadonlyArray<FlowNode>;
  readonly edges: ReadonlyArray<FlowEdge>;
}

const clip = (text: string, length = 34) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function routeLabel(node: Node, control: string): { kind: FlowEdgeKind; label: string } {
  if (control === "next") return { kind: "next", label: "next" };
  if (control === "onUnresolved") return { kind: "unresolved", label: "unresolved" };
  if (control === "otherwise") return { kind: "otherwise", label: "otherwise" };
  if (control === "approve") return { kind: "approve", label: "approve" };
  if (control === "changes") return { kind: "changes", label: "changes" };
  const index = Number(control.split(".")[1] ?? 0);
  const rule = node.kind === "decision" || node.kind === "join" ? node.rules[index] : undefined;
  return { kind: "rule", label: rule === undefined ? control : predicateSummary(rule.when) };
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
      for (const [lane, branch] of node.branches.entries()) {
        const id = `${node.id}/${branch.id}`;
        nodes.push({
          id,
          stepId: node.id,
          kind: "branch",
          title: branch.title || branch.id,
          detail: branch.skill ?? null,
          lane,
          entry: false,
          runLimit: false,
        });
        edges.push({
          id: `${node.id}->${id}`,
          source: node.id,
          target: id,
          kind: "fork",
          label: "",
          fullLabel: "",
          back: false,
        });
        edges.push({
          id: `${id}->${node.next}`,
          source: id,
          target: target(node.next),
          kind: "join",
          label: "",
          fullLabel: "",
          back: false,
        });
      }
      if (node.branches.length > 0) continue;
    }
    for (const { control, route } of routeControls(node)) {
      const { kind, label } = routeLabel(node, control);
      if (route.repeat === undefined) {
        edges.push({
          id: `${node.id}:${control}`,
          source: node.id,
          target: target(route.to),
          kind,
          label: clip(label),
          fullLabel: label,
          back: false,
        });
        continue;
      }
      const repeatLabel = `${kind === "next" ? "repeat" : `${label} · repeat`} ×${route.repeat.max}`;
      edges.push({
        id: `${node.id}:${control}`,
        source: node.id,
        target: target(route.to),
        kind: "repeat",
        label: kind === "rule" ? `${clip(label)} · repeat ×${route.repeat.max}` : repeatLabel,
        fullLabel: repeatLabel,
        back: true,
      });
      edges.push({
        id: `${node.id}:${control}.repeat`,
        source: node.id,
        target: target(route.repeat.atLimit),
        kind: "atLimit",
        label: "at limit",
        fullLabel: "at limit",
        back: false,
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
  // A route back to its own step is drawn as a loop beside the box, never through the layers.
  return {
    nodes,
    edges: edges.map((edge) =>
      edge.source === edge.target && !edge.back ? { ...edge, back: true } : edge,
    ),
  };
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

/**
 * Changes when boxes are added or removed or a route's ends move, the moments the canvas refits
 * the whole graph. Labels, titles and rule values are left out so editing them keeps the view.
 */
export const refitKey = (graph: FlowGraph): string =>
  JSON.stringify([
    graph.nodes.map((node) => node.id),
    graph.edges.map((edge) => [edge.id, edge.source, edge.target]),
  ]);

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export const fitPadding = 0.16;
/** The zoom floor of the canvas itself, which the manual Fit button falls back to. */
export const canvasMinZoom = 0.2;
const readableHeightZoom = 0.9;
const readableWidthZoom = 0.8;
const fitMargin = 24;

/**
 * The viewport the canvas opens on, in the editor and the viewer alike. A graph that fits
 * opens whole and centered. One too big for the canvas opens at a readable zoom instead of
 * shrunk to illegibility: anchored at its top, and sideways centered on the entry box
 * (`entryX`, its centre) so the start of the flow is what shows. The Fit button still shows all.
 */
export function autoFitViewport(bounds: Bounds, width: number, height: number, entryX?: number) {
  const fit = (box: Bounds) =>
    getViewportForBounds(box, width, height, canvasMinZoom, 1, fitPadding).zoom;
  const fitsWidth = fit({ ...bounds, height: 1 });
  const fitsHeight = fit({ ...bounds, width: 1 });
  const zoom = Math.min(
    1,
    Math.max(fitsWidth, readableWidthZoom),
    Math.max(fitsHeight, readableHeightZoom),
  );
  const centered = {
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
  const left = fitMargin - bounds.x * zoom;
  const right = width - fitMargin - (bounds.x + bounds.width) * zoom;
  const anchored = width / 2 - (entryX ?? bounds.x + bounds.width / 2) * zoom;
  return {
    zoom,
    x:
      bounds.width * zoom + 2 * fitMargin > width
        ? Math.min(left, Math.max(right, anchored))
        : centered.x,
    y: bounds.height * zoom + 2 * fitMargin > height ? fitMargin - bounds.y * zoom : centered.y,
  };
}

/** Approximate drawn width of an edge label (11px medium text plus padding). */
export const labelWidth = (label: string) => label.length * 6.5 + 16;

/** Top-to-bottom layered layout of one connected set of boxes, from the origin. */
function layoutComponent(nodes: ReadonlyArray<FlowNode>, allEdges: ReadonlyArray<FlowEdge>) {
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
  for (const node of nodes) layout.setNode(node.id, { ...nodeSize(node) });
  const members = new Set(nodes.map((node) => node.id));
  // dagre places a node's siblings in reverse of the order their edges were added, so fork
  // edges are fed last-to-first to leave reviewer lanes in definition order, left to right.
  const edges = allEdges.filter((edge) => members.has(edge.source));
  const forks = edges.filter((edge) => edge.kind === "fork").reverse();
  let nextFork = 0;
  const ordered = edges.map((edge) => (edge.kind === "fork" ? forks[nextFork++]! : edge));
  for (const edge of ordered) {
    if (edge.back) continue;
    layout.setEdge(
      edge.source,
      edge.target,
      edge.label === ""
        ? { minlen: 1 }
        : { minlen: 1, width: labelWidth(edge.label), height: 20, labelpos: "c" },
      edge.id,
    );
  }
  dagre.layout(layout);
  const routes = new Map<string, { points: ReadonlyArray<Point>; label: Point | null }>();
  for (const edge of edges) {
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
  const placed = nodes.map((node) => {
    const at = layout.node(node.id);
    const size = nodeSize(node);
    return {
      id: node.id,
      size,
      position: { x: (at?.x ?? 0) - size.width / 2, y: (at?.y ?? 0) - size.height / 2 },
    };
  });
  return { placed, routes, height: layout.graph().height ?? 0 };
}

/**
 * Layered layout. Repeat routes are left out so they never push steps around. Boxes the entry
 * cannot reach are laid out as their own sets, stacked below the main graph, so they never share
 * a rank with its loops and edges. Their routes into the main graph are drawn without a path.
 */
export function layoutFlow(graph: FlowGraph): FlowLayout {
  const reached = new Set<string>();
  const entry = graph.nodes.find((node) => node.entry);
  const pending = entry === undefined ? [] : [entry.id];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const edge of graph.edges) if (edge.source === id) pending.push(edge.target);
  }
  // Without an entry there is no main graph to protect; everything lays out as one set.
  const detached = graph.nodes.filter((node) => entry !== undefined && !reached.has(node.id));
  const parent = new Map(detached.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const edge of graph.edges)
    if (parent.has(edge.source) && parent.has(edge.target))
      parent.set(find(edge.source), find(edge.target));
  const groups = new Map<string, FlowNode[]>();
  for (const node of detached) {
    const root = find(node.id);
    groups.set(root, [...(groups.get(root) ?? []), node]);
  }
  const components = [
    graph.nodes.filter((node) => entry === undefined || reached.has(node.id)),
    ...groups.values(),
  ].filter((nodes) => nodes.length > 0);

  const positions = new Map<string, Point>();
  const sizes = new Map<string, { width: number; height: number }>();
  const routes = new Map<string, { points: ReadonlyArray<Point>; label: Point | null }>();
  let top = 0;
  for (const nodes of components) {
    const component = layoutComponent(nodes, graph.edges);
    for (const { id, size, position } of component.placed) {
      sizes.set(id, size);
      positions.set(id, { x: position.x, y: position.y + top });
    }
    for (const [id, route] of component.routes)
      routes.set(id, {
        points: route.points.map((point) => ({ x: point.x, y: point.y + top })),
        label: route.label === null ? null : { x: route.label.x, y: route.label.y + top },
      });
    top += component.height;
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

/** How far a detoured loop leg runs outside its box: inside the gaps dagre leaves. */
const detourGap = 14;

export interface RepeatLoop {
  /** The x of the loop's vertical run. */
  readonly x: number;
  /** Vertical centre of the loop, where its label sits. */
  readonly y: number;
  readonly labelWidth: number;
  /**
   * Set when a box sits between a loop end and its vertical run: the leg then drops into the
   * gap below the source (or above the target) at this y instead of crossing the box.
   */
  readonly sourceDetour: number | null;
  readonly targetDetour: number | null;
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
    const x = right + 32;
    // Whether a box other than the loop's ends lies on the straight leg at `y` from `from` to x.
    const blocked = (from: number, y: number) =>
      [...layout.positions].some(([id, position]) => {
        if (id === edge.source || id === edge.target) return false;
        const size = layout.sizes.get(id)!;
        return (
          position.x < x &&
          position.x + size.width > from &&
          position.y < y &&
          position.y + size.height > y
        );
      });
    const sourceY = source.y + sourceSize.height / 2;
    const targetY = target.y + targetSize.height / 2;
    loops.set(edge.id, {
      x,
      y: (sourceY + targetY) / 2,
      labelWidth: edge.label === "" ? 0 : labelWidth(edge.label),
      sourceDetour: blocked(source.x + sourceSize.width, sourceY)
        ? source.y + sourceSize.height + detourGap
        : null,
      targetDetour: blocked(target.x + targetSize.width, targetY) ? target.y - detourGap : null,
      top,
      bottom,
    });
  }
  return loops;
}

/**
 * A rounded orthogonal loop out to `x` and back, entering the target from the side. A detour
 * steps the leg into the gap beside the box first, then runs along the gap between ranks.
 */
export function loopPath(
  source: Point,
  target: Point,
  x: number,
  detours: { readonly source: number | null; readonly target: number | null } = {
    source: null,
    target: null,
  },
): string {
  const points: Point[] = [source];
  if (detours.source === null) points.push({ x, y: source.y });
  else
    points.push(
      { x: source.x + 12, y: source.y },
      { x: source.x + 12, y: detours.source },
      { x, y: detours.source },
    );
  if (detours.target === null) points.push({ x, y: target.y });
  else
    points.push(
      { x, y: detours.target },
      { x: target.x + 12, y: detours.target },
      { x: target.x + 12, y: target.y },
    );
  points.push(target);
  return roundedPath(points, 12);
}

/** An orthogonal polyline with each corner rounded by up to `radius`. */
function roundedPath(points: ReadonlyArray<Point>, radius: number): string {
  const parts = [`M${points[0]!.x},${points[0]!.y}`];
  for (let index = 1; index < points.length - 1; index++) {
    const previous = points[index - 1]!;
    const corner = points[index]!;
    const next = points[index + 1]!;
    const into = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const out = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, into / 2, out / 2);
    if (r <= 0 || into === 0 || out === 0) {
      parts.push(`L${corner.x},${corner.y}`);
      continue;
    }
    parts.push(
      `L${corner.x - ((corner.x - previous.x) / into) * r},${corner.y - ((corner.y - previous.y) / into) * r}`,
      `Q${corner.x},${corner.y} ${corner.x + ((next.x - corner.x) / out) * r},${corner.y + ((next.y - corner.y) / out) * r}`,
    );
  }
  const last = points[points.length - 1]!;
  parts.push(`L${last.x},${last.y}`);
  return parts.join(" ");
}

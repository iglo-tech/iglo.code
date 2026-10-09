import { getViewportForBounds } from "@xyflow/react";
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
  /** Short drawn label; a repeat's has two lines (route, then bound). */
  readonly label: string;
  /** The unshortened route text, for its tooltip. */
  readonly fullLabel: string;
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
          route: null,
          dangling: false,
        });
        edges.push({
          id: `${id}->${node.next}`,
          source: id,
          target: target(node.next),
          kind: "join",
          label: "",
          fullLabel: "",
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
          fullLabel: title,
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
        fullLabel: `${kind === "next" ? "" : `${title} · `}↩ ${repeatBadge(route.repeat)}`,
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
        fullLabel: `${kind === "next" ? "" : `${title} · `}at limit after ${repeatBadge(route.repeat)}`,
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
export interface FlowRoute {
  readonly points: ReadonlyArray<Point>;
  readonly label: Point | null;
  /** A cross-component route is only a source-local stub; its target remains in the Route list. */
  readonly stub?: { readonly label: string; readonly fullLabel: string };
}
export interface FlowLayout {
  /** Top-left corner of each box. */
  readonly positions: ReadonlyMap<string, Point>;
  readonly sizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  /** Routed points and label centre for each forward edge; back edges are drawn beside the flow. */
  readonly routes: ReadonlyMap<string, FlowRoute>;
}

export const nodeSize = (node: FlowNode) =>
  node.kind === "branch"
    ? { width: 200, height: 52 }
    : node.kind === "missing"
      ? { width: 176, height: 44 }
      : { width: 232, height: 60 };

/**
 * Everything the layout reads: box identities and kinds (sizes) and each edge's ends, label and
 * direction. A title only affects layout when a detached route names it in a stub.
 */
export function layoutSignature(graph: FlowGraph): string {
  const reached = reachableNodes(graph);
  const stubTargets = new Set(
    graph.edges
      .filter((edge) => !edge.back && !reached.has(edge.source) && reached.has(edge.target))
      .map((edge) => edge.target),
  );
  return JSON.stringify([
    graph.nodes.map((node) => [node.id, node.kind, stubTargets.has(node.id) ? node.title : null]),
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
/** Usual zoom floor; the canvas lowers it when fitting the complete bounds needs less. */
export const canvasMinZoom = 0.2;
const readableHeightZoom = 0.9;
const fitMargin = 24;

/**
 * The viewport the canvas opens on, in the editor and the viewer alike. A graph that fits
 * opens whole and centered. One too big for the canvas opens at a readable zoom instead of
 * shrunk vertically to illegibility: anchored at its top. Width always fits, including route
 * labels and loops. The Fit button still shows the whole height.
 */
export function autoFitViewport(bounds: Bounds, width: number, height: number) {
  const fit = (box: Bounds) => getViewportForBounds(box, width, height, 0, 1, fitPadding).zoom;
  const fitsWidth = fit({ ...bounds, height: 1 });
  const fitsHeight = fit({ ...bounds, width: 1 });
  const zoom = Math.min(1, fitsWidth, Math.max(fitsHeight, readableHeightZoom));
  const centered = {
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
  return {
    zoom,
    x: centered.x,
    y: bounds.height * zoom + 2 * fitMargin > height ? fitMargin - bounds.y * zoom : centered.y,
  };
}

/** Approximate drawn width of an edge label (11px medium text plus padding), by its longest line. */
export const labelWidth = (label: string) =>
  Math.max(...label.split("\n").map((line) => line.length)) * 6.5 + 16;
/** Approximate drawn height of an edge label: 18px per line plus its border. */
export const labelHeight = (label: string) => label.split("\n").length * 18 + 2;

/** How far a detoured leg runs outside its box: inside the gaps dagre leaves. */
const detourGap = 14;

const stubLabel = (edge: FlowEdge, title: string) => ({
  label: `${edge.label}${edge.label === "" ? "" : " "}→ ${clip(title)}`,
  fullLabel: `${edge.fullLabel}${edge.fullLabel === "" ? "" : " "}→ ${title}`,
});

/** Top-to-bottom layered layout of one connected set of boxes, from the origin. */
function layoutComponent(nodes: ReadonlyArray<FlowNode>, graph: FlowGraph) {
  const allEdges = graph.edges;
  const titles = new Map(graph.nodes.map((node) => [node.id, node.title]));
  const members = new Set(nodes.map((node) => node.id));
  const stubs = allEdges.filter(
    (edge) => !edge.back && members.has(edge.source) && !members.has(edge.target),
  );
  const counts = new Map<string, number>();
  for (const edge of stubs) counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
  const sizes = new Map(
    nodes.map((node) => {
      const size = nodeSize(node);
      const repeats = allEdges.filter((edge) => edge.back && edge.source === node.id);
      const returns = repeats.filter((edge) => edge.target === node.id).length;
      return [
        node.id,
        { ...size, height: Math.max(size.height, 12 + 8 * (repeats.length + returns - 1)) },
      ];
    }),
  );
  const extraHeight = Math.max(
    0,
    ...nodes.map((node) => (counts.get(node.id) ?? 0) * 24 - nodeSize(node).height),
  );
  const layout = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  layout.setGraph({
    rankdir: "TB",
    // Leave space beside every source for its short stubs, and between ranks for many labels.
    nodesep: Math.max(
      40,
      ...stubs.map(
        (edge) => labelWidth(stubLabel(edge, titles.get(edge.target) ?? edge.target).label) + 40,
      ),
    ),
    ranksep: 56 + extraHeight,
    edgesep: 24,
    marginx: 16,
    marginy: 16 + extraHeight / 2,
  });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) layout.setNode(node.id, { ...sizes.get(node.id)! });
  // dagre places a node's siblings in reverse of the order their edges were added, so fork
  // edges are fed last-to-first to leave reviewer lanes in definition order, left to right.
  const edges = allEdges.filter((edge) => members.has(edge.source) && members.has(edge.target));
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
  const routes = new Map<string, FlowRoute>();
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
    const size = sizes.get(node.id)!;
    return {
      id: node.id,
      size,
      position: { x: (at?.x ?? 0) - size.width / 2, y: (at?.y ?? 0) - size.height / 2 },
    };
  });
  return { placed, routes, height: layout.graph().height ?? 0 };
}

function reachableNodes(graph: FlowGraph) {
  const reached = new Set<string>();
  const entry = graph.nodes.find((node) => node.entry);
  const pending = entry === undefined ? [] : [entry.id];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const edge of graph.edges) if (edge.source === id) pending.push(edge.target);
  }
  return reached;
}

/**
 * Repeat edges stay out of the layered layout. Unreachable sets stack below the main graph;
 * routes out of them are source-local stubs, with their full relationship in the Route list.
 */
export function layoutFlow(graph: FlowGraph): FlowLayout {
  const reached = reachableNodes(graph);
  const entry = graph.nodes.find((node) => node.entry);
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
  const routes = new Map<string, FlowRoute>();
  let top = 0;
  for (const nodes of components) {
    const component = layoutComponent(nodes, graph);
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
  const targets = new Map(graph.nodes.map((node) => [node.id, node.title]));
  for (const node of graph.nodes) {
    const outgoing = graph.edges.filter(
      (edge) => !edge.back && edge.source === node.id && !routes.has(edge.id),
    );
    const source = positions.get(node.id)!;
    const size = sizes.get(node.id)!;
    for (const [index, edge] of outgoing.entries()) {
      const y = source.y + size.height / 2 + (index - (outgoing.length - 1) / 2) * 24;
      const stub = stubLabel(edge, targets.get(edge.target) ?? edge.target);
      routes.set(edge.id, {
        points: [
          { x: source.x, y: source.y + (size.height * (index + 1)) / (outgoing.length + 1) },
          { x: source.x - 24, y },
        ],
        label: { x: source.x - 32 - labelWidth(stub.label) / 2, y },
        stub,
      });
    }
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
  /** The actual drawn endpoints on the cards. */
  readonly source: Point;
  readonly target: Point;
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
  const exits = new Map<string, number>();
  const returns = new Map<string, number>();
  for (const node of graph.nodes) {
    // Repeat exits precede self-route exits; reserve separate slots below them for self returns.
    const leaving = graph.edges
      .filter((edge) => edge.back && edge.source === node.id)
      .sort((a, b) => Number(a.source === a.target) - Number(b.source === b.target));
    const position = layout.positions.get(node.id)!;
    const height = layout.sizes.get(node.id)!.height;
    const self = leaving.filter((edge) => edge.source === edge.target);
    const first = Math.max(
      8,
      Math.min(
        self.length > 0
          ? height / 2 - 10 - 8 * (leaving.length - 1)
          : height / 2 - 4 * (leaving.length - 1),
        height - 4 - 8 * self.length - 8 * (leaving.length - 1),
      ),
    );
    for (const [index, edge] of leaving.entries())
      exits.set(
        edge.id,
        position.y +
          (leaving.length === 1
            ? height / 2 - (edge.source === edge.target ? 10 : 0)
            : first + index * 8),
      );
    for (const [index, edge] of self.entries())
      returns.set(
        edge.id,
        position.y + (leaving.length === 1 ? height / 2 + 10 : height - 4 - index * 8),
      );
  }
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
        right = Math.max(
          right,
          route.label.x + labelWidth(route.stub?.label ?? labels.get(id) ?? "") / 2,
        );
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
    const own = edge.source === edge.target;
    const sourceY = exits.get(edge.id)!;
    const targetY = own ? returns.get(edge.id)! : target.y + targetSize.height / 2;
    loops.set(edge.id, {
      source: { x: source.x + sourceSize.width, y: sourceY },
      target: { x: target.x + targetSize.width, y: targetY },
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

const attributionReserve = 32;

/** Complete drawn bounds for initial fitting and the manual Fit button. */
export function graphBounds(
  graph: FlowGraph,
  layout: FlowLayout,
  loops: ReadonlyMap<string, RepeatLoop>,
): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x: number, y: number, width = 0, height = 0) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  };
  for (const [id, position] of layout.positions) {
    const size = layout.sizes.get(id)!;
    include(position.x, position.y, size.width, size.height);
  }
  const labels = new Map(graph.edges.map((edge) => [edge.id, edge.label]));
  for (const [id, route] of layout.routes) {
    for (const point of route.points) include(point.x, point.y);
    if (route.label !== null) {
      const label = route.stub?.label ?? labels.get(id) ?? "";
      const width = labelWidth(label);
      const height = labelHeight(label);
      include(route.label.x - width / 2, route.label.y - height / 2, width, height);
    }
  }
  for (const [id, loop] of loops) {
    include(loop.x, Math.min(loop.source.y, loop.target.y));
    include(loop.x, Math.max(loop.source.y, loop.target.y));
    if (loop.sourceDetour !== null) include(loop.x, loop.sourceDetour);
    if (loop.targetDetour !== null) include(loop.x, loop.targetDetour);
    const height = labelHeight(labels.get(id) ?? "");
    include(loop.x + 6, loop.y - height / 2, loop.labelWidth, height);
  }
  return left === Infinity
    ? { x: 0, y: 0, width: 1, height: 1 }
    : {
        x: left - 2,
        y: top - 2,
        width: right - left + 4,
        height: bottom - top + 4 + attributionReserve,
      };
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
export function roundedPath(points: ReadonlyArray<Point>, radius: number): string {
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

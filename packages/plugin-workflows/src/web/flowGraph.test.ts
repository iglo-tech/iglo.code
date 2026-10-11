import { describe, expect, it } from "vite-plus/test";
import { developmentReview, examples } from "../examples.ts";
import {
  autoFitViewport,
  flowGraph,
  layoutFlow,
  layoutSignature,
  refitKey,
  repeatLoops,
} from "./flowGraph.ts";
import { stepButtonId } from "./Flow.tsx";

const edge = (graph: ReturnType<typeof flowGraph>, source: string, target: string) =>
  graph.edges.filter((item) => item.source === source && item.target === target);

describe("workflow graph", () => {
  it("draws every route kind with its label, including repeat back edges and At limit", () => {
    const graph = flowGraph(developmentReview);
    expect(edge(graph, "implement", "checks")).toMatchObject([{ kind: "next", label: "next" }]);
    expect(edge(graph, "check-result", "reviews")).toMatchObject([
      { kind: "rule", label: "exitCode = 0" },
    ]);
    expect(edge(graph, "check-result", "human")).toMatchObject([
      { kind: "otherwise", label: "otherwise" },
    ]);
    expect(edge(graph, "join", "unresolved")).toMatchObject([
      { kind: "rule", label: "result ≠ all_completed" },
    ]);
    expect(edge(graph, "join", "rework")[0]?.label).toBe("verdict ∈ changes, blocker or +2");
    // Bounded rework returns to implementation and names the limit destination separately.
    expect(edge(graph, "rework", "implement")).toMatchObject([
      { kind: "repeat", label: "otherwise · repeat ×1", back: true },
    ]);
    expect(edge(graph, "rework", "human")).toMatchObject([
      { kind: "atLimit", label: "at limit", back: false },
    ]);
    expect(edge(graph, "human", "done")).toMatchObject([{ kind: "approve", label: "approve" }]);
    expect(edge(graph, "human", "unresolved")).toMatchObject([
      { kind: "changes", label: "changes" },
    ]);
    expect(graph.nodes.find((node) => node.id === "implement")).toMatchObject({ entry: true });
    expect(graph.nodes.find((node) => node.id === "human")).toMatchObject({ runLimit: true });
  });

  it("lays out reviewer lanes side by side between their fork and join, top to bottom", () => {
    const graph = flowGraph(developmentReview);
    const lanes = ["reviews/code", "reviews/security", "reviews/ux"];
    for (const lane of lanes) {
      expect(graph.nodes.find((node) => node.id === lane)).toMatchObject({
        kind: "branch",
        stepId: "reviews",
      });
      expect(edge(graph, "reviews", lane)).toHaveLength(1);
      expect(edge(graph, lane, "join")).toHaveLength(1);
    }
    // The fork's own route to its join is drawn through the lanes, not beside them.
    expect(edge(graph, "reviews", "join")).toEqual([]);
    const layout = layoutFlow(graph);
    const y = (id: string) => layout.positions.get(id)!.y;
    const x = (id: string) => layout.positions.get(id)!.x;
    expect(new Set(lanes.map(y)).size).toBe(1);
    expect(new Set(lanes.map(x)).size).toBe(3);
    // Lanes keep definition order left to right.
    expect(x(lanes[0]!)).toBeLessThan(x(lanes[1]!));
    expect(x(lanes[1]!)).toBeLessThan(x(lanes[2]!));
    expect(y("implement")).toBeLessThan(y("checks"));
    expect(y("reviews")).toBeLessThan(y(lanes[0]!));
    expect(y(lanes[0]!)).toBeLessThan(y("join"));
    // Forward routes are routed by the layout; the repeat back edge is drawn beside the flow.
    expect(layout.routes.get("implement:next")?.points.length).toBeGreaterThan(1);
    expect(layout.routes.has("rework:otherwise")).toBe(false);
    expect(layout.routes.get("rework:otherwise.repeat")?.label).not.toBeNull();
    // The loop runs clear of every box between rework and implementation.
    const loop = repeatLoops(graph, layout).get("rework:otherwise")!;
    for (const [id, position] of layout.positions)
      if (position.y <= layout.positions.get("rework")!.y)
        expect(loop.x).toBeGreaterThan(position.x + layout.sizes.get(id)!.width);
  });

  it("draws a human gate's repeat and its At limit self-route", () => {
    const graph = flowGraph(examples[0]!);
    expect(edge(graph, "review", "implement")).toMatchObject([
      { kind: "repeat", label: "changes · repeat ×1", back: true },
    ]);
    expect(edge(graph, "review", "review")).toMatchObject([{ kind: "atLimit", back: true }]);
    // The self-route is a loop beside the box, not a layered edge.
    const layout = layoutFlow(graph);
    expect(layout.routes.has("review:changes.repeat")).toBe(false);
    expect(repeatLoops(graph, layout).has("review:changes.repeat")).toBe(true);
  });

  it("keeps a dangling route visible against a missing step", () => {
    const definition = {
      ...examples[0]!,
      nodes: examples[0]!.nodes.filter((node) => node.id !== "done"),
    };
    const graph = flowGraph(definition);
    expect(graph.nodes.find((node) => node.id === "missing:done")).toMatchObject({
      kind: "missing",
      stepId: "done",
    });
    expect(edge(graph, "review", "missing:done")).toMatchObject([{ kind: "approve" }]);
  });

  it("relays out only for structural edits", () => {
    const key = layoutSignature(flowGraph(developmentReview));
    const renamed = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "implement" ? { ...node, title: "Renamed" } : node,
      ),
    };
    expect(layoutSignature(flowGraph(renamed))).toBe(key);
    const shorter = {
      ...developmentReview,
      nodes: developmentReview.nodes.filter((node) => node.id !== "unresolved"),
    };
    expect(layoutSignature(flowGraph(shorter))).not.toBe(key);
  });

  it("refits only when boxes are added or removed", () => {
    const key = refitKey(flowGraph(developmentReview));
    const relabelled = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "implement" ? { ...node, title: "Renamed" } : node,
      ),
    };
    expect(refitKey(flowGraph(relabelled))).toBe(key);
    const shorter = {
      ...developmentReview,
      nodes: developmentReview.nodes.filter((node) => node.id !== "unresolved"),
    };
    expect(refitKey(flowGraph(shorter))).not.toBe(key);
    // A route's target moving is structure; its label (rule value) is not.
    const rerouted = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "implement" && node.kind === "agent" ? { ...node, next: { to: "done" } } : node,
      ),
    };
    expect(refitKey(flowGraph(rerouted))).not.toBe(key);
    const graph = flowGraph(developmentReview);
    const relabeledEdges = { ...graph, edges: graph.edges.map((e) => ({ ...e, label: "x" })) };
    expect(refitKey(relabeledEdges)).toBe(key);
  });

  it("draws a route to its own step as a loop beside the box", () => {
    const self = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.kind === "human" ? { ...node, changes: { to: node.id } } : node,
      ),
    };
    const graph = flowGraph(self);
    const human = self.nodes.find((node) => node.kind === "human")!;
    const loop = edge(graph, human.id, human.id);
    expect(loop.length).toBeGreaterThan(0);
    expect(loop.every((item) => item.back)).toBe(true);
    const loops = repeatLoops(graph, layoutFlow(graph));
    for (const item of loop) expect(loops.has(item.id)).toBe(true);
  });

  it("opens big graphs readable at the entry and small ones whole", () => {
    const tall = autoFitViewport({ x: 0, y: 100, width: 232, height: 2000 }, 800, 600);
    expect(tall.zoom).toBe(0.9);
    expect(tall.y).toBeCloseTo(24 - 100 * 0.9);
    // Wider than the canvas: readable zoom, centered on the entry rather than shrunk to fit.
    const wide = autoFitViewport({ x: 0, y: 0, width: 1400, height: 400 }, 600, 500, 700);
    expect(wide.zoom).toBe(0.8);
    expect(700 * wide.zoom + wide.x).toBeCloseTo(300);
    const edge = autoFitViewport({ x: 0, y: 0, width: 1400, height: 400 }, 600, 500, 10);
    expect(edge.x).toBeCloseTo(24);
    const small = autoFitViewport({ x: 0, y: 0, width: 232, height: 200 }, 800, 600);
    expect(small.zoom).toBe(1);
    expect(small.y).toBeGreaterThan(0);
  });

  it("lays a detached step out clear of every box and loop of the main graph", () => {
    const agent = developmentReview.nodes.find((node) => node.id === "implement")!;
    const definition = {
      ...developmentReview,
      entry: "checks",
      nodes: [
        ...developmentReview.nodes,
        { ...agent, id: "orphan", title: "Orphan", next: { to: "done" } },
        { ...agent, id: "lonely", title: "Lonely", next: { to: "lonely" } },
      ],
    } as typeof developmentReview;
    const graph = flowGraph(definition);
    const layout = layoutFlow(graph);
    const box = (id: string) => {
      const at = layout.positions.get(id)!;
      const size = layout.sizes.get(id)!;
      return { left: at.x, top: at.y, right: at.x + size.width, bottom: at.y + size.height };
    };
    const hits = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const ids = graph.nodes.map((node) => node.id);
    for (const [index, id] of ids.entries())
      for (const other of ids.slice(index + 1)) expect(hits(box(id), box(other))).toBe(false);
    const mainBottom = Math.max(
      ...ids.filter((id) => id !== "orphan" && id !== "lonely").map((id) => box(id).bottom),
    );
    expect(box("orphan").top).toBeGreaterThan(mainBottom);
    // The orphan's edge into the main graph crosses sets, so it gets no routed path.
    expect(layout.routes.has("orphan->done")).toBe(false);
    // No main-graph loop's legs or vertical run touch a detached box.
    for (const [id, loop] of repeatLoops(graph, layout)) {
      const owner = graph.edges.find((item) => item.id === id)!;
      if (owner.source === "lonely") continue;
      const source = box(owner.source);
      const reach = { left: source.right, right: loop.x, top: source.top, bottom: source.bottom };
      for (const detached of ["orphan", "lonely"]) expect(hits(reach, box(detached))).toBe(false);
    }
  });

  it("gives every box a distinct focus id", () => {
    expect(stepButtonId("agent-1")).toBe("wf-step-agent-1");
    expect(stepButtonId("reviews/code")).not.toBe(stepButtonId("reviews-code"));
    expect(stepButtonId("a_x002f")).not.toBe(stepButtonId("a/"));
  });

  it("detours a loop leg around a box beside its source", () => {
    const definition = examples[0]!;
    const graph = flowGraph(definition);
    const layout = layoutFlow(graph);
    const source = layout.positions.get("review")!;
    const size = layout.sizes.get("review")!;
    // A box placed on the straight leg from the source's right side to the loop.
    const blocked = {
      ...layout,
      positions: new Map([
        ...layout.positions,
        ["side", { x: source.x + size.width + 40, y: source.y }],
      ]),
      sizes: new Map([...layout.sizes, ["side", size]]),
    };
    const clear = repeatLoops(graph, layout).get("review:changes")!;
    const loop = repeatLoops(graph, blocked).get("review:changes")!;
    expect(clear.sourceDetour).toBeNull();
    expect(loop.x).toBeGreaterThan(source.x + 2 * size.width + 40);
    expect(loop.sourceDetour).toBeGreaterThan(source.y + size.height);
  });
});

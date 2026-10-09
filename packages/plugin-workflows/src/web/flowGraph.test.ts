import { describe, expect, it } from "vite-plus/test";
import { getViewportForBounds } from "@xyflow/react";
import { developmentReview, examples } from "../examples.ts";
import {
  autoFitViewport,
  canvasMinZoom,
  fitPadding,
  flowGraph,
  graphBounds,
  layoutFlow,
  layoutSignature,
  labelWidth,
  loopPath,
  refitKey,
  repeatLoops,
  type FlowGraph,
  type RepeatLoop,
} from "./flowGraph.ts";
import { stepButtonId } from "./Flow.tsx";

const edge = (graph: ReturnType<typeof flowGraph>, source: string, target: string) =>
  graph.edges.filter((item) => item.source === source && item.target === target);

const drawnExit = (loop: RepeatLoop) =>
  Number(loopPath(loop.source, loop.target, loop.x).match(/^M[^,]+,([^ ]+)/)![1]);

const detachedGraph: FlowGraph = {
  nodes: ["a", "b", "c", "o", "p", "q"].map((id) => ({
    id,
    stepId: id,
    kind: "human",
    title: id === "c" ? "Done" : id,
    detail: null,
    entry: id === "a",
    runLimit: false,
  })),
  edges: [
    ["a", "b", ""],
    ["b", "c", ""],
    ["o", "c", "changes requested"],
    ["p", "b", "approved by reviewer"],
    ["q", "a", "x"],
  ].map(([source, target, label]) => ({
    id: `${source}:${label}`,
    source: source!,
    target: target!,
    label: label!,
    fullLabel: label!,
    kind: "next",
    back: false,
    route: null,
    dangling: false,
  })),
};

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
    // Rule summaries are clipped on the canvas; the full text is the edge's hover title.
    expect(edge(graph, "join", "rework")[0]).toMatchObject({
      label: "verdict ∈ changes, bloc…",
      fullLabel: "verdict ∈ changes, blocker or +2",
    });
    // Bounded rework returns to implementation and names the limit destination separately.
    expect(edge(graph, "rework", "implement")).toMatchObject([
      {
        kind: "repeat",
        label: "otherwise\n↩ ×1 · 2 visits",
        fullLabel: "otherwise · ↩ repeat ×1 (2 visits)",
        back: true,
        route: { stepId: "rework", control: "otherwise" },
      },
    ]);
    expect(edge(graph, "rework", "human")).toMatchObject([
      {
        kind: "atLimit",
        label: "at limit",
        back: false,
        route: { stepId: "rework", control: "otherwise.repeat" },
      },
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
      { kind: "repeat", label: "changes\n↩ ×1 · 2 visits", back: true },
    ]);
    expect(edge(graph, "review", "review")).toMatchObject([{ kind: "atLimit", back: true }]);
    // The self-route is a loop beside the box, not a layered edge.
    const layout = layoutFlow(graph);
    expect(layout.routes.has("review:changes.repeat")).toBe(false);
    const loops = repeatLoops(graph, layout);
    expect(loops.has("review:changes.repeat")).toBe(true);
    // Check the path's actual exits, rather than offsets that miss drawing adjustments.
    expect(
      Math.abs(
        drawnExit(loops.get("review:changes")!) - drawnExit(loops.get("review:changes.repeat")!),
      ),
    ).toBeGreaterThanOrEqual(8);
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
    expect(edge(graph, "review", "missing:done")).toMatchObject([
      { kind: "approve", dangling: true },
    ]);
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
    // Width always fits; only height may deliberately continue below the visible canvas.
    const wide = autoFitViewport({ x: 0, y: 0, width: 1400, height: 400 }, 600, 500);
    expect(wide.x).toBeGreaterThanOrEqual(0);
    expect(wide.x + 1400 * wide.zoom).toBeLessThanOrEqual(600);
    const small = autoFitViewport({ x: 0, y: 0, width: 232, height: 200 }, 800, 600);
    expect(small.zoom).toBe(1);
    expect(small.y).toBeGreaterThan(0);
  });

  it("keeps detached route labels near their own source and inside fit bounds", () => {
    const layout = layoutFlow(detachedGraph);
    const loops = repeatLoops(detachedGraph, layout);
    const bounds = graphBounds(detachedGraph, layout, loops);
    const labels = detachedGraph.edges
      .filter((e) => ["o", "p", "q"].includes(e.source))
      .map((e) => {
        const label = layout.routes.get(e.id)!.label!;
        const source = layout.positions.get(e.source)!;
        const size = layout.sizes.get(e.source)!;
        expect(Math.abs(label.y - (source.y + size.height / 2))).toBeLessThanOrEqual(24);
        const route = layout.routes.get(e.id)!;
        expect(route.stub?.fullLabel).toContain(
          `→ ${detachedGraph.nodes.find((n) => n.id === e.target)!.title}`,
        );
        const width = labelWidth(route.stub!.label);
        expect(label.x - width / 2).toBeGreaterThanOrEqual(bounds.x);
        expect(label.x + width / 2).toBeLessThanOrEqual(bounds.x + bounds.width);
        return { top: label.y - 10, bottom: label.y + 10 };
      });
    for (const [index, label] of labels.entries())
      for (const other of labels.slice(index + 1))
        expect(label.bottom <= other.top || other.bottom <= label.top).toBe(true);
  });

  it("gives multiple detached routes separate short exits, without reaching other nodes", () => {
    const graph = {
      ...detachedGraph,
      edges: [
        ...detachedGraph.edges,
        {
          id: "o:no",
          source: "o",
          target: "b",
          kind: "next" as const,
          label: "no",
          fullLabel: "no",
          back: false,
          route: null,
          dangling: false,
        },
      ],
    };
    const layout = layoutFlow(graph);
    const routes = graph.edges.filter((e) => e.source === "o").map((e) => layout.routes.get(e.id)!);
    const source = layout.positions.get("o")!;
    const size = layout.sizes.get("o")!;
    expect(new Set(routes.map((r) => r.points[0]!.y)).size).toBe(routes.length);
    for (const route of routes) {
      expect(route.points).toHaveLength(2);
      for (const point of route.points) {
        expect(Math.abs(point.x - source.x)).toBeLessThanOrEqual(32);
        expect(point.y).toBeGreaterThanOrEqual(source.y);
        expect(point.y).toBeLessThanOrEqual(source.y + size.height);
      }
    }
    expect(Math.abs(routes[0]!.label!.y - routes[1]!.label!.y)).toBeGreaterThanOrEqual(20);
  });

  it("keeps three repeat exits and a self-route separated within a 44px source card", () => {
    const graph: FlowGraph = {
      nodes: ["a", "b", "c", "source"].map((id) => ({
        id,
        stepId: id,
        kind: id === "source" ? "missing" : "human",
        title: id,
        detail: null,
        entry: false,
        runLimit: false,
      })),
      edges: ["a", "b", "c", "source"].map((target) => ({
        id: `source:${target}`,
        source: "source",
        target,
        kind: target === "source" ? "atLimit" : "repeat",
        label: "repeat",
        fullLabel: "repeat",
        back: true,
        route: null,
        dangling: false,
      })),
    };
    const layout = layoutFlow(graph);
    const top = layout.positions.get("source")!.y;
    const height = layout.sizes.get("source")!.height;
    const exits = [...repeatLoops(graph, layout).values()].map(drawnExit).sort((a, b) => a - b);
    for (const [index, exit] of exits.entries()) {
      expect(exit).toBeGreaterThanOrEqual(top);
      expect(exit).toBeLessThanOrEqual(top + height);
      if (index > 0) expect(exit - exits[index - 1]!).toBeGreaterThanOrEqual(8);
    }
    const self = repeatLoops(graph, layout).get("source:source")!;
    for (const exit of exits) expect(Math.abs(exit - self.target.y)).toBeGreaterThanOrEqual(8);
  });

  it("reserves space for long labels and many stubs beside sibling detached nodes", () => {
    const title = "Done with an exceptionally long workflow outcome name".repeat(3);
    const graph: FlowGraph = {
      nodes: detachedGraph.nodes.map((node) => (node.id === "c" ? { ...node, title } : node)),
      edges: [
        ...detachedGraph.edges,
        ...["o", "p"].map((target) => ({
          id: `q:${target}`,
          source: "q",
          target,
          kind: "next" as const,
          label: "next",
          fullLabel: "next",
          back: false,
          route: null,
          dangling: false,
        })),
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `o:rule-${index}`,
          source: "o",
          target: "c",
          kind: "rule" as const,
          label: `approved by reviewer ${index}`,
          fullLabel: `approved by reviewer ${index}`,
          back: false,
          route: null,
          dangling: false,
        })),
      ],
    };
    const layout = layoutFlow(graph);
    const bounds = graphBounds(graph, layout, repeatLoops(graph, layout));
    const stubs = [...layout.routes.values()].filter((route) => route.stub !== undefined);
    const sourceRoutes = graph.edges
      .filter((edge) => edge.source === "o")
      .map((edge) => layout.routes.get(edge.id)!)
      .filter((route) => route.stub !== undefined);
    for (const [index, route] of sourceRoutes.entries()) {
      expect(route.points).toHaveLength(2);
      for (const other of sourceRoutes.slice(index + 1)) {
        // Straight stubs with the same x range cross only when their vertical order reverses.
        expect(route.points[0]!.x).toBe(other.points[0]!.x);
        expect(route.points[1]!.x).toBe(other.points[1]!.x);
        const start = route.points[0]!.y - other.points[0]!.y;
        const end = route.points[1]!.y - other.points[1]!.y;
        expect(start * end).toBeGreaterThan(0);
      }
    }
    const labels = stubs.map((route) => {
      const width = labelWidth(route.stub!.label);
      return {
        left: route.label!.x - width / 2,
        right: route.label!.x + width / 2,
        top: route.label!.y - 10,
        bottom: route.label!.y + 10,
      };
    });
    const hits = (a: (typeof labels)[number], b: (typeof labels)[number]) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (const [index, label] of labels.entries()) {
      expect(label.left).toBeGreaterThanOrEqual(bounds.x);
      expect(label.right).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(label.top).toBeGreaterThanOrEqual(bounds.y);
      expect(label.bottom).toBeLessThanOrEqual(bounds.y + bounds.height);
      for (const other of labels.slice(index + 1)) expect(hits(label, other)).toBe(false);
      for (const [id, at] of layout.positions) {
        const size = layout.sizes.get(id)!;
        expect(
          hits(label, {
            left: at.x,
            right: at.x + size.width,
            top: at.y,
            bottom: at.y + size.height,
          }),
          id,
        ).toBe(false);
      }
    }
    for (const route of stubs) {
      const [from, to] = route.points;
      const leg = {
        left: Math.min(from!.x, to!.x),
        right: Math.max(from!.x, to!.x),
        top: Math.min(from!.y, to!.y),
        bottom: Math.max(from!.y, to!.y),
      };
      for (const [id, at] of layout.positions) {
        const size = layout.sizes.get(id)!;
        expect(
          hits(leg, {
            left: at.x,
            right: at.x + size.width,
            top: at.y,
            bottom: at.y + size.height,
          }),
          id,
        ).toBe(false);
      }
    }
    expect(layout.routes.get("o:rule-0")!.stub!.fullLabel).toContain(title);
    expect(layout.routes.get("o:rule-0")!.stub!.label).toContain("…");
    const renamed = {
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === "c" ? { ...node, title: "Finished" } : node)),
    };
    expect(layoutSignature(renamed)).not.toBe(layoutSignature(graph));
    expect(layoutFlow(renamed).routes.get("o:rule-0")!.stub!.label).toContain("→ Finished");
    // Presentation never rewrites the graph's canonical target or label.
    expect(graph.edges.find((e) => e.id === "o:rule-0")!.target).toBe("c");
    expect(graph.edges.find((e) => e.id === "o:rule-0")!.label).toBe("approved by reviewer 0");
  });

  it("keeps eight back-route exits inside a source card with at least 8px drawn separation", () => {
    const graph: FlowGraph = {
      nodes: detachedGraph.nodes,
      edges: Array.from({ length: 8 }, (_, index) => ({
        id: `o:${index}`,
        source: "o",
        target: index === 0 ? "o" : "a",
        kind: "repeat",
        label: "repeat",
        fullLabel: "repeat",
        back: true,
        route: null,
        dangling: false,
      })),
    };
    const layout = layoutFlow(graph);
    const at = layout.positions.get("o")!;
    const height = layout.sizes.get("o")!.height;
    const loops = repeatLoops(graph, layout);
    const exits = [...loops.values()].map(drawnExit).sort((a, b) => a - b);
    for (const [index, exit] of exits.entries()) {
      expect(exit).toBeGreaterThanOrEqual(at.y);
      expect(exit).toBeLessThanOrEqual(at.y + height);
      if (index > 0) expect(exit - exits[index - 1]!).toBeGreaterThanOrEqual(8);
      expect(Math.abs(exit - loops.get("o:0")!.target.y)).toBeGreaterThanOrEqual(8);
    }
  });

  it("opens the packaged large graph with every route and label inside the horizontal viewport", () => {
    const graph = flowGraph(developmentReview);
    const layout = layoutFlow(graph);
    const loops = repeatLoops(graph, layout);
    const bounds = graphBounds(graph, layout, loops);
    for (const width of [674, 514, 320]) {
      const viewport = autoFitViewport(bounds, width, 720);
      const visible = (x: number) => {
        expect(x * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
        expect(x * viewport.zoom + viewport.x).toBeLessThanOrEqual(width);
      };
      for (const route of layout.routes.values())
        for (const point of route.points) visible(point.x);
      for (const e of graph.edges) {
        const label = layout.routes.get(e.id)?.label;
        if (label) {
          visible(label.x - labelWidth(e.label) / 2);
          visible(label.x + labelWidth(e.label) / 2);
        }
      }
      for (const loop of loops.values()) {
        visible(loop.x);
        visible(loop.x + 6 + loop.labelWidth);
      }
    }
  });

  it("keeps tall continuations top-anchored while allowing Fit to reveal the whole graph", () => {
    const bounds = { x: -120, y: 16, width: 500, height: 6000 };
    const initial = autoFitViewport(bounds, 800, 600);
    expect(bounds.y * initial.zoom + initial.y).toBeCloseTo(24);
    expect((bounds.y + bounds.height) * initial.zoom + initial.y).toBeGreaterThan(600);
    const fitted = getViewportForBounds(bounds, 800, 600, 0, 1, fitPadding);
    expect(fitted.zoom).toBeLessThan(canvasMinZoom);
    expect(bounds.y * fitted.zoom + fitted.y).toBeGreaterThanOrEqual(0);
    expect((bounds.y + bounds.height) * fitted.zoom + fitted.y).toBeLessThanOrEqual(600);
    expect(bounds.x * fitted.zoom + fitted.x).toBeGreaterThanOrEqual(0);
    expect((bounds.x + bounds.width) * fitted.zoom + fitted.x).toBeLessThanOrEqual(800);
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
    // Only a short stub leaves the orphan; the semantic edge still names its real target.
    const route = layout.routes.get("orphan:next")!;
    const points = route.points;
    const end = points[points.length - 1]!;
    expect(end).toEqual({
      x: box("orphan").left - 24,
      y: (box("orphan").top + box("orphan").bottom) / 2,
    });
    expect(route.stub?.label).toBe("next → Done");
    expect(edge(graph, "orphan", "done")).toHaveLength(1);
    for (const [index, from] of points.slice(0, -1).entries()) {
      const to = points[index + 1]!;
      const leg = {
        left: Math.min(from.x, to.x),
        right: Math.max(from.x, to.x),
        top: Math.min(from.y, to.y),
        bottom: Math.max(from.y, to.y),
      };
      for (const id of ids) {
        const b = box(id);
        const inside =
          leg.left < b.right && leg.right > b.left && leg.top < b.bottom && leg.bottom > b.top;
        expect(inside, `${id} on leg ${index}`).toBe(false);
      }
    }
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

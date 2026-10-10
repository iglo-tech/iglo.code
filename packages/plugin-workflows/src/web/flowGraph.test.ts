import { describe, expect, it } from "vite-plus/test";
import { developmentReview, examples } from "../examples.ts";
import { flowGraph, layoutFlow, layoutSignature, repeatLoops } from "./flowGraph.ts";
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
    // Rule summaries are clipped on the canvas; the full text is the edge's hover title.
    expect(edge(graph, "join", "rework")[0]).toMatchObject({
      label: "verdict ∈ changes, bloc…",
      title: "verdict ∈ changes, blocker or +2",
    });
    // Bounded rework returns to implementation and names the limit destination separately.
    expect(edge(graph, "rework", "implement")).toMatchObject([
      {
        kind: "repeat",
        label: "otherwise\n↩ ×1 · 2 visits",
        title: "otherwise · ↩ repeat ×1 (2 visits)",
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
    expect(edge(graph, "review", "review")).toMatchObject([{ kind: "atLimit" }]);
    expect(layoutFlow(graph).routes.get("review:changes.repeat")?.points.length).toBeGreaterThan(1);
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

  it("gives every box a distinct focus id", () => {
    expect(stepButtonId("agent-1")).toBe("wf-step-agent-1");
    expect(stepButtonId("reviews/code")).not.toBe(stepButtonId("reviews-code"));
    expect(stepButtonId("a_x002f")).not.toBe(stepButtonId("a/"));
  });
});

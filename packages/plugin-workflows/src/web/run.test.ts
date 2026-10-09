import { describe, expect, it } from "vite-plus/test";
import type { Attempt, Definition, Run } from "../contracts.ts";
import { developmentReview } from "../examples.ts";
import { flowGraph } from "./flowGraph.ts";
import { repeatEvidence, stepStates, takenEdges } from "./run.ts";

type Visit = Pick<Attempt, "nodeId" | "branchId" | "phase" | "generation">;
type Routed = Pick<
  Run["trace"][number],
  "nodeId" | "chosen" | "considered" | "repeatCount" | "route" | "repeat"
>;
const visit = (nodeId: string, phase: Attempt["phase"], branchId: string | null = null): Visit => ({
  nodeId,
  branchId,
  phase,
  generation: 1,
});
const routed = (
  nodeId: string,
  chosen: string,
  matched: ReadonlyArray<boolean> = [],
  repeatCount: number | null = null,
): Routed => ({
  nodeId,
  chosen,
  repeatCount,
  considered: matched.map((value) => ({
    predicate: { op: "present", path: "x" },
    matched: value,
  })),
});
const states = (
  state: Run["state"],
  currentNode: string,
  attempts: ReadonlyArray<Visit>,
  trace: ReadonlyArray<Routed>,
  definition: Definition = developmentReview,
) => stepStates({ definition, state, currentNode, attempts, trace });

// Implementation and checks passed; the check result routed to the human gate.
const toGate = {
  attempts: [visit("implement", "completed"), visit("checks", "completed")],
  trace: [
    routed("implement", "checks"),
    routed("checks", "check-result"),
    routed("check-result", "human", [false]),
  ],
};

describe("run step states", () => {
  it("shows a gate waiting for a decision as the running step", () => {
    const gate = states("awaiting-review", "human", toGate.attempts, toGate.trace).get("human");
    expect(gate).toMatchObject({ status: "running", word: "Waiting", visits: 1 });
    expect(states("awaiting-review", "human", toGate.attempts, toGate.trace).get("done")).toBe(
      undefined,
    );
  });

  it("shows a run that stopped at a gate as stopped there, with the run's state", () => {
    expect(states("unresolved", "human", toGate.attempts, toGate.trace).get("human")).toMatchObject(
      { status: "stopped", label: "Unresolved" },
    );
    expect(states("canceled", "human", toGate.attempts, toGate.trace).get("human")).toMatchObject({
      status: "stopped",
      label: "Canceled",
    });
  });

  it("counts repeat visits and keeps the latest visit's status", () => {
    const result = states(
      "running",
      "implement",
      [
        visit("implement", "completed"),
        visit("checks", "completed"),
        visit("implement", "running"),
      ],
      [],
    );
    expect(result.get("implement")).toMatchObject({ status: "running", visits: 2 });
    expect(result.get("checks")).toMatchObject({ status: "completed", visits: 1 });
  });

  it("aggregates reviewer lanes into their group by the least settled lane", () => {
    const result = states(
      "running",
      "reviews",
      [
        visit("reviews", "completed", "code"),
        visit("reviews", "reported", "security"),
        visit("reviews", "completed", "ux"),
      ],
      [],
    );
    expect(result.get("reviews/security")).toMatchObject({ status: "reported" });
    expect(result.get("reviews")).toMatchObject({ status: "reported", label: "2 of 3 settled" });
  });

  it("shows the end a run finished at with the run's outcome", () => {
    const trace = [...toGate.trace, routed("human", "done")];
    expect(states("completed", "done", toGate.attempts, trace).get("done")).toMatchObject({
      status: "completed",
      label: "Completed",
    });
    expect(states("completed", "done", toGate.attempts, trace).get("unresolved")).toBe(undefined);
  });
});

describe("taken routes", () => {
  const drawn = (definition: Definition) => new Set(flowGraph(definition).edges.map((e) => e.id));

  it("lights the edges the recorded routing took, including an exhausted repeat's At limit", () => {
    const taken = takenEdges(developmentReview, [
      ...toGate.trace,
      routed("rework", "implement", [], 1),
      routed("rework", "human", [], 1),
    ]);
    expect([...taken].sort()).toEqual(
      [
        "check-result:otherwise",
        "checks:next",
        "implement:next",
        "rework:otherwise",
        "rework:otherwise.repeat",
      ].sort(),
    );
    for (const id of taken) expect(drawn(developmentReview).has(id)).toBe(true);
  });

  it("tells two rules to the same step apart by the recorded first match", () => {
    const definition: Definition = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "check-result" && node.kind === "decision"
          ? {
              ...node,
              rules: [
                { when: { op: "eq", path: "exitCode", value: 0 }, route: { to: "reviews" } },
                { when: { op: "eq", path: "exitCode", value: 1 }, route: { to: "reviews" } },
              ],
            }
          : node,
      ),
    };
    expect([...takenEdges(definition, [routed("check-result", "reviews", [false, true])])]).toEqual(
      ["check-result:rules.1"],
    );
    expect([...takenEdges(definition, [routed("check-result", "reviews", [true])])]).toEqual([
      "check-result:rules.0",
    ]);
  });

  it("does not light a repeat's At limit edge when a plain route reaches the same step", () => {
    // Approve goes to Done; Changes repeats back to work and, at its limit, also ends at Done.
    const definition: Definition = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "human" && node.kind === "human"
          ? {
              ...node,
              approve: { to: "done" },
              changes: { to: "implement", repeat: { max: 1, atLimit: "done" } },
            }
          : node,
      ),
    };
    expect([...takenEdges(definition, [routed("human", "done")])]).toEqual(["human:approve"]);
    expect([...takenEdges(definition, [routed("human", "done", [], 1)])]).toEqual([
      "human:changes.repeat",
    ]);
  });
  it("matches the recorded route exactly, even when two routes share a destination", () => {
    // Approve and Request changes both go to Done; only the recorded control lights.
    const definition: Definition = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.id === "human" && node.kind === "human"
          ? { ...node, approve: { to: "done" }, changes: { to: "done" } }
          : node,
      ),
    };
    expect([...takenEdges(definition, [{ ...routed("human", "done"), route: "changes" }])]).toEqual(
      ["human:changes"],
    );
  });

  it("lights a repeat's At limit edge at its limit and nothing when the run bound diverted it", () => {
    const repeat = (outcome: "admitted" | "limit" | "visit-limit", chosen: string) => ({
      ...routed("rework", chosen, [], 1),
      route: "otherwise",
      repeat: { max: 1, atLimit: "human", exhausted: outcome === "limit", outcome },
    });
    expect([...takenEdges(developmentReview, [repeat("admitted", "implement")])]).toEqual([
      "rework:otherwise",
    ]);
    expect([...takenEdges(developmentReview, [repeat("limit", "human")])]).toEqual([
      "rework:otherwise.repeat",
    ]);
    expect([...takenEdges(developmentReview, [repeat("visit-limit", "human")])]).toEqual([]);
    expect(repeatEvidence(developmentReview, repeat("admitted", "implement"))).toMatchObject({
      label: "repeat 1/1",
      limit: false,
    });
    expect(repeatEvidence(developmentReview, repeat("limit", "human"))).toMatchObject({
      label: "at limit",
      limit: true,
      detail: "1/1 repeats used · at limit → Human review",
    });
  });
});

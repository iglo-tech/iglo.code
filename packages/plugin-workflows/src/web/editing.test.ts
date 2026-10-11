import { describe, expect, it } from "vite-plus/test";
import { developmentReview } from "../examples.ts";
import { definitionProblems } from "../definition.ts";
import {
  addStep,
  exportYaml,
  importYaml,
  localProblems,
  moveStep,
  newDefinition,
  problemText,
  removeStep,
  reviewerAt,
  routeList,
  stepTitle,
} from "./editing.ts";

const capabilities = {
  nodeKinds: ["agent", "end"] as const,
  discoveryError: null,
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      available: true,
      reporting: true,
      reason: null,
      runtimeModes: ["approval-required" as const],
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, optionDescriptors: [] }],
    },
  ],
};

describe("workflow authoring", () => {
  it("builds a connected reported sequence with the canonical schema", () => {
    const empty = newDefinition("Implement and review");
    expect(empty).toMatchObject({ id: "implement-and-review", entry: "done", atLimit: "done" });
    const first = addStep(empty, "agent", null, capabilities);
    const second = addStep(first.definition, "agent", first.id, capabilities);
    const definition = second.definition;
    expect(definition.entry).toBe(first.id);
    expect(routeList(definition).map((route) => [route.from.id, route.to])).toEqual([
      [first.id, second.id],
      [second.id, "done"],
    ]);
    // Instructions are required before publication; the problem names its control.
    expect(localProblems(definition)).toContainEqual({
      severity: "error",
      message: `${first.id}: add instructions.`,
      nodeId: first.id,
      control: "instruction",
    });
    const ready = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.kind === "agent" ? { ...node, instruction: "Do the work" } : node,
      ),
    };
    expect(localProblems(ready)).toEqual([]);
    expect(definitionProblems(ready)).toEqual([]);
  });

  it("reorders reading order without changing routes and reconnects removed agents", () => {
    const one = addStep(newDefinition("Flow"), "agent", null, capabilities);
    const two = addStep(one.definition, "agent", one.id, capabilities);
    const moved = moveStep(two.definition, two.id, -1);
    expect(moved.nodes.map((node) => node.id)).toEqual([two.id, one.id, "done"]);
    const edges = (definition: typeof moved) =>
      routeList(definition)
        .map((route) => `${route.from.id}:${route.control}->${route.to}`)
        .sort();
    expect(edges(moved)).toEqual(edges(two.definition));
    const removed = removeStep(two.definition, one.id);
    expect(removed.entry).toBe(two.id);
    const end = addStep(removed, "end", null, capabilities);
    const dangling = removeStep(
      {
        ...end.definition,
        nodes: end.definition.nodes.map((node) =>
          node.kind === "agent" ? { ...node, next: { to: end.id } } : node,
        ),
      },
      end.id,
    );
    // Removing a route target leaves the route visible as a located error to repair.
    expect(localProblems(dangling)).toContainEqual(
      expect.objectContaining({ nodeId: two.id, control: "next", severity: "error" }),
    );
  });

  it("preserves every node kind and round-trips canonical YAML", () => {
    const edited = removeStep(
      addStep(developmentReview, "agent", "implement", capabilities).definition,
      "implement",
    );
    expect(edited.nodes.map((node) => node.kind).sort()).toEqual(
      developmentReview.nodes.map((node) => node.kind).sort(),
    );
    const parallel = edited.nodes.find((node) => node.kind === "parallel");
    expect(parallel).toEqual(developmentReview.nodes.find((node) => node.kind === "parallel"));
    const exported = exportYaml(developmentReview);
    expect(exported.protectedValues).toBe(0);
    expect(importYaml(exported.text)).toEqual({ _tag: "Success", definition: developmentReview });
    const placeholder = "⟦protected:0123456789ab:0⟧";
    expect(
      exportYaml({
        ...developmentReview,
        nodes: developmentReview.nodes.map((node) =>
          node.kind === "agent" ? { ...node, instruction: placeholder } : node,
        ),
      }).protectedValues,
    ).toBe(1);
    expect(importYaml("nodes: [")._tag).toBe("Failure");
    expect(importYaml("version: 2")._tag).toBe("Failure");
  });

  it("locates schema issues at their control and names steps by title", () => {
    const { definition, id } = addStep(newDefinition("Flow"), "agent", null, capabilities);
    const ready = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.kind === "agent" ? { ...node, instruction: "Do the work" } : node,
      ),
    };
    expect(localProblems({ ...ready, maxVisits: 0 })).toEqual([
      expect.objectContaining({ severity: "error", control: "maxVisits" }),
    ]);
    const missing = localProblems(definition).find((problem) => problem.control === "instruction")!;
    expect(problemText(missing, stepTitle(definition))).toBe("Agent step 1: add instructions.");
    expect(problemText(missing, null)).toBe("Add instructions.");
    expect(missing.nodeId).toBe(id);
  });

  it("warns about a step the entry never reaches", () => {
    const { definition } = addStep(newDefinition("Flow"), "agent", null, capabilities);
    const agent = definition.nodes.find((node) => node.kind === "agent")!;
    const orphan = {
      ...agent,
      id: "orphan",
      title: "Orphan",
      instruction: "Do",
      next: { to: "done" },
    };
    expect(localProblems({ ...definition, nodes: [...definition.nodes, orphan] })).toContainEqual({
      severity: "warning",
      message: "orphan: this step is unreachable from the entry step.",
      nodeId: "orphan",
    });
  });

  it("keeps the Start step when adding and moves it to the successor when removed", () => {
    const one = addStep(newDefinition("Flow"), "agent", null, capabilities);
    expect(one.definition.entry).toBe(one.id);
    // An unselected add appends to the entry's sequence instead of taking over the Start.
    const two = addStep(one.definition, "agent", null, capabilities);
    expect(two.definition.entry).toBe(one.id);
    expect(routeList(two.definition).map((route) => [route.from.id, route.to])).toEqual([
      [one.id, two.id],
      [two.id, "done"],
    ]);
    expect(addStep(two.definition, "end", null, capabilities).definition.entry).toBe(one.id);
    expect(removeStep(two.definition, one.id).entry).toBe(two.id);
    // Without a successor the Start is left unset, which validation reports.
    const lone = removeStep({ ...one.definition, entry: "done" }, "done");
    expect(lone.entry).toBe("done");
    expect(localProblems(lone)).toContainEqual(
      expect.objectContaining({ control: "entry", severity: "error" }),
    );
  });

  it("keeps a non-agent Start and appends after check steps", () => {
    const onCheck = addStep({ ...developmentReview, entry: "checks" }, "agent", null, capabilities);
    expect(onCheck.definition.entry).toBe("checks");
    expect(routeList(onCheck.definition)).toContainEqual(
      expect.objectContaining({ control: "next", to: onCheck.id }),
    );
    const onHuman = addStep({ ...developmentReview, entry: "human" }, "agent", null, capabilities);
    expect(onHuman.definition.entry).toBe("human");
    expect(localProblems(onHuman.definition)).toContainEqual(
      expect.objectContaining({ nodeId: onHuman.id, severity: "warning" }),
    );
    // agent -> check -> end appends after the whole sequence.
    const chain = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.kind === "check" ? { ...node, next: { to: "human" } } : node,
      ),
    } satisfies typeof developmentReview;
    const appended = addStep(chain, "agent", null, capabilities);
    expect(appended.definition.entry).toBe("implement");
    const checks = appended.definition.nodes.find((node) => node.id === "checks");
    expect(checks?.kind === "check" && checks.next.to).toBe(appended.id);
  });

  it("names new steps with the first unused number", () => {
    const one = addStep(newDefinition("Flow"), "agent", null, capabilities);
    const two = addStep(one.definition, "agent", null, capabilities);
    const without = removeStep(two.definition, one.id);
    const three = addStep(without, "agent", null, capabilities);
    const titles = three.definition.nodes.filter((n) => n.kind === "agent").map((n) => n.title);
    expect(new Set(titles).size).toBe(2);
    expect(titles).toContain("Agent step 1");
  });

  it("counts the run limit destination reachable when the flow can exceed a small limit", () => {
    const stop = developmentReview.nodes.find((node) => node.id === "done")!;
    const agent = developmentReview.nodes.find((node) => node.id === "implement")!;
    const chain = (maxVisits: number) =>
      ({
        ...developmentReview,
        maxVisits,
        entry: "a",
        atLimit: "stop",
        nodes: [
          ...["a", "b", "c"].map((id, index) => ({
            ...agent,
            id,
            title: id,
            next: { to: ["b", "c", "done"][index]! },
          })),
          stop,
          { ...stop, id: "stop", title: "Stop", outcome: "failed" },
        ],
      }) as typeof developmentReview;
    const stopWarnings = (maxVisits: number) =>
      localProblems(chain(maxVisits)).filter(
        (p) => p.severity === "warning" && p.nodeId === "stop",
      );
    expect(stopWarnings(2)).toEqual([]);
    expect(stopWarnings(10)).toHaveLength(1);
  });

  it("warns about unreachable steps of every kind, including the run limit destination", () => {
    const entryIsEnd = { ...developmentReview, entry: "done" };
    const warned = localProblems(entryIsEnd)
      .filter((problem) => problem.severity === "warning")
      .map((problem) => problem.nodeId);
    expect(warned).toEqual(expect.arrayContaining(["implement", developmentReview.atLimit]));
    expect(localProblems(developmentReview).filter((p) => p.severity === "warning")).toEqual([]);
  });

  it("names the field of a workflow-level problem and finds a selected reviewer", () => {
    const limit = localProblems({ ...newDefinition("Flow"), maxVisits: 0 })[0]!;
    expect(problemText(limit, () => "x")).toMatch(/^Run visit limit: /);
    expect(problemText(limit, null)).toBe(limit.message);
    const group = developmentReview.nodes.find((node) => node.kind === "parallel")!;
    const lane = group.kind === "parallel" ? group.branches[1]! : undefined;
    expect(reviewerAt(developmentReview, `${group.id}/${lane?.id}`)).toMatchObject({ lane: 1 });
    expect(reviewerAt(developmentReview, group.id)).toBeUndefined();
  });
});

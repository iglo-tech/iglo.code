import { describe, expect, it } from "vite-plus/test";
import { developmentReview } from "../examples.ts";
import { definitionProblems } from "../definition.ts";
import { sourceFields } from "../definition.ts";
import type { Definition, Node } from "../contracts.ts";
import { addTerm, readsAs } from "./decisions.ts";
import {
  addStep,
  exportYaml,
  importYaml,
  localProblems,
  moveStep,
  newDefinition,
  removeStep,
  routeList,
  routeText,
  updateNode,
} from "./editing.ts";

const capabilities = {
  nodeKinds: ["agent", "check", "decision", "human", "end"] as const,
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
});

describe("decision and repeat authoring", () => {
  /** Agent → Check → Decision, built the way the palette builds it. */
  const checked = () => {
    const agent = addStep(newDefinition("Checked"), "agent", null, capabilities);
    const check = addStep(agent.definition, "check", agent.id, capabilities);
    const decision = addStep(check.definition, "decision", check.id, capabilities);
    const human = addStep(decision.definition, "human", decision.id, capabilities);
    return {
      agent: agent.id,
      check: check.id,
      decision: decision.id,
      human: human.id,
      definition: human.definition,
    };
  };
  const node = <K extends Node["kind"]>(definition: Definition, id: string, _kind: K) =>
    definition.nodes.find((item) => item.id === id) as Extract<Node, { kind: K }>;

  it("inserts checks, decisions and gates into the continuing route and reads the prior step", () => {
    const built = checked();
    expect(
      routeList(built.definition).map((route) => [route.from.id, route.control, route.to]),
    ).toEqual([
      [built.agent, "next", built.check],
      [built.check, "next", built.decision],
      [built.decision, "otherwise", built.human],
      [built.human, "approve", "done"],
      [built.human, "changes", "done"],
    ]);
    expect(node(built.definition, built.decision, "decision").source).toBe(built.check);
    // A new check has no command yet; publication is blocked at that control.
    expect(localProblems(built.definition)).toContainEqual(
      expect.objectContaining({ nodeId: built.check, control: "command", severity: "error" }),
    );
  });

  it("shows the packaged development example's bounded rework reaching its human gate", () => {
    const lines = routeList(developmentReview).map(
      (route) => `${route.from.title} — ${routeText(developmentReview, route)}`,
    );
    expect(lines).toContain(
      "Bounded rework — Otherwise ↩ Implement · repeat ×1 (2 visits) · at limit → Human review",
    );
    expect(lines).toContain("Human review — Approve → Done");
    expect(developmentReview.atLimit).toBe("human");
  });

  it("reads the saved predicate with nesting, first-match order and absence semantics", () => {
    const fields = new Map([
      ["exitCode", { name: "exitCode", type: "number" as const, required: false }],
      ["timedOut", { name: "timedOut", type: "boolean" as const, required: true }],
    ]);
    const predicate = addTerm({ op: "eq", path: "timedOut", value: false }, [], {
      op: "any",
      terms: [
        { op: "ne", path: "exitCode", value: 0 },
        { op: "absent", path: "exitCode" },
      ],
    });
    expect(readsAs(predicate, fields)).toBe(
      "timedOut equals false and (exitCode does not equal 0 (false when exitCode is absent) or exitCode is absent)",
    );
    expect(readsAs({ op: "eq", path: "data.gone", value: 1 }, fields)).toBe(
      "data.gone (missing field) equals 1",
    );
  });

  it("explains Repeat once as two visits and exposes removed repeat targets as repairable errors", () => {
    const built = checked();
    const repeating = updateNode(built.definition, built.decision, (item) =>
      item.kind === "decision"
        ? {
            ...item,
            rules: [
              {
                when: { op: "eq", path: "exitCode", value: 0 },
                route: { to: built.human },
              },
            ],
            otherwise: { to: built.agent, repeat: { max: 1, atLimit: built.human } },
          }
        : item,
    );
    const otherwise = routeList(repeating).find((route) => route.control === "otherwise")!;
    expect(routeText(repeating, otherwise)).toBe(
      "Otherwise ↩ Agent step 1 · repeat ×1 (2 visits) · at limit → Human gate 1",
    );
    const rule = routeList(repeating).find((route) => route.control === "rules.0")!;
    expect(routeText(repeating, rule)).toBe(
      "Rule 1 (if exitCode equals 0 (false when exitCode is absent)) → Human gate 1",
    );
    // The cycle crosses a bounded repeat, so only the unfilled instruction and command remain.
    expect(
      localProblems(repeating)
        .filter((problem) => problem.severity === "error")
        .map((problem) => problem.control),
    ).toEqual(["instruction", "command"]);
    // Removing the At limit destination leaves the repeat in place with a located error.
    const withoutLimit = removeStep(repeating, built.human);
    expect(node(withoutLimit, built.decision, "decision").otherwise.repeat?.atLimit).toBe(
      built.human,
    );
    expect(localProblems(withoutLimit)).toContainEqual(
      expect.objectContaining({
        nodeId: built.decision,
        control: "otherwise.repeat",
        severity: "error",
      }),
    );
    // Removing the return target keeps the dangling route visible instead of rerouting it.
    const withoutReturn = removeStep(repeating, built.agent);
    expect(node(withoutReturn, built.decision, "decision").otherwise.to).toBe(built.agent);
    expect(localProblems(withoutReturn)).toContainEqual(
      expect.objectContaining({ nodeId: built.decision, control: "otherwise", severity: "error" }),
    );
    // An operand of the wrong type is located at its exact condition.
    const wrong = updateNode(repeating, built.decision, (item) =>
      item.kind === "decision"
        ? {
            ...item,
            rules: [
              {
                ...item.rules[0]!,
                when: { op: "all", terms: [{ op: "eq", path: "timedOut", value: "yes" }] },
              },
            ],
          }
        : item,
    );
    expect(sourceFields(node(wrong, built.check, "check"), wrong).get("timedOut")?.type).toBe(
      "boolean",
    );
    expect(localProblems(wrong)).toContainEqual(
      expect.objectContaining({
        nodeId: built.decision,
        control: "rules.0.when.0",
        severity: "error",
      }),
    );
  });

  it("locates a second repeat to the same step, a later source, and too many listed values", () => {
    const built = checked();
    const decision = node(built.definition, built.decision, "decision");
    const edit = (update: Partial<typeof decision>) =>
      localProblems(
        updateNode(built.definition, built.decision, () => ({ ...decision, ...update })),
      );
    const twice = edit({
      rules: [
        {
          when: { op: "eq", path: "exitCode", value: 1 },
          route: { to: built.agent, repeat: { max: 2, atLimit: built.human } },
        },
      ],
      otherwise: { to: built.agent, repeat: { max: 1, atLimit: built.human } },
    });
    expect(twice).toContainEqual(
      expect.objectContaining({
        nodeId: built.decision,
        control: "otherwise.repeat",
        severity: "error",
        message: expect.stringContaining("Rule 1 already repeats back to agent-1"),
      }),
    );
    expect(edit({ source: built.human })).toContainEqual(
      expect.objectContaining({ nodeId: built.decision, control: "source", severity: "error" }),
    );
    const many = edit({
      rules: [
        {
          when: {
            op: "in",
            path: "outcome",
            values: Array.from({ length: 33 }, (_, i) => `v${i}`),
          },
          route: { to: built.human },
        },
      ],
    });
    expect(many).toContainEqual(
      expect.objectContaining({
        nodeId: built.decision,
        control: "rules.0.when",
        message: `${built.decision}: "is one of" accepts at most 32 values.`,
      }),
    );
  });
});

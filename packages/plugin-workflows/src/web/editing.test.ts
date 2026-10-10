import { describe, expect, it } from "vite-plus/test";
import { developmentReview } from "../examples.ts";
import { definitionProblems } from "../definition.ts";
import { sourceFields } from "../definition.ts";
import type { Definition, Node } from "../contracts.ts";
import { addTerm, fieldLabels, readsAs } from "./decisions.ts";
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

  it("numbers added ends so each has a distinct title", () => {
    const first = addStep(newDefinition("Flow"), "end", null, capabilities);
    const second = addStep(first.definition, "end", null, capabilities);
    const third = addStep(second.definition, "end", null, capabilities);
    expect(third.definition.nodes.filter((n) => n.id !== "done").map((n) => n.title)).toEqual([
      "End 1",
      "End 2",
      "End 3",
    ]);
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

  it("counts human gates and review groups at their runtime cost", () => {
    const stop = developmentReview.nodes.find((node) => node.id === "done")!;
    const agent = developmentReview.nodes.find((node) => node.id === "implement")!;
    const human = developmentReview.nodes.find((node) => node.kind === "human")!;
    const group = developmentReview.nodes.find((node) => node.kind === "parallel")!;
    const warnings = (maxVisits: number, middle: ReadonlyArray<unknown>, first: string) =>
      localProblems({
        ...developmentReview,
        maxVisits,
        entry: "a",
        atLimit: "stop",
        nodes: [
          { ...agent, id: "a", title: "a", next: { to: first } },
          ...middle,
          stop,
          { ...stop, id: "stop", title: "Stop", outcome: "failed" },
        ],
      } as typeof developmentReview).filter((p) => p.severity === "warning" && p.nodeId === "stop");
    // a, gate, b is three admitted visits against a limit of two.
    expect(
      warnings(
        2,
        [
          { ...human, id: "gate", title: "Gate", approve: { to: "b" }, changes: { to: "b" } },
          { ...agent, id: "b", title: "b", next: { to: "done" } },
        ],
        "gate",
      ),
    ).toEqual([]);
    // a plus a two-reviewer group (open, two reviewers, join) is five against four.
    expect(
      warnings(
        4,
        [
          {
            ...group,
            id: "group",
            branches: group.kind === "parallel" ? group.branches.slice(0, 2) : [],
            next: { to: "done" },
          },
        ],
        "group",
      ),
    ).toEqual([]);
  });

  it("shows schema and hand-check problems together without repeating one", () => {
    const { definition } = addStep(newDefinition("Flow"), "agent", null, capabilities);
    const problems = localProblems({ ...definition, maxVisits: 0 });
    expect(problems.map((problem) => problem.control)).toEqual(
      expect.arrayContaining(["instruction", "maxVisits"]),
    );
    expect(problems.filter((problem) => problem.control === "maxVisits")).toHaveLength(1);
    const unnamed = localProblems({ ...definition, title: "" });
    expect(unnamed.filter((problem) => problem.control === "title")).toHaveLength(1);
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
    const cleared = edit({
      rules: [
        {
          when: { op: "all", terms: [{ op: "gt", path: "exitCode" }] },
          route: { to: built.human },
        },
      ],
    });
    expect(cleared).toContainEqual(
      expect.objectContaining({
        nodeId: built.decision,
        control: "rules.0.when.0",
        message: `${built.decision}: enter a value.`,
      }),
    );
  });

  it("labels picker fields by name unless another option shares it", () => {
    const join = developmentReview.nodes.find((item) => item.kind === "join");
    const labels = fieldLabels(
      [...sourceFields(join, developmentReview).keys()],
      developmentReview,
    );
    expect(labels.get("result")).toBe("result");
    expect(labels.get("branches.code.data.verdict")).toBe("Code · data.verdict");
    expect(labels.get("branches.security.summary")).toBe("Security · summary");
    const implement = developmentReview.nodes.find((item) => item.id === "implement");
    const own = fieldLabels(
      [...sourceFields(implement, developmentReview).keys(), "data.summary"],
      developmentReview,
    );
    expect(own.get("data.ready")).toBe("ready");
    expect(own.get("summary")).toBe("summary");
    expect(own.get("data.summary")).toBe("data.summary");
    const sameTitles = {
      ...developmentReview,
      nodes: developmentReview.nodes.map((node) =>
        node.kind === "parallel"
          ? { ...node, branches: node.branches.map((branch) => ({ ...branch, title: "Review" })) }
          : node,
      ),
    };
    const twins = fieldLabels(
      ["branches.code.summary", "branches.security.summary", "branches.security.data.verdict"],
      sameTitles,
    );
    expect(twins.get("branches.code.summary")).toBe("Review (code) · summary");
    expect(twins.get("branches.security.summary")).toBe("Review (security) · summary");
    expect(twins.get("branches.security.data.verdict")).toBe("verdict");
  });
});

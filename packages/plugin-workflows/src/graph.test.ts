import { describe, expect, it } from "vite-plus/test";
import { examples } from "./examples.ts";
import { allowedActions, transition, withheldDecisions, type State } from "./graph.ts";
import { repeatEvidence, withheldNotice } from "./web/run.ts";

const implementation = examples.find((definition) => definition.id === "implementation")!;
const gate = implementation.nodes.find((node) => node.kind === "human")!;
/** A run waiting at the human gate after another repeat already stopped automation. */
const stopped = (): State =>
  ({
    id: "run",
    definition: implementation,
    state: "awaiting-review",
    revision: 3,
    currentNode: gate.id,
    visits: 4,
    automationStopped: true,
    repeats: {},
    attempts: [],
    trace: [],
    reviews: [],
    reason: null,
    gate: { nodeId: gate.id, revision: 3, reviewId: null },
    allowedActions: [],
  }) as unknown as State;

describe("repeat routes", () => {
  it("does not spend or report a repeat that stopped automation diverts", () => {
    const run = stopped();
    if (gate.kind !== "human") throw new Error("Expected a human gate");
    transition(run, gate.id, gate.changes, 1, {
      control: "changes",
      reason: "Human decision: request-changes.",
    });
    expect(run.repeats).toEqual({});
    const item = run.trace.at(-1)!;
    expect(item).toMatchObject({
      chosen: "review",
      reason: "The exhausted automation bound permits only human gates or an end.",
      repeatCount: 0,
      repeat: { exhausted: false, outcome: "automation-stopped" },
    });
    expect(repeatEvidence(implementation, item)).toEqual({
      label: "not repeated",
      limit: true,
      detail: "Automation stopped · 0/1 repeats used · → Human review",
    });
  });

  it("spends the counter only when the repeat is admitted", () => {
    const run = { ...stopped(), automationStopped: false, state: "running" } as State;
    if (gate.kind !== "human") throw new Error("Expected a human gate");
    transition(run, gate.id, { to: gate.id, repeat: { max: 1, atLimit: "done" } }, 1, {
      control: "changes",
    });
    expect(run.repeats).toEqual({ "review:review": 1 });
    expect(repeatEvidence(implementation, run.trace.at(-1)!)).toEqual({
      label: "repeat 1/1",
      limit: false,
      detail: "Visit 2 of up to 2 · at limit → Done",
    });
  });

  it("offers only gate decisions the server would admit as authored, and says why", () => {
    const run = stopped();
    expect(allowedActions(run)).toEqual(["cancel", "approve"]);
    const [withheld] = withheldDecisions(run);
    expect(withheld).toEqual({
      action: "request-changes",
      to: "implement",
      repeat: true,
      cause: "automation-stopped",
    });
    expect(withheldNotice(implementation, withheld!)).toEqual({
      title: "Request changes unavailable",
      detail: "↩ Implement · automation stopped",
    });
    // Once the repeat is exhausted its own At limit is the authored route, so it is offered.
    const exhausted = { ...run, repeats: { "review:implement": 1 } } as State;
    expect(allowedActions(exhausted)).toEqual(["cancel", "approve", "request-changes"]);
  });
});

import { describe, expect, it } from "vite-plus/test";
import type { Attempt, Run } from "../contracts.ts";
import { developmentReview } from "../examples.ts";
import { stepStates } from "./run.ts";

type Visit = Pick<Attempt, "nodeId" | "branchId" | "phase" | "generation">;
const visit = (nodeId: string, phase: Attempt["phase"], branchId: string): Visit => ({
  nodeId,
  branchId,
  phase,
  generation: 1,
});
const states = (
  state: Run["state"],
  currentNode: string,
  attempts: ReadonlyArray<Visit>,
  trace: Run["trace"],
) => stepStates({ definition: developmentReview, state, currentNode, attempts, trace });

describe("reviewer settlement presentation", () => {
  it.each([
    ["completed", "completed", "Done", "Completed"],
    ["failed", "failed", "Failed", "Failed"],
    ["unresolved", "stopped", "Stopped", "Unresolved"],
    ["interrupted", "stopped", "Stopped", "Interrupted"],
    ["canceled", "stopped", "Stopped", "Canceled"],
    ["stale", "stopped", "Stopped", "Stale"],
  ] as const)(
    "counts a %s reviewer as settled alongside a still-reported peer",
    (phase, status, word, label) => {
      const result = states(
        "running",
        "reviews",
        [
          visit("reviews", phase, "code"),
          visit("reviews", "completed", "security"),
          visit("reviews", "reported", "ux"),
        ],
        [],
      );
      expect(result.get("reviews/code")).toMatchObject({ status, word, label });
      expect(result.get("reviews")).toMatchObject({
        status: "reported",
        word: "Reported",
        label: "2 of 3 settled",
      });
      expect(result.get("join")).toBeUndefined();
    },
  );

  it("counts a fully settled mixed-outcome group without presenting it as successful", () => {
    const result = states(
      "unresolved",
      "unresolved",
      [
        visit("reviews", "failed", "code"),
        visit("reviews", "canceled", "security"),
        visit("reviews", "completed", "ux"),
      ],
      [],
    );
    expect(result.get("reviews")).toMatchObject({
      status: "failed",
      word: "Failed",
      label: "3 of 3 settled",
    });
    expect(result.get("reviews/security")).toMatchObject({ status: "stopped", label: "Canceled" });
  });

  it("keeps unlaunched, launching, running and reported reviewers out of settlement", () => {
    const pending = states("running", "reviews", [visit("reviews", "failed", "code")], []);
    expect(pending.get("reviews")).toMatchObject({ label: "1 of 3 settled", status: "failed" });
    expect(pending.get("reviews/security")).toBeUndefined();
    const active = states(
      "running",
      "reviews",
      [
        visit("reviews", "launching", "code"),
        visit("reviews", "running", "security"),
        visit("reviews", "reported", "ux"),
      ],
      [],
    );
    expect(active.get("reviews")).toMatchObject({ label: "0 of 3 settled", status: "running" });
  });

  it("counts only the latest visible lane after retry, not its terminal history", () => {
    const history = [
      visit("reviews", "failed", "code"),
      visit("reviews", "completed", "code"),
      visit("reviews", "interrupted", "security"),
    ];
    const retry = { ...visit("reviews", "running", "code"), generation: 2 };
    const running = states("running", "reviews", [...history, retry], []);
    expect(running.get("reviews/code")).toMatchObject({ status: "running", visits: 3 });
    expect(running.get("reviews")).toMatchObject({ label: "1 of 3 settled", visits: 2 });
    const reported = states(
      "running",
      "reviews",
      [...history, { ...retry, phase: "reported" }],
      [],
    );
    expect(reported.get("reviews")).toMatchObject({ label: "1 of 3 settled", status: "reported" });
    const settled = states(
      "unresolved",
      "unresolved",
      [...history, { ...retry, phase: "stale" }],
      [],
    );
    expect(settled.get("reviews/code")).toMatchObject({
      status: "stopped",
      label: "Stale",
      visits: 3,
    });
    expect(settled.get("reviews")).toMatchObject({ label: "2 of 3 settled", visits: 2 });
  });
});

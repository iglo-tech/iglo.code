import { describe, expect, it } from "vite-plus/test";

import { chartMax, chartPaths, nearestIndex, niceMax } from "./hostHealthChart.logic";

describe("host health charts", () => {
  it("rounds the scale up to a readable top", () => {
    expect([niceMax(0), niceMax(0.7), niceMax(13), niceMax(4_200), niceMax(9_100)]).toEqual([
      1, 1, 20, 5_000, 10_000,
    ]);
  });

  it("breaks the line at missing values and at gaps longer than a few samples", () => {
    const [path] = chartPaths({
      timestamps: [0, 10, 20, 30, 100, 110],
      series: [[0, 50, null, 100, 100, 0]],
      fromMs: 0,
      toMs: 120,
      maxGapMs: 30,
      fixedMax: 100,
    });
    expect(path).toBe("M0.0,120.0L50.0,60.0M150.0,0.0M500.0,0.0L550.0,120.0");
  });

  it("fits the scale to the peak unless one is fixed, and clips values above it", () => {
    const input = { timestamps: [0], series: [[1_700], [300]], fromMs: 0, toMs: 1, maxGapMs: 1 };
    expect(chartMax(input)).toBe(2_000);
    expect(chartPaths({ ...input, fixedMax: 1_000 })[0]).toBe("M0.0,0.0");
  });

  it("finds the sample under the pointer", () => {
    expect(nearestIndex([0, 10, 20], 0.6, 0, 20)).toBe(1);
    expect(nearestIndex([0, 10, 20], 1, 0, 20)).toBe(2);
    expect(nearestIndex([], 0.5, 0, 20)).toBeNull();
  });
});

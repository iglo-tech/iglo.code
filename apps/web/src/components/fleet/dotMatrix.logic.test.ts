import { describe, expect, it } from "vite-plus/test";

import { dotColumns, niceMax } from "./dotMatrix.logic";

const base = { fromMs: 0, toMs: 100, maxGapMs: 10, max: 100, columns: 10, rows: 10 };

describe("dot matrix charts", () => {
  it("rounds the scale up to a readable top", () => {
    expect([niceMax(0), niceMax(0.7), niceMax(13), niceMax(4_200), niceMax(9_100)]).toEqual([
      1, 1, 20, 5_000, 10_000,
    ]);
  });

  it("keeps each column's peak, so a short spike stays visible", () => {
    const { columns } = dotColumns({ ...base, timestamps: [0, 2, 4], series: [[10, 90, 20]] });
    expect(columns[0]).toEqual({ dots: [9], values: [90], at: 4 });
  });

  it("stacks a second series on the first and clips at a fixed top", () => {
    const { columns } = dotColumns({ ...base, timestamps: [0], series: [[60], [70]] });
    expect(columns[0]?.dots).toEqual([6, 4]);
  });

  it("fits the scale to the tallest stacked column, so peaks in one column both show", () => {
    const { max: _fixed, ...fitted } = base;
    const { columns, max } = dotColumns({
      ...fitted,
      timestamps: [1, 2],
      series: [
        [100, 0],
        [0, 100],
      ],
    });
    expect(max).toBe(200);
    expect(columns[0]?.dots).toEqual([5, 5]);
  });

  it("keeps a floor while the data fits under it and grows past it otherwise", () => {
    const { max: _fixed, ...fitted } = base;
    const under = dotColumns({ ...fitted, floor: 16, timestamps: [0], series: [[12], [2]] });
    expect(under.max).toBe(16);
    const over = dotColumns({ ...fitted, floor: 16, timestamps: [0], series: [[15.5], [4]] });
    expect(over.max).toBe(20);
    expect(over.columns[0]?.dots).toEqual([8, 2]);
  });

  it("lights one dot for an idle sample, so idle differs from missing", () => {
    const { columns } = dotColumns({ ...base, timestamps: [0], series: [[0]] });
    expect(columns[0]?.dots).toEqual([1]);
    expect(columns[5]).toBeNull();
  });

  it("carries a column across a short sampling gap but not across downtime", () => {
    const { columns } = dotColumns({ ...base, timestamps: [5, 55], series: [[50, 50]] });
    expect(columns[1]?.at).toBe(5);
    expect(columns[2]).toBeNull();
    expect(columns[5]?.at).toBe(55);
  });
});

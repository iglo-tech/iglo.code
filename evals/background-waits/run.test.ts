import { describe, expect, it } from "vite-plus/test";

import { failingCases } from "./grade.ts";

describe("failingCases", () => {
  it("fails a case when half or more of its samples are wrong or errored", () => {
    expect(
      failingCases([
        { id: "loop", sample: 1, wait: true, expected: true },
        { id: "loop", sample: 2, wait: false, expected: true },
        { id: "loop", sample: 3, wait: true, expected: true },
        { id: "server", sample: 1, wait: true, expected: false },
        { id: "server", sample: 2, wait: null, expected: false },
        { id: "server", sample: 3, wait: false, expected: false },
      ]),
    ).toEqual(["server"]);
  });
});

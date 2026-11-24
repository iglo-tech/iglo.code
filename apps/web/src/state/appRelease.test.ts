import { describe, expect, it } from "vite-plus/test";

import { newerAppRelease } from "./appRelease";

describe("newerAppRelease", () => {
  it("offers a release newer than the server and the page", () => {
    expect(newerAppRelease("0.1.12", "0.1.11", "0.1.11")).toBe("0.1.12");
  });

  it("offers nothing once the server runs the newest release", () => {
    expect(newerAppRelease("0.1.12", "0.1.12", "0.1.11")).toBeNull();
  });

  it("offers nothing when the page runs ahead of the release", () => {
    expect(newerAppRelease("0.1.12", "0.1.11", "0.1.13")).toBeNull();
  });

  it("orders nightly builds by date", () => {
    expect(
      newerAppRelease(
        "0.1.12-nightly.20261124.1",
        "0.1.12-nightly.20261120.3",
        "0.1.12-nightly.20261120.3",
      ),
    ).toBe("0.1.12-nightly.20261124.1");
  });

  it("offers nothing without an answer or a server version", () => {
    expect(newerAppRelease(null, "0.1.11", "0.1.11")).toBeNull();
    expect(newerAppRelease("0.1.12", undefined, "0.1.11")).toBeNull();
  });
});

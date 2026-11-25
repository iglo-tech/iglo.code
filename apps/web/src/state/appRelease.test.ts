import { ServerReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { checkNow, newerAppRelease } from "./appRelease";

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

describe("checkNow", () => {
  it("settles at once when the query fails before it can wait", async () => {
    const registry = AtomRegistry.make();
    const query = Atom.make(Effect.fail(new ServerReleaseError({ reason: "not connected" })));
    registry.mount(query);
    await expect(checkNow(query, registry)).resolves.toContain("not connected");
  });

  it("settles with the answer of a query that waits", async () => {
    const registry = AtomRegistry.make();
    const query = Atom.make(Effect.promise(() => Promise.resolve({ version: "0.1.12" })));
    registry.mount(query);
    await expect(checkNow(query, registry)).resolves.toBeNull();
  });

  it("reports a query that never answers instead of a pass", async () => {
    const registry = AtomRegistry.make();
    const query = Atom.make(Effect.never);
    registry.mount(query);
    await expect(checkNow(query, registry, 10)).resolves.toEqual(expect.any(String));
  });
});

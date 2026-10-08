import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { PLUGIN_DRAFT_LIMITS, createPluginDraftStore } from "./drafts";
import { validatePluginSearch } from "./pageLink";

const memory = () => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};

describe("plugin drafts", () => {
  it("scopes drafts by environment and plugin and survives a new store instance", () => {
    const storage = memory();
    const first = createPluginDraftStore(storage, EnvironmentId.make("one"), "workflows");
    const second = createPluginDraftStore(storage, EnvironmentId.make("two"), "workflows");
    expect(first.write("project:flow", "draft")).toBe(true);
    expect(second.read("project:flow")).toBeNull();
    // A reload creates a new store over the same browser storage.
    expect(
      createPluginDraftStore(storage, EnvironmentId.make("one"), "workflows").read("project:flow"),
    ).toBe("draft");
    first.remove("project:flow");
    expect(first.read("project:flow")).toBeNull();
  });

  it("keeps drafts within a total size budget and lists the survivors", () => {
    const storage = memory();
    const store = createPluginDraftStore(storage, EnvironmentId.make("one"), "workflows");
    const large = "x".repeat(PLUGIN_DRAFT_LIMITS.characters);
    expect(store.write("first", large)).toBe(true);
    expect(store.write("second", large)).toBe(true);
    expect(store.keys()).toEqual(["first", "second"]);
    // A third large draft evicts the oldest so the plugin stays within its budget.
    expect(store.write("third", large)).toBe(true);
    expect(store.keys()).toEqual(["second", "third"]);
    const stored = [...storage.values.values()].reduce((sum, value) => sum + value.length, 0);
    expect(stored).toBeLessThanOrEqual(PLUGIN_DRAFT_LIMITS.totalCharacters + 1_000);
  });

  it("rejects oversized drafts and evicts the least recently written beyond the bound", () => {
    const storage = memory();
    const store = createPluginDraftStore(storage, EnvironmentId.make("one"), "workflows");
    expect(store.write("big", "x".repeat(PLUGIN_DRAFT_LIMITS.characters + 1))).toBe(false);
    for (let index = 0; index <= PLUGIN_DRAFT_LIMITS.entries; index++)
      expect(store.write(`draft-${index}`, String(index))).toBe(true);
    expect(store.read("draft-0")).toBeNull();
    expect(store.read(`draft-${PLUGIN_DRAFT_LIMITS.entries}`)).toBe(
      String(PLUGIN_DRAFT_LIMITS.entries),
    );
  });
});

describe("plugin drafts under a browser quota", () => {
  it("writes first and evicts only the oldest other drafts when the quota rejects", () => {
    const base = memory();
    const quota = 25;
    const storage = {
      ...base,
      setItem: (key: string, value: string) => {
        const used = [...base.values].reduce(
          (sum, [item, stored]) => sum + (item === key ? 0 : stored.length),
          0,
        );
        if (used + value.length > quota) throw new Error("QuotaExceededError");
        base.setItem(key, value);
      },
    };
    const store = createPluginDraftStore(storage, EnvironmentId.make("one"), "workflows");
    expect(store.write("a", "aaaa")).toBe(true);
    expect(store.write("b", "bbbb")).toBe(true);
    // Too large even alone: nothing is evicted and existing drafts survive.
    expect(store.write("huge", "x".repeat(quota + 1))).toBe(false);
    expect([store.read("a"), store.read("b")]).toEqual(["aaaa", "bbbb"]);
    // Fits only after evicting the oldest other draft.
    expect(store.write("c", "c".repeat(10))).toBe(true);
    expect(store.read("a")).toBeNull();
    expect(store.read("b")).toBe("bbbb");
    expect(store.read("c")).toBe("c".repeat(10));
  });
});

describe("plugin page links", () => {
  it("keeps bounded page state and drops invalid state without losing the target", () => {
    expect(
      validatePluginSearch({ pluginProjectId: "project", pluginState: { source: "a.yaml" } }),
    ).toEqual({ pluginProjectId: "project", pluginState: { source: "a.yaml" } });
    for (const pluginState of [
      { source: "x".repeat(257) },
      Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`k${index}`, "v"])),
      "not-an-object",
    ])
      expect(validatePluginSearch({ pluginProjectId: "project", pluginState })).toEqual({
        pluginProjectId: "project",
      });
    // Keys outside the allowed shape never reach the plugin.
    expect(
      validatePluginSearch({ pluginState: { "bad key": "v", source: "a.yaml" } }).pluginState,
    ).toEqual({ source: "a.yaml" });
  });
});

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

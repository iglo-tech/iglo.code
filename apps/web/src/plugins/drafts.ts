import type { EnvironmentId } from "@t3tools/contracts";
import type { PluginDraftStore } from "@t3tools/plugin-host-contract/web";

/**
 * Bounds keep plugin drafts from crowding out the client's own persisted state: browsers
 * typically allow about 5M characters per origin, shared with everything else the app stores.
 */
export const PLUGIN_DRAFT_LIMITS = {
  entries: 16,
  characters: 524_288,
  totalCharacters: 1_048_576,
  key: 256,
} as const;

/**
 * Plugin drafts survive reloads in browser storage, scoped by environment and plugin.
 * The least recently written drafts are evicted to stay within the entry and size budgets.
 */
export function createPluginDraftStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null,
  environmentId: EnvironmentId,
  pluginId: string,
): PluginDraftStore {
  const prefix = `t3code:plugin-drafts:v1:${encodeURIComponent(environmentId)}:${pluginId}`;
  const indexKey = `${prefix}:index`;
  const entryKey = (key: string) => `${prefix}:entry:${encodeURIComponent(key)}`;
  const readIndex = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(storage?.getItem(indexKey) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  const valid = (key: string) => key.length > 0 && key.length <= PLUGIN_DRAFT_LIMITS.key;
  return {
    read: (key) => (storage && valid(key) ? storage.getItem(entryKey(key)) : null),
    keys: () =>
      storage ? readIndex().filter((key) => storage.getItem(entryKey(key)) !== null) : [],
    write: (key, value) => {
      if (!storage || !valid(key) || value.length > PLUGIN_DRAFT_LIMITS.characters) return false;
      const index = [...readIndex().filter((item) => item !== key), key];
      const size = (item: string) =>
        item === key ? value.length : (storage.getItem(entryKey(item))?.length ?? 0);
      let total = index.reduce((sum, item) => sum + size(item), 0);
      const evicted: string[] = [];
      while (
        index.length > 1 &&
        (index.length > PLUGIN_DRAFT_LIMITS.entries || total > PLUGIN_DRAFT_LIMITS.totalCharacters)
      ) {
        const oldest = index.shift()!;
        total -= size(oldest);
        evicted.push(oldest);
      }
      try {
        for (const item of evicted) storage.removeItem(entryKey(item));
        storage.setItem(entryKey(key), value);
        storage.setItem(indexKey, JSON.stringify(index));
        return true;
      } catch {
        return false;
      }
    },
    remove: (key) => {
      if (!storage || !valid(key)) return;
      storage.removeItem(entryKey(key));
      storage.setItem(indexKey, JSON.stringify(readIndex().filter((item) => item !== key)));
    },
  };
}

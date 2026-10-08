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
      const others = readIndex().filter((item) => item !== key);
      // Write first so a failure never costs other drafts; free space only when the
      // browser quota rejects it, oldest first and never the draft being written.
      const removed: Array<readonly [string, string]> = [];
      for (;;) {
        try {
          storage.setItem(entryKey(key), value);
          break;
        } catch {
          const oldest = others.shift();
          if (oldest === undefined) {
            // Even an empty budget cannot hold it: put the evicted drafts back.
            for (const [item, stored] of removed) {
              try {
                storage.setItem(entryKey(item), stored);
              } catch {
                // Space they used is free again, so this only fails if storage changed.
              }
            }
            return false;
          }
          const stored = storage.getItem(entryKey(oldest));
          if (stored !== null) removed.push([oldest, stored]);
          storage.removeItem(entryKey(oldest));
        }
      }
      const size = (item: string) => storage.getItem(entryKey(item))?.length ?? 0;
      let total = others.reduce((sum, item) => sum + size(item), value.length);
      while (
        others.length > 0 &&
        (others.length + 1 > PLUGIN_DRAFT_LIMITS.entries ||
          total > PLUGIN_DRAFT_LIMITS.totalCharacters)
      ) {
        const oldest = others.shift()!;
        total -= size(oldest);
        storage.removeItem(entryKey(oldest));
      }
      try {
        storage.setItem(indexKey, JSON.stringify([...others, key]));
      } catch {
        // The index is advisory; entries remain readable by key.
      }
      return true;
    },
    remove: (key) => {
      if (!storage || !valid(key)) return;
      storage.removeItem(entryKey(key));
      storage.setItem(indexKey, JSON.stringify(readIndex().filter((item) => item !== key)));
    },
  };
}

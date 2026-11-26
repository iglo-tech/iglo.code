import {
  ClientSettingsSchema,
  FORK_CLIENT_DEFAULTS_VERSION,
  withForkClientDefaults,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  LocalStorageOperationError,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const FORK_CLIENT_DEFAULTS_VERSION_KEY = "iglo-code:fork-client-defaults-version";
const ForkClientDefaultsVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const isLocalStorageOperationError = Schema.is(LocalStorageOperationError);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function readForkClientDefaultsVersion(): number {
  try {
    return getLocalStorageItem(FORK_CLIENT_DEFAULTS_VERSION_KEY, ForkClientDefaultsVersion) ?? 0;
  } catch (error) {
    // A corrupt marker reapplies the steps, like the server's fork-defaults-version file.
    if (isLocalStorageOperationError(error) && error.operation === "decode") return 0;
    throw error;
  }
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  const saved = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  const appliedVersion = readForkClientDefaultsVersion();
  if (appliedVersion >= FORK_CLIENT_DEFAULTS_VERSION) {
    return saved;
  }
  const migrated = saved === null ? null : withForkClientDefaults(saved, appliedVersion);
  const changed =
    saved !== null &&
    migrated !== null &&
    Object.entries(migrated).some(([key, value]) => saved[key as keyof ClientSettings] !== value);
  if (changed) {
    setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, migrated, ClientSettingsSchema);
  }
  setLocalStorageItem(
    FORK_CLIENT_DEFAULTS_VERSION_KEY,
    FORK_CLIENT_DEFAULTS_VERSION,
    ForkClientDefaultsVersion,
  );
  return migrated;
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

/** Storage events fire only for other tabs' writes; a null key means storage was cleared. */
export function subscribeBrowserClientSettingsWrites(onChange: () => void): () => void {
  if (!hasWindow()) {
    return () => undefined;
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === CLIENT_SETTINGS_STORAGE_KEY || event.key === null) {
      onChange();
    }
  };
  const target = window;
  target.addEventListener("storage", handleStorage);
  return () => target.removeEventListener("storage", handleStorage);
}

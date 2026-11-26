import type {
  ClientSettings,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

export interface ForkClientDefaultsStep {
  readonly version: number;
  readonly patch: ClientSettingsPatch;
}

/**
 * iglo.code's per-browser defaults: each browser applies pending steps once to its saved client
 * settings, and a browser with none starts from them. Never edit or renumber a shipped step.
 */
const FORK_CLIENT_DEFAULTS_STEPS = [
  {
    version: 1,
    patch: { followUpBehavior: "queue" },
  },
] as const satisfies ReadonlyArray<ForkClientDefaultsStep>;

export const FORK_CLIENT_DEFAULTS_VERSION =
  FORK_CLIENT_DEFAULTS_STEPS[FORK_CLIENT_DEFAULTS_STEPS.length - 1]?.version ?? 0;

export const withForkClientDefaults = (
  settings: ClientSettings,
  appliedVersion = 0,
  steps: ReadonlyArray<ForkClientDefaultsStep> = FORK_CLIENT_DEFAULTS_STEPS,
): ClientSettings =>
  Object.assign(
    { ...settings },
    ...steps.filter((step) => step.version > appliedVersion).map((step) => step.patch),
  );

export interface ForkServerDefaultsStep {
  readonly version: number;
  readonly patch: ServerSettingsPatch;
}

/**
 * iglo.code's server defaults, applied once per server home and used by Settings as the reset
 * target. Never edit or renumber a shipped step; append a higher version instead.
 */
export const FORK_SERVER_DEFAULTS_STEPS = [
  {
    version: 1,
    patch: {
      defaultThreadEnvMode: "worktree",
      reviewGuidesEnabled: true,
      defaultAutoPull: true,
      worktreeCleanup: null,
      storageCleanup: {
        worktreeOnDelete: true,
        worktreeOnMerge: true,
        worktreeAfterDays: 8,
        worktreeSettledAfterDays: 8,
        worktreeUnchanged: true,
      },
      branchNamingMode: "custom",
      branchNameInstructions: 'Use "iglo-code/" followed by the issue ID and a short description.',
      linkedEnvironmentsEnabled: true,
      workflowsEnabled: true,
      promptSuggestionsEnabled: true,
    },
  },
  {
    version: 2,
    patch: { autoResumeLimitedThreads: true },
  },
] as const satisfies ReadonlyArray<ForkServerDefaultsStep>;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const mergeDefaults = (base: unknown, patch: unknown): unknown => {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = mergeDefaults(base[key], value);
  }
  return merged;
};

/** Lays every fork step over upstream's defaults; the server test pins it to its patch logic. */
export const withForkServerDefaults = (defaults: ServerSettings): ServerSettings =>
  FORK_SERVER_DEFAULTS_STEPS.reduce<ServerSettings>(
    (settings, step) => mergeDefaults(settings, step.patch) as ServerSettings,
    defaults,
  );

import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous: published, update } = input;
  // An external usage link stands in only until the provider streams a reading of its own.
  const previous = linkOnly(published) ? undefined : published;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return published;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex repeats unchanged limits on token ticks; avoid allocating snapshots for no-ops.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined) {
    return previous;
  }
  const unavailable =
    previous === undefined
      ? published === undefined
        ? { reason: "probeFailed" as const }
        : undefined
      : previous.unavailable;
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    // A sparse streamed update is not a fresh probe; only a complete update or a successful
    // probe (resolveUsageLimitsAfterProbe) may clear the stale marker.
    ...(previous?.stale !== undefined ? { stale: previous.stale } : {}),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
    ...(previous?.zeroSpendCap ? { zeroSpendCap: true } : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    (a.modelIds === b.modelIds ||
      (a.modelIds !== undefined &&
        b.modelIds !== undefined &&
        a.modelIds.length === b.modelIds.length &&
        a.modelIds.every((id, index) => id === b.modelIds?.[index]))) &&
    (a.providerIds === b.providerIds ||
      (a.providerIds !== undefined &&
        b.providerIds !== undefined &&
        a.providerIds.length === b.providerIds.length &&
        a.providerIds.every((id, index) => id === b.providerIds?.[index]))) &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/** Limits the provider cannot poll, published only as a link to the vendor's usage page. */
function linkOnly(limits: ServerProviderUsageLimits | undefined): boolean {
  return limits?.unavailable?.reason === "unsupported" && limits.externalUsage !== undefined;
}

export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  // A probe that can only link out does not replace bars streamed from the provider's turns.
  if (linkOnly(probed) && published && !published.unavailable && published.windows.length > 0) {
    return published;
  }
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    // Keep the last good bars, but never republish them as a fresh reading: the failed check
    // is recorded in `stale` so clients can tell the numbers are outdated.
    if (published.windows.length === 0) return probed;
    const since =
      published.stale !== undefined &&
      Date.parse(published.stale.since) <= Date.parse(probed.checkedAt)
        ? published.stale.since
        : probed.checkedAt;
    return {
      ...published,
      stale: {
        since,
        ...(probed.unavailable.message !== undefined
          ? { message: probed.unavailable.message }
          : published.stale?.message !== undefined
            ? { message: published.stale.message }
            : {}),
      },
    };
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    return {
      ...probed,
      checkedAt: published.checkedAt,
      windows: published.windows,
      ...(published.stale !== undefined ? { stale: published.stale } : {}),
    };
  }
  return probed;
}

/** What a provider reports when its limits need the user's usage access first. */
export const needsUsageAccessLimits: Effect.Effect<ServerProviderUsageLimits> = Effect.map(
  DateTime.now,
  (now) => ({ checkedAt: DateTime.formatIso(now), windows: [], needsUsageAccess: true }),
);

/** Runs a limits read that opens the provider's own sign-in files only once the user allows usage access. */
export const withUsageAccess = <E, R>(
  usageAccess: Effect.Effect<boolean>,
  read: Effect.Effect<ServerProviderUsageLimits, E, R>,
): Effect.Effect<ServerProviderUsageLimits, E, R> =>
  Effect.flatMap(usageAccess, (allowed) => (allowed ? read : needsUsageAccessLimits));

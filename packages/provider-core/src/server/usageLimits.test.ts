import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
    const scoped = { checkedAt, windows: [{ ...weekly, modelIds: ["opencode/a"] }] };
    const providerScoped = { checkedAt, windows: [{ ...weekly, providerIds: ["opencode"] }] };
    expect(
      applyUsageLimitsUpdate({
        previous: providerScoped,
        checkedAt,
        update: { windows: [{ ...weekly, providerIds: ["console-custom"] }] },
      })?.windows[0]?.providerIds,
    ).toEqual(["console-custom"]);
    expect(
      applyUsageLimitsUpdate({
        previous: scoped,
        checkedAt,
        update: { windows: [{ ...weekly, modelIds: ["opencode/a"] }] },
      }),
    ).toBe(scoped);
    expect(
      applyUsageLimitsUpdate({
        previous: scoped,
        checkedAt,
        update: { windows: [{ ...weekly, modelIds: ["opencode/b"] }] },
      })?.windows[0]?.modelIds,
    ).toEqual(["opencode/b"]);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits and a $0 cap when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits, zeroSpendCap: true },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
      zeroSpendCap: true,
    });
  });

  it("clears the stale marker when a streamed update moves a window, keeps it on a no-op", () => {
    const stale = { ...published, staleSince: "2026-09-03T12:00:01.000Z" };
    const moved = applyUsageLimitsUpdate({
      previous: stale,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });
    expect(moved).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
    expect(
      applyUsageLimitsUpdate({
        previous: stale,
        checkedAt: "2026-09-03T12:00:05.000Z",
        update: { windows: [{ ...session, usedPercent: 40 }] },
      }),
    ).toBe(stale);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toEqual(sameTime);
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: newer })).toEqual(newer);
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("marks a failed probe stale instead of republishing the last reading as fresh", () => {
    const failedAt = "2026-09-03T12:30:00.000Z";
    const failed = {
      checkedAt: failedAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    const afterFailure = resolveUsageLimitsAfterProbe({ published, probed: failed });
    expect(afterFailure).toEqual({ ...published, staleSince: failedAt });
    expect(afterFailure).not.toBe(published);
    // checkedAt still names the last good read, so fresher environments win the merge.
    expect(afterFailure?.checkedAt).toBe(checkedAt);

    // Repeated failures keep the earliest staleSince, even when one arrives out of order.
    const laterFailure = { ...failed, checkedAt: "2026-09-03T13:00:00.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: afterFailure, probed: laterFailure })).toEqual(
      { ...published, staleSince: failedAt },
    );
    const olderFailure = { ...failed, checkedAt: "2026-09-03T12:10:00.000Z" };
    expect(resolveUsageLimitsAfterProbe({ published: afterFailure, probed: olderFailure })).toEqual(
      { ...published, staleSince: "2026-09-03T12:10:00.000Z" },
    );

    // A later successful probe clears the marker.
    const recovered = {
      checkedAt: "2026-09-03T13:30:00.000Z",
      windows: [{ ...session, usedPercent: 5 }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: afterFailure, probed: recovered })).toEqual(
      recovered,
    );

    // A windowless published reading reports the failure instead of pretending no limits exist.
    const empty = { checkedAt, windows: [] };
    expect(resolveUsageLimitsAfterProbe({ published: empty, probed: failed })).toBe(failed);
  });

  it("keeps the stale marker when an older successful probe does not replace the newer windows", () => {
    const stalePublished = { ...published, staleSince: "2026-09-03T12:30:00.000Z" };
    const olderProbe = {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [{ ...session, usedPercent: 10 }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: stalePublished, probed: olderProbe })).toEqual(
      {
        ...olderProbe,
        checkedAt: stalePublished.checkedAt,
        windows: stalePublished.windows,
        staleSince: stalePublished.staleSince,
      },
    );
  });
});

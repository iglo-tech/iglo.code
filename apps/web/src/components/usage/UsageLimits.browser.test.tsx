import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { LimitWindows } from "./UsageLimits";

const now = Date.parse("2026-10-25T22:00:00.000Z");

function provider(usageLimits: ServerProvider["usageLimits"]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("antigravity"),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-25T16:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

describe("LimitWindows", () => {
  it("shows an elapsed reset as refilled and marks a stale reading with its last-checked time", async () => {
    const limits = {
      checkedAt: "2026-10-25T16:00:00.000Z",
      stale: { since: "2026-10-25T18:30:00.000Z" },
      windows: [
        {
          id: "gemini-5h",
          kind: "session" as const,
          label: "Gemini · 5-hour",
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: "2026-10-25T21:10:00.000Z",
        },
      ],
    };
    await using screen = await render(
      <LimitWindows
        driver={provider(limits).driver}
        windows={limits.windows}
        now={now}
        limits={limits}
      />,
    );

    // The window reset at 21:10, so the exhausted reading reads as 100% left again.
    await expect.element(screen.getByText("100% left")).toBeVisible();
    await expect.element(screen.getByText("reset").first()).toBeVisible();
    const staleLine = screen.getByText(/Stale since /);
    await expect.element(staleLine).toBeVisible();
    expect(screen.getByText("100% left").element().closest(".opacity-60")).not.toBeNull();
  });

  it("shows a fresh reading with its last-checked time and no stale marker", async () => {
    const limits = {
      checkedAt: "2026-10-25T21:50:00.000Z",
      windows: [
        {
          id: "gemini-5h",
          kind: "session" as const,
          label: "Gemini · 5-hour",
          usedPercent: 40,
          windowDurationMins: 300,
          resetsAt: "2026-10-25T23:00:00.000Z",
        },
      ],
    };
    await using screen = await render(
      <LimitWindows
        driver={provider(limits).driver}
        windows={limits.windows}
        now={now}
        limits={limits}
      />,
    );

    await expect.element(screen.getByText("60% left")).toBeVisible();
    const checkedLine = screen.getByText(/Last checked (?!.*stale)/);
    await expect.element(checkedLine).toBeVisible();
    expect(screen.getByText("60% left").element().closest(".opacity-60")).toBeNull();
  });
});

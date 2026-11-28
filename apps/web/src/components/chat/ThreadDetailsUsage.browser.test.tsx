import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ThreadDetailsUsage } from "./ThreadDetailsUsage";

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

const window = {
  id: "gemini-5h",
  kind: "session" as const,
  label: "Gemini · 5-hour",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2030-01-01T00:00:00.000Z",
};

describe("ThreadDetailsUsage stale limits", () => {
  it("dims the limits grid and says since when the reading is stale", async () => {
    const limits = {
      checkedAt: "2026-10-25T16:00:00.000Z",
      stale: { since: "2026-10-25T18:30:00.000Z" },
      windows: [window],
    };
    const sources: UsageLimitSourceSnapshots = [];
    await using screen = await render(
      <ThreadDetailsUsage
        environmentId={EnvironmentId.make("local")}
        providerInstanceId={ProviderInstanceId.make("antigravity")}
        model={null}
        providers={[provider(limits)]}
        sources={sources}
      />,
    );

    const staleLine = screen.getByText(/Stale since /);
    await expect.element(staleLine).toBeVisible();
    // The dim lives on the grid container, which renders a box; a `display: contents` wrapper cannot.
    expect(staleLine.element().closest(".grid")).toHaveClass(/opacity-60/);
  });

  it("shows a fresh reading with its last-checked time and no dimming", async () => {
    const limits = { checkedAt: "2026-10-25T21:50:00.000Z", windows: [window] };
    const sources: UsageLimitSourceSnapshots = [];
    await using screen = await render(
      <ThreadDetailsUsage
        environmentId={EnvironmentId.make("local")}
        providerInstanceId={ProviderInstanceId.make("antigravity")}
        model={null}
        providers={[provider(limits)]}
        sources={sources}
      />,
    );

    const checkedLine = screen.getByText(/Last checked (?!.*[Ss]tale)/);
    await expect.element(checkedLine).toBeVisible();
    expect(checkedLine.element().closest(".grid")).not.toHaveClass(/opacity-60/);
  });
});

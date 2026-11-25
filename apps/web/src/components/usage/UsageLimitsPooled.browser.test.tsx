import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled next refill", () => {
  it("skips elapsed resets while waiting for refreshed account data", async () => {
    function account(instanceId: string, usedPercent: number, resetsAt: string): ServerProvider {
      return {
        ...managedChatGpt(instanceId, instanceId),
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt }],
        },
      };
    }
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              account("Work", 20, "2026-10-25T17:00:00.000Z"),
              account("Personal", 60, "2026-10-25T18:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T17:30:00Z")} />,
    );
    await expect.element(screen.getByText("↻ +30%", { exact: true })).toBeVisible();

    await screen.rerender(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T18:00:00Z")} />,
    );
    await expect.element(screen.getByText(/^↻ \+\d+%$/)).not.toBeInTheDocument();
  });
});

describe("UsageLimitsPooled stale readings and elapsed resets", () => {
  function limitsProvider(
    instanceId: string,
    usageLimits: ServerProvider["usageLimits"],
  ): ServerProvider {
    return {
      ...managedChatGpt(instanceId, instanceId),
      usageLimits,
    };
  }

  it("dims a card whose checks failed, says when it was last checked, and shows an elapsed reset as refilled", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              limitsProvider("antigravity", {
                checkedAt: "2026-10-25T16:00:00.000Z",
                stale: { since: "2026-10-25T18:30:00.000Z" },
                windows: [
                  {
                    id: "gemini-5h",
                    kind: "session",
                    label: "Gemini · 5-hour",
                    usedPercent: 100,
                    windowDurationMins: 300,
                    resetsAt: "2026-10-25T21:10:00.000Z",
                  },
                ],
              }),
            ],
          },
        },
      ],
    ]);
    // Both the failed check and the window reset are in the past at this point.
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T22:00:00Z")} />,
    );

    const staleLine = screen.getByText(/Stale since /);
    await expect.element(staleLine).toBeVisible();
    expect(staleLine.element().closest(".rounded-lg")).toHaveClass(/opacity-60/);
    // The exhausted-looking window reset at 21:10, so it reads as fully available again.
    await expect.element(screen.getByRole("button", { name: /100% left, reset/ })).toBeVisible();
    await expect.element(screen.getByText("100%").first()).toBeVisible();
  });

  it("dims a pooled card when only one of its two accounts is stale", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              limitsProvider("stale-account", {
                checkedAt: "2026-10-25T16:00:00.000Z",
                stale: { since: "2026-10-25T18:30:00.000Z" },
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "5-hour",
                    usedPercent: 80,
                    windowDurationMins: 300,
                    resetsAt: "2026-10-25T23:00:00.000Z",
                  },
                ],
              }),
              limitsProvider("fresh-account", {
                checkedAt: "2026-10-25T21:50:00.000Z",
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "5-hour",
                    usedPercent: 20,
                    windowDurationMins: 300,
                    resetsAt: "2026-10-25T23:30:00.000Z",
                  },
                ],
              }),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T22:00:00Z")} />,
    );

    // ANY stale member dims the card, not only when every member is stale.
    const staleLine = screen.getByText(/Stale since /);
    await expect.element(staleLine).toBeVisible();
    expect(staleLine.element().closest(".rounded-lg")).toHaveClass(/opacity-60/);
    // Both members still render their segments.
    await expect.element(screen.getByText("5-hour").first()).toBeVisible();
  });

  it("shows a fresh card with its last-checked time and no dimming", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              limitsProvider("codex", {
                checkedAt: "2026-10-25T16:00:00.000Z",
                windows: [
                  {
                    id: "five_hour",
                    kind: "session",
                    label: "5-hour",
                    usedPercent: 40,
                    windowDurationMins: 300,
                    resetsAt: "2026-10-25T23:00:00.000Z",
                  },
                ],
              }),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T22:00:00Z")} />,
    );

    const checkedLine = screen.getByText(/Last checked (?!.*stale)/);
    await expect.element(checkedLine).toBeVisible();
    expect(checkedLine.element().closest(".rounded-lg")).not.toHaveClass(/opacity-60/);
    await expect.element(screen.getByText("60%").first()).toBeVisible();
  });
});

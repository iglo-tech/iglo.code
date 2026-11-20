import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  buildThreadActionMenuItems,
  buildThreadProjectMoveTargets,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("hides Move to project without destinations", () => {
    const items = buildThreadActionMenuItems(baseState);
    expect(items.some((item) => item.id === "move-to-project")).toBe(false);
  });

  it("offers destinations and disables moving while the thread is running", () => {
    const targets = [
      {
        projectId: ProjectId.make("alpha"),
        label: "Alpha",
        detail: "opencode/alpha",
        monogram: { text: "AL", color: "blue" as const },
      },
      {
        projectId: ProjectId.make("beta"),
        label: "Beta",
        detail: "opencode/beta",
        monogram: { text: "BE", color: "green" as const },
      },
    ];
    const idle = buildThreadActionMenuItems({ ...baseState, moveTargets: targets });
    const move = idle.find((item) => item.id === "move-to-project");
    expect(move?.children?.map((child) => child.id)).toEqual([
      "move-to-project:alpha",
      "move-to-project:beta",
    ]);
    expect(move?.disabled).toBeFalsy();
    const running = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      moveTargets: targets,
    });
    expect(running.find((item) => item.id === "move-to-project")?.disabled).toBe(true);
  });

  it("disables Move to project without permission", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      moveTargets: [
        {
          projectId: ProjectId.make("alpha"),
          label: "Alpha",
          detail: "opencode/alpha",
          monogram: { text: "AL", color: "blue" as const },
        },
      ],
    });
    const move = items.find((item) => item.id === "move-to-project");
    expect(move?.disabled).toBe(true);
    expect(move?.children?.every((child) => child.disabled)).toBe(true);
  });
});

describe("buildThreadProjectMoveTargets", () => {
  const environmentId = EnvironmentId.make("env");
  const project = (
    id: string,
    overrides: {
      environmentId?: EnvironmentId;
      workspaceRoot?: string;
      isScratch?: true;
      archivedAt?: string;
      projectIcon?: { kind: "monogram"; text: string; color: "purple" };
    } = {},
  ) => ({
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/tmp/${id}`,
    ...overrides,
  });

  it("offers same-environment projects that are not the thread's own, scratch, or archived", () => {
    const targets = buildThreadProjectMoveTargets({
      projects: [
        project("current"),
        { ...project("remote"), environmentId: EnvironmentId.make("other") },
        { ...project("flagged-scratch"), isScratch: true },
        { ...project("quiet-scratch"), workspaceRoot: "/tmp/scratch" },
        { ...project("archived"), archivedAt: "2026-01-01T00:00:00.000Z" },
        project("alpha"),
      ],
      environmentId,
      currentProjectId: ProjectId.make("current"),
      scratchWorkspaceRoot: "/tmp/scratch",
    });
    expect(
      targets.map(({ label, detail, monogram }) => ({ label, detail, monogram: monogram.text })),
    ).toEqual([{ label: "alpha", detail: "tmp/alpha", monogram: "AA" }]);
  });

  it("uses a custom monogram icon and shortens Windows paths", () => {
    const targets = buildThreadProjectMoveTargets({
      projects: [
        {
          ...project("starred", { workspaceRoot: "C:\\Users\\dev\\starred" }),
          projectIcon: { kind: "monogram", text: "★", color: "purple" },
        },
      ],
      environmentId,
      currentProjectId: ProjectId.make("current"),
      scratchWorkspaceRoot: null,
    });
    expect(targets).toEqual([
      {
        projectId: ProjectId.make("starred"),
        label: "starred",
        detail: "dev/starred",
        monogram: { text: "★", color: "purple" },
      },
    ]);
  });
});

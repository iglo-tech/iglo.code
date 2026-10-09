import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  pluginScheduleOwner,
  pluginScheduleSubmission,
  scheduleRevision,
  unavailableTargetText,
  webhookAvailable,
} from "./scheduleTargetLogic";

const payload = { definitionId: "sequence", task: "", workspace: "new-worktree" };
const ready = {
  scheduleId: "schedule-1",
  title: "  Nightly  ",
  projectId: ProjectId.make("project"),
  schedule: { type: "fixed_time" as const, timeOfDay: "09:00" },
  enabled: true,
  payload,
};
const task = (id: string, dispatchTarget?: ScheduledTask["dispatchTarget"]): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: "Nightly",
  prompt: "Scheduled plugin operation",
  ...(dispatchTarget === undefined ? {} : { dispatchTarget }),
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});

it("saves a plugin target only with a title, known project, payload and clock schedule", () => {
  expect(pluginScheduleSubmission(ready)).toEqual({
    ok: true,
    input: {
      id: "schedule-1",
      title: "Nightly",
      projectId: "project",
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      enabled: true,
      payload,
    },
  });
  for (const missing of [{ title: " " }, { projectId: null }, { payload: null }])
    expect(pluginScheduleSubmission({ ...ready, ...missing })).toMatchObject({
      ok: false,
      title: "Scheduled task is incomplete",
    });
  expect(
    pluginScheduleSubmission({ ...ready, schedule: { type: "webhook", signature: null } }),
  ).toMatchObject({ ok: false, title: "Choose a schedule" });
  expect(pluginScheduleSubmission({ ...ready, schedule: null })).toMatchObject({ ok: false });
  expect(
    pluginScheduleSubmission({ ...ready, schedule: { type: "interval", everyMs: 30_000 } }),
  ).toMatchObject({ ok: false, title: "Invalid interval" });
});

it("offers webhook triggers only to prompt schedules", () => {
  expect(webhookAvailable(null)).toBe(true);
  expect(webhookAvailable("workflows.start")).toBe(false);
});

it("finds the plugin-local identity only for schedules a plugin saved", () => {
  const target = { id: "workflows.start", payload };
  expect(pluginScheduleOwner(task("plugin:workflows:nightly", target))).toEqual({
    targetId: "workflows.start",
    pluginId: "workflows",
    scheduleId: "nightly",
  });
  // A target on a row the plugin did not save has no history or plugin editor.
  expect(pluginScheduleOwner(task("scheduled-task:other", target))?.scheduleId).toBeNull();
  expect(pluginScheduleOwner(task("scheduled-task:prompt"))).toBeNull();
});

it("changes the history revision when the host records another dispatch", () => {
  const before = task("plugin:workflows:nightly");
  expect(scheduleRevision({ ...before, runCount: 1, lastRunStatus: "succeeded" })).not.toBe(
    scheduleRevision(before),
  );
});

it("words a missing target from the catalog state instead of claiming it is gone", () => {
  expect(unavailableTargetText("reconciling", "workflows.start")).toBe(
    "Checking this environment's plugins…",
  );
  expect(unavailableTargetText("catalog-unavailable", "workflows.start")).toContain(
    "Could not check",
  );
  expect(unavailableTargetText("connected", "workflows.start")).toContain(
    "workflows.start is unavailable",
  );
});

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import type { PluginScheduleTargetEditorProps } from "@t3tools/plugin-host-contract/web";
import { useEffect, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// The real dialog and row logic run; data hooks and portal-based primitives are replaced.
const state = vi.hoisted(() => ({
  tasks: [] as Array<unknown>,
  targets: { targets: [] as Array<unknown>, status: "reconciling" as string },
  upsert: null as unknown as ReturnType<typeof vi.fn>,
  save: null as unknown as ReturnType<typeof vi.fn>,
}));
const environment = vi.hoisted(() => ({
  environmentId: "local",
  label: "Workstation",
  connection: { phase: "connected" },
  serverConfig: { environment: { platform: { machine: "server" } } },
}));
const commands = vi.hoisted(() => ({
  upsertScheduledTask: { permissionAtom: () => "allowed" },
  setScheduledTaskEnabled: { permissionAtom: () => "allowed" },
  runScheduledTaskNow: { permissionAtom: () => "allowed" },
  deleteScheduledTask: { permissionAtom: () => "allowed" },
  rotateScheduledTaskWebhookToken: { permissionAtom: () => "allowed" },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "providers" ? [] : true),
}));
vi.mock("@tanstack/react-router", () => ({ Link: () => null, useNavigate: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    ...commands,
    providersValueAtom: () => "providers",
    scheduledTasksLive: () => "live",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.upsertScheduledTask ? state.upsert : vi.fn(),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: unknown) =>
    query === null ? { data: null, error: null } : { data: { tasks: state.tasks }, error: null },
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => environment,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "project", environmentId: "local", title: "Project", workspaceRoot: "/project" },
  ],
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return { useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS };
});
vi.mock("../../providerInstances", () => ({
  applyProviderInstanceSettings: () => [],
  deriveProviderInstanceEntries: () => [],
  sortProviderInstanceEntries: () => [],
}));
vi.mock("../../modelSelection", () => ({ getCustomModelOptionsByInstance: () => ({}) }));
vi.mock("../../cloud/primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => ({ target: null, data: null }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: ["local"] },
    environments: [environment],
    connectedEnvironments: [environment],
    environment,
  }),
}));
vi.mock("../../plugins/ScheduleTargets", () => ({
  usePluginScheduleTargets: () => state.targets,
}));
const passthrough = vi.hoisted(
  () =>
    ({ children }: { children?: ReactNode }) =>
      children,
);
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: passthrough,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children?: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: (props: {
    title?: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      {props.title}|{props.description}|{props.status}|{props.control}
    </div>
  ),
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  useRelativeTimeTick: () => undefined,
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogClose: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogPanel: passthrough,
  DialogPopup: passthrough,
  DialogTitle: passthrough,
}));
vi.mock("../ui/menu", () => ({
  Menu: passthrough,
  MenuTrigger: passthrough,
  MenuPopup: passthrough,
  MenuSeparator: () => null,
  MenuItem: ({ children, onClick }: { children?: ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: (props: {
    value: string;
    onValueChange: (value: string) => void;
    children?: ReactNode;
  }) => (
    <div role="listbox" data-value={props.value} data-on-value-change={props.onValueChange}>
      {props.children}
    </div>
  ),
  SelectTrigger: ({ id, children }: { id?: string; children?: ReactNode }) => (
    <span id={id}>{children}</span>
  ),
  SelectValue: passthrough,
  SelectPopup: passthrough,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: (props: { onValueChange?: (values: string[]) => void; children?: ReactNode }) => (
    <div role="group">{props.children}</div>
  ),
  Toggle: ({ value, children }: { value: string; children?: ReactNode }) => (
    <button value={value}>{children}</button>
  ),
}));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ui/button", () => ({
  Button: (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
    <button disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  ),
}));
vi.mock("../ui/input", () => ({
  Input: (props: { id?: string; value?: string; onChange?: (event: unknown) => void }) => (
    <input id={props.id} value={props.value} onChange={props.onChange} />
  ),
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../WorktreeBaseBranchPicker", () => ({ WorktreeBaseBranchPicker: () => null }));
vi.mock("../EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const payload = { definitionId: "sequence", task: "Nightly", workspace: "new-worktree" };
/** A contributed target whose fields report a ready payload, like a plugin editor. */
function FixtureFields(props: PluginScheduleTargetEditorProps) {
  const { onChange } = props;
  useEffect(() => onChange(payload), [onChange]);
  return <p>Fixture fields for {props.projectId}</p>;
}
const target = () => ({
  id: "fixture.run",
  pluginId: "fixture",
  title: "Run a fixture",
  renderEditor: (props: PluginScheduleTargetEditorProps) => <FixtureFields {...props} />,
  renderHistory: () => null,
  save: state.save,
});
const pluginTask = {
  id: ScheduledTaskId.make("plugin:fixture:nightly"),
  title: "Nightly",
  prompt: "Scheduled plugin operation",
  dispatchTarget: { id: "fixture.run", payload },
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "server",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
} satisfies ScheduledTask;

let renderer: ReactTestRenderer;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const page = () => text(renderer.root);
const button = (label: string) =>
  renderer.root.findAll((node) => node.type === "button" && text(node) === label)[0]!;
const select = (id: string) =>
  renderer.root.find(
    (node) =>
      node.props.role === "listbox" && node.findAll((child) => child.props.id === id).length > 0,
  );
const mount = () =>
  act(async () => {
    renderer = create(<ScheduledTasksSettings environmentId={EnvironmentId.make("local")} />);
  });
const rerender = () =>
  act(async () =>
    renderer.update(<ScheduledTasksSettings environmentId={EnvironmentId.make("local")} />),
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.tasks = [];
  state.targets = { targets: [], status: "reconciling" };
  state.upsert = vi.fn().mockResolvedValue({ _tag: "Success", value: {} });
  state.save = vi.fn().mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("offers a plugin target only once the environment publishes it and saves through the plugin", async () => {
  await mount();
  await act(async () => button("New task").props.onClick());
  // While the plugin list loads, the editor offers no target and nothing claims unavailability.
  expect(renderer.root.findAll((node) => node.props.id === "scheduled-task-target")).toEqual([]);
  expect(page()).toContain("On webhook");

  state.targets = { targets: [target()], status: "connected" };
  await rerender();
  expect(page()).toContain("Run a fixture");
  await act(async () =>
    select("scheduled-task-target").props["data-on-value-change"]("fixture.run"),
  );
  expect(page()).toContain("Fixture fields for project");
  // A plugin target runs at a time or on an interval, not from a webhook.
  expect(page()).not.toContain("On webhook");
  await act(async () =>
    renderer.root
      .find((node) => node.type === "input" && node.props.id === "scheduled-task-title")
      .props.onChange({ target: { value: "Nightly fixture" } }),
  );
  await act(async () => button("Create task").props.onClick());
  expect(state.upsert).not.toHaveBeenCalled();
  expect(state.save).toHaveBeenCalledWith({
    id: expect.stringMatching(/^schedule-[0-9a-f]{24}$/),
    title: "Nightly fixture",
    projectId: "project",
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    enabled: true,
    payload,
  });
});

it("keeps an unavailable target's schedule editable through the host without dropping it", async () => {
  state.tasks = [pluginTask];
  await mount();
  expect(page()).toContain("Checking this environment's plugins…");
  state.targets = { targets: [], status: "connected" };
  await rerender();
  expect(page()).toContain(
    "fixture.run is unavailable in this environment or this client. Its settings are kept",
  );
  await act(async () => button("Edit").props.onClick());
  // The dialog explains the target; it does not show prompt fields or a target editor.
  expect(page()).not.toContain("Fixture fields");
  await act(async () =>
    renderer.root
      .find((node) => node.type === "input" && node.props.id === "scheduled-task-time")
      .props.onChange({ target: { value: "18:30" } }),
  );
  await act(async () => button("Save task").props.onClick());
  expect(state.save).not.toHaveBeenCalled();
  expect(state.upsert).toHaveBeenCalledTimes(1);
  const [{ input }] = state.upsert.mock.calls[0]! as [{ input: Record<string, unknown> }];
  expect(input).toMatchObject({
    id: pluginTask.id,
    requireExisting: true,
    dispatchTarget: pluginTask.dispatchTarget,
    schedule: { type: "fixed_time", timeOfDay: "18:30" },
    projectId: "project",
  });
});

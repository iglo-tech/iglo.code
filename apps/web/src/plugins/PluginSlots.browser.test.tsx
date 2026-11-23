import { EnvironmentId, type PluginAttention, type PluginCatalog } from "@t3tools/contracts";
import { web } from "@t3tools/plugin-workflows/web";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  environmentId: "" as EnvironmentId,
  catalog: null as PluginCatalog | null,
  attention: [] as ReadonlyArray<PluginAttention>,
  navigate: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useConnectedEnvironmentIds: () => [state.environmentId],
  useEnvironment: () => null,
}));
// The real workflow contributions, without the client that would open a connection.
vi.mock(import("./compiled"), async () => {
  const { bind } = await import("./contributions");
  return { compiledWebPlugins: [{ manifest: web.manifest, bind: () => bind(web, null as never) }] };
});
vi.mock(import("./runtime"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const value = <A,>(read: () => A) => Atom.family((_: EnvironmentId) => Atom.make(read));
  return {
    pluginConnectedAtom: value(() => true),
    pluginSupportAtom: value(() => "supported" as const),
    catalogAtom: value(() => AsyncResult.success(state.catalog)) as never,
    availableCatalogAtom: value(() => state.catalog),
    attentionAtom: value(() => AsyncResult.success(state.attention)) as never,
  };
});

import { SidebarProvider } from "../components/ui/sidebar";
import { PluginSidebarAttention } from "./PluginSlots";

function setup(count: number) {
  // A fresh environment per case keeps atom family members from carrying over.
  const environmentId = EnvironmentId.make(`environment-${count}`);
  state.environmentId = environmentId;
  state.navigate = vi.fn();
  state.catalog = {
    environmentId,
    hostVersion: web.manifest.hostVersion,
    plugins: [{ environmentId, manifest: web.manifest, status: "available", reason: null }],
    providerTools: [],
  };
  state.attention = [
    {
      environmentId,
      pluginId: web.manifest.id,
      total: count,
      items: Array.from({ length: count }, (_, index) => ({
        id: `run-${index}`,
        summary: `Run ${index}`,
        severity: "warning" as const,
        reason: "Waiting for input",
        link: { pageId: "workflows.runs", state: { run: `run-${index}` } },
      })),
    },
  ];
}

const openedAttention = () =>
  expect(state.navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      params: expect.objectContaining({ pageId: "workflows.attention" }),
    }),
  );

it("opens the full attention view when every item fits in the sidebar", async () => {
  setup(2);
  await using screen = await render(
    <SidebarProvider>
      <PluginSidebarAttention />
    </SidebarProvider>,
  );
  await expect.element(screen.getByText("Run 1")).toBeVisible();
  expect(screen.getByText(/more$/).elements()).toHaveLength(0);
  await screen.getByRole("button", { name: "View all: Needs attention" }).click();
  openedAttention();
});

it("keeps the overflow link beside the header link when items exceed the sidebar", async () => {
  setup(7);
  await using screen = await render(
    <SidebarProvider>
      <PluginSidebarAttention />
    </SidebarProvider>,
  );
  await screen.getByRole("button", { name: "2 more" }).click();
  openedAttention();
  state.navigate.mockClear();
  await screen.getByRole("button", { name: "View all: Needs attention" }).click();
  openedAttention();
});

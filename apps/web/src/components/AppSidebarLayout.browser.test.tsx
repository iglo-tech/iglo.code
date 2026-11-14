import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  updateClientSettings,
} from "../hooks/useSettings";

vi.mock("../env", () => ({ isElectron: true }));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
// The thread list needs live environments; the shortcut lives in the shell around it.
vi.mock(import("./Sidebar"), () => ({ default: (() => null) as never }));
vi.mock("./BackgroundThreadAnnouncer", () => ({ BackgroundThreadAnnouncer: () => null }));
vi.mock("./sidebar/SidebarChrome", () => ({ SidebarBrandWidthProbe: () => null }));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: { setClientSettings: async () => undefined },
  }),
}));

import { AppSidebarLayout } from "./AppSidebarLayout";

function setup() {
  __resetClientSettingsPersistenceForTests();
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
}

function wheel(deltaX: number) {
  window.dispatchEvent(new WheelEvent("wheel", { deltaX, clientY: 200 }));
}

describe("desktop history swipe navigation", () => {
  it.each(["back", "forward"] as const)(
    "leaves %s swipes off by default and can enable them without reloading",
    async (direction) => {
      setup();
      using _available = vi
        .spyOn(window.navigation, direction === "back" ? "canGoBack" : "canGoForward", "get")
        .mockReturnValue(true);
      await using screen = await render(<AppSidebarLayout>Thread</AppSidebarLayout>);
      using navigate = vi.spyOn(window.history, direction).mockImplementation(() => undefined);
      const deltaX = direction === "back" ? -140 : 140;

      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).not.toHaveBeenCalled();
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => wheel(deltaX));
      await expect.element(screen.getByTestId("history-swipe-indicator")).toBeInTheDocument();

      await act(() => updateClientSettings({ historySwipeNavigation: false }));
      await expect.element(screen.getByTestId("history-swipe-indicator")).not.toBeInTheDocument();
      await act(() => wheel(0));
      expect(navigate).not.toHaveBeenCalled();

      await act(() => updateClientSettings({ historySwipeNavigation: true }));
      await act(() => {
        wheel(deltaX);
        wheel(0);
      });
      expect(navigate).toHaveBeenCalledOnce();
    },
  );
});

describe("sidebar toggle shortcut", () => {
  it("leaves the key to a focused terminal when its rule excludes terminalFocus", async () => {
    setup();
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(
      <AppSidebarLayout>
        <div data-terminal-owner="drawer">
          <textarea aria-label="Terminal input" />
        </div>
        <button type="button">Outside</button>
      </AppSidebarLayout>,
    );
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;

    await userEvent.click(screen.getByRole("textbox", { name: "Terminal input" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed"));
  });
});

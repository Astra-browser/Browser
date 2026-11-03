import { afterEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import { emitNativeEvent } from "$shared/testing/native-events";
import { surface } from "$domain/surface";
import { tabs } from "$domain/tabs";
import * as launch from "$session/motion.svelte";
import * as sidebar from "$session/sidebar-mode.svelte";
import Shell from "../Shell.svelte";

const native = vi.hoisted(() => ({
  width: vi.fn(async (_width: number | null, _animate: boolean, _revision: number | null) => {}),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    sidebarSetHidden: async () => {},
    sidebarPeek: async () => {},
    sidebarSetWidth: native.width,
    sidebarResize: async () => false,
    sidebarResizeGuide: async () => true,
    settingSet: async () => ({ accepted: true, operation_id: null }),
  });
});

afterEach(() => {
  sidebar.adoptMode("default");
  surface.dispose();
  tabs.dispose();
  vi.clearAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const shownWidth = () =>
  document.querySelector<HTMLElement>(".browser-sidebar")!.getBoundingClientRect().width;
const lastWidth = () => native.width.mock.calls.at(-1)?.[0];

// Settings puts its sections in a panel beside the rail. That panel is part
// of the column, so the width native insets the page by has to include it:
// published only on close, the page would stand under the panel until then.
test("settings publishes the panel's width, and gives it back on the way out", async () => {
  await page.viewport(1100, 800);
  launch.dispose();
  await surface.init();
  await tabs.init();
  render(Shell);
  await settle();

  emitNativeEvent("uiCommand", "browser.settings");
  await expect.poll(() => surface.currentPage()).toBe("settings");
  // The panel the sections stand in: the rail, the gap and the panel.
  await expect.poll(lastWidth).toBe(328);
  await expect.poll(shownWidth).toBe(328);

  emitNativeEvent("uiCommand", "browser.return");
  await expect.poll(() => surface.currentPage()).toBe(null);
  await expect.poll(lastWidth).toBe(240);
  await expect.poll(shownWidth).toBe(240);
});

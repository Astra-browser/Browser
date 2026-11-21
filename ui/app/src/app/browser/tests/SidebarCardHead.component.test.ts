import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabFixture, revision, spaceFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { surface } from "$domain/surface";
import { preferences } from "$domain/preferences";
import * as sidebar from "$session/sidebar-mode.svelte";
import Shell from "../Shell.svelte";

vi.mock("../WorkWorkspace.svelte", async () => await import("./StageStub.svelte"));

const native = vi.hoisted(() => ({
  settings: { "ui.main-bar": "hidden" } as Record<string, string>,
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    tabsActivate: async () => ({ accepted: true, operation_id: null }),
    sidebarSetHidden: async () => {},
    sidebarSetWidth: async () => {},
    sidebarPeek: async () => {},
    settingGet: async (key: string) => native.settings[key] ?? null,
  });
});

afterEach(() => {
  sidebar.adoptMode("default");
  sidebar.setSidebarCardShown(false);
  surface.dispose();
  tabs.dispose();
  preferences.dispose();
});

async function putAwayOverPage() {
  await preferences.init();
  await surface.init();
  await tabs.init();
  sidebar.adoptMode("hidden");
  const tab = tabFixture({ url: "https://example.com/a" });
  emitNativeEvent("itemsChanged", {
    projection_revision: revision(41),
    profile: { id: "profile", name: "Personal", kind: "default" },
    spaces: [spaceFixture("space", "Home")],
    active_space_id: "space",
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  });
  const screen = await render(Shell);
  return screen;
}

function edge(near: boolean) {
  window.dispatchEvent(new CustomEvent("astra:sidebar-edge", { detail: { near } }));
}

test("the card a put-away column slides out keeps the page controls and address", async () => {
  const screen = await putAwayOverPage();
  const bar = screen.container.querySelector<HTMLElement>(".stage-bar")!;
  const side = screen.container.querySelector<HTMLElement>(".browser-sidebar")!;
  await expect.poll(() => side.getAttribute("data-hidden")).toBe("true");

  // Away with the bar hidden: the bar is the only place the field can be.
  expect(screen.container.querySelector(".sidebar-top-field")).toBeNull();
  expect(bar.querySelector("[data-astra-address]")).not.toBeNull();

  // The pointer reaches the left edge: the card slides out carrying the head.
  edge(true);
  await expect.poll(() => side.getAttribute("data-peek")).toBe("true");
  await expect.poll(() => !!screen.container.querySelector(".sidebar-top-field")).toBe(true);

  const head = screen.container.querySelector<HTMLElement>(".sidebar-top")!;
  expect(head.querySelector("[data-astra-address]")).not.toBeNull();
  // Back, Forward, Reload and Home, not only the column's own two controls.
  expect(head.querySelectorAll(".sidebar-top-row button").length).toBeGreaterThanOrEqual(4);
  expect(bar.querySelector("[data-astra-address]")).toBeNull();
  expect(screen.container.querySelectorAll("[data-astra-address]").length).toBe(1);

  // The card goes back: the bar is the field's home again.
  edge(false);
  await expect.poll(() => side.getAttribute("data-peek")).toBeNull();
  await expect.poll(() => bar.querySelector("[data-astra-address]")).not.toBeNull();
  expect(screen.container.querySelector(".sidebar-top-field")).toBeNull();
});

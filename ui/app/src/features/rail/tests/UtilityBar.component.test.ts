import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import "$styles/global.css";
import type { ItemsState } from "$shared/ipc/bindings";
import { emitNativeEvent } from "$shared/testing/native-events";
import { revision, spaceFixture, tabFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import UtilityBar from "../components/UtilityBar.svelte";

const tools = vi.hoisted(() => ({
  active: null as string | null,
  open: vi.fn(),
  close: vi.fn(),
}));

vi.mock("$session/tools.svelte", () => ({
  open: tools.open,
  close: tools.close,
  activeTool: () => tools.active,
}));

vi.mock("$domain/media-player", () => ({
  mediaPlayer: {
    view: () => native.player,
    show: native.showPlayer,
  },
}));

const native = vi.hoisted(() => ({
  activate: vi.fn(async (_id: string) => ({ accepted: true, operation_id: null })),
  switchSpace: vi.fn(async () => ({ accepted: true, operation_id: null })),
  run: vi.fn(async () => ({ accepted: true, operation_id: null })),
  showPlayer: vi.fn(),
  player: null as null | Record<string, unknown>,
  extensions: [] as unknown[],
  openPage: vi.fn(async (_page: string) => {}),
  setTheme: vi.fn(async (_key: string, _value: string) => {}),
  appearance: "light",
  openUrl: vi.fn(async (_url: string, _newTab: boolean) => ({
    accepted: true,
    operation_id: null,
  })),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    tabsActivate: native.activate,
    spacesSwitch: native.switchSpace,
    runCommand: native.run,
    browserOpenUrl: native.openUrl,
  });
});

vi.mock("$domain/webext", () => ({
  webext: {
    list: () => native.extensions,
    error: () => null,
    isAvailable: () => true,
    refresh: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    setPinned: vi.fn(async () => {}),
    pinnedCount: () => 0,
    MAX_PINNED: 3,
    openOptions: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    chooseFile: vi.fn(async () => {}),
  },
}));

vi.mock("$domain/extensions", () => ({
  extensions: {
    activeActions: () => [],
    isInvoking: () => false,
    invoke: vi.fn(async () => {}),
  },
}));

vi.mock("$domain/preferences", () => ({
  preferences: {
    value: (key: string) => (key === "appearance.theme" ? native.appearance : ""),
    set: native.setTheme,
  },
}));

vi.mock("$domain/surface", () => ({
  surface: { open: native.openPage, currentPage: () => null },
}));

afterEach(() => {
  tabs.dispose();
  tools.active = null;
  tools.open.mockClear();
  tools.close.mockClear();
  native.activate.mockClear();
  native.switchSpace.mockClear();
  native.run.mockClear();
  native.showPlayer.mockClear();
  native.player = null;
  native.extensions = [];
  native.setTheme.mockClear();
  native.openPage.mockClear();
  native.openUrl.mockClear();
  native.appearance = "light";
});

let projection = 100;
function project(over: Partial<ItemsState> = {}) {
  emitNativeEvent("itemsChanged", {
    projection_revision: revision((projection += 1)),
    profile: { id: "p1", name: "Personal", kind: "default" },
    spaces: [spaceFixture("home", "Home"), spaceFixture("studio", "Studio")],
    active_space_id: "home",
    nodes: [],
    tabs: [],
    active: null,
    split_group: null,
    ...over,
  });
}

async function bar(over: Partial<ItemsState> = {}) {
  await tabs.init();
  project(over);
  return render(UtilityBar);
}

test("the bar is one row of 26px eight-cornered plates with 18px glyphs", async () => {
  const screen = await bar();
  const element = screen.container.querySelector<HTMLElement>(".utility-bar")!;
  expect(getComputedStyle(element).display).toBe("flex");

  const button = screen.getByRole("button", { name: "Downloads", exact: true }).element();
  expect(getComputedStyle(button).width).toBe("26px");
  expect(getComputedStyle(button).height).toBe("26px");
  expect(getComputedStyle(button).borderRadius).toBe("8px");
  expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
  // The native tooltip is the label that can stand outside the chrome, and
  // the accessible name is the one the keyboard reads.
  expect(button.getAttribute("title")).toBe("Downloads");
  expect(button.getAttribute("aria-label")).toBe("Downloads");
});

test("the shape toggle heads the row and calls its owner", async () => {
  const ontoggle = vi.fn();
  await tabs.init();
  project();
  const screen = await render(UtilityBar, { ontoggle });
  await screen.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
  expect(ontoggle).toHaveBeenCalledOnce();
});

test("at rail width the bar becomes the two-column tool grid", async () => {
  await tabs.init();
  project({
    tabs: [tabFixture({ id: "a", title: "Night Drive", audio: { muted: false, can_mute: true } })],
    active: "a",
  });
  const screen = await render(UtilityBar, { compact: true });
  const element = screen.container.querySelector<HTMLElement>(".utility-bar")!;
  expect(element.hasAttribute("data-compact")).toBe(true);
  expect(getComputedStyle(element).display).toBe("grid");
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  const row = screen.getByRole("menuitem", { name: "Night Drive" }).element();
  expect(getComputedStyle(row.querySelector<HTMLElement>(".rail-row-title")!).display).toBe("none");
});

test("the bar is one row when the column has room", async () => {
  await tabs.init();
  project();
  const screen = await render(UtilityBar, { ontoggle: () => {} });
  const host = screen.container;
  host.style.inlineSize = "320px";
  host.style.containerType = "inline-size";
  const element = host.querySelector<HTMLElement>(".utility-bar")!;
  await expect.poll(() => getComputedStyle(element).display).toBe("flex");
  // One row: the bar is no taller than its 26px plate.
  expect(element.getBoundingClientRect().height).toBeLessThanOrEqual(30);
});

test("the bar reflows as an even four-column grid below 220px", async () => {
  await tabs.init();
  project();
  const screen = await render(UtilityBar, { ontoggle: () => {} });
  const host = screen.container;
  host.style.inlineSize = "216px";
  host.style.containerType = "inline-size";
  const element = host.querySelector<HTMLElement>(".utility-bar")!;
  await expect.poll(() => getComputedStyle(element).display).toBe("grid");
  // Four plates per row, not a ragged wrap: eight entries make exactly two
  // even rows in the narrow column.
  expect(getComputedStyle(element).gridTemplateColumns.split(" ")).toHaveLength(4);
  expect(getComputedStyle(host.querySelector<HTMLElement>(".bar-rule")!).display).toBe("none");
  const hostBox = host.getBoundingClientRect();
  for (const button of element.querySelectorAll<HTMLElement>("button")) {
    const box = button.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(hostBox.left - 0.5);
    expect(box.right).toBeLessThanOrEqual(hostBox.right + 0.5);
  }
});

test("the settled column keeps one row above the grid threshold", async () => {
  await tabs.init();
  project();
  const screen = await render(UtilityBar, { ontoggle: () => {} });
  const host = screen.container;
  // The expanded column never goes below its one-row minimum: the grid is for
  // the narrow rail and a compact header, not a settled 260px column.
  host.style.inlineSize = "240px";
  host.style.containerType = "inline-size";
  const element = host.querySelector<HTMLElement>(".utility-bar")!;
  await expect.poll(() => getComputedStyle(element).display).toBe("flex");
});

test("the narrow grid still fits the column at its 180px minimum", async () => {
  await tabs.init();
  project();
  const screen = await render(UtilityBar, { ontoggle: () => {} });
  const host = screen.container;
  host.style.inlineSize = "180px";
  host.style.containerType = "inline-size";
  const element = host.querySelector<HTMLElement>(".utility-bar")!;
  await expect.poll(() => getComputedStyle(element).display).toBe("grid");
  expect(getComputedStyle(element).gridTemplateColumns.split(" ")).toHaveLength(4);
  const hostBox = host.getBoundingClientRect();
  for (const button of element.querySelectorAll<HTMLElement>("button")) {
    const box = button.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(hostBox.left - 0.5);
    expect(box.right).toBeLessThanOrEqual(hostBox.right + 0.5);
  }
});

test("every utility entry is named, and each opens its own surface", async () => {
  const screen = await bar();
  for (const name of [
    "Media",
    "Downloads",
    "Gallery",
    "Notes",
    "All Spaces",
    "Sleeping tabs",
    "Extensions",
  ]) {
    await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
  }

  await screen.getByRole("button", { name: "Gallery", exact: true }).click();
  expect(native.openPage).toHaveBeenLastCalledWith("gallery");
  await screen.getByRole("button", { name: "Downloads", exact: true }).click();
  expect(tools.open).toHaveBeenLastCalledWith("downloads");
  await screen.getByRole("button", { name: "Notes", exact: true }).click();
  expect(tools.open).toHaveBeenLastCalledWith("notes");
});

test("the open tool lights its entry", async () => {
  tools.active = "downloads";
  const screen = await bar();
  await expect
    .element(screen.getByRole("button", { name: "Downloads", exact: true }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(screen.getByRole("button", { name: "Notes", exact: true }))
    .not.toHaveAttribute("aria-current");
});

test("a tool entry closes the panel it opened", async () => {
  tools.active = "notes";
  const screen = await bar();
  await screen.getByRole("button", { name: "Notes", exact: true }).click();
  expect(tools.close).toHaveBeenCalledOnce();
  expect(tools.open).not.toHaveBeenCalled();
});

test("media lists the tabs playing something, and selecting one brings it forward", async () => {
  const screen = await bar({
    tabs: [
      tabFixture({ id: "a", title: "Night Drive", audio: { muted: false, can_mute: true } }),
      tabFixture({ id: "b", title: "Quiet page" }),
    ],
    active: "a",
  });
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Night Drive" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Quiet page");
  // A listening tab says so at a glance, without opening the list.
  expect(screen.container.querySelector(".rail-pip")).not.toBeNull();
  await screen.getByRole("menuitem", { name: "Night Drive" }).click();
  expect(native.activate).toHaveBeenCalledWith("a");
});

test("the media entry follows the active player and brings its tab forward", async () => {
  native.player = {
    tab_id: "player-tab",
    title: "Night Drive",
    artist: "Neon Coast",
    icon: null,
  };
  const screen = await bar();
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Night Drive" })).toBeVisible();
  await screen.getByRole("menuitem", { name: "Night Drive" }).click();
  expect(native.showPlayer).toHaveBeenCalledOnce();
});

test("sleeping tabs lists native's sleeping pages, and selecting one wakes it", async () => {
  const screen = await bar({
    tabs: [
      tabFixture({ id: "asleep", title: "Old notes", availability: { state: "sleeping" } }),
      tabFixture({ id: "awake", title: "Current page" }),
    ],
    active: "awake",
  });
  await screen.getByRole("button", { name: "Sleeping tabs", exact: true }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Old notes" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Current page");
  await screen.getByRole("menuitem", { name: "Old notes" }).click();
  expect(native.activate).toHaveBeenCalledWith("asleep");
});

test("the spaces entry switches the window's space", async () => {
  const screen = await bar();
  await screen.getByRole("button", { name: "All Spaces", exact: true }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Home", exact: true }))
    .toHaveAttribute("aria-current", "true");
  await screen.getByRole("menuitem", { name: "Studio", exact: true }).click();
  expect(native.switchSpace).toHaveBeenCalledWith("studio");
});

test("the extensions entry opens the hub for every installed extension", async () => {
  native.extensions = [
    {
      profile_id: "p1",
      install_id: "install-a",
      id: "ext-a",
      name: "Bitwarden",
      version: "1",
      description: "",
      enabled: true,
      icon: null,
      state: "running",
      error: null,
      warnings: [],
      limitations: [],
      access: "all",
      sites: [],
      site_scoped: false,
      has_options: false,
      held_update: null,
      sideloaded: false,
      pinned: false,
    },
  ];
  const screen = await bar();
  // One door, not two: the old manage/store menu is folded into the hub.
  expect(screen.getByRole("button", { name: "Extensions", exact: true }).elements()).toHaveLength(
    1,
  );
  await screen.getByRole("button", { name: "Extensions", exact: true }).click();
  await expect.element(screen.getByText("Bitwarden", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Manage extensions" })).toBeVisible();
  // Everything the second puzzle used to carry is still one click away.
  await expect.element(screen.getByRole("button", { name: "Chrome Web Store" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Firefox Add-ons" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install from file" })).toBeVisible();
});

test("the appearance switch turns the window dark from a light window", async () => {
  const screen = await bar();
  const dark = screen.getByRole("button", { name: "Use dark appearance", exact: true });
  await expect.element(dark).toBeVisible();
  await dark.click();
  expect(native.setTheme).toHaveBeenCalledWith("appearance.theme", "dark");
});

test("a dark window offers the way back to light", async () => {
  native.appearance = "dark";
  const screen = await bar();
  const light = screen.getByRole("button", { name: "Use light appearance", exact: true });
  await expect.element(light).toBeVisible();
  await light.click();
  expect(native.setTheme).toHaveBeenCalledWith("appearance.theme", "light");
});

test("the keyboard reaches a tool entry", async () => {
  const screen = await bar();
  screen.getByRole("button", { name: "Downloads", exact: true }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(tools.open).toHaveBeenCalledWith("downloads");
});

test("a private window keeps its media and sleeping lists empty", async () => {
  const screen = await bar({
    profile: { id: "incognito", name: "Private", kind: "incognito" },
    tabs: [
      tabFixture({
        id: "secret",
        title: "Private page",
        audio: { muted: false, can_mute: true },
        availability: { state: "sleeping" },
      }),
    ],
    active: "secret",
  });

  await screen.getByRole("button", { name: "Media", exact: true }).click();
  await expect.element(screen.getByText("Media is not kept in private windows")).toBeVisible();
  expect(screen.container.textContent).not.toContain("Private page");

  await screen.getByRole("button", { name: "Sleeping tabs", exact: true }).click();
  await expect
    .element(screen.getByText("Sleeping tabs are not kept in private windows"))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Private page");
  // A private window has no spaces switcher.
  expect(screen.getByRole("button", { name: /^Spaces/u }).query()).toBeNull();
});

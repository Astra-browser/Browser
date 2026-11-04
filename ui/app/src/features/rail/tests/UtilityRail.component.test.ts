import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import "$styles/global.css";
import type { ItemsState } from "$shared/ipc/bindings";
import { emitNativeEvent } from "$shared/testing/native-events";
import { revision, spaceFixture, tabFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import UtilityRail from "../components/UtilityRail.svelte";

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
  profiles: vi.fn(async () => ({
    status: "ok" as const,
    data: {
      current: "p1",
      private: false,
      private_tabs: null,
      profiles: [
        {
          id: "p1",
          name: "Personal",
          kind: "default" as const,
          avatar: { style: "initials" as const, color: 1, symbol: 0, revision: 0 },
        },
        {
          id: "p2",
          name: "Work",
          kind: "named" as const,
          avatar: { style: "initials" as const, color: 2, symbol: 0, revision: 0 },
        },
      ],
    },
  })),
  switchProfile: vi.fn(async () => ({ accepted: true, operation_id: null })),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    tabsActivate: native.activate,
    spacesSwitch: native.switchSpace,
    runCommand: native.run,
    profilesGet: native.profiles,
    profilesSwitch: native.switchProfile,
  });
});

afterEach(() => {
  tabs.dispose();
  tools.active = null;
  tools.open.mockClear();
  tools.close.mockClear();
  native.activate.mockClear();
  native.switchSpace.mockClear();
  native.run.mockClear();
  native.switchProfile.mockClear();
  native.showPlayer.mockClear();
  native.player = null;
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

async function rail(over: Partial<ItemsState> = {}) {
  await tabs.init();
  project(over);
  return render(UtilityRail);
}

test("the rail is 44px, with 32px eight-cornered marks and 18px glyphs", async () => {
  const screen = await rail();
  const element = screen.container.querySelector<HTMLElement>(".utility-rail")!;
  expect(getComputedStyle(element).width).toBe("44px");

  const button = screen.getByRole("button", { name: "Downloads", exact: true }).element();
  expect(getComputedStyle(button).width).toBe("32px");
  expect(getComputedStyle(button).height).toBe("32px");
  expect(getComputedStyle(button).borderRadius).toBe("8px");
  expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
  // The native tooltip is the label that can stand outside the chrome, and
  // the accessible name is the one the keyboard reads.
  expect(button.getAttribute("title")).toBe("Downloads");
  expect(button.getAttribute("aria-label")).toBe("Downloads");
});

test("at rail width its panels are the narrow glyph stack", async () => {
  await tabs.init();
  project({
    tabs: [tabFixture({ id: "a", title: "Night Drive", audio: { muted: false, can_mute: true } })],
    active: "a",
  });
  const screen = await render(UtilityRail, { compact: true });
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  const panel = screen.container.querySelector<HTMLElement>(".rail-popover")!;
  expect(getComputedStyle(panel).width).toBe("48px");
  const row = screen.getByRole("menuitem", { name: "Night Drive" }).element();
  expect(getComputedStyle(row.querySelector<HTMLElement>(".rail-row-title")!).display).toBe("none");
});

test("every utility entry is named, and each opens its own surface", async () => {
  const screen = await rail();
  for (const name of ["Media", "Downloads", "Notes", "Spaces — Home", "Sleeping tabs", "Profile"]) {
    await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
  }

  await screen.getByRole("button", { name: "Downloads", exact: true }).click();
  expect(tools.open).toHaveBeenLastCalledWith("downloads");
  await screen.getByRole("button", { name: "Notes", exact: true }).click();
  expect(tools.open).toHaveBeenLastCalledWith("notes");
});

test("the open tool lights its entry", async () => {
  tools.active = "downloads";
  const screen = await rail();
  await expect
    .element(screen.getByRole("button", { name: "Downloads", exact: true }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(screen.getByRole("button", { name: "Notes", exact: true }))
    .not.toHaveAttribute("aria-current");
});

test("a tool entry closes the panel it opened", async () => {
  tools.active = "notes";
  const screen = await rail();
  await screen.getByRole("button", { name: "Notes", exact: true }).click();
  expect(tools.close).toHaveBeenCalledOnce();
  expect(tools.open).not.toHaveBeenCalled();
});

test("media lists the tabs playing something, and selecting one brings it forward", async () => {
  const screen = await rail({
    tabs: [
      tabFixture({ id: "a", title: "Night Drive", audio: { muted: false, can_mute: true } }),
      tabFixture({ id: "b", title: "Quiet page" }),
    ],
    active: "a",
  });
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Night Drive" })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Quiet page");
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
  const screen = await rail();
  await screen.getByRole("button", { name: "Media", exact: true }).click();
  await expect.element(screen.getByRole("menuitem", { name: "Night Drive" })).toBeVisible();
  await screen.getByRole("menuitem", { name: "Night Drive" }).click();
  expect(native.showPlayer).toHaveBeenCalledOnce();
});

test("sleeping tabs lists native's sleeping pages, and selecting one wakes it", async () => {
  const screen = await rail({
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
  const screen = await rail();
  await screen.getByRole("button", { name: "Spaces — Home", exact: true }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Home", exact: true }))
    .toHaveAttribute("aria-current", "true");
  await screen.getByRole("menuitem", { name: "Studio", exact: true }).click();
  expect(native.switchSpace).toHaveBeenCalledWith("studio");
});

test("the profile menu switches who the window is, and opens its settings", async () => {
  const screen = await rail();
  await screen.getByRole("button", { name: "Profile", exact: true }).click();
  await expect
    .element(screen.getByRole("menuitem", { name: "Switch this window to Work" }))
    .toBeVisible();
  await screen.getByRole("menuitem", { name: "Switch this window to Work" }).click();
  expect(native.switchProfile).toHaveBeenCalledWith("p2");

  await screen.getByRole("button", { name: "Profile", exact: true }).click();
  await screen.getByRole("menuitem", { name: /Personal — Profile Settings/u }).click();
  expect(native.run).toHaveBeenLastCalledWith("settings.profiles");
});

test("the keyboard reaches a tool entry", async () => {
  const screen = await rail();
  screen.getByRole("button", { name: "Downloads", exact: true }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(tools.open).toHaveBeenCalledWith("downloads");
});

test("a private window keeps its media and sleeping lists empty", async () => {
  const screen = await rail({
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

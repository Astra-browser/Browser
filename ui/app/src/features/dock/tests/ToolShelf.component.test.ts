import { expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import * as notices from "$session/notice.svelte";
import { preferences } from "$domain/preferences";
import { emitNativeEvent } from "$shared/testing/native-events";
import type { ProfilesView } from "$shared/ipc/bindings";
import { ContextMenu } from "$features/menus";
import ToolShelf from "../components/ToolShelf.svelte";

const native = vi.hoisted(() => ({
  run: vi.fn(async () => ({ accepted: true, operation_id: null })),
  profiles: vi.fn(async () => ({ status: "ok" as const, data: null as ProfilesView | null })),
  switchTo: vi.fn(async () => ({ accepted: true, operation_id: null })),
}));

const names = (root: HTMLElement) =>
  [...root.querySelectorAll(".shelf-item")].map((item) =>
    item.querySelector(":scope > span:not(.ui-menu-icon, .shelf-keys)")?.textContent?.trim(),
  );

const menuLabels = () =>
  [...document.querySelectorAll(".shell-menu-item .shell-menu-label")].map((node) =>
    node.textContent?.trim(),
  );

const menuRow = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")].find(
    (item) => item.querySelector(".shell-menu-label")?.textContent?.trim() === label,
  );

const avatar = { style: "initials" as const, color: 1, symbol: 0, revision: 0 };
const ROSTER: ProfilesView = {
  current: "p1",
  private: false,
  profiles: [
    { id: "p1", name: "Personal", kind: "default", avatar },
    { id: "p2", name: "Work", kind: "named", avatar: { ...avatar, color: 4 } },
  ],
};

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    runCommand: native.run,
    profilesGet: native.profiles,
    profilesSwitch: native.switchTo,
    settingGet: async () => null,
    sidebarSetHidden: async () => {},
    sidebarPeek: async () => {},
    sidebarSetWidth: vi.fn(async () => undefined),
  });
});

test("the tools stay out of reach until the case is pressed", async () => {
  const screen = await render(ToolShelf);
  // The stack grows upward out of the case, so it needs room above it.
  screen.container.style.paddingBlockStart = "280px";
  const stack = screen.container.querySelector<HTMLElement>(".shelf-stack")!;
  const tools = screen.getByRole("button", { name: "Tools", exact: true });

  // Inert, so the stack is neither clickable nor tabbable while concealed,
  // and hovering the case is not a request for it.
  expect(stack.inert).toBe(true);
  await tools.hover();
  expect(stack.inert).toBe(true);

  await tools.click();
  await expect.poll(() => stack.inert).toBe(false);
  await expect.element(tools).toHaveAttribute("aria-expanded", "true");

  // Picking one puts the stack away; the panel it opened is the answer now.
  await screen.getByRole("menuitem", { name: "Notes", exact: true }).click();
  await expect.poll(() => stack.inert).toBe(true);
  await expect.poll(() => screen.container.querySelector(".case-lit")).not.toBeNull();

  await tools.click();
  await expect.poll(() => stack.inert).toBe(false);
  await expect
    .element(screen.getByRole("menuitem", { name: "Notes", exact: true }))
    .toHaveAttribute("aria-current", "true");
});

test("the profile opens on a switcher of who you are, then the tools", async () => {
  native.profiles.mockResolvedValueOnce({ status: "ok" as const, data: ROSTER });
  await page.viewport(1200, 800);
  const screen = await render(ToolShelf);
  await render(ContextMenu);
  screen.container.style.paddingBlockStart = "480px";
  const tools = screen.getByRole("button", { name: /^Tools/ });
  await expect.element(tools).toHaveAttribute("aria-haspopup", "menu");
  await expect
    .poll(() => screen.container.querySelector(".shelf-me-name")?.textContent)
    .toBe("Personal");
  expect(names(screen.container)).toEqual([
    "Notes",
    "Tasks",
    "Time",
    "History",
    "Downloads",
    "Bookmarks",
    "Settings",
  ]);
  // Nearest the case settles first, so each row's step counts from the foot.
  const steps = [...screen.container.querySelectorAll<HTMLElement>(".shelf-item, .shelf-head")].map(
    (item) => Number(item.style.getPropertyValue("--step")),
  );
  expect(steps).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  expect(screen.container.textContent).not.toContain("Manage Profiles");
  // The account is not this profile's: it lives on the New Tab page and in Work.
  expect(screen.getByRole("menuitem", { name: /^Account|^Sign in/u }).query()).toBeNull();

  await tools.click();
  await screen.getByRole("menuitem", { name: "Switch to Work" }).click();
  expect(native.switchTo).toHaveBeenCalledWith("p2");
  await tools.click();
  await screen.getByRole("menuitem", { name: "New Incognito Window" }).click();
  expect(native.run).toHaveBeenLastCalledWith("window.newPrivate");
  await tools.click();
  await screen.getByRole("menuitem", { name: /^Personal — / }).click();
  expect(native.run).toHaveBeenLastCalledWith("settings.profiles");

  // A right-click is the app's own menu, with the stack's rows, not a host
  // popup that has no route.
  await tools.click({ button: "right" });
  await expect
    .poll(menuLabels)
    .toEqual([
      "Personal — Profile Settings",
      "Work",
      "New Incognito Window",
      "Notes",
      "Tasks",
      "Time",
      "History",
      "Downloads",
      "Bookmarks",
      "Settings",
    ]);

  // Every row calls the same thing the stack row does, in this window.
  native.switchTo.mockClear();
  native.run.mockClear();
  menuRow("Work")!.click();
  await expect.poll(() => native.switchTo.mock.calls).toEqual([["p2"]]);

  await tools.click({ button: "right" });
  await expect.poll(menuLabels).toContain("Settings");
  menuRow("Settings")!.click();
  await expect.poll(() => native.run.mock.calls).toEqual([["browser.settings"]]);
});

test("with one profile the head is you alone, and a private window beside you", async () => {
  native.profiles.mockResolvedValueOnce({
    status: "ok" as const,
    data: { ...ROSTER, profiles: ROSTER.profiles.slice(0, 1) },
  });
  const screen = await render(ToolShelf);
  await expect
    .poll(() => screen.container.querySelector(".shelf-me-name")?.textContent)
    .toBe("Personal");
  const chips = [...screen.container.querySelectorAll(".shelf-chip")];
  expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["New Incognito Window"]);
});

test("the private chip becomes the way back while the private window is set aside", async () => {
  native.profiles.mockResolvedValueOnce({
    status: "ok" as const,
    data: { ...ROSTER, private_tabs: 2 },
  });
  const screen = await render(ToolShelf);
  screen.container.style.paddingBlockStart = "480px";
  await expect
    .poll(() => screen.container.querySelector(".shelf-private")?.getAttribute("aria-label"))
    .toBe("Back to private window");
  await screen.getByRole("button", { name: /^Tools/ }).click();
  const chip = screen.getByRole("menuitem", { name: "Back to private window" });
  await expect.element(chip).toHaveAttribute("data-aside", "true");
  await chip.click();
  expect(native.run).toHaveBeenLastCalledWith("window.newPrivate");
});

test("a feature switched off takes its tool out, and an empty group its rule", async () => {
  await preferences.init();
  const screen = await render(ToolShelf);
  for (const feature of ["notes", "tasks", "time"])
    emitNativeEvent("preferenceChanged", { key: `${feature}.enabled`, value: "false" });
  await expect
    .poll(() => names(screen.container))
    .toEqual(["History", "Downloads", "Bookmarks", "Settings"]);
  expect(screen.container.querySelectorAll(".shelf-rule")).toHaveLength(2);
  for (const feature of ["notes", "tasks", "time"])
    emitNativeEvent("preferenceChanged", { key: `${feature}.enabled`, value: "true" });
  preferences.dispose();
});

test("at rail width a notice is its glyph on the case, and then it goes", async () => {
  const screen = await render(ToolShelf, { compact: true });
  screen.container.style.cssText = "padding:24px;inline-size:96px;background:var(--color-chrome)";
  expect(screen.container.querySelector(".pip")).toBeNull();

  notices.show("Link copied");
  await expect.element(screen.getByRole("status")).toHaveTextContent("Link copied");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await page
    .elementLocator(screen.container)
    .screenshot({ path: "../../../../../target/time/pip-link.png" });

  notices.show("Download started", "download");
  await expect.element(screen.getByRole("status")).toHaveTextContent("Download started");
  await expect.poll(() => screen.container.querySelector(".pip"), { timeout: 4000 }).toBeNull();
});

test("expanded, the case carries no glyph; the sidebar's own notice speaks", async () => {
  const screen = await render(ToolShelf);
  notices.show("Link copied");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.container.querySelector(".pip")).toBeNull();
});

test("a press on the page, which takes focus away, puts the stack away", async () => {
  const screen = await render(ToolShelf);
  screen.container.style.paddingBlockStart = "280px";
  const stack = screen.container.querySelector<HTMLElement>(".shelf-stack")!;
  await screen.getByRole("button", { name: /^Tools/ }).click();
  await expect.poll(() => stack.inert).toBe(false);
  window.dispatchEvent(new FocusEvent("blur"));
  await expect.poll(() => stack.inert).toBe(true);
});

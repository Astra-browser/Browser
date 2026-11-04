import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { emitNativeEvent } from "$shared/testing/native-events";
import type { SidebarNodeView } from "$shared/ipc/bindings";
import { revision, spaceFixture, tabFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { ContextMenu } from "$features/menus";
import { installTabMenuPresenter } from "../tab-menu";

const native = vi.hoisted(() => ({
  close: vi.fn(),
  reload: vi.fn(),
  open: vi.fn(),
  split: vi.fn(),
  keep: vi.fn(),
  mute: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    tabsClose: native.close,
    tabsReload: native.reload,
    tabsOpen: native.open,
    tabsSplit: native.split,
    tabsSetEssential: native.keep,
    tabSetMuted: native.mute,
  });
});

vi.mock("$domain/operations", async (original) => ({
  ...(await original<typeof import("$domain/operations")>()),
  settle: native.settle,
}));

// Every snapshot and every tab takes a newer revision than anything before
// it; the projection keeps an unchanged tab's object by design.
let clock = 0;
const next = () => revision(++clock);

const snapshot = (list: ReturnType<typeof tabFixture>[], nodes: SidebarNodeView[] = []) => ({
  projection_revision: next(),
  profile: { id: "profile", name: "Personal", kind: "default" as const },
  spaces: [spaceFixture("space", "Home")],
  active_space_id: "space",
  nodes,
  tabs: list.map((tab) => ({ ...tab, projection_revision: next() })),
  active: list[0]!.id,
  split_group: null,
});

const menuLabels = () =>
  [...document.querySelectorAll(".shell-menu-item .shell-menu-label")].map((node) =>
    node.textContent?.trim(),
  );

let stopPresenter: () => void;

beforeEach(async () => {
  vi.clearAllMocks();
  native.settle.mockResolvedValue({ outcome: "applied", disposition: null });
  await tabs.init();
  emitNativeEvent(
    "itemsChanged",
    snapshot([
      tabFixture({ id: "a" }),
      tabFixture({ id: "b", audio: { muted: false, can_mute: true } }),
    ]),
  );
  stopPresenter = installTabMenuPresenter();
  render(ContextMenu);
});

afterEach(() => {
  stopPresenter();
  tabs.dispose();
});

test("a tab's right-click is Astra's menu, with rows the projection supports", async () => {
  tabs.openTabMenu("b", 40, 40);
  await expect
    .poll(menuLabels)
    .toEqual([
      "New Tab",
      "Reload Tab",
      "Copy Link",
      "Add to Essentials",
      "Open in Split View",
      "Mute Tab",
      "Clear Data for This Site…",
      "Close Tab",
    ]);
});

test("the menu's rows act on the tab that was right-clicked, not the active one", async () => {
  tabs.openTabMenu("b", 40, 40);
  await expect.poll(() => !!document.querySelector(".shell-menu")).toBe(true);
  document.querySelector<HTMLButtonElement>(".shell-menu-item:last-of-type")!.click();
  await expect.poll(() => native.close.mock.calls).toEqual([["b"]]);

  tabs.openTabMenu("b", 40, 40);
  await expect.poll(() => document.querySelectorAll(".shell-menu-item").length).toBeGreaterThan(0);
  const reload = [...document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")].find((row) =>
    row.textContent?.includes("Reload Tab"),
  )!;
  reload.click();
  await expect.poll(() => native.reload.mock.calls).toEqual([["b"]]);

  tabs.openTabMenu("b", 40, 40);
  await expect.poll(() => document.querySelectorAll(".shell-menu-item").length).toBeGreaterThan(0);
  const keep = [...document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")].find((row) =>
    row.textContent?.includes("Add to Essentials"),
  )!;
  keep.click();
  await expect.poll(() => native.keep.mock.calls).toEqual([["b", true, null]]);
});

test("a kept tab offers its removal, and the lone new tab offers no close", async () => {
  emitNativeEvent(
    "itemsChanged",
    snapshot(
      [tabFixture({ id: "b", url: null })],
      [
        {
          id: "b",
          parent_id: null,
          section: "favorites",
          kind: { type: "tab", tab_id: "b" },
        },
      ],
    ),
  );
  tabs.openTabMenu("b", 40, 40);
  await expect.poll(menuLabels).toContain("Remove from Essentials");
  // One tab, no address: it is the window's lone new tab, so closing it is
  // not offered.
  expect(menuLabels()).not.toContain("Close Tab");
});

test("the in-use indicator offers the sound and nothing else", async () => {
  tabs.openMediaMenu("b", 40, 40);
  await expect.poll(menuLabels).toEqual(["Mute Tab"]);
  document.querySelector<HTMLButtonElement>(".shell-menu-item")!.click();
  await expect.poll(() => native.mute.mock.calls).toEqual([["b", true]]);
});

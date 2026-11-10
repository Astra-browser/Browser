import "$styles/global.css";
import { createRawSnippet } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { revision, tabFixture } from "$shared/testing/fixtures";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabs } from "$domain/tabs";
import { ContextMenu } from "$features/menus";
import ContentBar from "../components/ContentBar.svelte";

const native = vi.hoisted(() => ({
  back: vi.fn(async () => ({ accepted: true, operation_id: null })),
  forward: vi.fn(async () => ({ accepted: true, operation_id: null })),
  reload: vi.fn(async () => ({ accepted: true, operation_id: null })),
}));

const history = vi.hoisted(() => ({
  list: vi.fn(),
  go: vi.fn(async () => ({ moved: true })),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    tabsBack: native.back,
    tabsForward: native.forward,
    tabsReload: native.reload,
  });
});

// The menu reads and moves the engine's session history through the typed
// surface. Other presenters in the shell share that module, so keep them real
// and stand in only for the two history callers.
vi.mock("$shared/ipc/surfaces", async (original) => ({
  ...(await original<typeof import("$shared/ipc/surfaces")>()),
  tabHistory: history.list,
  tabHistoryGo: history.go,
}));

// The bar only places the field it is given; the app composes the product's
// own field into this slot. This stand-in carries the frozen field's box —
// a 34px field and the 8px trailing gap its form reserves — so the wrapper's
// placement is measured against the real shape without restyling it.
const field = createRawSnippet(() => ({
  render: () =>
    '<form role="search" style="margin:0;padding-block-end:8px"><div class="address-field" data-astra-address style="block-size:34px"></div></form>',
}));

// The store keeps the newest projection it admitted across tests, so a stamp
// that follows the clock can land behind the last test's when tests run fast.
let clock = Date.now();
const stamp = () => revision((clock += 1));

afterEach(() => {
  tabs.dispose();
  native.back.mockClear();
  native.forward.mockClear();
  native.reload.mockClear();
  history.list.mockReset();
  history.go.mockClear();
});

async function bar(over: Parameters<typeof tabFixture>[0] = {}) {
  await tabs.init();
  const tab = tabFixture({ projection_revision: stamp(), ...over });
  emitNativeEvent("itemsChanged", {
    projection_revision: stamp(),
    profile: null,
    spaces: [],
    active_space_id: null,
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  });
  const screen = await render(ContentBar, { field });
  // The bar only asks for a menu; the shell draws it. Mount the renderer too
  // so a row can be read and clicked, as it would be in the app frame.
  render(ContextMenu);
  return { screen, tab };
}

const menuLabels = () =>
  [...document.querySelectorAll(".shell-menu-item .shell-menu-label")].map((node) =>
    node.textContent?.trim(),
  );

const page = (url: string, title = "") => ({ url, title });

test("the bar is one 40px band that places the field it is given", async () => {
  const { screen } = await bar({ url: "https://www.example.com/a" });
  const root = screen.container.querySelector<HTMLElement>("[data-content-bar]")!;
  expect(root.getBoundingClientRect().height).toBe(40);
  expect(root.querySelector('form[role="search"]')).not.toBeNull();
  expect(root.querySelector("[data-astra-address]")).not.toBeNull();
  // The 34px field sits centred in the band rather than on its edge.
  const box = root.querySelector<HTMLElement>(".address-field")!;
  const offset = box.getBoundingClientRect().top - root.getBoundingClientRect().top;
  expect(offset).toBe(3);
  expect(box.getBoundingClientRect().height).toBe(34);
});

test("back, forward and reload keep the page's own actions", async () => {
  const { screen, tab } = await bar({
    url: "https://www.example.com/a",
    can_go_back: true,
    can_go_forward: true,
  });
  await screen.getByRole("button", { name: "Back", exact: true }).click();
  expect(native.back).toHaveBeenCalledWith(tab.id);
  await screen.getByRole("button", { name: "Forward", exact: true }).click();
  expect(native.forward).toHaveBeenCalledWith(tab.id);
  await screen.getByRole("button", { name: "Reload", exact: true }).click();
  expect(native.reload).toHaveBeenCalledWith(tab.id);
});

test("a page with nowhere to go has no back or forward to press", async () => {
  const { screen } = await bar({ url: "https://www.example.com/a" });
  await expect.element(screen.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Forward", exact: true })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Reload", exact: true })).toBeEnabled();
});

test("a right click on back lists the pages behind, and forward the pages ahead", async () => {
  const { screen, tab } = await bar({
    url: "https://www.example.com/c",
    can_go_back: true,
    can_go_forward: true,
  });
  history.list.mockResolvedValue({
    index: 2,
    entries: [
      page("https://www.example.com/a", "First"),
      page("https://www.example.com/b"),
      page("https://www.example.com/c", "Current"),
      page("https://www.example.com/d", "Fourth"),
    ],
  });
  const back = screen.getByRole("button", { name: "Back", exact: true }).element();
  back.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  // Nearest first; a page without a title shows its address.
  await expect.poll(menuLabels).toEqual(["https://www.example.com/b", "First"]);
  expect(history.list).toHaveBeenCalledWith(tab.id);
  document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")[0]!.click();
  await expect.poll(() => history.go.mock.calls).toEqual([[tab.id, 1]]);
});

test("a right click on forward lists the pages ahead of the one in front", async () => {
  const { screen, tab } = await bar({
    url: "https://www.example.com/b",
    can_go_back: true,
    can_go_forward: true,
  });
  history.list.mockResolvedValue({
    index: 1,
    entries: [
      page("https://www.example.com/a", "First"),
      page("https://www.example.com/b", "Current"),
      page("https://www.example.com/c", "Third"),
      page("https://www.example.com/d", "Fourth"),
    ],
  });
  const forward = screen.getByRole("button", { name: "Forward", exact: true }).element();
  forward.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  // Nearest first, ending at the newest entry.
  await expect.poll(menuLabels).toEqual(["Third", "Fourth"]);
  expect(history.list).toHaveBeenCalledWith(tab.id);
  document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")[0]!.click();
  await expect.poll(() => history.go.mock.calls).toEqual([[tab.id, 2]]);
});

test("a history read with nothing behind or ahead opens no menu", async () => {
  const { screen } = await bar({
    url: "https://www.example.com/a",
    can_go_back: true,
    can_go_forward: true,
  });
  history.list.mockResolvedValue({ index: 0, entries: [] });
  const back = screen.getByRole("button", { name: "Back", exact: true }).element();
  back.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await expect.poll(() => history.list.mock.calls.length).toBe(1);
  expect(document.querySelector(".shell-menu")).toBeNull();
});

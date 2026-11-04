import "$styles/global.css";
import { createRawSnippet } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { revision, tabFixture } from "$shared/testing/fixtures";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabs } from "$domain/tabs";
import ContentBar from "../components/ContentBar.svelte";

const native = vi.hoisted(() => ({
  back: vi.fn(async () => ({ accepted: true, operation_id: null })),
  forward: vi.fn(async () => ({ accepted: true, operation_id: null })),
  reload: vi.fn(async () => ({ accepted: true, operation_id: null })),
  history: vi.fn(async () => true),
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    tabsBack: native.back,
    tabsForward: native.forward,
    tabsReload: native.reload,
    historyMenuPopup: native.history,
  });
});

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
  native.history.mockClear();
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
  return { screen, tab };
}

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
    url: "https://www.example.com/a",
    can_go_back: true,
    can_go_forward: true,
  });
  const back = screen.getByRole("button", { name: "Back", exact: true }).element();
  back.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(native.history).toHaveBeenCalledWith(
    tab.id,
    false,
    expect.any(Number),
    expect.any(Number),
  );
  native.history.mockClear();
  const forward = screen.getByRole("button", { name: "Forward", exact: true }).element();
  forward.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  expect(native.history).toHaveBeenCalledWith(tab.id, true, expect.any(Number), expect.any(Number));
});

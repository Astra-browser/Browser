import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { tick } from "svelte";
import { render } from "vitest-browser-svelte";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabFixture, revision } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { surface } from "$domain/surface";
import * as notices from "$session/notice.svelte";
import * as sidebarMode from "$session/sidebar-mode.svelte";
import { theme } from "$domain/appearance";
import Shell from "../Shell.svelte";

vi.mock("../WorkWorkspace.svelte", async () => await import("./StageStub.svelte"));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    sidebarSetHidden: async () => {},
    sidebarSetWidth: async () => {},
    settingSet: async () => ({ accepted: true, operation_id: null }),
  });
});

afterEach(() => {
  surface.dispose();
  tabs.dispose();
  document.documentElement.removeAttribute("data-reduce-motion");
});

function boot(tab = tabFixture()) {
  return {
    projection_revision: revision(40),
    profile: null,
    spaces: [],
    active_space_id: null,
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  };
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (node) => node.getClientRects().length > 0,
  );
}

test("landmarks name the shell regions for assistive technology", async () => {
  await surface.init();
  await tabs.init();
  // A real page: the main-page bar carries the search landmark.
  emitNativeEvent("itemsChanged", boot());
  const screen = await render(Shell);

  // Complementary sidebar, labelled.
  expect(screen.container.querySelector("aside[aria-label]")).not.toBeNull();
  // Tab lists are navigation landmarks with names.
  const navs = screen.container.querySelectorAll("nav[aria-label]");
  expect(navs.length).toBeGreaterThan(0);
  // The address field is a search landmark, in the column's head.
  expect(screen.container.querySelector('form[role="search"]')).not.toBeNull();
  // The skip link names the stage the app draws; native pages own their own
  // document, so the target exists on the new-tab and internal stages.
  expect(screen.container.querySelector(".skip-link")?.getAttribute("href")).toBe("#astra-stage");
});

test("the address field stands in the column's head, and the bar keeps it when the column is a rail", async () => {
  await surface.init();
  await tabs.init();
  emitNativeEvent("itemsChanged", boot());
  const screen = await render(Shell);

  const field = screen.container.querySelector("[data-astra-address]")!;
  const sidebar = screen.container.querySelector("aside")!;
  expect(sidebar.contains(field)).toBe(true);
  // The bar above the page has nothing of its own to carry while the column
  // is in its full shape.
  expect(screen.container.querySelector(".stage-column [data-content-bar]")).toBeNull();
  // One field, the product's own, not a second bar for the new tab.
  expect(screen.container.querySelectorAll("[data-astra-address]")).toHaveLength(1);

  // Put the column away and the bar is the field's home again.
  sidebarMode.holdShown(false);
  sidebarMode.setMode("hidden");
  await tick();
  await expect
    .poll(() => screen.container.querySelector(".stage-column [data-content-bar]"), {
      timeout: 4000,
    })
    .not.toBeNull();
  const bar = screen.container.querySelector(".stage-column [data-content-bar]")!;
  await expect
    .poll(() => bar.contains(screen.container.querySelector("[data-astra-address]")))
    .toBe(true);
  sidebarMode.setMode("default");
});

test("keyboard order runs skip link, the address field, the column's list, then content", async () => {
  await surface.init();
  await tabs.init();
  emitNativeEvent("itemsChanged", boot());
  const screen = await render(Shell);

  const order = tabbables(screen.container);
  const skip = screen.container.querySelector<HTMLElement>(".skip-link")!;
  const address = screen.container.querySelector<HTMLInputElement>("[data-astra-address]")!;
  const firstTab = screen.container.querySelector<HTMLElement>("[data-astra-tab-id] button")!;
  expect(order[0]).toBe(skip);
  // The column's head carries the controls and the field, so the address is
  // reached before the list it stands above.
  expect(order.indexOf(address)).toBeGreaterThan(order.indexOf(skip));
  expect(order.indexOf(address)).toBeLessThan(order.indexOf(firstTab));

  // The skip link moves focus to the stage the app draws. A native page owns
  // the content surface itself, so the link is present and named, and the
  // app-drawn new-tab/internal stages are the targets it can reach.
  const skipLink = screen.container.querySelector<HTMLAnchorElement>(".skip-link")!;
  expect(skipLink.getAttribute("href")).toBe("#astra-stage");
  skipLink.focus();
  expect(document.activeElement).toBe(skipLink);
});

test("status notices are announced through a live region", async () => {
  await surface.init();
  await tabs.init();
  emitNativeEvent("itemsChanged", boot());
  const screen = await render(Shell);

  notices.show("Link copied");
  await expect
    .poll(() => screen.container.querySelector('[role="status"]')?.textContent?.trim())
    .toBe("Link copied");
});

test("reduced-motion setting is reflected on the document root", async () => {
  theme.applyUiPreferences("graphite", true);
  expect(document.documentElement.getAttribute("data-reduce-motion")).toBe("true");
  theme.applyUiPreferences("graphite", false);
  expect(document.documentElement.getAttribute("data-reduce-motion")).toBe("false");
});

import "$styles/global.css";
import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import { emitNativeEvent } from "$shared/testing/native-events";
import { tabFixture, revision } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { surface } from "$domain/surface";
import * as notices from "$session/notice.svelte";
import { theme } from "$domain/appearance";
import Shell from "../Shell.svelte";

vi.mock("../WorkWorkspace.svelte", async () => await import("./StageStub.svelte"));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    pagePermissionCardHost: async () => {},
    tabsBootstrap: async () => {},
    sidebarSetHidden: async () => {},
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
  // A tab with no address yet shows the new-tab stage, so a main is present.
  emitNativeEvent("itemsChanged", boot(tabFixture({ url: null, title: "" })));
  const screen = await render(Shell);

  // Complementary sidebar, labelled.
  expect(screen.container.querySelector("aside[aria-label]")).not.toBeNull();
  // Tab lists are navigation landmarks with names.
  const navs = screen.container.querySelectorAll("nav[aria-label]");
  expect(navs.length).toBeGreaterThan(0);
  // The address field is a search landmark.
  expect(screen.container.querySelector('form[role="search"]')).not.toBeNull();
  // One main stage, targeted by the skip link.
  const main = screen.container.querySelector("main#astra-stage");
  expect(main).not.toBeNull();
  expect(main?.getAttribute("tabindex")).toBe("-1");
});

test("keyboard order runs skip link, address field, tabs, then content", async () => {
  await surface.init();
  await tabs.init();
  emitNativeEvent("itemsChanged", boot());
  const screen = await render(Shell);

  const order = tabbables(screen.container);
  const skip = screen.container.querySelector<HTMLElement>(".skip-link")!;
  const address = screen.container.querySelector<HTMLInputElement>("[data-astra-address]")!;
  const firstTab = screen.container.querySelector<HTMLElement>("[data-astra-tab-id] button")!;
  expect(order[0]).toBe(skip);
  expect(order.indexOf(address)).toBeGreaterThan(order.indexOf(skip));
  expect(order.indexOf(firstTab)).toBeGreaterThan(order.indexOf(address));

  // The skip link moves focus to the stage, past the whole tab column.
  // Activated from the keyboard, as a keyboard-only person would: the link
  // sits off-viewport until focused, so a pointer click cannot reach it.
  const skipLink = screen.container.querySelector<HTMLAnchorElement>(".skip-link")!;
  skipLink.focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => document.activeElement?.id).toBe("astra-stage");
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

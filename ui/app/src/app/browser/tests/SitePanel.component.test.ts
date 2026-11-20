import "$styles/global.css";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page, userEvent } from "vitest/browser";
import type { BlockerStatusView, SitePermissionsView } from "$shared/ipc/bindings";
import { emitNativeEvent } from "$shared/testing/native-events";
import { revision, tabFixture } from "$shared/testing/fixtures";
import { surface } from "$domain/surface";
import { tabs } from "$domain/tabs";
import Shell from "../Shell.svelte";

vi.mock("../WorkWorkspace.svelte", async () => await import("./StageStub.svelte"));
// The new tab's own figures read the blocker's stats; only the panel's
// requests are under test here.
vi.mock(
  "$features/newtab/components/NewTab.svelte",
  async () => await import("./StageStub.svelte"),
);

const native = vi.hoisted(() => ({
  list: vi.fn<(origin?: string) => Promise<SitePermissionsView | null>>(),
  set: vi.fn(async (..._args: unknown[]) => true),
  refresh: vi.fn(async () => {}),
  setProtected: vi.fn(async (_protect: boolean) => true),
  stats: vi.fn(async () => ({
    status: "ok" as const,
    data: { today: 42, last7Days: 0, days: [] },
  })),
  status: null as unknown as BlockerStatusView,
  extensions: false,
}));
vi.mock("$domain/permissions", async (original) => ({
  ...(await original<typeof import("$domain/permissions")>()),
  sitePermissions: { list: native.list, set: native.set },
}));
vi.mock("$domain/webext", async (original) => {
  const { webext } = await original<typeof import("$domain/webext")>();
  return { webext: { ...webext, isAvailable: () => native.extensions } };
});
vi.mock("$domain/blocker", async (original) => ({
  ...(await original<typeof import("$domain/blocker")>()),
  blocker: { status: () => native.status, refresh: native.refresh },
  blockerSites: { setProtected: native.setProtected },
}));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    pagePermissionCardHost: async () => {},
    runCommand: async () => ({ accepted: true, operation_id: null }),
    blockerStats: native.stats,
  });
});

let clock = 100;
const stamp = () => revision((clock += 1));

beforeEach(async () => {
  // The field lives in the main-page bar now, so it needs the window a person
  // actually reads a site panel in; at the default narrow viewport the bar is
  // all navigation and the panel would be a column of clipped rows.
  await page.viewport(1100, 800);
  native.extensions = false;
  native.status = {
    protection: "active",
    applied_enabled: true,
    desired_enabled: true,
    can_enable: true,
    preference: "authoritative",
    site: {
      context: { profile: "p", tab: "tab-1", site: "meet.example", revision: "1" },
      paused: false,
      private_session: false,
      ready: true,
      busy: false,
      hides: [],
    },
  } as unknown as BlockerStatusView;
  native.list.mockResolvedValue({
    private: false,
    complete: true,
    kinds: ["camera", "microphone", "geolocation", "popups"],
    entries: [{ origin: "https://meet.example", kind: "camera", decision: "allow" }],
  });
});
afterEach(() => {
  surface.dispose();
  tabs.dispose();
  vi.clearAllMocks();
});

async function shell(over: Parameters<typeof tabFixture>[0] = {}) {
  await surface.init();
  await tabs.init();
  const tab = tabFixture({
    projection_revision: stamp(),
    url: "https://meet.example/room",
    ...over,
  });
  emitNativeEvent("itemsChanged", {
    projection_revision: stamp(),
    profile: { id: "p", name: "Personal", kind: "default" },
    spaces: [],
    active_space_id: null,
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  });
  const screen = await render(Shell);
  // The tray's glyph is painted only while the column is in use (or its field
  // has the keyboard); a real pointer rests in the column before reaching it.
  screen.container
    .querySelector(".bar-reveal")
    ?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  screen.container
    .querySelector(".browser-sidebar")
    ?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
  return screen;
}

const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

test("the address field has one control, at its end, and no zoom badge", async () => {
  const screen = await shell({ zoom: 125 });
  const field = screen.container.querySelector<HTMLElement>(".address-field")!;
  const input = field.querySelector("input")!;
  // The tray's glyph is revealed with the column; wait for it to be reachable.
  await expect.element(screen.getByRole("button", { name: "Site information" })).toBeVisible();
  const glyph = screen.getByRole("button", { name: "Site information" }).element();
  expect(field.contains(glyph)).toBe(true);
  expect(before(input, glyph)).toBe(true);
  expect(field.querySelectorAll("button")).toHaveLength(1);
  await expect.element(screen.getByRole("button", { name: /Page zoom/u })).not.toBeInTheDocument();
});

test("one panel, top to bottom: the shield with blocking, its permissions, zoom, and its data, and no host", async () => {
  const screen = await shell({ zoom: 125 });
  await screen.getByRole("button", { name: "Site information" }).click();
  const panel = screen.getByRole("group", { name: "Site information" });

  const secure = panel.getByRole("img", { name: "Secure" });
  const blocking = panel.getByRole("switch", { name: "Block on this site" });
  const hide = panel.getByRole("button", { name: "Hide elements…" });
  const camera = panel.getByRole("radiogroup", { name: "Camera" });
  const zoom = panel.getByRole("group", { name: "Page zoom" });
  const clear = panel.getByRole("button", { name: "Clear data for this site…" });
  await expect.element(secure).toBeVisible();
  await expect.element(blocking).toBeChecked();
  await expect.element(hide).toBeVisible();
  await expect.element(camera.getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect.element(zoom.getByRole("status")).toHaveTextContent("125%");
  await expect.element(clear).toBeVisible();

  const order = [secure, blocking, hide, camera, zoom, clear].map((locator) => locator.element());
  for (let at = 1; at < order.length; at++) expect(before(order[at - 1]!, order[at]!)).toBe(true);

  const text = panel.element().textContent ?? "";
  // The head names the site it is about: a panel that says "Blocking" without
  // saying blocking where makes a person check the address bar.
  expect(panel.element().querySelector(".protection .head .site")?.textContent).toBe(
    "meet.example",
  );
  expect(text).not.toContain("Site settings");
  expect(text).not.toMatch(/blocked today|Ad blocking|\b42\b/u);
  expect(native.stats).not.toHaveBeenCalled();
});

test("the shield and the switch are one row: the shield leads, what the switch does follows, the switch ends it", async () => {
  const screen = await shell();
  await screen.getByRole("button", { name: "Site information" }).click();
  const panel = screen.getByRole("group", { name: "Site information" });
  await expect.element(panel.getByRole("switch", { name: "Block on this site" })).toBeVisible();
  const head = panel.element().querySelector<HTMLElement>(".protection .head")!;
  const rect = (element: Element) => element.getBoundingClientRect();
  const shield = head.querySelector(".mark")!;
  const name = head.querySelector(".name")!;
  const toggle = head.querySelector("[role=switch]")!;
  expect(rect(shield).right).toBeLessThanOrEqual(rect(name).left);
  expect(rect(name).right).toBeLessThanOrEqual(rect(toggle).left);
  expect(
    Math.abs(rect(shield).top + rect(shield).height / 2 - (rect(head).top + rect(head).height / 2)),
  ).toBeLessThan(1);
  const words = head.querySelector<HTMLElement>(".words")!;
  // The head is its two lines (the site, then what the switch acts on) and its
  // own 2px padding: nothing else adds height to the row.
  expect(head.querySelector(".site")?.textContent).toBe("meet.example");
  expect(head.offsetHeight).toBe(Math.round(words.getBoundingClientRect().height) + 4);
  expect(head.querySelectorAll("svg")).toHaveLength(1);
  expect(head.querySelector(".status")).toBeNull();
});

test("a page at its default zoom with no decisions lists the kinds it could ask for at Ask", async () => {
  native.list.mockResolvedValue({
    private: false,
    complete: true,
    kinds: ["camera"],
    entries: [],
  });
  const screen = await shell();
  await screen.getByRole("button", { name: "Site information" }).click();
  const panel = screen.getByRole("group", { name: "Site information" });
  await expect.element(panel.getByRole("switch", { name: "Block on this site" })).toBeVisible();
  await expect.poll(() => native.list.mock.calls.length).toBe(1);
  // No decision is a state of its own: the page may ask, and the row says so
  // rather than the panel pretending the site has no permissions.
  const camera = panel.getByRole("radiogroup", { name: "Camera" });
  await expect.element(camera).toBeVisible();
  await expect.element(panel.getByText("Ask", { exact: true })).toBeVisible();
  await expect.element(panel.getByText("Permissions", { exact: true })).toBeVisible();
  await expect.element(panel.getByRole("group", { name: "Page zoom" })).not.toBeInTheDocument();
  await expect
    .element(panel.getByRole("button", { name: "Clear data for this site…" }))
    .toBeVisible();
});

test("the panel is as wide as the field, with two groups divided and every row on one line", async () => {
  const screen = await shell({ zoom: 125 });
  await screen.getByRole("button", { name: "Site information" }).click();
  const panel = screen.getByRole("group", { name: "Site information" });
  await expect.element(panel.getByRole("switch", { name: "Block on this site" })).toBeVisible();
  await expect.element(panel.getByRole("group", { name: "Page zoom" })).toBeVisible();

  const fieldElement = screen.container.querySelector<HTMLElement>(".address-field")!;
  const field = fieldElement.getBoundingClientRect();
  // Opening scales the panel up from a hair under, so wait for it to settle.
  // In the column the tray is a sheet as wide as the field; in the page bar it
  // is a floating panel anchored to the field's end and capped to a readable
  // width, because a 700px-wide tray is not a menu.
  const inColumn = !!fieldElement.closest(".browser-sidebar");
  if (inColumn) {
    await expect
      .poll(() => Math.abs(panel.element().getBoundingClientRect().left - field.left))
      .toBeLessThanOrEqual(1);
    expect(
      Math.abs(panel.element().getBoundingClientRect().right - field.right),
    ).toBeLessThanOrEqual(1);
  } else {
    await expect
      .poll(() => Math.abs(panel.element().getBoundingClientRect().right - field.right))
      .toBeLessThanOrEqual(8);
    expect(panel.element().getBoundingClientRect().width).toBeLessThanOrEqual(320);
  }

  const body = panel.element().querySelector<HTMLElement>("[data-tray-body]")!;
  const line = (row: Element) => (row as HTMLElement).offsetHeight;
  const head = body.querySelector<HTMLElement>(".protection .head")!;
  const words = head.querySelector<HTMLElement>(".words")!;
  // The head is as tall as its words and its own padding; every action row is
  // the panel's one-line height. (The zoom *group* stacks its label and its
  // control, so it is a block, not a row.)
  expect(line(head)).toBe(Math.round(words.getBoundingClientRect().height) + 4);
  expect(line(panel.getByRole("button", { name: "Hide elements…" }).element())).toBe(34);
  expect(line(panel.getByRole("button", { name: "Clear data for this site…" }).element())).toBe(34);

  // What acts on the page, and what the site has: one divider between.
  const dividers = [...body.children].filter(
    (child) => parseFloat(getComputedStyle(child).borderTopWidth) > 0,
  );
  expect(dividers).toHaveLength(1);
});

test("with extensions, they join the blocking in its group; the label opens the manager, each extension its own", async () => {
  native.extensions = true;
  const screen = await shell({ zoom: 125 });
  await screen.getByRole("button", { name: "Site information" }).click();
  const panel = screen.getByRole("group", { name: "Site information" });
  const manage = panel.getByRole("button", { name: "Manage extensions" });
  await expect.element(manage).toBeVisible();
  await expect.element(panel.getByRole("button", { name: "Hide elements…" })).toBeVisible();

  const body = panel.element().querySelector<HTMLElement>("[data-tray-body]")!;
  const ruled = [...body.children].filter(
    (child) => parseFloat(getComputedStyle(child).borderTopWidth) > 0,
  );
  expect(ruled.map((child) => child.className.replace(/\s*svelte-\w+/gu, ""))).toEqual(["details"]);
  const row = body.querySelector<HTMLElement>(".extensions .row")!;
  expect(row.offsetHeight).toBe(34);
  expect(row.querySelector(".ui-menu-icon")).toBeNull();
  const edge = body.getBoundingClientRect().left;
  expect(
    [...body.querySelectorAll<HTMLElement>(".ui-menu-icon")].every(
      (icon) => Math.round(icon.getBoundingClientRect().left - edge) === 8,
    ),
  ).toBe(true);
  expect(
    Math.round(manage.element().querySelector(".name")!.getBoundingClientRect().left - edge),
  ).toBe(8);
});

test("an unencrypted page keeps the warning in view, and the panel says why", async () => {
  const screen = await shell({ url: "http://meet.example/" });
  const glyph = screen.getByRole("button", {
    name: "Site information, Connection is not encrypted",
  });
  await expect.element(glyph).toHaveAttribute("title", "Connection is not encrypted");
  expect(getComputedStyle(glyph.element()).opacity).toBe("1");
  await glyph.click();
  const panel = screen.getByRole("group", {
    name: "Site information, Connection is not encrypted",
  });
  await expect.element(panel.getByText("Not secure")).toBeVisible();
  await expect.element(panel.getByRole("img", { name: "Not secure" })).toBeVisible();
  expect(panel.element().textContent).not.toContain("Secure");
  // The warning names the site it is about.
  expect(panel.element().querySelector(".protection .head .site")?.textContent).toBe(
    "meet.example",
  );
});

test("a certificate the person continued past is not secure either", async () => {
  const screen = await shell({ certificate_exception: true });
  await expect
    .element(
      screen.getByRole("button", {
        name: "Site information, Certificate not trusted. You chose to continue to this site.",
      }),
    )
    .toBeVisible();
});

test("a new tab keeps its own search field and shows the page bar", async () => {
  native.extensions = true;
  const screen = await shell({ url: null });
  // The one address field stands in the page bar; on Windows the bar is the
  // top panel (it carries the window's controls), so the column keeps only its
  // own controls. On the other platforms the full column still owns the field.
  expect(screen.container.querySelector("[data-astra-address]")).not.toBeNull();
  expect(screen.container.querySelector("[data-content-bar] [data-astra-address]")).not.toBeNull();
  expect(screen.container.querySelector(".browser-sidebar [data-astra-address]")).toBeNull();
  expect(screen.container.querySelector("main#astra-stage")).not.toBeNull();
});

test("Escape closes the panel and returns to the glyph", async () => {
  const screen = await shell();
  const glyph = screen.getByRole("button", { name: "Site information" });
  await glyph.click();
  await expect.element(glyph).toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(glyph).toHaveAttribute("aria-expanded", "false");
  await expect.element(glyph).toHaveFocus();
});

test("nothing is read until the panel is opened", async () => {
  const screen = await shell();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(native.list).not.toHaveBeenCalled();
  expect(native.refresh).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Site information" }).click();
  await expect.poll(() => native.list.mock.calls.length).toBe(1);
  expect(native.refresh).toHaveBeenCalled();
});

test("the panel raises the frame over the page while it is open", async () => {
  const screen = await shell();
  const glyph = screen.getByRole("button", { name: "Site information" });
  await glyph.click();
  await expect.element(screen.getByRole("group", { name: "Site information" })).toBeVisible();
  // The panel is drawn by the app frame, which sits under the page surface;
  // opening it asks the shell to raise the frame, as a context menu does.
  expect(document.documentElement.dataset.astraRaised).toBe("true");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.documentElement.dataset.astraRaised).toBeUndefined();
});

test("Work has no page in front, so the field's tray describes no site", async () => {
  const screen = await shell();
  await expect.element(screen.getByRole("button", { name: "Site information" })).toBeVisible();
  emitNativeEvent("uiCommand", "browser.work");
  await expect.poll(() => screen.container.querySelector("[data-work-stage-stub]")).not.toBeNull();
  // With no page in front there is no site to describe, only the utilities.
  await expect
    .element(screen.getByRole("button", { name: "Site information" }))
    .not.toBeInTheDocument();
  // The tray is painted only while the column is in use or its field has the
  // keyboard; in Work the field is the one that reveals it.
  screen.container.querySelector<HTMLInputElement>(".address-field input")?.focus();
  await expect.element(screen.getByRole("button", { name: "Utilities" })).toBeVisible();
});

import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { preferences } from "$domain/preferences";
import { surface } from "$domain/surface";
import { tabs } from "$domain/tabs";
import { clearRequest } from "$domain/site-data";
import type { BlockerStatusView } from "$shared/ipc/bindings";
import { ContextMenu } from "$features/menus";
import { revision, tabFixture } from "$shared/testing/fixtures";
import { emitNativeEvent } from "$shared/testing/native-events";
import SidebarHeader from "../components/SidebarHeader.svelte";

const native = vi.hoisted(() => ({
  setProtected: vi.fn(async (_protect: boolean) => true),
  kind: "default" as "default" | "incognito",
  status: null as unknown as BlockerStatusView,
}));

vi.mock("$domain/blocker", async (original) => ({
  ...(await original<typeof import("$domain/blocker")>()),
  blocker: { status: () => native.status },
  blockerSites: { setProtected: native.setProtected },
}));
vi.mock("$domain/webext", () => ({ webext: { isAvailable: () => false } }));
vi.mock("$domain/extensions", () => ({ extensions: { activeActions: () => [] } }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    runCommand: async () => ({ accepted: true, operation_id: null }),
    settingGet: async () => null,
  });
});

const CONTEXT = { profile: "p1", tab: "tab-1", site: "example.com", revision: "1" };

function blocking(site: Record<string, unknown> = {}): BlockerStatusView {
  return {
    protection: "active",
    applied_enabled: true,
    desired_enabled: true,
    can_enable: true,
    preference: "authoritative",
    site: {
      context: CONTEXT,
      paused: false,
      private_session: false,
      ready: true,
      busy: false,
      hides: [],
      ...site,
    },
  } as unknown as BlockerStatusView;
}

const noSite = () =>
  ({
    protection: "unavailable",
    applied_enabled: null,
    site: null,
  }) as unknown as BlockerStatusView;

let clock = Date.now();
const stamp = () => revision((clock += 1));

afterEach(() => {
  // The menu lives in a module store; Escape closes it through the same path
  // the chrome uses, so one test cannot leak a menu into the next.
  document
    .querySelector(".shell-menu")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  clearRequest.dismiss();
  tabs.dispose();
  surface.dispose();
  preferences.dispose();
  native.setProtected.mockClear();
  native.kind = "default";
});

const menuLabels = () =>
  [...document.querySelectorAll(".shell-menu-item .shell-menu-label")].map((node) =>
    node.textContent?.trim(),
  );

function clickRow(label: string) {
  const row = [...document.querySelectorAll<HTMLButtonElement>(".shell-menu-item")].find((button) =>
    button.textContent?.includes(label),
  );
  expect(row).toBeDefined();
  row!.click();
}

async function rail(over: Parameters<typeof tabFixture>[0]) {
  await tabs.init();
  const tab = tabFixture({ projection_revision: stamp(), ...over });
  emitNativeEvent("itemsChanged", {
    projection_revision: stamp(),
    profile: { id: "p1", name: "Personal", kind: native.kind },
    spaces: [],
    active_space_id: null,
    nodes: [],
    tabs: [tab],
    active: tab.id,
    split_group: null,
  });
  native.status =
    over?.url !== null && over?.url !== undefined && (over.content ?? "web") === "web"
      ? blocking()
      : noSite();
  render(ContextMenu);
  const screen = await render(SidebarHeader, { compact: true });
  await screen.getByRole("button", { name: "Sidebar options" }).click();
  return screen;
}

test("the rail's menu offers site protection and clearing a web page's data", async () => {
  await rail({ url: "https://example.com/a" });
  await expect
    .poll(menuLabels)
    .toEqual(["Site protection: On", "Hide sidebar", "Clear Data for This Site…"]);
});

test("a new tab and a blank page have no site, so no data to clear", async () => {
  await rail({ url: null });
  expect(menuLabels()).not.toContain("Clear Data for This Site…");
});

test("an internal page has no site to clear either", async () => {
  await rail({ url: "https://example.com/", content: "settings" });
  expect(menuLabels()).not.toContain("Clear Data for This Site…");
});

test("a private window keeps nothing, so offers nothing to clear", async () => {
  native.kind = "incognito";
  await rail({ url: "https://example.com/" });
  expect(menuLabels()).not.toContain("Clear Data for This Site…");
});

test("choosing to clear data asks for that page's site", async () => {
  await rail({ url: "https://example.com/a" });
  await expect.poll(menuLabels).toContain("Clear Data for This Site…");
  clickRow("Clear Data for This Site…");
  await expect
    .poll(() => clearRequest.pending())
    .toEqual({ url: "https://example.com/a", host: "example.com" });
});

test("the protection row toggles that site's protection", async () => {
  await rail({ url: "https://example.com/a" });
  await expect.poll(menuLabels).toContain("Site protection: On");
  clickRow("Site protection: On");
  await expect.poll(() => native.setProtected.mock.calls).toEqual([[false]]);
});

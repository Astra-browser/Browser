import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import type { ExtensionActionView, WebExtensionView } from "$shared/ipc/bindings";
import ExtensionHub from "../components/ExtensionHub.svelte";

const native = vi.hoisted(() => ({
  extensions: [] as WebExtensionView[],
  actions: [] as ExtensionActionView[],
  error: null as string | null,
  refresh: vi.fn(async () => {}),
  setEnabled: vi.fn(async (_id: string, _on: boolean) => {}),
  setPinned: vi.fn(async (_id: string, _pinned: boolean) => {}),
  openOptions: vi.fn(async (_id: string) => {}),
  uninstall: vi.fn(async (_id: string) => {}),
  chooseFile: vi.fn(async (_folder: boolean) => {}),
  invoke: vi.fn(async (..._args: unknown[]) => {}),
  openPage: vi.fn(async (_page: string) => {}),
  openUrl: vi.fn(async (_url: string, _newTab: boolean) => ({
    accepted: true,
    operation_id: null,
  })),
}));

vi.mock("$domain/webext", () => ({
  webext: {
    list: () => native.extensions,
    error: () => native.error,
    isAvailable: () => true,
    refresh: native.refresh,
    setEnabled: native.setEnabled,
    setPinned: native.setPinned,
    pinnedCount: () => native.extensions.filter((extension) => extension.pinned).length,
    MAX_PINNED: 3,
    openOptions: native.openOptions,
    uninstall: native.uninstall,
    chooseFile: native.chooseFile,
  },
}));

vi.mock("$domain/extensions", () => ({
  extensions: {
    activeActions: () => native.actions,
    isInvoking: () => false,
    invoke: native.invoke,
  },
}));

vi.mock("$domain/tabs", () => ({
  tabs: { profile: () => ({ id: "profile" }), activeId: () => "tab" },
}));

vi.mock("$domain/surface", () => ({ surface: { open: native.openPage } }));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ browserOpenUrl: native.openUrl });
});

const extension = (over: Partial<WebExtensionView> = {}): WebExtensionView => ({
  profile_id: "profile",
  install_id: "install-a",
  id: "ext-a",
  name: "Bitwarden",
  version: "1.0",
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
  ...over,
});

const action = (over: Partial<ExtensionActionView> = {}): ExtensionActionView => ({
  runtime: { install_id: "install-a", generation: "g" },
  revision: "r1",
  label: "Bitwarden",
  badge: "",
  icon_rgba_base64: null,
  enabled: true,
  presents_popup: true,
  unread_badge: false,
  ...over,
});

beforeEach(() => {
  native.extensions = [];
  native.actions = [];
  native.error = null;
});
afterEach(() => vi.clearAllMocks());

test("with nothing installed the hub offers both ways to add an extension", async () => {
  const screen = await render(ExtensionHub);
  await expect.element(screen.getByText("Add your first extension")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Install from file" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Chrome Web Store" })).toBeVisible();
});

test("every installed extension has a row, a switch and its own menu", async () => {
  native.extensions = [
    extension(),
    extension({
      id: "ext-b",
      install_id: "install-b",
      name: "Dark Reader",
      icon: "data:image/png;base64,AA==",
    }),
  ];
  native.actions = [action()];
  const screen = await render(ExtensionHub);
  await expect.element(screen.getByText("Bitwarden", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Dark Reader", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Ready on this page")).toBeVisible();
  await expect.element(screen.getByText("No action on this page")).toBeVisible();
  await expect
    .element(screen.getByRole("switch", { name: "Turn Bitwarden on or off" }))
    .toBeChecked();
  await expect.element(screen.getByRole("button", { name: "More for Bitwarden" })).toBeVisible();
});

test("a live action is invoked from the row, and the panel leaves", async () => {
  native.extensions = [extension()];
  native.actions = [action()];
  const screen = await render(ExtensionHub);
  const use = screen.getByRole("button", { name: "Bitwarden", exact: true });
  await expect.element(use).toHaveAttribute("data-dismiss");
  await use.click();
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith(
    "profile",
    "tab",
    native.actions[0],
    expect.any(DOMRect),
  );
});

test("the switch turns the extension off through the host", async () => {
  native.extensions = [extension()];
  const screen = await render(ExtensionHub);
  await screen.getByRole("switch", { name: "Turn Bitwarden on or off" }).click();
  expect(native.setEnabled).toHaveBeenCalledExactlyOnceWith("ext-a", false);
});

test("managing opens the extensions page, and the store opens in a tab", async () => {
  native.extensions = [extension()];
  const screen = await render(ExtensionHub);
  await screen.getByRole("button", { name: "Manage extensions" }).click();
  expect(native.openPage).toHaveBeenCalledExactlyOnceWith("extensions");
  await screen.getByRole("button", { name: "Chrome Web Store" }).click();
  expect(native.openUrl).toHaveBeenCalledExactlyOnceWith(
    "https://addons.mozilla.org/firefox/",
    true,
  );
});

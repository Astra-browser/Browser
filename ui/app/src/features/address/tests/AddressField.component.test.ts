import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { userEvent } from "vitest/browser";
import { emitNativeEvent } from "$shared/testing/native-events";
import { revision, tabFixture } from "$shared/testing/fixtures";
import { tabs } from "$domain/tabs";
import { preferences } from "$domain/preferences";
import { uiCommands } from "$domain/ui-commands";
import AddressFieldHost from "./AddressFieldHost.svelte";

const native = vi.hoisted(() => {
  // A plain function, not a spy: Vitest's spy result tracking attaches a
  // handler to the promise it returns, which would hide a rejection the app
  // never handles — the thing the field is being tested for.
  const state = {
    defaultZoom: "100",
    page: null as string | null,
    editCalls: 0,
    editFails: false,
    navigate: vi.fn(async () => ({ accepted: true, operation_id: null })),
    edit: async (_tab: string, _url: string) => {
      state.editCalls += 1;
      if (state.editFails) throw new Error("not routed");
      return true;
    },
  };
  return state;
});

vi.mock("$domain/surface", () => ({ surface: { currentPage: () => native.page } }));
vi.mock("$domain/permissions", () => ({
  sitePermissions: { list: async () => null, set: async () => true },
}));
vi.mock("$domain/blocker", async (original) => ({
  ...(await original<typeof import("$domain/blocker")>()),
  blocker: {
    status: () => ({ protection: "unavailable", applied_enabled: null, site: null }),
    refresh: async () => {},
  },
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    tabsBootstrap: async () => {},
    runCommand: async () => ({ accepted: true, operation_id: null }),
    launcherEdit: native.edit,
    tabsNavigate: native.navigate,
    settingGet: async (key: string) => (key === "zoom.default" ? native.defaultZoom : null),
  });
});

// The store keeps the newest projection it admitted across tests, so a stamp
// that follows the clock can land behind the last test's when tests run fast.
let clock = Date.now();
const stamp = () => revision((clock += 1));

afterEach(() => {
  tabs.dispose();
  preferences.dispose();
  native.defaultZoom = "100";
  native.page = null;
  native.editCalls = 0;
  native.editFails = false;
  native.navigate.mockClear();
});

async function field(props: { compact?: boolean } = {}) {
  await tabs.init();
  const tab = tabFixture({
    projection_revision: stamp(),
    url: "https://www.wikipedia.org/wiki/Premium",
  });
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
  const screen = await render(AddressFieldHost, props);
  const input = screen.container.querySelector<HTMLInputElement>("[data-astra-address]")!;
  return { screen, input };
}

test("a click on a page's address edits it here, and only the shortcut opens the launcher", async () => {
  const { screen, input } = await field();
  await screen.getByRole("combobox", { name: /address/iu }).click();
  expect(document.activeElement).toBe(input);
  await expect.poll(() => input.value).toBe("https://www.wikipedia.org/wiki/Premium");
  expect(native.editCalls).toBe(0);
});

test("editing shows the whole address and rests on the host", async () => {
  const { input } = await field();
  expect(input.value).toBe("www.wikipedia.org");
  input.focus();
  await expect.poll(() => input.value).toBe("https://www.wikipedia.org/wiki/Premium");
  input.blur();
  await expect.poll(() => input.value).toBe("www.wikipedia.org");
});

test("a refused navigation's ring leaves with the page it was about", async () => {
  native.navigate.mockResolvedValueOnce({ accepted: false, operation_id: null });
  const { screen, input } = await field();
  input.focus();
  await expect.poll(() => input.value).toBe("https://www.wikipedia.org/wiki/Premium");
  await userEvent.keyboard("https://missing.invalid/");
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("alert")).toBeInTheDocument();
  expect(input.getAttribute("aria-invalid")).toBe("true");

  // The press that moves to another tab takes the caret out of the field and
  // the new page's address in; the refusal was about the old page.
  input.blur();
  emitNativeEvent("tabChanged", {
    ...tabs.activeTab()!,
    projection_revision: stamp(),
    url: "https://example.com/",
  });
  await expect.poll(() => input.value).toBe("example.com");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(input.getAttribute("aria-invalid")).toBeNull();
});

test("Enter hands the typed line to the host rather than deciding itself", async () => {
  const { input } = await field();
  input.focus();
  await expect.poll(() => input.value).toBe("https://www.wikipedia.org/wiki/Premium");
  await userEvent.keyboard("rust lifetimes");
  await userEvent.keyboard("{Enter}");
  // One place decides whether those words are an address or a search; the
  // field only says what was typed, and it says it whole.
  await vi.waitFor(() =>
    expect(native.navigate).toHaveBeenCalledWith(tabs.activeId(), "rust lifetimes"),
  );
});

test("an address of only spaces navigates nowhere", async () => {
  const { input } = await field();
  input.focus();
  await expect.poll(() => input.value).toBe("https://www.wikipedia.org/wiki/Premium");
  await userEvent.keyboard("   ");
  await userEvent.keyboard("{Enter}");
  await new Promise((done) => setTimeout(done, 30));
  expect(native.navigate).not.toHaveBeenCalled();
  // The page did not move, so the field stays where the person is typing.
  expect(document.activeElement).toBe(input);
});

test("a launcher hand-off that the host refuses raises nothing", async () => {
  const rejections: unknown[] = [];
  const caught = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
  };
  window.addEventListener("unhandledrejection", caught);
  try {
    native.editFails = true;
    const { input } = await field();
    await uiCommands.init();
    emitNativeEvent("uiCommand", "url.focus");
    await vi.waitFor(() => expect(native.editCalls).toBe(1));
    // The shortcut hands the address to the launcher; when that cannot be
    // delivered the field must not leave a rejected promise behind. It takes
    // the caret instead of doing nothing: a refused hand-off is what these
    // tests caught Ctrl+L doing silently before.
    await new Promise((done) => setTimeout(done, 50));
    expect(rejections).toEqual([]);
    expect(document.activeElement).toBe(input);
  } finally {
    window.removeEventListener("unhandledrejection", caught);
    uiCommands.dispose();
  }
});

test("a press anywhere else in the chrome ends editing", async () => {
  const { input } = await field();
  const elsewhere = document.createElement("div");
  elsewhere.style.cssText = "width:40px;height:40px";
  document.body.append(elsewhere);

  input.focus();
  expect(document.activeElement).toBe(input);
  elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(document.activeElement).not.toBe(input);
  await expect.poll(() => input.value).toBe("www.wikipedia.org");
  elsewhere.remove();
});

test("the page taking focus from the chrome ends editing", async () => {
  const { input } = await field();
  input.focus();
  window.dispatchEvent(new Event("blur"));
  expect(document.activeElement).not.toBe(input);
});

test("a native blocked-popup projection is visible without changing the address", async () => {
  const { screen, input } = await field();
  const tab = tabs.activeTab()!;
  emitNativeEvent("tabChanged", {
    ...tab,
    projection_revision: stamp(),
    page_request: { kind: "popup", host: "example.com", site: null },
  });
  const card = screen.getByRole("alertdialog");
  await expect.element(card).toHaveTextContent("Pop-up blocked");
  await expect.element(card).toHaveTextContent("example.com");
  await expect.element(card.getByRole("button", { name: "Open" })).toBeVisible();
  expect(input.value).toBe("www.wikipedia.org");
});

test("a page's link for another app asks before it opens", async () => {
  const { screen } = await field();
  const tab = tabs.activeTab()!;
  emitNativeEvent("tabChanged", {
    ...tab,
    projection_revision: stamp(),
    page_request: { kind: "external_app", site: "zoom.us", scheme: "zoommtg", app: "zoom.us" },
  });
  const card = screen.getByRole("alertdialog");
  await expect.element(card).toHaveTextContent("Open zoom.us?");
  await expect.element(card.getByRole("checkbox")).not.toBeChecked();
  await expect.element(card.getByRole("button", { name: "Cancel" })).toBeVisible();
});

test("a page that stopped responding offers to wait or reload", async () => {
  const { screen } = await field();
  const tab = tabs.activeTab()!;
  emitNativeEvent("tabChanged", {
    ...tab,
    projection_revision: stamp(),
    page_request: { kind: "unresponsive" },
  });
  const card = screen.getByRole("alertdialog");
  await expect.element(card).toHaveTextContent("This page isn't responding");
  await expect.element(card.getByRole("button", { name: "Wait" })).toBeVisible();
  await expect.element(card.getByRole("button", { name: "Reload" })).toBeVisible();
  emitNativeEvent("tabChanged", {
    ...tab,
    projection_revision: stamp(),
    page_request: null,
  });
  await expect.element(screen.getByRole("alertdialog")).not.toBeInTheDocument();
});

const told = (screen: { container: Element }) =>
  JSON.parse(screen.container.querySelector("[data-trailing]")?.textContent ?? "undefined");

async function trailed(change: Record<string, unknown> = {}) {
  const { screen, input } = await field();
  if (Object.keys(change).length > 0) {
    emitNativeEvent("tabChanged", {
      ...tabs.activeTab()!,
      projection_revision: stamp(),
      ...change,
    });
  }
  return { screen, input };
}

test("the trailing controls are told about a secure web page, with nothing wrong with it", async () => {
  const { screen } = await trailed();
  expect(told(screen)).toEqual({
    url: "https://www.wikipedia.org/wiki/Premium",
    security: "secure",
    warning: null,
    capture: null,
    privateWindow: false,
    zoom: null,
    standardZoom: 100,
  });
});

test("an unencrypted page, and one past a certificate warning, are told what is wrong", async () => {
  const { screen } = await trailed({ url: "http://example.com/" });
  await expect.poll(() => told(screen).security).toBe("insecure");
  expect(told(screen).warning).toBe("Connection is not encrypted");

  emitNativeEvent("tabChanged", {
    ...tabs.activeTab()!,
    projection_revision: stamp(),
    url: "https://self-signed.example/",
    certificate_exception: true,
  });
  await expect.poll(() => told(screen).security).toBe("untrusted");
  expect(told(screen).warning).toBe("Certificate not trusted. You chose to continue to this site.");
});

test("the page's zoom is passed on with what pages show at by default", async () => {
  native.defaultZoom = "110";
  await preferences.init();
  const { screen } = await trailed({ zoom: 125 });
  await expect.poll(() => told(screen).zoom).toBe(125);
  expect(told(screen).standardZoom).toBe(110);
});

test("a camera in use is told too", async () => {
  const { screen } = await trailed({ capture: { camera: "active", microphone: "none" } });
  await expect.poll(() => told(screen).capture).toEqual({ camera: "active", microphone: "none" });
});

test("a new tab, an internal page and a blank page have no site to be told of", async () => {
  const blank = await pageWithout({ url: null });
  await expect.poll(() => told(blank)).toBeNull();
  blank.unmount();

  const internal = await pageWithout({ url: null, content: "settings" });
  await expect.poll(() => told(internal)).toBeNull();
  internal.unmount();

  const about = await pageWithout({ url: "about:blank" });
  await expect.poll(() => told(about)).toBeNull();
});

test("a page behind Settings has none either, and the rail draws no trailing controls", async () => {
  native.page = "settings";
  const behind = await field();
  await expect.poll(() => told(behind.screen)).toBeNull();
  behind.screen.unmount();

  native.page = null;
  const rail = await field({ compact: true });
  expect(rail.screen.container.querySelector("[data-trailing]")).toBeNull();
});

test("the field itself carries no site glyph and no zoom badge", async () => {
  const { screen } = await trailed({ url: "http://example.com/", zoom: 90 });
  await expect.poll(() => told(screen).zoom).toBe(90);
  await expect
    .element(screen.getByRole("button", { name: /Site information|Page zoom/u }))
    .not.toBeInTheDocument();
});

async function pageWithout(change: Record<string, unknown>) {
  const { screen, input } = await field();
  emitNativeEvent("tabChanged", {
    ...tabs.activeTab()!,
    projection_revision: stamp(),
    ...change,
  });
  await expect.poll(() => input.value).toBe("");
  return screen;
}

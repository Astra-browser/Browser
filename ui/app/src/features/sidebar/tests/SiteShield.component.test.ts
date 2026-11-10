import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import "$styles/global.css";
import SiteShield from "../components/SiteShield.svelte";

const state = vi.hoisted(() => ({
  status: {
    applied_enabled: true as boolean,
    protection: "active",
    site: null as null | Record<string, unknown>,
  },
  setProtected: vi.fn(async () => true),
  setEnabled: vi.fn(async () => ({ state: "processed", disposition: { outcome: "applied" } })),
  refresh: vi.fn(async () => {}),
  profile: { kind: "default" },
}));

vi.mock("$domain/blocker", () => ({
  blocker: {
    status: () => state.status,
    refresh: state.refresh,
    setEnabled: state.setEnabled,
  },
  blockerSites: { setProtected: state.setProtected },
  shieldPresentation: () => ({
    visible: true,
    tone: "quiet",
    blocked: false,
    label: "Protection active",
  }),
}));

vi.mock("$domain/tabs", () => ({
  tabs: {
    activeId: () => "a",
    activeTab: () => ({ url: "https://news.example/story", projection_revision: "r1" }),
    profile: () => state.profile,
  },
}));

const site = (paused: boolean) => ({
  site: "news.example",
  context: { profile: "default", tab: "a", site: "news.example", revision: "1" },
  paused,
  ready: true,
  busy: false,
});

afterEach(() => {
  state.status.site = null;
  state.status.applied_enabled = true;
  state.setProtected.mockClear();
  state.setEnabled.mockClear();
  state.refresh.mockClear();
  state.profile = { kind: "default" };
});

test("the sidebar shield names the page's site and turns blocking off", async () => {
  state.status.site = site(false);
  const screen = await render(SiteShield);
  const button = screen.container.querySelector<HTMLButtonElement>("[data-astra-shield]")!;
  expect(button).not.toBeNull();
  expect(button.dataset.shieldState).toBe("on");
  expect(button.dataset.shieldSite).toBe("news.example");
  expect(button.getAttribute("aria-label")).toBe("Turn off blocking on news.example");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  button.click();
  await vi.waitFor(() => expect(state.setProtected).toHaveBeenLastCalledWith(false));
  expect(state.setEnabled).not.toHaveBeenCalled();
});

test("a paused site shows off and the same control turns it back on", async () => {
  state.status.site = site(true);
  const screen = await render(SiteShield);
  const button = screen.container.querySelector<HTMLButtonElement>("[data-astra-shield]")!;
  expect(button.dataset.shieldState).toBe("off");
  expect(button.getAttribute("aria-label")).toBe("Turn on blocking on news.example");
  expect(button.getAttribute("aria-pressed")).toBe("false");
  button.click();
  await vi.waitFor(() => expect(state.setProtected).toHaveBeenLastCalledWith(true));
});

test("with blocking off globally the same control turns it on", async () => {
  state.status.applied_enabled = false;
  state.status.site = site(false);
  const screen = await render(SiteShield);
  const button = screen.container.querySelector<HTMLButtonElement>("[data-astra-shield]")!;
  button.click();
  await vi.waitFor(() => expect(state.setEnabled).toHaveBeenLastCalledWith(true));
  expect(state.setProtected).not.toHaveBeenCalled();
});

test("a private window has no per-site switch (the policy is process-wide)", async () => {
  state.profile = { kind: "incognito" };
  state.status.site = site(false);
  const screen = await render(SiteShield);
  expect(screen.container.querySelector("[data-astra-shield]")).toBeNull();
});

// P0-T07 golden screens: one deterministic setup per capture.
// Each setup mounts its root component into #root with fixed fixtures and
// resolves once the screen has settled. The capture script screenshots after
// `document.documentElement.dataset.golden === "ready"`.
//
// Fixture sources mirror the component-test benches (look-bench, TimeLook,
// LauncherPanel tests) so goldens and tests seed the same world. Ordering
// matters: boot() subscribes the domain stores, then paint emits events,
// then components mount and read the stores.

import { mount } from "svelte";
import Shell from "../src/app/browser/Shell.svelte";
import LauncherPanel from "../src/features/search/components/LauncherPanel.svelte";
import { preferences } from "../src/domain/preferences";
import { surface } from "../src/domain/surface";
import { tabs } from "../src/domain/tabs";
import { favicons } from "../src/domain/favicons";
import { theme } from "../src/domain/appearance";
import { keymap } from "../src/domain/keymap";
import { taskSession } from "../src/domain/resources";
import { setPageView } from "../src/features/tasks/lib/page-view.svelte";
import { resourceServerFor } from "./servers";
import { notesTestServer } from "../src/shared/testing/notes/server";
import { nativeEventNames } from "../src/shared/ipc/native-events";
import type { SearchResult } from "../src/shared/ipc/bindings";
import { installHandlers, settings } from "./mocks/router";
import { SPACES, faviconEntries, nextRevision, seedTabs } from "./seed";
import NewTabStage from "./NewTabStage.svelte";

export const PROFILE = "01J0000000000000000000000G1";

function emit(name: keyof typeof nativeEventNames, detail: unknown): void {
  window.dispatchEvent(new CustomEvent(nativeEventNames[name], { detail }));
}

const ok = { accepted: true, operation_id: null };

/** Theme on the root, the way the browser applies it. */
function applyTheme(mode: "light" | "dark"): void {
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.material = "none";
  theme.applyCustomization({
    theme: "astra",
    custom: "",
    level: "50",
    contrast: false,
    font: "system",
    fontSize: "13",
    codeFont: "system",
  });
}

async function boot(): Promise<void> {
  // theme.init() adopts the stored appearance; align the bag first so the
  // requested theme survives init.
  settings.appearance = THEME();
  await theme.init();
  await preferences.init();
  await surface.init();
  await tabs.init();
  await favicons.init();
}

function paintTabs(active: string): void {
  const kept = seedTabs(["beacon", "northwind", "ledger"]);
  const open = seedTabs(["harbor", "chorus", "compass", "atlas"]);
  const fresh = {
    id: "fresh",
    projection_revision: nextRevision(),
    title: "New Tab",
    url: null,
    loading: false,
    can_go_back: false,
    can_go_forward: false,
    icon: null,
  };
  emit("favicons", {
    surface: "chrome",
    profile_id: PROFILE,
    entries: faviconEntries(),
  });
  emit("itemsChanged", {
    projection_revision: nextRevision(),
    profile: { id: PROFILE, name: "Personal", kind: "default" },
    spaces: [],
    active_space_id: null,
    nodes: [
      ...kept.map((tab) => ({
        id: tab.id,
        parent_id: null,
        section: "favorites",
        kind: { type: "tab", tab_id: tab.id },
      })),
      ...open.map((tab) => ({
        id: tab.id,
        parent_id: null,
        section: "today",
        kind: { type: "tab", tab_id: tab.id },
      })),
    ],
    tabs: [...kept, ...open, fresh],
    active,
    split_group: null,
  });
}

function paintSpaces(): void {
  const open = seedTabs(["harbor", "chorus", "compass", "atlas"]);
  emit("itemsChanged", {
    projection_revision: nextRevision(),
    profile: { id: PROFILE, name: "Personal", kind: "default" },
    spaces: SPACES,
    active_space_id: "home",
    nodes: open.map((tab) => ({
      id: tab.id,
      parent_id: null,
      section: "today",
      kind: { type: "tab", tab_id: tab.id },
    })),
    tabs: open,
    active: "harbor",
    split_group: null,
  });
}

const waitFor = async (ready: () => boolean, timeout = 20000): Promise<void> => {
  // performance.now: the golden clock pin freezes Date.now, so deadlines
  // must never be measured with the wall clock.
  const start = performance.now();
  for (;;) {
    if (ready()) return;
    if (performance.now() - start > timeout) throw new Error("golden: settle timeout");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

function markReady(): void {
  document.documentElement.dataset.golden = "ready";
}

const THEME = () =>
  (new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light") as
    "light" | "dark";

async function shellScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  await boot();
  const tasks = taskSession(PROFILE, "seed");
  await tasks.create({ title: "Review the browser task experience", dueDate: "2026-09-28" });
  await tasks.create({ title: "Write the launch notes", dueDate: "2026-09-28" });
  paintTabs("fresh");
  mount(Shell, { target: document.getElementById("root")! });
  await waitFor(() => document.querySelector('.newtab[data-ready="true"]') !== null);
  await settle();
  markReady();
}

async function spacesScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  await boot();
  await keymap.init();
  paintTabs("harbor");
  paintSpaces();
  mount(Shell, { target: document.getElementById("root")! });
  await settle();
  const button = [...document.querySelectorAll("button")].find((entry) =>
    (entry.getAttribute("aria-label") ?? "").startsWith("Spaces —"),
  );
  button?.dispatchEvent(new PointerEvent("click", { bubbles: true }));
  await waitFor(() => document.querySelector('[role="menu"], [role="listbox"]') !== null);
  await settle();
  markReady();
}

async function newtabScreen(): Promise<void> {
  await import("../src/styles/global.css");
  resourceServerFor(PROFILE);
  applyTheme(THEME());
  await boot();
  const tasks = taskSession(PROFILE, "seed");
  await tasks.create({ title: "Review the browser task experience", dueDate: "2026-09-28" });
  await tasks.create({ title: "Write the launch notes", dueDate: "2026-09-28" });
  await tasks.create({ title: "Book train tickets", dueDate: "2026-10-01" });
  mount(NewTabStage, { target: document.getElementById("root")! });
  await waitFor(() => document.querySelector('.newtab[data-ready="true"]') !== null);
  await settle();
  markReady();
}

const launcherResults = (query: string): SearchResult[] => [
  {
    kind: "history",
    title: "Beacon Messenger",
    detail: "beacon.example",
    icon: null,
    action: { type: "OpenUrl", url: "https://beacon.example/" },
  },
  {
    kind: "search",
    title: `${query} — compass search`,
    detail: "Compass",
    icon: null,
    action: { type: "OpenUrl", url: `https://compass.example/?q=${encodeURIComponent(query)}` },
  },
];

async function launcherScreen(): Promise<void> {
  await import("../src/styles/panel.css");
  document.documentElement.dataset.theme = THEME();
  document.documentElement.dataset.material = "none";
  installHandlers({
    launcher_search: async ({ query, requestId }) => {
      const text = String(query ?? "");
      queueMicrotask(() =>
        emit("searchChanged", {
          pending: false,
          context: {
            window_id: "window",
            profile_id: PROFILE,
            space_id: "space",
            session_id: "0000000000000001",
            request_id: String(requestId ?? ""),
          },
          query: text,
          completion: null,
          results: launcherResults(text),
        }),
      );
      return true;
    },
    launcher_run: async () => ok,
  });
  await boot();
  mount(LauncherPanel, {
    target: document.getElementById("root")!,
    props: {
      context: {
        window_id: "window",
        profile_id: PROFILE,
        space_id: "space",
        session_id: "0000000000000001",
        request_id: "",
        revision: "0000000000000001",
        visible: true,
        profile_name: "Personal",
        error: false,
        corner_radius: 20,
        seed: null,
        seed_tab: null,
      },
    },
  });
  await settle();
  const box = document.querySelector('[role="combobox"]') as HTMLInputElement | null;
  box?.focus();
  document.execCommand("insertText", false, "read");
  box?.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => (document.body.textContent ?? "").includes("Beacon Messenger"));
  await settle();
  markReady();
}

/** Shell-hosted page (tasks/notes/time/settings): boot, mount, seed, open. */
async function openPage(
  page: "tasks" | "notes" | "time" | "settings",
  seed: () => void | Promise<void>,
): Promise<void> {
  installHandlers({
    run_command: async ({ id }) => {
      const name = String(id ?? "");
      if (name.startsWith("browser.")) {
        const destination = name.slice("browser.".length);
        queueMicrotask(() => emit("uiCommand", `browser.${destination}`));
      }
      return ok;
    },
  });
  await boot();
  mount(Shell, { target: document.getElementById("root")! });
  await settle();
  await seed();
  paintTabs("fresh");
  await surface.open(page);
  await waitFor(() => document.querySelector(`.stage-page[data-page="${page}"]`) !== null);
  await waitFor(
    () =>
      document.querySelector(
        '.stage-page [data-ready="true"], .stage-page ul, .stage-page [role="list"]',
      ) !== null,
  ).catch(() => {});
  await settle();
  markReady();
}

async function tasksScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  resourceServerFor(PROFILE);
  setPageView({ scope: "today", trashed: false, board: false, list: null }, PROFILE);
  const session = taskSession(PROFILE, "page");
  await session.create({ title: "Review the browser task experience", dueDate: "2026-09-28" });
  await session.create({ title: "Write the launch notes", dueDate: "2026-09-28" });
  await openPage("tasks", () => {});
}

async function notesScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  const server = notesTestServer(PROFILE, (changed, reset, links) =>
    queueMicrotask(() => emit("notesChanged", { profile: PROFILE, notes: changed, reset, links })),
  );
  installHandlers({
    note_call: async ({ expectedProfile, call }) =>
      server.call(String(expectedProfile ?? ""), call as never),
  });
  await openPage("notes", async () => {
    const now = Date.now();
    server.seed("# Reading list\n\n- [ ] The Timeless Way of Building\n", {
      pinned: true,
      modified_at: String(now - 9 * 86_400_000),
    });
    server.seed(
      "# Trip to Lisbon\n\nBook the **train from Porto** on Friday.\n\n- [ ] Pack the adapter\n- [x] Buy tickets\n",
      { modified_at: String(now) },
    );
    server.seed("# Weekly review\n\nWhat moved, what stalled, what to drop.\n", {
      modified_at: String(now - 86_400_000),
    });
  });
}

async function timeScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  installHandlers({
    time_call: async ({ call }) => timeReport(call as { kind: string; from_day?: number }),
    focus_control: async () => ok,
  });
  await openPage("time", () => {});
}

// A working day: mornings on code and planning, a long lunch on video.
const DAY = [
  0, 0, 0, 0, 0, 0, 0, 0, 840, 2950, 3300, 2100, 1500, 2600, 3120, 1830, 0, 0, 0, 0, 0, 0, 0, 0,
];

function timeReport(call: { kind: string; from_day?: number }): unknown {
  if (call.kind === "focus_days") {
    return {
      kind: "focus_days",
      days: [{ day: call.from_day ?? 0, seconds: 3000, sessions: 2, completed: 1 }],
    };
  }
  const total = DAY.reduce((sum, value) => sum + value, 0);
  const sites = [
    { site: "harbor.example", seconds: Math.round(total * 0.34), opens: 14 },
    { site: "compass.example", seconds: Math.round(total * 0.21), opens: 9 },
    { site: "chorus.example", seconds: Math.round(total * 0.16), opens: 4 },
    { site: "ledger.example", seconds: Math.round(total * 0.11), opens: 6 },
  ].map((entry) => ({ ...entry, icon: null, series: [] as number[] }));
  return {
    kind: "report",
    buckets: DAY.map((value) => ({
      browse: Math.round(value * 0.82),
      work: Math.round(value * 0.18),
    })),
    previous: { browse: Math.round(total * 0.95), work: 600 },
    sites,
  };
}

async function settingsScreen(): Promise<void> {
  await import("../src/styles/global.css");
  applyTheme(THEME());
  await openPage("settings", () => {});
  await waitFor(() => (document.body.textContent ?? "").length > 2000);
  await settle();
  markReady();
}

export const screens: Record<string, () => Promise<void>> = {
  shell: shellScreen,
  spaces: spacesScreen,
  newtab: newtabScreen,
  launcher: launcherScreen,
  tasks: tasksScreen,
  notes: notesScreen,
  time: timeScreen,
  settings: settingsScreen,
};

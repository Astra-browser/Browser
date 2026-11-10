/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Commands module (v1, P4-T01 wiring). `run_command` is how the
// chrome asks for one product command by id: the same ids the native menus,
// the launcher, the keymap and Keyboard settings use, so a shortcut and a
// menu item and a button are one command rather than three paths.
//
// Native execution belongs here, not in the UI: a command that changes a
// browser surface announces the change on `ui-command` (the app's surface
// mirror only moves once native confirms), and a command that acts on a tab
// calls the Tabs/Navigation modules. The registry this validates against is
// `crates/astra-core/src/commands.rs`, ported in slices — an id that is not
// ported yet is refused instead of silently doing nothing.
//
// The second group below is the keyboard path: ids the keymap already binds
// (Back, Reload, Bookmark This Page, Developer Tools, …). The ones that move
// a tab are executed here; the ones that need the chrome window's own objects
// (a real window, DevTools, Save Page) are announced on `ui-command` and the
// shell performs them against the page in front. Refusing them, as this
// module did before, is what made every shortcut look dead.
//
// Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";
import { Tabs, __itemsSnapshot, __tabsState } from "./Tabs.sys.mjs";
import { Navigation } from "./Navigation.sys.mjs";
import { Settings } from "./Settings.sys.mjs";
import { Zoom } from "./Zoom.sys.mjs";

/** Browser surfaces a command can stand over the active tab. */
const PAGES = new Set([
  "settings",
  "work",
  "extensions",
  "history",
  "downloads",
  "tasks",
  "notes",
  "time",
  "source",
]);

/** The side-panel tools; `tool.<kind>` opens one the way its shelf row does. */
const TOOLS = new Set([
  "notes",
  "tasks",
  "time",
  "ai",
  "history",
  "downloads",
  "bookmarks",
]);

/**
 * Settings destinations. `settings.<section>` is what the product's own
 * controls ask for (the account menu, a fault's fix, a style block); native
 * opens Settings and names the section, so the page lands on it rather than
 * on whatever it showed last.
 */
const SECTIONS = new Set([
  "general",
  "appearance",
  "tabs",
  "newtab",
  "search",
  "privacy",
  "focus",
  "performance",
  "profiles",
  "spaces",
  "work",
  "ai",
  "skills",
  "memory",
  "sites",
  "mcp",
  "features",
  "shortcuts",
  "about",
  "account",
]);

/** Commands the chrome window must perform against the page in front. */
const SHELL_ACTIONS = new Set([
  "bookmark.add",
  "page.copy",
  "page.copyLink",
  "page.devtools",
  "page.devtools.alt",
  "page.print",
  "page.save",
  "page.selectAll",
  "page.viewSource",
  "window.closePrivate",
  "window.fullscreen",
  "window.new",
  "window.newPrivate",
  "window.showPrivate",
  "window.showRegular",
  "window.togglePrivate",
]);

/** Commands the app's own surfaces answer from `ui-command`. */
const APP_ACTIONS = new Set([
  "extensions.manage",
  "find.next",
  "find.previous",
  "find.show",
  "split.choose",
  "theme.dark",
  "theme.light",
  "theme.system",
  "url.focus",
  "work.dictate",
  "work.pane.close",
]);

/** The chrome's `runCommand` answer: an admission, as `settle()` expects. */
function admission(accepted) {
  return { operation_id: null, accepted };
}

function selectedId() {
  return __tabsState().selectedId;
}

async function tabIndexInSpace() {
  const list = await Tabs.list({});
  const tabs = list.tabs ?? [];
  const current = tabs.find((tab) => tab.astra_tab_id === selectedId());
  if (!current) return null;
  const order = tabs.filter((tab) => tab.space_id === current.space_id);
  return { order, at: order.findIndex((tab) => tab.astra_tab_id === selectedId()) };
}

async function stepTab(direction) {
  const pos = await tabIndexInSpace();
  if (!pos || pos.at < 0) return admission(false);
  const next = pos.order[(pos.at + direction + pos.order.length) % pos.order.length];
  if (!next) return admission(false);
  await Tabs.select({ astra_tab_id: next.astra_tab_id });
  return admission(true);
}

async function selectTabAt(index) {
  const pos = await tabIndexInSpace();
  if (!pos) return admission(false);
  const target = index === -1 ? pos.order[pos.order.length - 1] : pos.order[index];
  if (!target) return admission(false);
  await Tabs.select({ astra_tab_id: target.astra_tab_id });
  return admission(true);
}

async function stepSpace(direction) {
  const result = await Tabs.stepSpace({ step: direction });
  return admission(result.accepted === true);
}

async function tabNavigation(method) {
  const id = selectedId();
  if (!id) return admission(false);
  const result = await Navigation[method]({ astra_tab_id: id });
  return admission(!result?.error);
}

async function zoomBy(delta) {
  const id = selectedId();
  if (!id) return admission(false);
  const current = await Navigation.getZoom({ astra_tab_id: id });
  const from = typeof current.zoom === "number" ? current.zoom : 1;
  const next =
    delta === 0
      ? await Zoom.defaultLevel()
      : Math.round((from + delta) * 100) / 100;
  const result = await Navigation.setZoom({ astra_tab_id: id, zoom: next });
  if (result?.error) return admission(false);
  // Persist what the engine applied, not the requested step: a step past the
  // 0.3–3.0 range is clamped by the model and must not store 2.0/3.1.
  const applied =
    typeof result.zoom === "number" && Number.isFinite(result.zoom)
      ? result.zoom
      : next;
  // The engine stores a site's level in the content-pref service; the model
  // alone would forget it on the next launch. A private tab never writes.
  // Reset removes the site's override (100% is "no own level"), even when the
  // level it falls back to is a non-100% default.
  const tab = __tabsState().tabs.get(id);
  await Zoom.persist({
    url: tab?.url ?? "",
    zoom: delta === 0 ? 1 : applied,
    private: tab?.private === true,
  });
  return admission(true);
}

/**
 * The address `nav.home` lands on. The Settings choice (`tabs.home`) wins;
 * otherwise the first startup page (`browser.startup.homepage`) is the home
 * page, as it is in Firefox's own BrowserHome. With neither, Astra's New Tab
 * is the page in front: `about:blank` is the stage's New Tab, while
 * `about:home`/`about:newtab` would be treated as search words.
 */
function homeUrl() {
  const custom = Settings.current("tabs.home");
  const chosen = typeof custom === "string" ? custom.trim() : "";
  if (chosen !== "") {
    return chosen === "about:home" || chosen === "about:newtab"
      ? "about:blank"
      : chosen;
  }
  const pages = Settings.current("tabs.startup-pages");
  const first =
    typeof pages === "string"
      ? pages
          .split("\n")
          .map((page) => page.trim())
          .find(Boolean)
      : "";
  return first === undefined || first === "" ? "about:blank" : first;
}

async function goHome() {
  const id = selectedId();
  if (!id) return admission(false);
  const result = await Navigation.loadURL({ astra_tab_id: id, url: homeUrl() });
  return admission(!result?.error);
}

export const Commands = {
  /**
   * Run one command by id. Page commands are synchronous state changes: the
   * surface event is emitted before the admission returns, so the app can
   * never paint a page native did not agree to.
   */
  async run({ id = "" } = {}) {
    if (typeof id !== "string" || id === "") {
      return admission(false);
    }
    // Keymap alternates share one command: `.alt`, `.alt2`, … are the same
    // action as the base id. The shell remaps a few of these; normalising
    // here covers all of them (Ctrl+F5, Shift+F5, F5, ...).
    id = id.replace(/\.alt\d*$/u, "");
    if (id === "") {
      return admission(false);
    }
    // Leaving a browser surface returns the window to the tab it was over.
    if (id === "browser.return") {
      emit("ui-command", "browser.return");
      return admission(true);
    }
    const page = id.startsWith("browser.") ? id.slice("browser.".length) : "";
    if (PAGES.has(page)) {
      emit("ui-command", id);
      return admission(true);
    }
    // A tool is a panel beside the page, not a page: the shelf and a shortcut
    // open the same one.
    const tool = id.startsWith("tool.") ? id.slice("tool.".length) : "";
    if (TOOLS.has(tool)) {
      emit("ui-command", id);
      return admission(true);
    }
    // A note starts where notes already are, which is the app's decision, not
    // this module's: announce it and let the surface place it.
    if (id === "note.new") {
      emit("ui-command", id);
      return admission(true);
    }
    // Settings lands on the section that asked for it: name the section first
    // so the page is built with it, then give the window the page.
    if (id.startsWith("settings.section.")) {
      const section = id.slice("settings.section.".length);
      if (!SECTIONS.has(section)) return admission(false);
      emit("ui-command", id);
      emit("ui-command", "browser.settings");
      return admission(true);
    }
    const section = id.startsWith("settings.") ? id.slice("settings.".length) : "";
    if (SECTIONS.has(section)) {
      emit("ui-command", `settings.section.${section}`);
      emit("ui-command", "browser.settings");
      return admission(true);
    }

    // --- The keyboard's own commands -------------------------------------
    if (SHELL_ACTIONS.has(id) || APP_ACTIONS.has(id)) {
      emit("ui-command", id);
      return admission(true);
    }
    switch (id) {
      case "tab.new":
        await Tabs.create({ url: "about:blank" });
        return admission(true);
      case "tab.close": {
        const current = selectedId();
        if (!current) return admission(false);
        const out = await Tabs.close({ astra_tab_id: current });
        return admission(out.closed !== false);
      }
      case "tab.next":
        return stepTab(1);
      case "tab.previous":
        return stepTab(-1);
      case "tab.above":
        return stepTab(-1);
      case "tab.below":
        return stepTab(1);
      case "tab.select.last":
        return selectTabAt(-1);
      case "nav.back":
        return tabNavigation("goBack");
      case "nav.forward":
        return tabNavigation("goForward");
      case "nav.reload":
        return tabNavigation("reload");
      case "nav.hardReload":
        return tabNavigation("hardReload");
      case "nav.home":
        return goHome();
      case "nav.stop":
        return tabNavigation("stop");
      case "zoom.in":
        return zoomBy(0.1);
      case "zoom.out":
        return zoomBy(-0.1);
      case "zoom.reset":
        return zoomBy(0);
      case "space.next":
        return stepSpace(1);
      case "space.previous":
        return stepSpace(-1);
      default:
        break;
    }
    const tabMatch = /^tab\.select\.(\d+)$/u.exec(id);
    if (tabMatch) return selectTabAt(Number(tabMatch[1]) - 1);
    const spaceMatch = /^space\.select\.(\d+)$/u.exec(id);
    if (spaceMatch) {
      const space = __itemsSnapshot().spaces[Number(spaceMatch[1]) - 1];
      if (!space) return admission(false);
      const out = await Tabs.switchSpace({ space: space.id });
      return admission(out.accepted === true);
    }
    return admission(false);
  },

  /** Every id this module currently executes (tests and diagnostics). */
  async supported() {
    return [
      ...[...PAGES].map((page) => `browser.${page}`),
      ...[...TOOLS].map((tool) => `tool.${tool}`),
      ...[...SECTIONS].map((section) => `settings.${section}`),
      ...SHELL_ACTIONS,
      ...APP_ACTIONS,
      "browser.return",
      "note.new",
      "tab.new",
      "tab.close",
      "tab.next",
      "tab.previous",
      "tab.above",
      "tab.below",
      "tab.select.last",
      "nav.back",
      "nav.forward",
      "nav.reload",
      "nav.hardReload",
      "nav.home",
      "nav.stop",
      "zoom.in",
      "zoom.out",
      "zoom.reset",
      "space.next",
      "space.previous",
    ];
  },
};

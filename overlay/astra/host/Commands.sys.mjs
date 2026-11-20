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
import {
  Tabs,
  __itemsSnapshot,
  __tabsState,
  __selectedInWindow,
} from "./Tabs.sys.mjs";
import { Navigation } from "./Navigation.sys.mjs";
import { Settings } from "./Settings.sys.mjs";
import { Zoom } from "./Zoom.sys.mjs";
// The closed-tab stack belongs to the engine, and the engine keys it by
// window: the command has to name the window that pressed the key, not "the
// last window this process focused".
import { __windowIdFor } from "./Windows.sys.mjs";

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
  "page.cut",
  "page.paste",
  "page.devtools",
  "page.devtools.alt",
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
  "launcher.toggle",
  "sidebar.toggleCompact",
  "split.choose",
  "theme.dark",
  "theme.light",
  "theme.system",
  "url.focus",
  "work.dictate",
  "work.pane.close",
]);

/**
 * Commands the keymap advertises that no surface answers yet. They are refused
 * by name rather than by falling off the end of the switch, so a dead shortcut
 * is visible in `supported()`/diagnostics and in the contract test instead of
 * looking like an id nobody registered. Each needs the app route named here
 * before it can move out of this map.
 */
const UNAVAILABLE = new Map([
  // No password picker: passkeys owns sign-in, there is no saved-login sheet.
  ["page.autofillPassword", "no password picker"],
  // Clear Browsing Data has no sheet of its own (site data has one).
  ["settings.clearData", "no clear-data sheet"],
  // Work panes have no "open this pane in Browse" hand-off yet.
  ["work.pane.openInBrowse", "no work pane hand-off"],
]);

/** The chrome's `runCommand` answer: an admission, as `settle()` expects. */
function admission(accepted) {
  return { operation_id: null, accepted };
}

/**
 * An honest refusal. `reason` is diagnostics, not wire: the UI reads
 * `accepted` (through `settle()`), and a surface that wants to explain a
 * refusal hears it on `ui-command` instead.
 */
function refusal(reason) {
  return { operation_id: null, accepted: false, reason };
}

function selectedId(window_id = "") {
  return window_id ? __selectedInWindow(window_id) : __tabsState().selectedId;
}

async function tabIndexInSpace(window_id = "") {
  const list = await Tabs.list({ window_id });
  const tabs = list.tabs ?? [];
  const current = tabs.find(
    (tab) => tab.astra_tab_id === selectedId(window_id),
  );
  if (!current) return null;
  const order = tabs.filter((tab) => tab.space_id === current.space_id);
  return {
    order,
    at: order.findIndex((tab) => tab.astra_tab_id === selectedId(window_id)),
  };
}

async function stepTab(direction, window_id = "") {
  const pos = await tabIndexInSpace(window_id);
  if (!pos || pos.at < 0) return admission(false);
  const next =
    pos.order[(pos.at + direction + pos.order.length) % pos.order.length];
  if (!next) return admission(false);
  await Tabs.select({ astra_tab_id: next.astra_tab_id });
  return admission(true);
}

async function selectTabAt(index, window_id = "") {
  const pos = await tabIndexInSpace(window_id);
  if (!pos) return admission(false);
  const target =
    index === -1 ? pos.order[pos.order.length - 1] : pos.order[index];
  if (!target) return admission(false);
  await Tabs.select({ astra_tab_id: target.astra_tab_id });
  return admission(true);
}

async function stepSpace(direction) {
  const result = await Tabs.stepSpace({ step: direction });
  return admission(result.accepted === true);
}

async function tabNavigation(method, window_id = "") {
  const id = selectedId(window_id);
  if (!id) return admission(false);
  const result = await Navigation[method]({ astra_tab_id: id });
  return admission(!result?.error);
}

async function zoomBy(delta, window_id = "") {
  const id = selectedId(window_id);
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

async function goHome(window_id = "") {
  const id = selectedId(window_id);
  if (!id) return admission(false);
  const result = await Navigation.loadURL({ astra_tab_id: id, url: homeUrl() });
  return admission(!result?.error);
}

// --- Reopening a closed tab ------------------------------------------------
//
// The engine owns the closed-tab stack, per window: it is the same store
// Firefox's own "Reopen Closed Tab" reads, and the only place a closed page
// (URL, history, container) still exists. `HistoryCall` answers
// `closed_tabs: []` and `reopen_closed: unavailable` because it holds no copy
// of that stack, so the command reads the engine's own answer instead of
// presenting a History row that could not reopen anything.

/** Test seam: `{ window, store }` replaces the chrome window and engine store. */
let _reopenForTests = null;

export function __setReopenForTests(engine) {
  _reopenForTests = engine ?? null;
}

let _sessionStore = null;
let _sessionStoreRead = false;

/** Commands state the contract test has to be able to put back. */
export function __resetCommandsForTests() {
  _reopenForTests = null;
  _sessionStore = null;
  _sessionStoreRead = false;
  _launcherToggleAt = 0;
}

/** The engine's SessionStore, or null outside chrome. Read once, lazily. */
function sessionStore() {
  if (_reopenForTests) return _reopenForTests.store ?? null;
  if (_sessionStoreRead) return _sessionStore;
  _sessionStoreRead = true;
  try {
    const CU = globalThis.ChromeUtils;
    _sessionStore =
      CU?.importESModule?.(
        "resource:///modules/sessionstore/SessionStore.sys.mjs",
      )?.SessionStore ?? null;
  } catch {
    _sessionStore = null;
  }
  return _sessionStore;
}

/**
 * The chrome window `window_id` names, or null. A command runs in the window
 * that sent it, so the id is the authority; "the focused window" is only the
 * fallback for a caller that has no id (a direct diagnostic call).
 */
function chromeWindow(window_id = "") {
  if (_reopenForTests) return _reopenForTests.window ?? null;
  let services = null;
  try {
    services = globalThis.Services ?? null;
  } catch {
    services = null;
  }
  if (!services?.wm?.getEnumerator) return null;
  let windows = null;
  try {
    windows = services.wm.getEnumerator("navigator:browser");
  } catch {
    return null;
  }
  let first = null;
  while (windows.hasMoreElements()) {
    let win = null;
    try {
      win = windows.getNext();
    } catch {
      break;
    }
    if (!win || win.closed === true) continue;
    if (!first) first = win;
    if (window_id !== "" && __windowIdFor(win) === window_id) return win;
  }
  // An id nobody bound is not an invitation to guess another window.
  if (window_id !== "") return null;
  try {
    return services.wm.getMostRecentWindow("navigator:browser") ?? first;
  } catch {
    return first;
  }
}

/** How many tabs the engine would let this window bring back. */
function closedTabCount(store, win) {
  if (!store) return 0;
  try {
    const count =
      typeof store.getClosedTabCountForWindow === "function"
        ? store.getClosedTabCountForWindow(win)
        : typeof store.getClosedTabCount === "function"
          ? store.getClosedTabCount(win)
          : 0;
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    // An untracked window has no stack; the engine throws for it.
    return 0;
  }
}

/**
 * Reopen the most recently closed tab in the calling window. Nothing to
 * reopen is a refusal, never a pretend success: the sidebar only moves when
 * the engine really restored a tab.
 */
async function reopenClosedTab(window_id = "") {
  const win = chromeWindow(window_id);
  if (!win) return refusal("unavailable");
  const store = sessionStore();
  if (closedTabCount(store, win) <= 0) return refusal("empty");
  try {
    // Source and target are the same window: a reopen belongs where the key
    // was pressed, never in whichever window the engine calls topmost.
    const tab = store.undoCloseTab(win, 0, win);
    if (!tab) return refusal("refused");
  } catch {
    // SessionStore throws for an index it no longer has (another window took
    // the last closed tab first); that is not a reopen.
    return refusal("refused");
  }
  // The engine announces the restored tab through `TabOpen`, which the content
  // stage adopts into the model, so the projection follows without a second
  // write here.
  return admission(true);
}

// --- The launcher ----------------------------------------------------------
//
// One press can arrive twice: the core registers the launcher as an OS hotkey
// and the chrome's own key handler also matches it while this window is in
// front. Toggling twice closes what the first press just opened, so a second
// delivery within one press is coalesced.
const LAUNCHER_TOGGLE_MS = 120;
let _launcherToggleAt = 0;

function launcherToggle() {
  const now = Date.now();
  if (now - _launcherToggleAt < LAUNCHER_TOGGLE_MS) {
    // The press was handled by the first delivery.
    return admission(true);
  }
  _launcherToggleAt = now;
  emit("ui-command", "launcher.toggle");
  return admission(true);
}

export const Commands = {
  /**
   * Run one command by id. Page commands are synchronous state changes: the
   * surface event is emitted before the admission returns, so the app can
   * never paint a page native did not agree to.
   */
  async run({ id = "", window_id = "" } = {}) {
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
    const section = id.startsWith("settings.")
      ? id.slice("settings.".length)
      : "";
    if (SECTIONS.has(section)) {
      emit("ui-command", `settings.section.${section}`);
      emit("ui-command", "browser.settings");
      return admission(true);
    }

    // --- The keyboard's own commands -------------------------------------
    // An advertised command with no surface behind it is refused by name, so
    // a dead shortcut never looks like a command that simply did nothing.
    if (UNAVAILABLE.has(id)) return refusal("unavailable");
    // The launcher's key is a real toggle, not a one-way announce: a press
    // that arrives from both the OS hotkey and this window must not cancel
    // itself out.
    if (id === "launcher.toggle") return launcherToggle();
    if (SHELL_ACTIONS.has(id) || APP_ACTIONS.has(id)) {
      emit("ui-command", id);
      return admission(true);
    }
    switch (id) {
      case "tab.new":
        await Tabs.create({ url: "about:blank" });
        return admission(true);
      case "tab.close": {
        const current = selectedId(window_id);
        if (!current) return admission(false);
        const out = await Tabs.close({ astra_tab_id: current });
        return admission(out.closed !== false);
      }
      // The engine's own closed-tab stack, for the window that asked.
      case "tab.reopen":
        return reopenClosedTab(window_id);
      // The menu's Duplicate: the same host route the sidebar already had,
      // reached through the command id so no new binding is needed.
      case "tab.duplicate": {
        const current = selectedId(window_id);
        if (!current) return refusal("no_tab");
        const out = await Tabs.duplicate({ astra_tab_id: current });
        return out?.error ? refusal("refused") : admission(true);
      }
      case "page.print":
        // Firefox's print preview is native UI (D-38), and the product has no
        // print sheet yet. The press is refused, and the reason is announced
        // for the app to show as a notice (`notice.print-unavailable`); the
        // shortcut is never answered by silently opening the engine's window.
        emit("ui-command", "notice.print-unavailable");
        return refusal("unavailable");
      case "tab.next":
        return stepTab(1, window_id);
      case "tab.previous":
        return stepTab(-1, window_id);
      case "tab.above":
        return stepTab(-1, window_id);
      case "tab.below":
        return stepTab(1, window_id);
      case "tab.select.last":
        return selectTabAt(-1, window_id);
      case "nav.back":
        return tabNavigation("goBack", window_id);
      case "nav.forward":
        return tabNavigation("goForward", window_id);
      case "nav.reload":
        return tabNavigation("reload", window_id);
      case "nav.hardReload":
        return tabNavigation("hardReload", window_id);
      case "nav.home":
        return goHome(window_id);
      case "nav.stop":
        return tabNavigation("stop", window_id);
      case "zoom.in":
        return zoomBy(0.1, window_id);
      case "zoom.out":
        return zoomBy(-0.1, window_id);
      case "zoom.reset":
        return zoomBy(0, window_id);
      case "space.next":
        return stepSpace(1);
      case "space.previous":
        return stepSpace(-1);
      default:
        break;
    }
    const tabMatch = /^tab\.select\.(\d+)$/u.exec(id);
    if (tabMatch) return selectTabAt(Number(tabMatch[1]) - 1, window_id);
    const spaceMatch = /^space\.select\.(\d+)$/u.exec(id);
    if (spaceMatch) {
      const space = __itemsSnapshot().spaces[Number(spaceMatch[1]) - 1];
      if (!space) return admission(false);
      const out = await Tabs.switchSpace({ space: space.id });
      return admission(out.accepted === true);
    }
    // Nothing matched: say so with a reason. A keymap id that reaches this
    // line is a wiring gap, which the contract test keeps visible.
    return refusal("unknown");
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
      "tab.reopen",
      "tab.duplicate",
      "tab.next",
      "tab.previous",
      "tab.above",
      "tab.below",
      "tab.select.last",
      ...Array.from({ length: 9 }, (_unused, index) => `tab.select.${index + 1}`),
      ...Array.from({ length: 9 }, (_unused, index) => `space.select.${index + 1}`),
      "page.print",
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

  /** Advertised commands this module answers with an explicit refusal. */
  async unavailable() {
    return [...UNAVAILABLE.keys()];
  },
};

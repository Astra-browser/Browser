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
// Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";

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


/** The chrome's `runCommand` answer: an admission, as `settle()` expects. */
function admission(accepted) {
  return { operation_id: null, accepted };
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
    return admission(false);
  },

  /** Every id this module currently executes (tests and diagnostics). */
  async supported() {
    return [
      ...[...PAGES].map((page) => `browser.${page}`),
      ...[...TOOLS].map((tool) => `tool.${tool}`),
      ...[...SECTIONS].map((section) => `settings.${section}`),
      "browser.return",
      "note.new",
    ];
  },
};

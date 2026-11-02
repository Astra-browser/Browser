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
    return admission(false);
  },

  /** Every id this module currently executes (tests and diagnostics). */
  async supported() {
    return [...PAGES].map((page) => `browser.${page}`).concat("browser.return");
  },
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API System module (v1, wiring). The small "about this machine, about
// this browser" reads: About's build facts, the OS clock's hour cycle, the
// updater's state, whether Astra is the default browser, whether it launches
// at login, and the UI's material discovery at boot.
//
// Each of these is a claim about the machine the person is sitting at, so an
// answer here is either a fact this process can read locally or an honest
// "not known" in the shape the wire already allows. Nothing is inferred from
// a preference, a build file or a plausible-looking default.
//
// What this module will and will not say:
// - `system_clock_24h` reads `Intl.DateTimeFormat().resolvedOptions()`, the
//   same hour cycle the OS hands this process, and maps it to the wire's
//   boolean. A runtime that reports neither `hourCycle` nor `hour12` answers
//   `null`, and the page keeps its language's own cycle.
// - `ui_info` answers `material: "none"`. No native window material has been
//   discovered, and `none` is the documented opaque tier the bootstrap
//   document already paints; a tier is announced only once native finds it
//   (`material.*` on `ui-command`), never guessed from the platform.
// - `about_info` answers `null`. The app's version, the OS product version
//   and the arch are the bundle's facts; nothing in this tree holds them yet,
//   and a placeholder version would be read on About as the real one.
// - `update_status` and `update_check` answer `{ state: "unavailable" }`: no
//   updater is connected, so nothing is checked, downloaded or installed and
//   no version is named. `update_check` is advisory — it starts nothing and
//   never answers `checking` or `ready` for work it did not do.
// - `default_browser_status` answers `null`. Whether Astra is the default
//   browser is the system's answer, and neither yes nor no can be read from
//   here.
// - `login_item_status` answers `supported: false`, with `enabled` and
//   `needs_approval` false: this build cannot register a login item, and
//   General settings hides the row on `supported: false` rather than showing
//   a switch that could not do anything.
//
// Pure logic, no Firefox internals, no Events import: nothing here changes
// state, so there is no event to announce. `ui_info` lives here because Boot
// answers the handshake only; it never answers `ui_info`.

/** `Material`'s opaque tier: no native effect is behind the window. */
const MATERIAL_NONE = "none";

/** The resolved hour cycles that mean a 24-hour clock, and the two that do
 *  not. Anything else (a runtime reporting neither) stays unknown. */
const HOUR_24 = { h11: true, h23: true, h12: false, h24: false };

/** The hour cycle this process resolved, or null where it named none. */
function localHourCycle() {
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    if (resolved && typeof resolved.hourCycle === "string") {
      return resolved.hourCycle;
    }
    // Older runtimes report the boolean form instead of the cycle's name.
    if (resolved && typeof resolved.hour12 === "boolean") {
      return resolved.hour12 ? "h12" : "h23";
    }
  } catch {
    // No readable clock format: the page keeps its language's own cycle.
  }
  return null;
}

/** The updater's state where no updater is connected. Fresh each call, so a
 *  caller cannot hold a handle on the host's answer. */
function noUpdater() {
  return { state: "unavailable" };
}

export const System = {
  // `AboutInfo | null`: no version, OS product name or arch is known here.
  async aboutInfo() {
    return null;
  },

  // `boolean | null`: the OS clock's own hour cycle, as this process sees it.
  async systemClock24h() {
    const cycle = localHourCycle();
    return Object.hasOwn(HOUR_24, cycle) ? HOUR_24[cycle] : null;
  },

  // `UpdateStatus | null`: nothing to report, because nothing is connected.
  async updateStatus() {
    return noUpdater();
  },

  // `UpdateStatus | null`: a check is advisory. It starts nothing and reports
  // the same state as `updateStatus`, rather than a `checking` that would
  // never finish.
  async updateCheck() {
    return noUpdater();
  },

  // `DefaultBrowserStatus | null`: not known, so neither claim is made.
  async defaultBrowserStatus() {
    return null;
  },

  // `LoginItemStatus`: this build cannot register one, so the row is hidden.
  async loginItemStatus() {
    return { supported: false, enabled: false, needs_approval: false };
  },

  // `UiInfo`: the material axis' opaque tier, which the UI already paints
  // before native discovery. Never a tier nothing has discovered.
  async uiInfo() {
    return { material: MATERIAL_NONE };
  },
};

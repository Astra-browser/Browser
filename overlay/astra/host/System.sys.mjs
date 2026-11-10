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
// - `ui_info` answers the material tier this build can actually put behind
//   the window, plus the tiers it can offer. The window material is a
//   platform capability, never a preference: Windows can install Mica through
//   the widget's own `widget.windows.mica` switch (the chrome root already
//   carries `windowsmica="true"`, and the widget reads the pref live). Linux
//   has no native glass API, so only the opaque `none` tier is offered there.
//   macOS also offers `none`: the engine's vibrancy (`NSVisualEffectView`
//   behind `-moz-mac-vibrant-titlebar-*`) and macOS 26 glass
//   (`NSGlassEffectView`) are applied to native menus and titlebars by the
//   widget, and this build exposes no JS switch for a whole web-chrome
//   window. A tier is therefore never announced for a platform that cannot
//   draw it. `ui_info` applies the resolved native tier as it reads it, so the
//   boot answer and the window agree.
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
// - `set_content_color_scheme` maps the app's light/dark/system choice onto
//   Firefox's `layout.css.prefers-color-scheme.content-override` pref
//   (1/0/2). Content reads that mirrored pref, so a page's
//   `prefers-color-scheme` follows the chrome's theme instead of the OS.
//
// `set_content_color_scheme` reaches the chrome window's `Services.prefs` and
// answers `{ applied: false }` outside chrome (a Node test or preview) instead
// of throwing. No Events import: the app already knows the theme it chose, so
// there is no event to announce. `ui_info` lives here because Boot answers the
// handshake only; it never answers `ui_info`. It is the second chrome write:
// resolving the material also sets the platform's own switch on Windows.

import { Settings } from "./Settings.sys.mjs";

/** `Material`'s opaque tier: no native effect is behind the window. */
const MATERIAL_NONE = "none";

/** Windows installs Mica through the widget's own switch. */
const WINDOWS_MICA_PREF = "widget.windows.mica";

/** Mica exists from Windows 11 22H2 (build 22621) on. Below it the DWM call
 *  is accepted but draws nothing, so it is not offered. */
const MICA_MIN_BUILD = 22621;

/** Test-only platform/pref seams (Node has neither Services nor a window). */
let injectedPlatform = null;
let injectedPrefs = null;

export function __setPlatformForTests(platform) {
  injectedPlatform = platform ?? null;
}

export function __setSystemPrefsForTests(prefs) {
  injectedPrefs = prefs ?? null;
}

export function __resetSystemForTests() {
  injectedPlatform = null;
  injectedPrefs = null;
}

/** The running OS and its build, or empty strings outside chrome. */
function platformInfo() {
  if (injectedPlatform) {
    return {
      os: String(injectedPlatform.os ?? ""),
      build: String(injectedPlatform.build ?? ""),
    };
  }
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      const services = scope?.Services;
      if (!services?.appinfo) continue;
      return {
        os: String(services.appinfo.OS ?? ""),
        build: String(services.sysinfo?.getProperty?.("build") ?? ""),
      };
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return { os: "", build: "" };
}

/** The chrome `Services`, or null outside a chrome process. */
function servicesForUse() {
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      if (scope?.Services?.appinfo) return scope.Services;
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

/** Where the profile's own logs live, or the profile directory itself. */
function logsDirectory(services) {
  try {
    const file = services.dirsvc.get("ProfD", globalThis.Ci?.nsIFile);
    const logs = file.clone();
    logs.append("astra");
    logs.append("logs");
    return logs.exists() ? logs : file;
  } catch {
    return null;
  }
}

/** Hide the home path in a report that may be pasted into a bug. */
function redactPath(services, text) {
  try {
    const home = services.dirsvc.get("Home", globalThis.Ci?.nsIFile).path;
    if (home && typeof text === "string") return text.split(home).join("~");
  } catch {
    // No home directory: the path stays as the profile reports it.
  }
  return text;
}

/** The chrome window's `Services.prefs`, or null outside a chrome process. */
function systemPrefs() {
  if (injectedPrefs) return injectedPrefs;
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      const prefs = scope?.Services?.prefs;
      if (prefs && typeof prefs.setBoolPref === "function") return prefs;
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

/**
 * The material tiers this build can draw on this machine, and what
 * `auto` resolves to. `none` is always available: it is what the bootstrap
 * document paints before any discovery.
 */
function materialCapability() {
  const { os, build } = platformInfo();
  const system = os.toLowerCase();
  if (system === "winnt") {
    // `build` is the release build number on Windows ("22631"), but be
    // tolerant of a dotted form: the last group is the build.
    const groups = String(build).match(/\d+/gu) ?? [];
    const number = groups.length > 0 ? Number(groups[groups.length - 1]) : NaN;
    if (Number.isFinite(number) && number >= MICA_MIN_BUILD) {
      return { os: system, available: ["none", "mica"], automatic: "mica" };
    }
  }
  return { os: system, available: [MATERIAL_NONE], automatic: MATERIAL_NONE };
}

/**
 * The tier a stored choice resolves to: `auto` means the platform's best,
 * an unsupported tier falls back to the opaque one, and the answer always
 * names the tiers the picker may offer.
 */
function resolveMaterial(choice) {
  const capability = materialCapability();
  const picked =
    choice === "auto" || choice === null || choice === undefined
      ? capability.automatic
      : String(choice);
  const material = capability.available.includes(picked)
    ? picked
    : MATERIAL_NONE;
  return { material, materials: capability.available, capability };
}

/** Put the resolved tier behind the window where the platform has a switch. */
function applyMaterial(material, capability) {
  if (capability.os !== "winnt" || !capability.available.includes("mica")) {
    return;
  }
  try {
    systemPrefs()?.setBoolPref(WINDOWS_MICA_PREF, material === "mica");
  } catch {
    // No pref service: the UI still reports the tier it can draw.
  }
}

/** The resolved hour cycles that mean a 24-hour clock, and the two that do
 *  not. Anything else (a runtime reporting neither) stays unknown. */
const HOUR_24 = { h11: true, h23: true, h12: false, h24: false };

/** Firefox reads a content document's `prefers-color-scheme` from this pref:
 *  0 = dark, 1 = light, 2 = follow the system. It is mirrored to content
 *  (`mirror: always`), so a chrome write reaches the pages already open. */
const CONTENT_COLOR_SCHEME_PREF =
  "layout.css.prefers-color-scheme.content-override";

/** Test-only pref writer, wired by a contract test with no chrome window. */
let contentPrefWriter = null;

export function __setContentPrefForTests(fn) {
  contentPrefWriter = typeof fn === "function" ? fn : null;
}

/** The chrome window's `Services.prefs`, or null outside a chrome process.
 *  Read per call: a Node import has no chrome global at all. */
function contentPrefs() {
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) {
      scopes.push(view);
    }
    for (const scope of scopes) {
      const prefs = scope?.Services?.prefs;
      if (prefs && typeof prefs.setIntPref === "function") {
        return prefs;
      }
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

/** A safe field read: a hostile getter answers "absent", never throws. */
function field(payload, name) {
  try {
    return payload?.[name];
  } catch {
    return undefined;
  }
}

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

  /**
   * The real, redacted diagnostics text About copies or shows. Everything is
   * read from this process or its profile; nothing is inferred and nothing
   * leaves the machine. `null` outside chrome, which the page renders as its
   * retry state instead of an empty report.
   */
  async diagnosticsReport() {
    const services = servicesForUse();
    if (!services) return null;
    try {
      const app = services.appinfo ?? {};
      const prefs = services.prefs;
      let lists = 0;
      try {
        const raw = prefs?.getStringPref("astra.blocker.installed", "{}") ?? "{}";
        const parsed = JSON.parse(raw);
        const source = parsed?.lists ?? parsed;
        if (source && typeof source === "object") lists = Object.keys(source).length;
      } catch {
        lists = 0;
      }
      const logs = logsDirectory(services);
      const lines = [
        "Astra diagnostics",
        `Generated: ${new Date().toISOString()}`,
        `Astra: ${String(app.version ?? "unknown")} (${String(app.buildID ?? "unknown")})`,
        `Platform: ${String(app.OS ?? "")} ${String(app.XPCOMABI ?? "")}`.trim(),
        `System build: ${String(services.sysinfo?.getProperty?.("build") ?? "unknown")}`,
        `Locale: ${String(services.locale?.appLocales?.[0] ?? "unknown")}`,
        `Profile: ${String(services.dirsvc?.get?.("ProfD", globalThis.Ci?.nsIFile)?.path ?? "unknown")}`,
        `Logs: ${String(logs?.path ?? "unknown")}`,
        `Theme: ${String(Settings.current("appearance") ?? "unknown")}`,
        `Default zoom: ${String(Settings.current("zoom.default") ?? "100")}%`,
        `Inactive tab sleeping: ${String(Settings.current("performance.sleep") ?? "unknown")}`,
        `Blocker lists installed: ${lists}`,
      ];
      return redactPath(services, lines.join("\n"));
    } catch {
      return null;
    }
  },

  /** Reveal the profile's log folder; false when no folder is reachable. */
  async diagnosticsShowLogs() {
    const services = servicesForUse();
    const directory = services ? logsDirectory(services) : null;
    if (!directory) return false;
    try {
      directory.reveal();
      return true;
    } catch {
      return false;
    }
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

  /**
   * Mirror the app's theme into content `prefers-color-scheme`: `light:
   * true` is light, `false` dark, `null` (or absent) follows the system.
   * Answers `{ applied: true, value }` with the pref's integer, or
   * `{ applied: false }` where no chrome `Services.prefs` is reachable.
   * The app already knows the theme it chose, so nothing is announced.
   */
  async setContentColorScheme(payload = {}) {
    const light = field(payload, "light");
    let value;
    if (light === true) {
      value = 1;
    } else if (light === false) {
      value = 0;
    } else if (light === undefined || light === null) {
      value = 2;
    } else {
      return { error: { code: "invalid_light" } };
    }
    let write = contentPrefWriter;
    if (!write) {
      const prefs = contentPrefs();
      if (prefs) {
        write = (name, int) => prefs.setIntPref(name, int);
      }
    }
    if (!write) {
      return { applied: false };
    }
    try {
      write(CONTENT_COLOR_SCHEME_PREF, value);
    } catch {
      return { applied: false };
    }
    return { applied: true, value };
  },

  // `UiInfo`: the tier this build can actually draw, and the tiers the picker
  // may offer. Reading also puts the resolved tier behind the window where the
  // platform has a switch, so the boot answer and the chrome agree.
  async uiInfo() {
    const stored = Settings.current("ui.material");
    const resolved = resolveMaterial(
      typeof stored === "string" && stored !== "" ? stored : "auto",
    );
    applyMaterial(resolved.material, resolved.capability);
    return { material: resolved.material, materials: resolved.materials };
  },
};

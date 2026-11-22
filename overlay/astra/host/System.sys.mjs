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
// - `about_info` answers Astra's own product version, the OS product string
//   the engine reports and the CPU arch. The version is the pref the branding
//   renderer writes from `branding/astra.toml` (never the Firefox pin), and
//   any of the three facts missing answers `null` â€” About shows nothing rather
//   than a placeholder version it would be read as real.
// - `update_status` and `update_check` answer `{ state: "unavailable" }`: no
//   updater is connected, so nothing is checked, downloaded or installed and
//   no version is named. `update_check` is advisory â€” it starts nothing and
//   never answers `checking` or `ready` for work it did not do.
// - `default_browser_status` reads Windows' own `UserChoice` ProgId. Astra is
//   the default only when that value names Astra's `AstraURL`. On other
//   platforms it answers `null`, so neither yes nor no is claimed. The request
//   opens Windows Settings; Windows owns the final choice and the answer is
//   read back, never assumed.
// - `login_item_status` reads and writes the per-user Windows `Run` value.
//   Other platforms answer `supported: false` so General hides the row.
// - `windows_reputation_managed` reads the SmartScreen policy values; without
//   the registry it answers `null`, which the Settings card renders as its
//   launch fallback. `windows_diagnostics_settings` opens Windows' feedback
//   page and answers whether the system accepted the request.
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

/** Windows registry paths this module reads. */
const USER_CHOICE_HTTP =
  "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice";
const RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "Astra";
const SMARTSCREEN_POLICY_PATHS = [
  ["HKLM", "Software\\Policies\\Microsoft\\Windows\\System"],
  ["HKCU", "Software\\Policies\\Microsoft\\Windows\\System"],
  ["HKLM", "Software\\Policies\\Microsoft\\Windows\\Defender\\SmartScreen"],
  ["HKCU", "Software\\Policies\\Microsoft\\Windows\\Defender\\SmartScreen"],
];
const SMARTSCREEN_POLICY_VALUES = [
  "EnableSmartScreen",
  "ShellSmartScreenLevel",
  "ConfigureAppInstallControlEnabled",
];
const ASTRA_PROGID = "astraurl";
/** Where About sends a person when an update reports a manual download. */
const UPDATE_PAGE = "https://gitlab.com/kyoiske/astra/-/releases";

/** Test-only platform/pref/registry seams (Node has neither Services nor a
 *  window). */
let injectedPlatform = null;
let injectedPrefs = null;
let injectedWindows = null;

export function __setPlatformForTests(platform) {
  injectedPlatform = platform ?? null;
}

export function __setSystemPrefsForTests(prefs) {
  injectedPrefs = prefs ?? null;
}

/** Replace the Windows registry/settings bridge in Node contract tests. */
export function __setWindowsForTests(windows) {
  injectedWindows = windows ?? null;
}

export function __resetSystemForTests() {
  injectedPlatform = null;
  injectedPrefs = null;
  injectedWindows = null;
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

/** Astra's own product version, as the shipped pref names it. `null` when the
 *  build carries no version: About must not read an invented number. */
function astraVersion(services) {
  try {
    const version = services.prefs?.getStringPref?.("astra.version", "");
    return typeof version === "string" && version.trim() !== ""
      ? version.trim()
      : null;
  } catch {
    return null;
  }
}

/** The OS product string this process can read (name + version), or "". */
function osProduct(services) {
  try {
    const name = services.sysinfo?.getProperty?.("name") ?? "";
    const version = services.sysinfo?.getProperty?.("version") ?? "";
    return [name, version]
      .map((part) => String(part).trim())
      .filter((part) => part !== "")
      .join(" ");
  } catch {
    return "";
  }
}

/** The CPU half of the engine's ABI string (`x86_64-gcc3` -> `x86_64`). */
function archName(services) {
  try {
    const abi = String(services.appinfo?.XPCOMABI ?? "");
    return abi.split("-")[0].trim();
  } catch {
    return "";
  }
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

/** The registry hive constant for a path written as "HKCU" or "HKLM". */
function registryRoot(root) {
  const Ci = globalThis.Ci;
  return root === "HKLM"
    ? Ci.nsIWindowsRegKey.ROOT_KEY_LOCAL_MACHINE
    : Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER;
}

/** Open Windows' own Settings page for a URI. Explorer is the system's own
 *  handler for `ms-settings:`; the answer is only "the launch was accepted". */
function openWindowsSettings(uri) {
  try {
    const { Cc, Ci } = globalThis;
    const env = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment,
    );
    const winDir = env.get("WINDIR");
    if (!winDir) return false;
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(winDir);
    file.append("explorer.exe");
    if (!file.exists()) return false;
    const process = Cc["@mozilla.org/process/util;1"].createInstance(
      Ci.nsIProcess,
    );
    process.init(file);
    const args = [uri];
    process.run(false, args, args.length);
    return true;
  } catch {
    return false;
  }
}

/** The real Windows registry/settings bridge. */
function createWindowsBridge(services) {
  const { Cc, Ci } = globalThis;
  const service = () =>
    Cc["@mozilla.org/windows-registry-key;1"].createInstance(
      Ci.nsIWindowsRegKey,
    );

  function withKey(root, path, access, body) {
    let key = null;
    try {
      key = service();
      if (access === Ci.nsIWindowsRegKey.ACCESS_ALL) {
        key.create(registryRoot(root), path, access);
      } else {
        key.open(registryRoot(root), path, access);
      }
      return body(key);
    } catch {
      return null;
    } finally {
      try {
        key?.close();
      } catch {
        // A key that never opened has nothing to close.
      }
    }
  }

  return {
    readString(root, path, name) {
      return withKey(root, path, Ci.nsIWindowsRegKey.ACCESS_READ, (key) =>
        key.hasValue(name) ? key.readStringValue(name) : null,
      );
    },
    readInt(root, path, name) {
      return withKey(root, path, Ci.nsIWindowsRegKey.ACCESS_READ, (key) =>
        key.hasValue(name) ? key.readIntValue(name) : null,
      );
    },
    exists(root, path) {
      return (
        withKey(root, path, Ci.nsIWindowsRegKey.ACCESS_READ, () => true) ===
        true
      );
    },
    writeString(root, path, name, value) {
      return (
        withKey(root, path, Ci.nsIWindowsRegKey.ACCESS_ALL, (key) => {
          key.writeStringValue(name, String(value));
          return true;
        }) === true
      );
    },
    removeValue(root, path, name) {
      return (
        withKey(root, path, Ci.nsIWindowsRegKey.ACCESS_ALL, (key) => {
          if (key.hasValue(name)) key.removeValue(name);
          return true;
        }) === true
      );
    },
    removeKey(root, path) {
      const split = path.lastIndexOf("\\");
      if (split <= 0) return false;
      const parent = path.slice(0, split);
      const leaf = path.slice(split + 1);
      return (
        withKey(root, parent, Ci.nsIWindowsRegKey.ACCESS_ALL, (key) => {
          if (key.hasChild(leaf)) key.removeChild(leaf);
          return true;
        }) === true
      );
    },
    packaged() {
      try {
        const exe = services.dirsvc.get("XREExeF", Ci.nsIFile).path;
        return !/[\\/]obj-[^\\/]+[\\/]/u.test(exe);
      } catch {
        return false;
      }
    },
    exePath() {
      try {
        return services.dirsvc.get("XREExeF", Ci.nsIFile).path;
      } catch {
        return null;
      }
    },
    profilePath() {
      try {
        return services.dirsvc.get("ProfD", Ci.nsIFile).path;
      } catch {
        return null;
      }
    },
    openSettings(uri) {
      return openWindowsSettings(uri);
    },
  };
}

/** The Windows bridge, a test double, or null on a platform without one. */
function windowsForUse() {
  if (injectedWindows) return injectedWindows;
  const services = servicesForUse();
  if (!services) return null;
  const os = String(services.appinfo?.OS ?? "").toLowerCase();
  if (os !== "winnt") return null;
  try {
    return createWindowsBridge(services);
  } catch {
    return null;
  }
}

/** Read Windows' default-browser answer from `UserChoice`. */
function defaultBrowserFor(windows) {
  const progId = windows.readString("HKCU", USER_CHOICE_HTTP, "ProgId");
  return {
    is_default:
      typeof progId === "string" &&
      progId.trim().toLowerCase() === ASTRA_PROGID,
    can_request: windows.packaged() === true,
  };
}

/** Read the per-user login item's current state. */
function loginItemFor(windows) {
  if (windows.packaged() !== true) {
    return { supported: false, enabled: false, needs_approval: false };
  }
  const command = windows.readString("HKCU", RUN_KEY, RUN_VALUE);
  return {
    supported: true,
    enabled: typeof command === "string" && command.trim() !== "",
    needs_approval: false,
  };
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
    // `build` is the release build number on Windows ("22631"), but a dotted
    // form ("22631.4890") puts the revision last: the first group is the
    // build that decides whether Mica exists.
    const groups = String(build).match(/\d+/gu) ?? [];
    const number = groups.length > 0 ? Number(groups[0]) : NaN;
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
  // `AboutInfo | null`: Astra's own version plus the OS and arch this process
  // can read. Any fact missing is `null`: About shows nothing rather than a
  // version the person would take as the build's.
  async aboutInfo() {
    const services = servicesForUse();
    if (!services) return null;
    const version = astraVersion(services);
    const os = osProduct(services);
    const arch = archName(services);
    if (!version || !os || !arch) return null;
    return { version, os, arch };
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
        const raw =
          prefs?.getStringPref("astra.blocker.installed", "{}") ?? "{}";
        const parsed = JSON.parse(raw);
        const source = parsed?.lists ?? parsed;
        if (source && typeof source === "object")
          lists = Object.keys(source).length;
      } catch {
        lists = 0;
      }
      const logs = logsDirectory(services);
      const lines = [
        "Astra diagnostics",
        `Generated: ${new Date().toISOString()}`,
        `Astra: ${astraVersion(services) ?? "unknown"} (build ${String(app.buildID ?? "unknown")})`,
        `Engine: Firefox ${String(app.version ?? "unknown")}`,
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

  /**
   * `UpdateHighlights | null`: what the running release brought. This build
   * ships no updater and no release-note source, so it answers null instead of
   * naming a version it cannot substantiate. The day an updater lands, this
   * reads the parked update's notes.
   */
  async updateHighlights() {
    return null;
  },

  /**
   * `boolean`: install the parked update and relaunch through the orderly
   * shutdown. With no updater connected nothing is parked, so this refuses
   * rather than pretending to restart. It is a real answer, not an error: the
   * UI shows "no update is ready" from `update_status` and never calls this.
   */
  async updateRelaunch() {
    return false;
  },

  /**
   * Opens the release page in a new tab. The About row that asks for it only
   * appears when an update reports a manual download, and this build has no
   * updater, so the call is a guard rather than a common path.
   */
  async openSoftwareUpdate() {
    try {
      const { Search } = await import("./Search.sys.mjs");
      const result = await Search.openUrl({ url: UPDATE_PAGE, new_tab: true });
      return result?.accepted === true;
    } catch {
      return false;
    }
  },

  /**
   * `DefaultBrowserStatus | null`: Windows' own `UserChoice` ProgId decides.
   * `can_request` is false for a development build, which Windows cannot
   * register; `null` on a platform this module cannot read.
   */
  async defaultBrowserStatus() {
    const windows = windowsForUse();
    if (!windows) return null;
    return defaultBrowserFor(windows);
  },

  /** Open Windows' default-apps page; the system owns the final choice. */
  async defaultBrowserRequest() {
    const windows = windowsForUse();
    if (!windows) return null;
    const status = defaultBrowserFor(windows);
    if (status.can_request) windows.openSettings("ms-settings:defaultapps");
    return status;
  },

  /**
   * `LoginItemStatus`: the per-user Windows `Run` value. Other platforms and
   * development builds answer `supported: false`, so General hides the row.
   */
  async loginItemStatus() {
    const windows = windowsForUse();
    if (!windows)
      return { supported: false, enabled: false, needs_approval: false };
    return loginItemFor(windows);
  },

  /** Register or remove the per-user login item, then report what is held. */
  async loginItemSet(payload = {}) {
    const windows = windowsForUse();
    if (!windows)
      return { supported: false, enabled: false, needs_approval: false };
    const enabled = field(payload, "enabled");
    if (enabled === true) {
      const exe = windows.exePath();
      if (exe) {
        const profile = windows.profilePath();
        const command = profile
          ? `"${exe}" -profile "${profile}" -no-remote`
          : `"${exe}"`;
        windows.writeString("HKCU", RUN_KEY, RUN_VALUE, command);
      }
    } else if (enabled === false) {
      windows.removeValue("HKCU", RUN_KEY, RUN_VALUE);
    }
    return loginItemFor(windows);
  },

  /** Open Windows' Startup Apps page, where a disabled entry can be allowed. */
  async loginItemOpenSettings() {
    const windows = windowsForUse();
    if (!windows) return false;
    return windows.openSettings("ms-settings:startupapps");
  },

  /**
   * `boolean | null`: whether SmartScreen is held by policy. `null` where no
   * registry is reachable, which the Settings card renders as its fallback.
   */
  async windowsReputationManaged() {
    const windows = windowsForUse();
    if (!windows) return null;
    for (const [root, path] of SMARTSCREEN_POLICY_PATHS) {
      for (const name of SMARTSCREEN_POLICY_VALUES) {
        if (windows.readInt(root, path, name) !== null) return true;
        if (windows.readString(root, path, name) !== null) return true;
      }
    }
    return false;
  },

  /** Open Windows' diagnostics/feedback privacy page. */
  async windowsDiagnosticsSettings() {
    const windows = windowsForUse();
    if (!windows) return false;
    return windows.openSettings("ms-settings:privacy-feedback");
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

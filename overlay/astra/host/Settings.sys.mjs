/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Settings module (v1, P3-T20). The ported product UI reads its
// preferences with `setting_get` (payload is the raw stored value or null)
// and writes them with `setting_set` (payload is an OperationAdmission).
//
// A key in NATIVE is a browser setting that Firefox already owns. It is read
// from and written to the real pref (or, for the default zoom, the content
// pref service), so the choice survives restarts and changes the engine's
// behaviour instead of only repainting Astra. Every other key is an Astra
// setting with no native pref; it is stored under `astra.settings.*` in the
// profile, so it survives a restart until the core store is wired in.

import { emit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;

const _values = new Map();

/** Astra-owned settings with no Firefox pref of their own. They live in the
 *  profile's pref store under one branch so they survive a restart; the core
 *  store replaces this branch when its settings commands are wired. */
const ASTRA_PREFIX = "astra.settings.";

let injectedPrefs = null;
let injectedContentPrefs = null;
let observedPrefs = null;
let observer = null;

/** The chrome window's `Services.prefs`, or null outside a chrome process. */
function prefsForUse() {
  if (injectedPrefs) return injectedPrefs;
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) scopes.push(globalThis.window);
    const view = globalThis.document?.defaultView;
    if (view) scopes.push(view);
    for (const scope of scopes) {
      const prefs = scope?.Services?.prefs;
      if (prefs && typeof prefs.getBoolPref === "function" && typeof prefs.setBoolPref === "function") {
        return prefs;
      }
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

function chromeGlobal() {
  try {
    if (injectedContentPrefs) return globalThis;
    return globalThis.window ?? globalThis.document?.defaultView ?? globalThis;
  } catch {
    return globalThis;
  }
}

function contentPrefs() {
  if (injectedContentPrefs) return injectedContentPrefs;
  try {
    const scope = chromeGlobal();
    const cc = scope.Cc ?? globalThis.Cc;
    const ci = scope.Ci ?? globalThis.Ci;
    if (!cc || !ci) return null;
    return cc["@mozilla.org/content-pref/service;1"].getService(ci.nsIContentPrefService2);
  } catch {
    return null;
  }
}

function loadContext() {
  try {
    const cu = chromeGlobal().Cu ?? globalThis.Cu;
    return cu?.createLoadContext?.() ?? null;
  } catch {
    return null;
  }
}

function boolPref(prefs, name, fallback) {
  try {
    return prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

function intPref(prefs, name, fallback) {
  try {
    return prefs.getIntPref(name, fallback);
  } catch {
    return fallback;
  }
}

function stringPref(prefs, name, fallback) {
  try {
    return prefs.getStringPref(name, fallback);
  } catch {
    return fallback;
  }
}

function astraPrefName(key) {
  return ASTRA_PREFIX + key;
}

function readAstra(prefs, key) {
  return prefs ? stringPref(prefs, astraPrefName(key), null) : null;
}

function flag(value) {
  return value ? "true" : "false";
}

function parseFlag(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function clearOrSetInt(prefs, name, value) {
  if (value === -1) {
    prefs.clearUserPref(name);
  } else {
    prefs.setIntPref(name, value);
  }
}

/** "Ask"/"Allow"/"Block" over `permissions.default.*` (0/1/2). */
function permissionDefault(name) {
  return {
    prefs: [name],
    read: (prefs) => {
      const state = intPref(prefs, name, 0);
      return state === 1 ? "Allow" : state === 2 ? "Block" : "Ask";
    },
    write: (prefs, value) => {
      const state = value === "Allow" ? 1 : value === "Block" ? 2 : value === "Ask" ? 0 : null;
      if (state === null) return false;
      prefs.setIntPref(name, state);
      return true;
    },
  };
}

const ZOOM_VALUE = "browser.content.full-zoom";

function cachedZoom() {
  try {
    const cached = contentPrefs()?.getCachedGlobal?.(ZOOM_VALUE, loadContext());
    if (cached?.value) {
      const zoom = Number.parseFloat(cached.value);
      if (Number.isFinite(zoom)) return String(Math.round(zoom * 100));
    }
  } catch {
    // No cached global value yet.
  }
  return null;
}

function parseAddress(value) {
  const text = String(value ?? "").trim();
  const split = text.lastIndexOf(":");
  if (split <= 0) return null;
  const host = text.slice(0, split);
  const port = Number(text.slice(split + 1));
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function proxyModeFromPrefs(prefs) {
  const type = intPref(prefs, "network.proxy.type", 5);
  if (type !== 1) return "system";
  const http = stringPref(prefs, "network.proxy.http", "");
  const socks = stringPref(prefs, "network.proxy.socks", "");
  if (socks !== "" && http === "") return "socks5";
  // A freshly chosen mode has no address yet; keep the choice until one is
  // typed instead of reporting the other manual protocol.
  if (socks === "" && http === "") {
    const remembered = _values.get("network.proxy");
    if (remembered === "socks5" || remembered === "http") return remembered;
  }
  return "http";
}

function readProxyAddress(prefs) {
  if (intPref(prefs, "network.proxy.type", 5) !== 1) return "";
  const http = stringPref(prefs, "network.proxy.http", "");
  const socks = stringPref(prefs, "network.proxy.socks", "");
  const useSocks = socks !== "" && http === "";
  const host = useSocks ? socks : http;
  if (host === "") return "";
  const port = useSocks
    ? intPref(prefs, "network.proxy.socks_port", 0)
    : intPref(prefs, "network.proxy.http_port", 0);
  return port > 0 ? `${host}:${port}` : host;
}

function readStartupPages(prefs) {
  const raw = stringPref(prefs, "browser.startup.homepage", "");
  if (["", "about:home", "about:newtab", "about:blank"].includes(raw)) return "";
  return raw.split("|").filter(Boolean).join("\n");
}

const NATIVE = {
  "tabs.new-position": {
    prefs: ["browser.tabs.insertAfterCurrent", "browser.tabs.insertRelatedAfterCurrent"],
    read: (prefs) => (boolPref(prefs, "browser.tabs.insertAfterCurrent", false) ? "after-current" : "end"),
    write: (prefs, value) => {
      if (value !== "end" && value !== "after-current") return false;
      const after = value === "after-current";
      prefs.setBoolPref("browser.tabs.insertAfterCurrent", after);
      prefs.setBoolPref("browser.tabs.insertRelatedAfterCurrent", after);
      return true;
    },
  },

  "tabs.external-position": {
    prefs: ["browser.link.open_newwindow.override.external"],
    read: (prefs) => {
      const target = intPref(prefs, "browser.link.open_newwindow.override.external", -1);
      return target === 7 ? "after-current" : target === 3 ? "end" : "new-tab";
    },
    write: (prefs, value) => {
      const target = value === "after-current" ? 7 : value === "end" ? 3 : value === "new-tab" ? -1 : null;
      if (target === null) return false;
      clearOrSetInt(prefs, "browser.link.open_newwindow.override.external", target);
      return true;
    },
  },

  "tabs.automatic-pip": {
    prefs: ["media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled"],
    read: (prefs) =>
      flag(boolPref(prefs, "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", false)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", enabled);
      return true;
    },
  },

  "tabs.startup": {
    prefs: ["browser.startup.page"],
    read: (prefs) => {
      const page = intPref(prefs, "browser.startup.page", 1);
      return page === 3 ? "continue" : page === 1 ? "pages" : "new-tab";
    },
    write: (prefs, value) => {
      const page = value === "continue" ? 3 : value === "pages" ? 1 : value === "new-tab" ? 0 : null;
      if (page === null) return false;
      // Firefox's compiled default is 1 ("pages"), so a user 1 would be
      // dropped as "equal to the default". Move the default to Astra's
      // continue mode first; the pref then keeps whatever the person chose.
      try {
        prefs.getDefaultBranch(null).setIntPref("browser.startup.page", 3);
      } catch {
        // A test double without a default branch still stores the user value.
      }
      prefs.setIntPref("browser.startup.page", page);
      return true;
    },
  },

  "tabs.startup-pages": {
    prefs: ["browser.startup.homepage"],
    read: readStartupPages,
    write: (prefs, value) => {
      const pages = String(value)
        .split("\n")
        .map((page) => page.trim())
        .filter(Boolean);
      if (pages.length === 0) {
        prefs.clearUserPref("browser.startup.homepage");
      } else {
        prefs.setStringPref("browser.startup.homepage", pages.join("|"));
      }
      return true;
    },
  },

  "search.suggestions": {
    prefs: ["browser.search.suggest.enabled"],
    read: (prefs) => flag(boolPref(prefs, "browser.search.suggest.enabled", true)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("browser.search.suggest.enabled", enabled);
      return true;
    },
  },

  "search.history": {
    prefs: ["browser.urlbar.suggest.history"],
    read: (prefs) => flag(boolPref(prefs, "browser.urlbar.suggest.history", true)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("browser.urlbar.suggest.history", enabled);
      return true;
    },
  },

  "privacy.smartscreen": {
    prefs: ["browser.safebrowsing.malware.enabled", "browser.safebrowsing.phishing.enabled"],
    read: (prefs) =>
      flag(
        boolPref(prefs, "browser.safebrowsing.malware.enabled", true) &&
          boolPref(prefs, "browser.safebrowsing.phishing.enabled", true),
      ),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("browser.safebrowsing.malware.enabled", enabled);
      prefs.setBoolPref("browser.safebrowsing.phishing.enabled", enabled);
      return true;
    },
  },

  "privacy.fingerprinting": {
    prefs: ["privacy.fingerprintingProtection"],
    read: (prefs) => flag(boolPref(prefs, "privacy.fingerprintingProtection", true)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("privacy.fingerprintingProtection", enabled);
      return true;
    },
  },
  "privacy.cleanup": {
    prefs: ["privacy.sanitize.sanitizeOnShutdown"],
    read: (prefs) => flag(boolPref(prefs, "privacy.sanitize.sanitizeOnShutdown", false)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("privacy.sanitize.sanitizeOnShutdown", enabled);
      return true;
    },
  },

  "privacy.camera": permissionDefault("permissions.default.camera"),
  "privacy.microphone": permissionDefault("permissions.default.microphone"),
  "privacy.location": permissionDefault("permissions.default.geo"),
  "privacy.notifications": permissionDefault("permissions.default.desktop-notification"),

  "performance.sleep": {
    prefs: ["browser.tabs.unloadOnLowMemory"],
    read: (prefs) => flag(boolPref(prefs, "browser.tabs.unloadOnLowMemory", false)),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setBoolPref("browser.tabs.unloadOnLowMemory", enabled);
      return true;
    },
  },

  "performance.after": {
    prefs: ["browser.tabs.min_inactive_duration_before_unload"],
    read: (prefs) => {
      const ms = intPref(prefs, "browser.tabs.min_inactive_duration_before_unload", 600000);
      return ms < 600000 ? "5" : ms < 1350000 ? "15" : ms < 2700000 ? "30" : "60";
    },
    write: (prefs, value) => {
      const ms = { "5": 300000, "15": 900000, "30": 1800000, "60": 3600000 }[value];
      if (ms === undefined) return false;
      prefs.setIntPref("browser.tabs.min_inactive_duration_before_unload", ms);
      return true;
    },
  },

  "ui.density": {
    prefs: ["browser.uidensity"],
    read: (prefs) => (intPref(prefs, "browser.uidensity", 0) === 1 ? "compact" : "comfortable"),
    write: (prefs, value) => {
      if (value !== "comfortable" && value !== "compact") return false;
      prefs.setIntPref("browser.uidensity", value === "compact" ? 1 : 0);
      return true;
    },
  },

  "ui.reduce-motion": {
    prefs: ["ui.prefersReducedMotion"],
    read: (prefs) => flag(intPref(prefs, "ui.prefersReducedMotion", 0) === 1),
    write: (prefs, value) => {
      const enabled = parseFlag(value);
      if (enabled === null) return false;
      prefs.setIntPref("ui.prefersReducedMotion", enabled ? 1 : 0);
      return true;
    },
  },

  "network.proxy": {
    prefs: ["network.proxy.type", "network.proxy.http", "network.proxy.socks"],
    read: proxyModeFromPrefs,
    write: (prefs, value) => {
      if (value === "system") {
        prefs.setIntPref("network.proxy.type", 5);
        return true;
      }
      if (value !== "http" && value !== "socks5") return false;
      prefs.setIntPref("network.proxy.type", 1);
      if (value === "http") {
        prefs.clearUserPref("network.proxy.socks");
        prefs.clearUserPref("network.proxy.socks_port");
      } else {
        prefs.clearUserPref("network.proxy.http");
        prefs.clearUserPref("network.proxy.http_port");
        prefs.clearUserPref("network.proxy.ssl");
        prefs.clearUserPref("network.proxy.ssl_port");
        prefs.setIntPref("network.proxy.socks_version", 5);
      }
      return true;
    },
  },

  "network.proxy-address": {
    prefs: [
      "network.proxy.type",
      "network.proxy.http",
      "network.proxy.http_port",
      "network.proxy.ssl",
      "network.proxy.ssl_port",
      "network.proxy.socks",
      "network.proxy.socks_port",
    ],
    read: readProxyAddress,
    write: (prefs, value) => {
      const address = parseAddress(value);
      if (address === null) return false;
      const mode = _values.get("network.proxy") ?? proxyModeFromPrefs(prefs);
      if (mode === "socks5") {
        prefs.setStringPref("network.proxy.socks", address.host);
        prefs.setIntPref("network.proxy.socks_port", address.port);
        prefs.setIntPref("network.proxy.socks_version", 5);
      } else {
        prefs.setStringPref("network.proxy.http", address.host);
        prefs.setIntPref("network.proxy.http_port", address.port);
        prefs.setStringPref("network.proxy.ssl", address.host);
        prefs.setIntPref("network.proxy.ssl_port", address.port);
      }
      return true;
    },
  },

  "zoom.default": {
    prefs: [],
    read: () => cachedZoom(),
    async readAsync() {
      const service = contentPrefs();
      if (!service?.getGlobal) return cachedZoom();
      return new Promise((resolve) => {
        let zoom = 1;
        try {
          service.getGlobal(ZOOM_VALUE, loadContext(), {
            handleResult(pref) {
              const value = Number.parseFloat(pref?.value);
              if (Number.isFinite(value)) zoom = value;
            },
            handleCompletion() {
              resolve(String(Math.round(zoom * 100)));
            },
            handleError() {
              resolve(cachedZoom());
            },
          });
        } catch {
          resolve(cachedZoom());
        }
      });
    },
    async writeAsync(_prefs, value) {
      const percent = Number(value);
      if (!Number.isFinite(percent) || percent < 20 || percent > 500) return false;
      const service = contentPrefs();
      if (!service?.setGlobal) return false;
      return new Promise((resolve) => {
        try {
          service.setGlobal(ZOOM_VALUE, percent / 100, loadContext(), {
            handleCompletion() {
              resolve(true);
            },
            handleError() {
              resolve(false);
            },
          });
        } catch {
          resolve(false);
        }
      });
    },
  },
};

const WATCHED = new Map();
for (const [key, native] of Object.entries(NATIVE)) {
  for (const name of native.prefs) {
    const keys = WATCHED.get(name) ?? [];
    keys.push(key);
    WATCHED.set(name, keys);
  }
}

function unwatch() {
  try {
    if (observedPrefs && observer) observedPrefs.removeObserver(observer);
  } catch {
    // The pref service may already be gone at shutdown.
  }
  observedPrefs = null;
  observer = null;
}

/** Re-announce a native pref this window did not write, so every surface
 *  agrees without polling. One observer per process, removed on reset. */
function watch(prefs) {
  if (!prefs || observedPrefs === prefs) return;
  unwatch();
  const candidate = {
    observe(_subject, topic, name) {
      if (topic !== "nsPref:changed") return;
      if (name.startsWith(ASTRA_PREFIX)) {
        const key = name.slice(ASTRA_PREFIX.length);
        if (!/^[a-z0-9._-]+$/iu.test(key) || NATIVE[key]) return;
        const value = readAstra(prefs, key);
        if (value === null) _values.delete(key);
        else _values.set(key, value);
        emit("ui-command", `preference.${key}=${value ?? ""}`);
        return;
      }
      const keys = WATCHED.get(name);
      if (!keys) return;
      for (const key of keys) {
        let value = null;
        try {
          value = NATIVE[key].read(prefs);
        } catch {
          value = null;
        }
        if (value === null || value === undefined) continue;
        _values.set(key, value);
        emit("ui-command", `preference.${key}=${value}`);
      }
    },
  };
  try {
    prefs.addObserver("", candidate);
    observedPrefs = prefs;
    observer = candidate;
  } catch {
    observedPrefs = null;
    observer = null;
  }
}

function admission(accepted) {
  return { operation_id: null, accepted };
}

export const Settings = {
  // Returns the value itself (string | null), not an envelope: the UI reads
  // the payload directly (`settingGet` is typed `string | null`).
  async get({ key = "" } = {}) {
    if (typeof key !== "string" || key === "") {
      return null;
    }
    const native = NATIVE[key];
    if (!native) {
      const prefs = prefsForUse();
      const stored = readAstra(prefs, key);
      if (stored !== null) {
        _values.set(key, stored);
        watch(prefs);
        return stored;
      }
      return _values.has(key) ? _values.get(key) : null;
    }
    const prefs = prefsForUse();
    let value = null;
    try {
      value = native.readAsync ? await native.readAsync(prefs) : prefs ? native.read(prefs) : null;
    } catch {
      value = null;
    }
    if (value === null || value === undefined) {
      value = _values.has(key) ? _values.get(key) : null;
    }
    if (value !== null) _values.set(key, value);
    watch(prefs);
    return value;
  },

  async set({ request_id = "", key = "", value = null } = {}) {
    // Keys are a closed vocabulary the app owns. Anything else could forge a
    // `ui-command` for another surface (the preference push is a string).
    if (typeof key !== "string" || !/^[a-z0-9._-]+$/iu.test(key)) {
      return admission(false);
    }
    // A newline is a list separator in startup pages and performance
    // exceptions. Every other C0 control could forge a `ui-command`.
    if (typeof value !== "string" || /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)) {
      return admission(false);
    }
    const native = NATIVE[key];
    if (native) {
      const prefs = prefsForUse();
      let written = false;
      try {
        if (native.writeAsync) written = (await native.writeAsync(prefs, value)) === true;
        else if (prefs) written = native.write(prefs, value) === true;
      } catch {
        written = false;
      }
      if (!written) {
        // Outside chrome (a Node contract test) the session value stands in.
        if (!prefs) {
          _values.set(key, value);
          emit("ui-command", `preference.${key}=${value}`);
          return admission(true);
        }
        return admission(false);
      }
      _values.set(key, value);
      watch(prefs);
    } else {
      const prefs = prefsForUse();
      if (prefs) {
        try {
          prefs.setStringPref(astraPrefName(key), value);
        } catch {
          return admission(false);
        }
        watch(prefs);
      }
      _values.set(key, value);
    }
    // The app also listens for preference pushes from chrome (`ui-command`);
    // announce the change so every surface agrees without a re-read.
    emit("ui-command", `preference.${key}=${value}`);
    return admission(true);
  },

  /** The stored value, read synchronously. Modules that decide what a typed
   *  field means (Search) cannot await a promise mid-parse. */
  current(key) {
    if (typeof key !== "string") return null;
    const native = NATIVE[key];
    if (native) {
      const prefs = prefsForUse();
      if (prefs) {
        try {
          const value = native.read(prefs);
          if (value !== null && value !== undefined) {
            _values.set(key, value);
            return value;
          }
        } catch {
          // Fall through to the cached value.
        }
      }
      return _values.has(key) ? _values.get(key) : null;
    }
    const prefs = prefsForUse();
    const stored = readAstra(prefs, key);
    if (stored !== null) {
      _values.set(key, stored);
      return stored;
    }
    return _values.has(key) ? _values.get(key) : null;
  },

  // Diagnostics/tests: the whole session map.
  async all() {
    return Object.fromEntries(_values);
  },
};

export function __settingsSnapshot() {
  return Object.fromEntries(_values);
}

/** Test seam: stand in for `Services.prefs` where no chrome process exists. */
export function __setPrefsForTests(prefs) {
  unwatch();
  injectedPrefs = prefs ?? null;
}

/** Test seam: stand in for the content-pref service (default zoom). */
export function __setContentPrefsForTests(service) {
  injectedContentPrefs = service ?? null;
}

// Test-only reset so contract tests start from a clean slate.
export function __resetSettingsForTests() {
  unwatch();
  injectedPrefs = null;
  injectedContentPrefs = null;
  _values.clear();
}

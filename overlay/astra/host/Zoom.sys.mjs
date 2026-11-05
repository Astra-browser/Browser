/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Zoom module. `zoom_call` is the Settings page's "Zoom levels"
// surface: the sites a profile has given their own level, and the two ways to
// take a level back. The store is Firefox's own content-pref database under
// `browser.content.full-zoom`, the same pref `FullZoom` reads and writes, so a
// level removed here is removed for the engine too and a level the engine
// stores appears here.
//
// The shape is the router's existing `ZoomCall`/`ZoomResponse`:
//   { kind: "levels" }                    -> { kind: "levels", levels }
//   { kind: "forget", site }              -> { kind: "levels", levels }
//   { kind: "forget_all" }                -> { kind: "levels", levels }
// A failure is `{ kind: "error", error: "invalid" | "unavailable" }`; it is
// never an empty list standing in for a store that could not be read.
//
// The session also persists the level a `zoom.in`/`zoom.out`/`zoom.reset`
// command changes. It follows the engine's rules:
//   - `browser.zoom.siteSpecific` false means zoom is not per-site, so nothing
//     is written (the engine marks the tab custom instead).
//   - a private window never writes: the content-pref service would keep the
//     value in its private store, and Astra's isolation rule is stricter.
//   - 100% is the absence of an override, so it removes the site's pref
//     rather than storing a redundant 1.
//
// `browser.content.full-zoom` also has a global value (the Settings "Default
// zoom"). `forget_all` clears every site through `removeByName` and puts that
// global value back, so "Reset all" cannot silently reset the default zoom.
//
// Pure logic except for the chrome service lookup, which is read per call so
// Node contract tests can run with an injected pref service.

const ZOOM_NAME = "browser.content.full-zoom";
const SITE_SPECIFIC_PREF = "browser.zoom.siteSpecific";

/** The private profile the shell projects into a private window. */
const PRIVATE_PROFILE = "incognito";

let injectedContentPrefs = null;
let injectedPrefs = null;
let injectedContext = null;

/** Test seam: stand in for `Services.prefs`. */
export function __setPrefsForTests(prefs) {
  injectedPrefs = prefs ?? null;
}

/** Test seam: stand in for `nsIContentPrefService2`. */
export function __setContentPrefsForTests(service) {
  injectedContentPrefs = service ?? null;
}

/** Test seam: stand in for `Cu.createLoadContext()`. */
export function __setLoadContextForTests(context) {
  injectedContext = context ?? null;
}

export function __resetZoomForTests() {
  injectedContentPrefs = null;
  injectedPrefs = null;
  injectedContext = null;
}

function chromeGlobal() {
  try {
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
    return cc["@mozilla.org/content-pref/service;1"].getService(
      ci.nsIContentPrefService2,
    );
  } catch {
    return null;
  }
}

function loadContext() {
  if (injectedContext) return injectedContext;
  try {
    const cu = chromeGlobal().Cu ?? globalThis.Cu;
    return cu?.createLoadContext?.() ?? null;
  } catch {
    return null;
  }
}

function prefs() {
  if (injectedPrefs) return injectedPrefs;
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) scopes.push(view);
    for (const scope of scopes) {
      const service = scope?.Services?.prefs;
      if (service && typeof service.getBoolPref === "function") return service;
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

function siteSpecific() {
  try {
    const service = prefs();
    return service ? service.getBoolPref(SITE_SPECIFIC_PREF, true) : true;
  } catch {
    return true;
  }
}

/** The host a site pref belongs to, or "" for a page zoom cannot apply to. */
function hostOf(url) {
  try {
    const parsed = new URL(String(url ?? ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.hostname
      : "";
  } catch {
    return "";
  }
}

const PERCENT_MIN = 1;
const PERCENT_MAX = 1000;

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number * 100);
  return rounded >= PERCENT_MIN && rounded <= PERCENT_MAX ? rounded : null;
}

function listLevels(service) {
  return new Promise((resolve, reject) => {
    const levels = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      levels.sort((a, b) => a.site.localeCompare(b.site));
      resolve(levels);
    };
    try {
      service.getByName(ZOOM_NAME, loadContext(), {
        handleResult(pref) {
          // A global pref has no domain; it is the default zoom, not a site.
          const site = typeof pref?.domain === "string" ? pref.domain : "";
          const value = percent(pref?.value);
          if (site !== "" && value !== null) levels.push({ site, percent: value });
        },
        handleError() {
          finish(new Error("content pref read failed"));
        },
        handleCompletion() {
          finish();
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error("content pref read failed"));
    }
  });
}

function removeSite(service, site) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      service.removeByDomainAndName(site, ZOOM_NAME, loadContext(), {
        handleCompletion() {
          finish(true);
        },
        handleError() {
          finish(false);
        },
      });
    } catch {
      finish(false);
    }
  });
}

function removeAllSites(service) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      service.removeByName(ZOOM_NAME, loadContext(), {
        handleCompletion() {
          finish(true);
        },
        handleError() {
          finish(false);
        },
      });
    } catch {
      finish(false);
    }
  });
}

function readGlobal(service) {
  return new Promise((resolve) => {
    let value = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      service.getGlobal(ZOOM_NAME, loadContext(), {
        handleResult(pref) {
          const number = Number(pref?.value);
          if (Number.isFinite(number)) value = number;
        },
        handleError() {
          finish();
        },
        handleCompletion() {
          finish();
        },
      });
    } catch {
      finish();
    }
  });
}

function restoreGlobal(service, value) {
  if (value === null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      service.setGlobal(ZOOM_NAME, value, loadContext(), {
        handleCompletion() {
          finish(true);
        },
        handleError() {
          finish(false);
        },
      });
    } catch {
      finish(false);
    }
  });
}

function setSite(service, site, zoom) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      service.set(site, ZOOM_NAME, zoom, loadContext(), {
        handleCompletion() {
          finish(true);
        },
        handleError() {
          finish(false);
        },
      });
    } catch {
      finish(false);
    }
  });
}

async function levels(service) {
  try {
    return { kind: "levels", levels: await listLevels(service) };
  } catch {
    return { kind: "error", error: "unavailable" };
  }
}

export const Zoom = {
  /**
   * One `zoom_call`. `expected_profile` is the app's profile token; the
   * private projection is `"incognito"`, where the session has no site levels
   * to show and no store to write.
   */
  async call({ expected_profile = "", call = {} } = {}) {
    const profile = typeof expected_profile === "string" ? expected_profile : "";
    const kind = typeof call?.kind === "string" ? call.kind : "";
    if (kind !== "levels" && kind !== "forget" && kind !== "forget_all") {
      return { kind: "error", error: "invalid" };
    }
    if (profile === PRIVATE_PROFILE) {
      // Nothing is recorded in a private window, so nothing is read back.
      return { kind: "levels", levels: [] };
    }
    const service = contentPrefs();
    if (!service) {
      return { kind: "error", error: "unavailable" };
    }
    if (kind === "levels") {
      return levels(service);
    }
    if (kind === "forget") {
      const site = typeof call?.site === "string" ? call.site.trim() : "";
      if (site === "" || hostOf(`https://${site}`) === "") {
        return { kind: "error", error: "invalid" };
      }
      if (!(await removeSite(service, site))) {
        return { kind: "error", error: "unavailable" };
      }
      return levels(service);
    }
    // Reset all sites but keep the global default zoom.
    const global = await readGlobal(service);
    if (!(await removeAllSites(service))) {
      return { kind: "error", error: "unavailable" };
    }
    if (global !== null) await restoreGlobal(service, global);
    return levels(service);
  },

  /**
   * The global default zoom ("Default zoom" in Settings), or 1 when the
   * service is unreachable. Reset falls back to this level, as FullZoom does.
   */
  async defaultLevel() {
    const service = contentPrefs();
    if (!service) return 1;
    try {
      const value = await readGlobal(service);
      if (!Number.isFinite(value) || value <= 0) return 1;
      return Math.min(3, Math.max(0.3, value));
    } catch {
      return 1;
    }
  },

  /**
   * Save the active tab's new level. Answers whether a pref was written; a
   * private window, a non-site page, a disabled site-specific pref or a
   * missing service is a refusal, not an error the caller has to show.
   */
  async persist({ url = "", zoom = 1, private: isPrivate = false } = {}) {
    if (isPrivate === true) return false;
    if (!siteSpecific()) return false;
    const site = hostOf(url);
    if (!site) return false;
    const number = Number(zoom);
    if (!Number.isFinite(number)) return false;
    const service = contentPrefs();
    if (!service) return false;
    // 100% is the default: the site keeps no override of its own.
    if (Math.abs(number - 1) < 0.0001) {
      return removeSite(service, site);
    }
    return setSite(service, site, number);
  },
};

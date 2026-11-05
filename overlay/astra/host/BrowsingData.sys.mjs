/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API BrowsingData module (Lane 3). One request shape
// (`BrowsingDataCall`) for the clear-data dialog, the site-data list and the
// page's "clear site data" command.
//
// Native owners:
// - Clearing by time range/category: `Sanitizer.sanitize(items, options)`
//   (`browser/modules/Sanitizer.sys.mjs`), which drives
//   `Services.clearData` (`nsIClearDataService`). `history`, `downloads` and
//   `cache` map one-to-one; `cookies` is cookies *and site data*, so it also
//   clears `offlineApps` exactly as the engine's own sanitize dialog does. A
//   `downloads` clear removes the download list, never the files.
// - Listing/removing site data: `SiteDataManager.updateSites()/getSites()/
//   remove()` (`browser/modules/SiteDataManager.sys.mjs`).
// - Removing one page's origin: `Services.clearData.deleteDataFromPrincipal`
//   with the cookies-and-site-data + caches flags.
//
// Ranges are converted here to the PRTime microsecond range the engine wants:
// hour/day/week/four weeks are relative to now, everything is unbounded.
//
// Private scope: a private window keeps nothing that survives it, so this
// module answers `private` and performs no write at all. It never falls back
// to clearing the normal profile from a private window.
//
// Pure logic with one injectable backend. Node contract tests exercise the
// routing, validation and range/category mapping without Firefox; the live
// backend is created lazily on first use.

import { emit } from "./Events.sys.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The ranges the Settings dialog offers, and their span from now. */
const RANGE_MS = new Map([
  ["hour", HOUR_MS],
  ["day", DAY_MS],
  ["week", 7 * DAY_MS],
  ["four_weeks", 28 * DAY_MS],
  ["everything", null],
]);

/** UI category -> Sanitizer item names. `cookies` is cookies + site data. */
const CLEAR_ITEMS = {
  history: ["history"],
  cookies: ["cookies", "offlineApps"],
  cache: ["cache"],
  downloads: ["downloads"],
};

const KINDS = ["history", "cookies", "cache", "downloads"];

/** Longest site name/host accepted from the UI. */
const MAX_SITE = 255;

let _backend = null;

export function __setBrowsingDataBackend(backend) {
  _backend = backend;
  return () => {
    if (_backend === backend) _backend = null;
  };
}

export function __resetBrowsingDataForTests() {
  _backend = null;
}

function lazyModule(specifier, key) {
  if (typeof ChromeUtils === "undefined") return null;
  const imported = ChromeUtils.importESModule(specifier);
  return imported[key] ?? null;
}

function sharedServices() {
  try {
    return typeof Services !== "undefined" && Services ? Services : null;
  } catch {
    return null;
  }
}

/** True when the focused browser window is private. */
function focusedWindowIsPrivate() {
  const services = sharedServices();
  if (!services) return false;
  try {
    const win =
      services.focus?.activeWindow ??
      services.wm.getMostRecentWindow("navigator:browser");
    if (!win) {
      // No browser window to attribute the call to; a clear would be
      // unattributable, so callers treat this as unavailable below.
      return false;
    }
    const { PrivateBrowsingUtils } = lazyModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      "PrivateBrowsingUtils"
    );
    return PrivateBrowsingUtils ? PrivateBrowsingUtils.isWindowPrivate(win) === true : false;
  } catch {
    return false;
  }
}

function focusedWindowExists() {
  try {
    const services = sharedServices();
    return !!(
      services?.focus?.activeWindow ??
      services?.wm.getMostRecentWindow("navigator:browser")
    );
  } catch {
    return false;
  }
}

function hasChrome() {
  return typeof ChromeUtils !== "undefined";
}

/**
 * The live backend over Sanitizer/ClearDataService/SiteDataManager.
 * Every call is guarded; a missing subsystem reports `false`, never a fake
 * success.
 */
function liveBackend() {
  if (!hasChrome()) return null;
  const services = sharedServices();
  if (!services) return null;
  return {
    isPrivate: focusedWindowIsPrivate,
    hasWindow: focusedWindowExists,
    async clear(range, kinds) {
      const items = [];
      for (const kind of KINDS) {
        if (!kinds[kind]) continue;
        items.push(...CLEAR_ITEMS[kind]);
      }
      if (items.length === 0) return false;
      const { Sanitizer } = lazyModule(
        "resource:///modules/Sanitizer.sys.mjs",
        "Sanitizer"
      );
      if (!Sanitizer) return false;
      const span = RANGE_MS.get(range);
      const options =
        span === null
          ? { ignoreTimespan: true }
          : {
              ignoreTimespan: false,
              range: [Date.now() * 1000 - span * 1000, Date.now() * 1000],
            };
      try {
        await Sanitizer.sanitize(items, options);
        return true;
      } catch {
        // Sanitizer throws when any item failed; the caller reports failed
        // rather than claiming a partial clear succeeded.
        return false;
      }
    },
    async sites() {
      const { SiteDataManager } = lazyModule(
        "resource:///modules/SiteDataManager.sys.mjs",
        "SiteDataManager"
      );
      if (!SiteDataManager) return null;
      try {
        await SiteDataManager.updateSites();
        const list = await SiteDataManager.getSites();
        const sites = [];
        for (const entry of list) {
          const site = typeof entry.baseDomain === "string" ? entry.baseDomain : "";
          if (site === "") continue;
          const cookies = Array.isArray(entry.cookies) && entry.cookies.length > 0;
          const storage = typeof entry.usage === "number" && entry.usage > 0;
          if (!cookies && !storage) continue;
          sites.push({ site, cookies, storage });
        }
        sites.sort((a, b) => a.site.localeCompare(b.site));
        return { sites, partial: false };
      } catch {
        return null;
      }
    },
    async forgetSite(site) {
      const { SiteDataManager } = lazyModule(
        "resource:///modules/SiteDataManager.sys.mjs",
        "SiteDataManager"
      );
      if (!SiteDataManager) return false;
      try {
        await SiteDataManager.remove([site]);
        return true;
      } catch {
        return false;
      }
    },
    async forgetPage(origin) {
      let principal;
      try {
        principal =
          services.scriptSecurityManager.createContentPrincipalFromOrigin(origin);
      } catch {
        return false;
      }
      if (!principal) return false;
      try {
        const flags =
          Ci.nsIClearDataService.CLEAR_COOKIES_AND_SITE_DATA |
          Ci.nsIClearDataService.CLEAR_ALL_CACHES;
        const ok = await new Promise((resolve) => {
          services.clearData.deleteDataFromPrincipal(principal, true, flags, {
            onDataDeleted(failedFlags) {
              resolve(failedFlags === 0);
            },
          });
        });
        return ok === true;
      } catch {
        return false;
      }
    },
  };
}

function backend() {
  return _backend ?? liveBackend();
}

function error(code) {
  return { kind: "error", error: code };
}

function isRange(value) {
  return typeof value === "string" && RANGE_MS.has(value);
}

function isSite(value) {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_SITE &&
    !/[\s/]/u.test(value)
  );
}

function isOrigin(value) {
  if (typeof value !== "string" || value === "" || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

/** The profile the call names must be the profile that is running. */
function profileScope(expectedProfile, backendImpl) {
  if (typeof expectedProfile !== "string" || expectedProfile === "") {
    return { scope: "invalid" };
  }
  if (expectedProfile === "incognito") return { scope: "private" };
  if (expectedProfile !== "default") return { scope: "unavailable" };
  let isPrivate = false;
  let hasWindow = true;
  try {
    isPrivate = backendImpl.isPrivate() === true;
  } catch {
    isPrivate = false;
  }
  try {
    hasWindow = backendImpl.hasWindow?.() !== false;
  } catch {
    hasWindow = true;
  }
  if (!hasWindow) return { scope: "unavailable" };
  return { scope: isPrivate ? "private" : "normal" };
}

function validClearCall(call) {
  if (!isRange(call.range)) return false;
  let chosen = 0;
  for (const kind of KINDS) {
    if (typeof call[kind] !== "boolean") return false;
    if (call[kind]) chosen += 1;
  }
  return chosen > 0;
}

async function answer(expectedProfile, call) {
  const impl = backend();
  if (!impl) return error("unavailable");
  if (
    call === null ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    typeof call.kind !== "string"
  ) {
    return error("invalid");
  }

  switch (call.kind) {
    case "clear": {
      if (!validClearCall(call)) return error("invalid");
      const { scope } = profileScope(expectedProfile, impl);
      if (scope === "invalid") return error("invalid");
      if (scope === "unavailable") return error("unavailable");
      if (scope === "private") return error("private");
      const kinds = {};
      for (const kind of KINDS) kinds[kind] = call[kind] === true;
      let cleared = false;
      try {
        cleared = (await impl.clear(call.range, kinds)) === true;
      } catch {
        cleared = false;
      }
      if (!cleared) return error("failed");
      // Cookies/site data and history change what other surfaces show.
      if (kinds.cookies) emit("sites-changed", { profile: "default" });
      if (kinds.history) emit("history.cleared", {});
      return { kind: "cleared" };
    }

    case "sites": {
      const { scope } = profileScope(expectedProfile, impl);
      if (scope === "invalid") return error("invalid");
      if (scope === "unavailable") return error("unavailable");
      if (scope === "private") return error("private");
      let result = null;
      try {
        result = await impl.sites();
      } catch {
        result = null;
      }
      if (!result) return error("failed");
      return {
        kind: "sites",
        sites: Array.isArray(result.sites) ? result.sites : [],
        partial: result.partial === true,
      };
    }

    case "forget_site": {
      if (!isSite(call.site)) return error("invalid");
      const { scope } = profileScope(expectedProfile, impl);
      if (scope === "invalid") return error("invalid");
      if (scope === "unavailable") return error("unavailable");
      if (scope === "private") return error("private");
      let cleared = false;
      try {
        cleared = (await impl.forgetSite(call.site)) === true;
      } catch {
        cleared = false;
      }
      if (!cleared) return error("failed");
      emit("sites-changed", { profile: "default" });
      return { kind: "cleared" };
    }

    case "forget_page": {
      if (!isOrigin(call.origin)) return error("invalid");
      const { scope } = profileScope(expectedProfile, impl);
      if (scope === "invalid") return error("invalid");
      if (scope === "unavailable") return error("unavailable");
      if (scope === "private") return error("private");
      let cleared = false;
      try {
        cleared = (await impl.forgetPage(call.origin)) === true;
      } catch {
        cleared = false;
      }
      if (!cleared) return error("failed");
      emit("sites-changed", { profile: "default" });
      return { kind: "cleared" };
    }

    default:
      return error("invalid");
  }
}

export const BrowsingData = {
  /** `browsing_data_call`: one request, the existing BrowsingDataResponse. */
  async call({ expected_profile = "", call = null } = {}) {
    try {
      return await answer(expected_profile, call);
    } catch {
      return error("unavailable");
    }
  },

  /** Test/diagnostic seam only. */
  __backend: () => backend(),
};

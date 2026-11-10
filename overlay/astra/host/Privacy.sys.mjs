/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Privacy module (cookies, forgetful browsing, bounce tracking and
// fingerprinting modes).
//
// Everything here is native engine state: `network.cookie.cookieBehavior`,
// the cookie permission manager, `privacy.bounceTrackingProtection.mode`,
// `privacy.fingerprintingProtection` (+ its granular overrides) and
// `nsIClearDataService`. No site content is inspected and no WebExtension
// shim is used.

import { addEventListener } from "./Events.sys.mjs";

const COOKIE_MODE_PREF = "astra.privacy.cookies-mode";
const FORGET_PREF = "astra.privacy.forget-on-close";
const FORGET_SITES_PREF = "astra.privacy.forget-sites";
const EPHEMERAL_PREF = "astra.privacy.ephemeral-storage";
const FINGERPRINT_PREF = "astra.privacy.fingerprint-mode";
const LANGUAGE_PREF = "astra.privacy.language-spoof";
const SCREEN_PREF = "astra.privacy.screen-spoof";
const BTP_PREF = "astra.privacy.bounce-protection";
const SITE_FP_PREF = "astra.privacy.site-fingerprint";
const SITE_COOKIE_PREF = "astra.privacy.site-cookies";
const LANGUAGE_BACKUP_PREF = "astra.privacy.language-backup";

const COOKIE_MODES = new Set(["allow", "block-third-party", "partition"]);
const FP_MODES = new Set(["off", "standard", "aggressive"]);
const FP_STANDARD =
  "+WebGLRenderInfo,+WebGLRenderCapability,+WebGLVendorSanitize,+WebGLRendererConstant,+WebGLRandomization" +
  ",+AudioContext,+AudioSampleRate,+MediaCapabilities,+MediaDevices,+MediaError,+NetworkConnection" +
  ",+FontVisibilityBaseSystem,+CSSResolution,+CSSDeviceSize,+CSSColorInfo" +
  ",+FrameRate,+WebCodecs,+WebGPULimits,+WebGPUIsFallbackAdapter,+WebGPUSubgroupSizes" +
  ",+VideoElementMozFrames,+VideoElementMozFrameDelay,+VideoElementPlaybackQuality";
// Timer precision is deliberately not reduced here. FPP's
// ReduceTimerPrecision target clamps performance.now() to 16.667 ms (one
// 60 Hz atom), which makes Speedometer report 0-time suites and breaks
// real animation code. The engine's default 1 ms timer floor still applies.
const FP_AGGRESSIVE =
  "+CanvasRandomization,+EfficientCanvasRandomization,+AudioContext,+AudioSampleRate,+MediaCapabilities,+MediaDevices,+MediaError,+NetworkConnection,+FontVisibilityBaseSystem,+CSSResolution,+CSSDeviceSize,+CSSColorInfo,+WebGLRenderInfo,+WebGLRenderCapability,+WebGLVendorSanitize,+WebGLRendererConstant,+WebGLRandomization,+FrameRate,+WebCodecs,+WebGPULimits,+WebGPUIsFallbackAdapter,+WebGPUSubgroupSizes,+VideoElementMozFrames,+VideoElementMozFrameDelay,+VideoElementPlaybackQuality,+ScreenRect,+ScreenAvailRect,+ScreenPixelDepth,+WindowOuterSize,+WindowScreenXY,+WindowInnerScreenXY,+JSLocale,+JSLocalePrompt,+RoundWindowSize,+MouseEventScreenPoint";
const FP_SCREEN =
  "+ScreenRect,+ScreenAvailRect,+ScreenPixelDepth,+WindowOuterSize,+WindowScreenXY,+WindowInnerScreenXY,+RoundWindowSize,+MouseEventScreenPoint";
const FP_LANGUAGE = "+JSLocale,+JSLocalePrompt";

let _installed = false;
let _tabs = new Map(); // window:tab -> host
let _dispose = null;

function chromeScope() {
  try {
    if (
      typeof ChromeUtils !== "undefined" &&
      typeof Services !== "undefined" &&
      typeof Cc !== "undefined" &&
      typeof Ci !== "undefined"
    ) {
      return { ChromeUtils, Services, Cc, Ci };
    }
  } catch {
    // Node contract tests have no chrome globals.
  }
  return null;
}

function prefBool(name, fallback) {
  try {
    return Services.prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

function prefString(name, fallback) {
  try {
    return Services.prefs.getStringPref(name, fallback);
  } catch {
    return fallback;
  }
}

function prefInt(name, fallback) {
  try {
    return Services.prefs.getIntPref(name, fallback);
  } catch {
    return fallback;
  }
}

function readJSON(name, fallback) {
  try {
    const parsed = JSON.parse(prefString(name, ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

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

function normalizeHost(host) {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/u, "")
    .replace(/\.$/u, "");
}

function privateActive() {
  try {
    const win =
      Services.focus?.activeWindow ??
      Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) return false;
    const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    );
    return PrivateBrowsingUtils.isWindowPrivate(win) === true;
  } catch {
    return false;
  }
}

function readForgetSites() {
  const parsed = readJSON(FORGET_SITES_PREF, []);
  return Array.isArray(parsed)
    ? parsed.filter((host) => typeof host === "string" && host !== "")
    : [];
}

function readSiteCookies() {
  const parsed = readJSON(SITE_COOKIE_PREF, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function readSiteFingerprints() {
  const parsed = readJSON(SITE_FP_PREF, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function cookieMode() {
  const value = prefString(COOKIE_MODE_PREF, "partition");
  return COOKIE_MODES.has(value) ? value : "partition";
}

function fingerprintMode() {
  const value = prefString(FINGERPRINT_PREF, "standard");
  return FP_MODES.has(value) ? value : "standard";
}

function cookieBehaviorFor(mode) {
  if (mode === "allow") return 0;
  if (mode === "block-third-party") return 1;
  return 5; // partition (DFPI)
}

function writeBool(name, value) {
  try {
    Services.prefs.setBoolPref(name, value === true);
    return true;
  } catch {
    return false;
  }
}

function writeString(name, value) {
  try {
    Services.prefs.setStringPref(name, String(value));
    return true;
  } catch {
    return false;
  }
}

function applyCookieMode() {
  const mode = cookieMode();
  try {
    Services.prefs.setIntPref(
      "network.cookie.cookieBehavior",
      cookieBehaviorFor(mode),
    );
  } catch {
    // A locked pref keeps the previous mode.
  }
  const ephemeral = prefBool(EPHEMERAL_PREF, false);
  try {
    // Partitioned third-party storage is the native mechanism behind both the
    // "partition" cookie mode and ephemeral third-party storage.
    const partition = mode === "partition" || ephemeral;
    Services.prefs.setBoolPref(
      "privacy.partition.always_partition_third_party_non_cookie_storage",
      partition,
    );
    Services.prefs.setBoolPref("privacy.partition.serviceWorkers", partition);
    Services.prefs.setBoolPref("privacy.partition.network_state", partition);
  } catch {
    // Best effort: the partition prefs are not user-locked.
  }
}

function applyBounceProtection() {
  try {
    // 1 = enabled (active purge); 2 = standby; 3 = dry-run; 0 = disabled.
    Services.prefs.setIntPref(
      "privacy.bounceTrackingProtection.mode",
      prefBool(BTP_PREF, true) ? 1 : 0,
    );
  } catch {
    // Locked pref.
  }
}

function fingerprintOverrides() {
  const mode = fingerprintMode();
  if (mode === "off") return "";
  let overrides = mode === "aggressive" ? FP_AGGRESSIVE : FP_STANDARD;
  if (prefBool(LANGUAGE_PREF, false)) overrides += `,${FP_LANGUAGE}`;
  if (prefBool(SCREEN_PREF, false)) overrides += `,${FP_SCREEN}`;
  return overrides;
}

function applyFingerprinting() {
  const mode = fingerprintMode();
  try {
    Services.prefs.setBoolPref(
      "privacy.fingerprintingProtection",
      mode !== "off",
    );
    // RFP stays off: the per-target set gives Brave-style farbling without
    // changing the user agent, timezone or colour scheme.
    Services.prefs.setBoolPref("privacy.resistFingerprinting", false);
    Services.prefs.setStringPref(
      "privacy.fingerprintingProtection.overrides",
      fingerprintOverrides(),
    );
  } catch {
    // Locked pref.
  }
  applySiteFingerprints();
  applyLanguage();
}

function applyLanguage() {
  const spoof = prefBool(LANGUAGE_PREF, false);
  try {
    if (spoof) {
      if (!Services.prefs.prefHasUserValue(LANGUAGE_BACKUP_PREF)) {
        writeString(
          LANGUAGE_BACKUP_PREF,
          prefString("intl.accept_languages", ""),
        );
      }
      Services.prefs.setStringPref("intl.accept_languages", "en-US, en");
      Services.prefs.setIntPref("privacy.spoof_english", 2);
    } else {
      const backup = prefString(LANGUAGE_BACKUP_PREF, "");
      if (backup) {
        Services.prefs.setStringPref("intl.accept_languages", backup);
        Services.prefs.clearUserPref(LANGUAGE_BACKUP_PREF);
      }
      if (Services.prefs.getIntPref("privacy.spoof_english", 0) === 2) {
        Services.prefs.setIntPref("privacy.spoof_english", 0);
      }
    }
  } catch {
    // Best effort.
  }
  if (spoof) installLanguageObserver();
  else uninstallLanguageObserver();
}

function applySiteFingerprints() {
  const sites = readSiteFingerprints();
  let existing = [];
  try {
    existing = JSON.parse(
      prefString("privacy.fingerprintingProtection.granularOverrides", "[]"),
    );
    if (!Array.isArray(existing)) existing = [];
  } catch {
    existing = [];
  }
  const ours = new Set(Object.keys(sites).map((host) => normalizeHost(host)));
  const merged = existing.filter(
    (entry) =>
      !entry ||
      typeof entry.firstPartyDomain !== "string" ||
      !ours.has(normalizeHost(entry.firstPartyDomain)),
  );
  for (const [host, mode] of Object.entries(sites)) {
    if (mode === "aggressive") {
      // `+AllTargets` includes ReduceTimerPrecision, whose 16.667 ms clamp
      // breaks performance.now() (Speedometer's 0-time check, animation
      // timing). The global sets leave it out; the per-site set must too.
      merged.push({
        firstPartyDomain: host,
        overrides: "+AllTargets,-ReduceTimerPrecision",
      });
    } else if (mode === "standard") {
      merged.push({ firstPartyDomain: host, overrides: FP_STANDARD });
    } else if (mode === "off") {
      merged.push({ firstPartyDomain: host, overrides: "-AllTargets" });
    }
  }
  try {
    Services.prefs.setStringPref(
      "privacy.fingerprintingProtection.granularOverrides",
      JSON.stringify(merged),
    );
  } catch {
    // Locked pref.
  }
}

const LANGUAGE_OBSERVER = {
  observe(subject, topic) {
    if (topic !== "http-on-modify-request" || !prefBool(LANGUAGE_PREF, false)) {
      return;
    }
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      channel.setRequestHeader("Accept-Language", "en-US,en;q=0.9", false);
    } catch {
      // Non-HTTP channels and system loads are left alone.
    }
  },
};

let _languageObserved = false;

function installLanguageObserver() {
  if (_languageObserved) return;
  try {
    Services.obs.addObserver(LANGUAGE_OBSERVER, "http-on-modify-request");
    _languageObserved = true;
  } catch {
    _languageObserved = false;
  }
}

function uninstallLanguageObserver() {
  if (!_languageObserved) return;
  try {
    Services.obs.removeObserver(LANGUAGE_OBSERVER, "http-on-modify-request");
  } catch {
    // Already gone.
  }
  _languageObserved = false;
}

function clearHost(host) {
  const key = normalizeHost(host);
  if (!key) return Promise.resolve(false);
  const chrome = chromeScope();
  if (!chrome) return Promise.resolve(false);
  return new Promise((resolve) => {
    const flags = Ci.nsIClearDataService.CLEAR_FORGET_ABOUT_SITE;
    let site = key;
    try {
      site = Services.eTLD.getSchemelessSite(key) || key;
    } catch {
      site = key;
    }
    if (typeof Services.clearData.deleteDataFromSite === "function") {
      try {
        Services.clearData.deleteDataFromSite(site, {}, true, flags, () =>
          resolve(true),
        );
        return;
      } catch {
        // Fall back to the per-host API on builds where the site API is not
        // callable from this context.
      }
    }
    try {
      Services.clearData.deleteDataFromHost(key, true, flags, () =>
        resolve(true),
      );
    } catch {
      resolve(false);
    }
  });
}

function forgetOnClose(host) {
  const key = normalizeHost(host);
  if (!key || privateActive()) return false;
  const defaultOn = prefBool(FORGET_PREF, false);
  const sites = new Set(readForgetSites());
  const ephemeral = prefBool(EPHEMERAL_PREF, false);
  if (!defaultOn && !ephemeral && !sites.has(key)) return false;
  void clearHost(key);
  return true;
}

function trackTab(_windowId, tabId, url) {
  // Tab ids are globally unique; window ids are not present on every event.
  const key = tabId;
  const host = hostOf(url);
  if (!host) return;
  _tabs.set(key, host);
}

function onEvent(event) {
  if (!event || typeof event.type !== "string") return;
  if (event.type === "items-changed") {
    const windowId = event.data?.window_id ?? "main";
    const tabs = Array.isArray(event.data?.tabs) ? event.data.tabs : [];
    for (const tab of tabs) {
      if (tab && typeof tab.id === "string") {
        trackTab(windowId, tab.id, tab.url);
      }
    }
    return;
  }
  if (event.type === "tab.closed") {
    const tabId = event.data?.astra_tab_id;
    const key = tabId;
    const host = _tabs.get(key);
    _tabs.delete(key);
    // "Forget me when I close this site" means the site's last tab, not every
    // tab of a site that is still open elsewhere.
    if (host && ![..._tabs.values()].includes(host)) forgetOnClose(host);
    return;
  }
  if (event.type === "nav.committed" || event.type === "tab.updated") {
    const windowId = event.data?.window_id ?? "main";
    const tabId = event.data?.astra_tab_id;
    const url = event.data?.url;
    if (tabId && url) trackTab(windowId, tabId, url);
  }
}

export function install() {
  if (_installed) return true;
  try {
    applyCookieMode();
    applyBounceProtection();
    applyFingerprinting();
    _dispose = addEventListener(onEvent);
    _installed = true;
  } catch {
    _installed = false;
  }
  return _installed;
}

export function uninstall() {
  if (!_installed) return;
  _installed = false;
  try {
    _dispose?.();
  } catch {
    // The event pump is already gone.
  }
  _dispose = null;
  uninstallLanguageObserver();
  _tabs.clear();
}

export function __resetPrivacyForTests() {
  uninstall();
  _installed = false;
  _tabs = new Map();
}

function activeOrigin() {
  try {
    const win =
      Services.focus?.activeWindow ??
      Services.wm.getMostRecentWindow("navigator:browser");
    const uri = win?.gBrowser?.selectedBrowser?.currentURI;
    if (!uri || (uri.scheme !== "http" && uri.scheme !== "https")) return "";
    return `${uri.scheme}://${uri.hostPort}`;
  } catch {
    return "";
  }
}

function permissionPrincipal(spec) {
  const uri = Services.io.newURI(spec);
  return Services.scriptSecurityManager.createContentPrincipal(uri, {});
}

function sitePermission(host) {
  try {
    const key = normalizeHost(host);
    let deny = false;
    let allow = false;
    const specs = ["http://", "https://"].map((scheme) => `${scheme}${key}/`);
    const origin = activeOrigin();
    if (origin) {
      try {
        const active = new URL(origin);
        if (active.hostname === key) specs.push(`${origin}/`);
      } catch {
        // Ignore a malformed active origin.
      }
    }
    for (const spec of specs) {
      const principal = permissionPrincipal(spec);
      const value = Services.perms.testExactPermissionFromPrincipal(principal, "cookie");
      if (value === Ci.nsICookiePermission.ACCESS_DENY) deny = true;
      if (value === Ci.nsICookiePermission.ACCESS_ALLOW) allow = true;
    }
    if (deny) return "block";
    if (allow) return "allow";
    return "default";
  } catch {
    return "default";
  }
}

function setSitePermission(host, value) {
  try {
    const key = normalizeHost(host);
    if (!key) return false;
    // A site is reachable over both schemes and, on a non-default port, the
    // permission key includes that port. Cover the standard origins and the
    // origin of the page in front.
    const specs = ["http://", "https://"].map((scheme) => `${scheme}${key}/`);
    const origin = activeOrigin();
    if (origin) {
      try {
        const active = new URL(origin);
        if (active.hostname === key) specs.push(`${origin}/`);
      } catch {
        // Ignore a malformed active origin.
      }
    }
    for (const spec of specs) {
      const principal = permissionPrincipal(spec);
      if (value === "default") {
        Services.perms.removeFromPrincipal(principal, "cookie");
      } else {
        Services.perms.addFromPrincipal(
          principal,
          "cookie",
          value === "allow"
            ? Ci.nsICookiePermission.ACCESS_ALLOW
            : Ci.nsICookiePermission.ACCESS_DENY,
          Ci.nsIPermissionManager.EXPIRE_NEVER,
        );
      }
    }
    return true;
  } catch {
    return false;
  }
}

export const Privacy = {
  async state() {
    install();
    return {
      cookies: cookieMode(),
      forget_on_close: prefBool(FORGET_PREF, false),
      forget_sites: readForgetSites(),
      ephemeral: prefBool(EPHEMERAL_PREF, false),
      fingerprinting: fingerprintMode(),
      language: prefBool(LANGUAGE_PREF, false),
      screen: prefBool(SCREEN_PREF, false),
      bounce_protection: prefBool(BTP_PREF, true),
      site_cookies: readSiteCookies(),
      site_fingerprints: readSiteFingerprints(),
      targets:
        fingerprintMode() === "off"
          ? []
          : fingerprintOverrides().replaceAll("+", "").split(",").filter(Boolean),
      cookie_behavior: (() => {
        try {
          return Services.prefs.getIntPref("network.cookie.cookieBehavior", 5);
        } catch {
          return 5;
        }
      })(),
      bounce_mode: (() => {
        try {
          return prefInt("privacy.bounceTrackingProtection.mode", 3);
        } catch {
          return 3;
        }
      })(),
    };
  },

  async configure({
    cookies = null,
    forget_on_close = null,
    ephemeral = null,
    fingerprinting = null,
    language = null,
    screen = null,
    bounce_protection = null,
  } = {}) {
    if (
      (cookies !== null && !COOKIE_MODES.has(cookies)) ||
      (forget_on_close !== null && typeof forget_on_close !== "boolean") ||
      (ephemeral !== null && typeof ephemeral !== "boolean") ||
      (fingerprinting !== null && !FP_MODES.has(fingerprinting)) ||
      (language !== null && typeof language !== "boolean") ||
      (screen !== null && typeof screen !== "boolean") ||
      (bounce_protection !== null &&
        typeof bounce_protection !== "boolean")
    ) {
      return { accepted: false, reason: "invalid_input" };
    }
    const chrome = chromeScope();
    if (!chrome) return { accepted: false, reason: "unsupported_command" };
    install();
    try {
      if (cookies !== null) writeString(COOKIE_MODE_PREF, cookies);
      if (forget_on_close !== null) writeBool(FORGET_PREF, forget_on_close);
      if (ephemeral !== null) writeBool(EPHEMERAL_PREF, ephemeral);
      if (fingerprinting !== null) {
        writeString(FINGERPRINT_PREF, fingerprinting);
      }
      if (language !== null) writeBool(LANGUAGE_PREF, language);
      if (screen !== null) writeBool(SCREEN_PREF, screen);
      if (bounce_protection !== null) {
        writeBool(BTP_PREF, bounce_protection);
      }
    } catch {
      return { accepted: false, reason: "store_admission_rejected" };
    }
    applyCookieMode();
    applyBounceProtection();
    applyFingerprinting();
    return {
      accepted: true,
      state: await Privacy.state(),
    };
  },

  async siteState({ host = "" } = {}) {
    const key = normalizeHost(host);
    if (!key) return { host: "", cookies: "default", forget: false, fingerprint: "" };
    install();
    return {
      host: key,
      cookies: sitePermission(key),
      forget: readForgetSites().includes(key),
      fingerprint: readSiteFingerprints()[key] ?? "",
    };
  },

  async siteConfigure({
    host = "",
    cookies = null,
    forget = null,
    fingerprint = null,
  } = {}) {
    const key = normalizeHost(host);
    if (!key) return { accepted: false, reason: "invalid_input" };
    if (
      (cookies !== null && !["default", "allow", "block"].includes(cookies)) ||
      (forget !== null && typeof forget !== "boolean") ||
      (fingerprint !== null &&
        fingerprint !== "" &&
        !FP_MODES.has(fingerprint))
    ) {
      return { accepted: false, reason: "invalid_input" };
    }
    const chrome = chromeScope();
    if (!chrome) return { accepted: false, reason: "unsupported_command" };
    if (privateActive()) return { accepted: false, reason: "invalid_scope" };
    install();
    if (cookies !== null) {
      if (!setSitePermission(key, cookies)) {
        return { accepted: false, reason: "store_admission_rejected" };
      }
      const map = readSiteCookies();
      if (cookies === "default") delete map[key];
      else map[key] = cookies;
      writeString(SITE_COOKIE_PREF, JSON.stringify(map));
    }
    if (forget !== null) {
      const sites = new Set(readForgetSites());
      if (forget) sites.add(key);
      else sites.delete(key);
      writeString(FORGET_SITES_PREF, JSON.stringify([...sites].sort()));
    }
    if (fingerprint !== null) {
      const map = readSiteFingerprints();
      if (fingerprint === "" ) delete map[key];
      else map[key] = fingerprint;
      writeString(SITE_FP_PREF, JSON.stringify(map));
      applySiteFingerprints();
    }
    return { accepted: true, state: await Privacy.siteState({ host: key }) };
  },

  async forgetSite({ host = "" } = {}) {
    const key = normalizeHost(host);
    if (!key) return { accepted: false, reason: "invalid_input" };
    const chrome = chromeScope();
    if (!chrome) return { accepted: false, reason: "unsupported_command" };
    if (privateActive()) return { accepted: false, reason: "invalid_scope" };
    const ok = await clearHost(key);
    return ok
      ? { accepted: true, reason: "mutation_applied" }
      : { accepted: false, reason: "native_work_pending" };
  },

  install,
  uninstall,
  __reset: __resetPrivacyForTests,
};

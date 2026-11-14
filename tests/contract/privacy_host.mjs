#!/usr/bin/env node
// Privacy host contract: prefs, cookie permissions, clear-data and the
// fingerprint/language/bounce bindings, exercised through a fake chrome.
//
// Usage: node tests/contract/privacy_host.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const prefs = new Map([
  ["intl.accept_languages", "de-DE, de"],
  ["privacy.bounceTrackingProtection.mode", 3],
  ["privacy.fingerprintingProtection.granularOverrides", "[]"],
]);
const observations = [];
const cleared = [];
const permissions = new Map();
let addedObserver = null;
let removedObserver = null;

const PREF_INVALID = 0;
const PREF_STRING = 32;
const PREF_INT = 64;
const PREF_BOOL = 128;

function getPref(name, fallback) {
  return prefs.has(name) ? prefs.get(name) : fallback;
}

globalThis.ChromeUtils = {};
globalThis.Cc = {};
globalThis.Services = {
  prefs: {
    PREF_INVALID,
    getPrefType(name) {
      if (!prefs.has(name)) return PREF_INVALID;
      const value = prefs.get(name);
      if (typeof value === "boolean") return PREF_BOOL;
      if (typeof value === "number") return PREF_INT;
      return PREF_STRING;
    },
    getBoolPref(name, fallback = false) {
      const value = getPref(name, fallback);
      return typeof value === "boolean" ? value : fallback;
    },
    getStringPref(name, fallback = "") {
      const value = getPref(name, fallback);
      return typeof value === "string" ? value : fallback;
    },
    getIntPref(name, fallback = 0) {
      const value = getPref(name, fallback);
      return typeof value === "number" ? value : fallback;
    },
    setBoolPref(name, value) {
      prefs.set(name, value);
    },
    setStringPref(name, value) {
      prefs.set(name, value);
    },
    setIntPref(name, value) {
      prefs.set(name, value);
    },
    prefHasUserValue(name) {
      return prefs.has(name);
    },
    clearUserPref(name) {
      prefs.delete(name);
    },
  },
  obs: {
    addObserver(observer, topic) {
      addedObserver = { observer, topic };
    },
    removeObserver(observer, topic) {
      removedObserver = { observer, topic };
    },
    notifyObservers(subject, topic) {
      observations.push({ subject, topic });
    },
  },
  io: {
    newURI(spec) {
      const url = new URL(spec);
      return { spec, host: url.hostname, scheme: url.protocol.replace(":", "") };
    },
  },
  scriptSecurityManager: {
    createContentPrincipal(uri) {
      return { host: uri.host, scheme: uri.scheme };
    },
  },
  perms: {
    testExactPermissionFromPrincipal(principal, type) {
      return permissions.get(`${principal.host}:${type}`) ?? 0;
    },
    addFromPrincipal(principal, type, capability) {
      permissions.set(`${principal.host}:${type}`, capability);
    },
    removeFromPrincipal(principal, type) {
      permissions.delete(`${principal.host}:${type}`);
    },
  },
  eTLD: {
    getSchemelessSite(host) {
      return host;
    },
  },
  clearData: {
    deleteDataFromSite(site, _pattern, _user, flags, callback) {
      cleared.push({ host: site, flags });
      callback?.();
    },
    deleteDataFromHost(host, _user, flags, callback) {
      cleared.push({ host, flags });
      callback?.();
    },
  },
};

globalThis.Ci = {
  nsICookiePermission: { ACCESS_ALLOW: 1, ACCESS_DENY: 2, ACCESS_SESSION: 8 },
  nsIPermissionManager: { EXPIRE_NEVER: 0 },
  nsIClearDataService: { CLEAR_FORGET_ABOUT_SITE: 0x80000000 },
};

const { Privacy, install, uninstall } = await import(pathToFileURL(path.join(HOST, "Privacy.sys.mjs")).href);

// --- defaults ---------------------------------------------------------------
const initial = await Privacy.state();
check("default cookie mode is partition", initial.cookies === "partition");
check("default fingerprint mode is standard", initial.fingerprinting === "standard");
check("default bounce protection is on", initial.bounce_protection === true);
check("language is off by default", initial.language === false);

// --- configure --------------------------------------------------------------
const applied = await Privacy.configure({
  cookies: "block-third-party",
  fingerprinting: "aggressive",
  language: true,
  screen: true,
  bounce_protection: true,
});
check("configure accepted", applied.accepted === true);
check(
  "cookie behavior reached the engine pref",
  prefs.get("network.cookie.cookieBehavior") === 1,
  String(prefs.get("network.cookie.cookieBehavior")),
);
const overrides = prefs.get("privacy.fingerprintingProtection.overrides");
check(
  "aggressive fingerprint set includes screen and locale",
  typeof overrides === "string" && overrides.includes("ScreenRect") && overrides.includes("JSLocale"),
  String(overrides).slice(0, 120),
);
check("bounce tracking protection set to active purge", prefs.get("privacy.bounceTrackingProtection.mode") === 1);
check("Accept-Language was spoofed", prefs.get("intl.accept_languages") === "en-US, en");
check("language observer installed", addedObserver?.topic === "http-on-modify-request");

// --- invalid input ----------------------------------------------------------
const bad = await Privacy.configure({ cookies: "nonsense" });
check("invalid cookie mode refused", bad.accepted === false && bad.reason === "invalid_input");

// --- per-site cookies -------------------------------------------------------
const blocked = await Privacy.siteConfigure({ host: "Example.COM", cookies: "block" });
check("site cookie block accepted", blocked.accepted === true);
check("site cookie permission is DENY", permissions.get("example.com:cookie") === 2);
check("site state reads the block", blocked.state.cookies === "block");
const allowed = await Privacy.siteConfigure({ host: "example.com", cookies: "allow" });
check("site cookie allow sets ALLOW", allowed.state.cookies === "allow");
const reset = await Privacy.siteConfigure({ host: "example.com", cookies: "default" });
check("site cookie default removes the permission", reset.state.cookies === "default");

// --- forget -----------------------------------------------------------------
const forgot = await Privacy.forgetSite({ host: "example.com" });
check("forget site accepted", forgot.accepted === true);
check(
  "forget uses the engine forget-about-site flag",
  cleared.length === 1 && cleared[0].host === "example.com" && cleared[0].flags === 0x80000000,
  JSON.stringify(cleared),
);

// --- disable + teardown -----------------------------------------------------
const off = await Privacy.configure({
  fingerprinting: "off",
  language: false,
  screen: false,
  bounce_protection: false,
  cookies: "partition",
});
check("fingerprinting can be turned off", off.accepted === true && prefs.get("privacy.fingerprintingProtection") === false);
check("bounce protection disabled", prefs.get("privacy.bounceTrackingProtection.mode") === 0);
check("language restored", prefs.get("intl.accept_languages") === "de-DE, de");
uninstall();
check("uninstall removes the language observer", removedObserver?.topic === "http-on-modify-request");

console.log(`privacy host contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);

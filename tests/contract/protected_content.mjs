#!/usr/bin/env node
// Protected content contract (EME / Widevine L3).
//
// This is the strict gate that keeps DRM native instead of drifting back to a
// mock or a Firefox-owned surface. It proves:
//   - the shipped autoconfig enables EME, exposes Widevine, and suppresses the
//     engine's own "enable DRM" doorhanger
//   - the CDM update host is classified KEEP with an owner sign-off
//   - the Settings host maps `privacy.drm` to the real `media.eme.enabled`
//     pref and writes/reads it back
//   - the app declares the setting and renders a control for it
//
// Usage: node tests/contract/protected_content.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

// --- shipped posture -----------------------------------------------------
const cfg = read("overlay/astra/mozilla.cfg");
check("autoconfig enables EME", /defaultPref\("media\.eme\.enabled",\s*true\)/.test(cfg));
check(
  "autoconfig exposes the Widevine CDM",
  /defaultPref\("media\.gmp-widevinecdm\.visible",\s*true\)/.test(cfg) &&
    /defaultPref\("media\.gmp-widevinecdm\.enabled",\s*true\)/.test(cfg),
);
check(
  "autoconfig suppresses the engine's DRM doorhanger",
  /defaultPref\("browser\.eme\.ui\.enabled",\s*false\)/.test(cfg),
);

// --- CDM update endpoint -------------------------------------------------
const toml = read("tools/endpoint-audit/classify.toml");
const endpoint = toml
  .split("[[endpoint]]")
  .find((block) => /host\s*=\s*"update\.googleapis\.com"/.test(block));
check("update.googleapis.com is classified", endpoint !== undefined);
check("update.googleapis.com is a KEEP", /class\s*=\s*"KEEP"/.test(endpoint ?? ""));
check("update.googleapis.com has owner sign-off", /owner_signoff\s*=\s*true/.test(endpoint ?? ""));

// --- host wiring ---------------------------------------------------------
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { Settings, __resetSettingsForTests, __setPrefsForTests, __setContentPrefsForTests } =
  await import(pathToFileURL(path.join(HOST, "Settings.sys.mjs")).href);
const { __resetEventsForTests } = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

const values = new Map();
const prefs = {
  getBoolPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  getIntPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  getStringPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  setBoolPref: (name, value) => values.set(name, value === true),
  setIntPref: (name, value) => values.set(name, value),
  setStringPref: (name, value) => values.set(name, value),
  clearUserPref: (name) => values.delete(name),
  addObserver: () => {},
  removeObserver: () => {},
};

__resetSettingsForTests();
__resetEventsForTests();
__setPrefsForTests(prefs);
__setContentPrefsForTests(null);

// Start from the engine's Linux default, then let the setting turn EME on.
values.set("media.eme.enabled", false);
values.set("browser.eme.ui.enabled", true);
check("privacy.drm reads the engine pref", (await Settings.get({ key: "privacy.drm" })) === "false");

const on = await Settings.set({ key: "privacy.drm", value: "true" });
check("privacy.drm accepts 'true'", on.accepted === true);
check("privacy.drm writes media.eme.enabled", values.get("media.eme.enabled") === true);
check("privacy.drm hides the engine doorhanger", values.get("browser.eme.ui.enabled") === false);
check("privacy.drm reads back", (await Settings.get({ key: "privacy.drm" })) === "true");

const off = await Settings.set({ key: "privacy.drm", value: "false" });
check("privacy.drm accepts 'false'", off.accepted === true);
check("privacy.drm clears media.eme.enabled", values.get("media.eme.enabled") === false);
check("a non-flag value is refused", (await Settings.set({ key: "privacy.drm", value: "maybe" })).accepted === false);

// --- app surface ---------------------------------------------------------
const catalog = read("ui/app/src/features/settings/lib/catalog.ts");
check("the settings catalog declares privacy.drm", catalog.includes('"privacy.drm"'));
const page = read("ui/app/src/features/settings/components/sections/PrivacyPage.svelte");
check("the Privacy page renders the privacy.drm control", page.includes("privacy.drm"));

const en = JSON.parse(read("ui/app/messages/en.json"));
check("English label exists", typeof en.privacy_drm === "string" && en.privacy_drm.length > 0);
check("English help exists", typeof en.privacy_drm_help === "string" && en.privacy_drm_help.length > 0);
check(
  "the copy states the L3 / no-4K limit",
  /L3/i.test(en.privacy_protected_group_help ?? "") && /4K/i.test(en.privacy_protected_group_help ?? ""),
);

if (failed) {
  console.error(`protected-content contract: FAIL (${failed} of ${passed + failed})`);
  process.exit(1);
}
console.log(`protected-content contract: PASS (${passed} checks)`);

#!/usr/bin/env node
// Lane 6 contract: Zoom levels, the Home command and the window material.
//
//   - `zoom_call` lists/removes the real `browser.content.full-zoom` sites
//     through the content-pref service, keeps the global default zoom, and
//     refuses a private profile (nothing recorded, nothing read back)
//   - `zoom.in`/`zoom.out`/`zoom.reset` write the active site's level only
//     when `browser.zoom.siteSpecific` is on and the tab is not private
//   - `nav.home` lands on `tabs.home`, falls back to the first startup page,
//     then Astra's New Tab; it is an advertised command
//   - `ui_info` reports the material tier this build can draw, and only the
//     tiers that tier's platform can install
//
// Usage: node tests/contract/zoom_home_material.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Tabs, Navigation, Commands, Zoom, Settings, System } = HostAPI;
const ZoomMod = await import(path.join(HOST, "Zoom.sys.mjs"));
const SystemMod = await import(path.join(HOST, "System.sys.mjs"));
const TabsMod = await import(path.join(HOST, "Tabs.sys.mjs"));
const { __setPrefsForTests } = await import(path.join(HOST, "Settings.sys.mjs"));

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

// --- Firefox pref service stand-in ---------------------------------------
const values = new Map();
const observers = new Set();
function notify(name) {
  for (const observer of observers) observer.observe(null, "nsPref:changed", name);
}
const prefs = {
  getBoolPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  getIntPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  getStringPref: (name, fallback) => (values.has(name) ? values.get(name) : fallback),
  setBoolPref: (name, value) => {
    values.set(name, value === true);
    notify(name);
  },
  setIntPref: (name, value) => {
    values.set(name, value);
    notify(name);
  },
  setStringPref: (name, value) => {
    values.set(name, value);
    notify(name);
  },
  clearUserPref: (name) => {
    if (!values.delete(name)) return;
    notify(name);
  },
  getDefaultBranch: () => ({ setIntPref() {} }),
  addObserver: (_branch, observer) => observers.add(observer),
  removeObserver: (observer) => observers.delete(observer),
};

// --- nsIContentPrefService2 stand-in -------------------------------------
const zoomStore = new Map();
const contentPrefs = {
  global: undefined,
  getByName(_name, _context, callback) {
    for (const [domain, value] of zoomStore) {
      callback.handleResult({ domain, name: "browser.content.full-zoom", value });
    }
    callback.handleCompletion(0);
  },
  getGlobal(_name, _context, callback) {
    if (this.global !== undefined) {
      callback.handleResult({ domain: "", name: "browser.content.full-zoom", value: this.global });
    }
    callback.handleCompletion(0);
  },
  setGlobal(_name, value, _context, callback) {
    this.global = value;
    callback.handleCompletion(0);
  },
  set(group, _name, value, _context, callback) {
    let domain;
    try {
      domain = new URL(group).hostname;
    } catch {
      domain = String(group);
    }
    zoomStore.set(domain, value);
    callback.handleCompletion(0);
  },
  removeByDomainAndName(domain, _name, _context, callback) {
    zoomStore.delete(domain);
    callback.handleCompletion(0);
  },
  removeByName(_name, _context, callback) {
    zoomStore.clear();
    this.global = undefined;
    callback.handleCompletion(0);
  },
};

function resetHost() {
  HostAPI.__resetForTests();
  values.clear();
  observers.clear();
  zoomStore.clear();
  contentPrefs.global = undefined;
  __setPrefsForTests(prefs);
  ZoomMod.__setPrefsForTests(prefs);
  ZoomMod.__setContentPrefsForTests(contentPrefs);
  SystemMod.__setSystemPrefsForTests(prefs);
  SystemMod.__setPlatformForTests({ os: "Linux", build: "6.8.0" });
}

resetHost();

function levelsOf(res) {
  return Array.isArray(res?.levels) ? res.levels : [];
}

// === Zoom levels =========================================================
{
  zoomStore.set("github.com", 0.8);
  zoomStore.set("nytimes.com", 1.25);
  contentPrefs.global = 1;

  const listed = await Zoom.call({
    request_id: "z-1",
    expected_profile: "default",
    call: { kind: "levels" },
  });
  check("zoom_call levels answers a levels view", listed?.kind === "levels", JSON.stringify(listed));
  check(
    "zoom_call lists the real sites in order",
    levelsOf(listed)
      .map((level) => `${level.site}:${level.percent}`)
      .join(",") === "github.com:80,nytimes.com:125",
    JSON.stringify(levelsOf(listed)),
  );
  check("the global default zoom is not listed as a site", levelsOf(listed).length === 2);

  const forgotten = await Zoom.call({
    request_id: "z-2",
    expected_profile: "default",
    call: { kind: "forget", site: "github.com" },
  });
  check(
    "zoom_call forget removes one site from the store",
    !zoomStore.has("github.com") && levelsOf(forgotten).length === 1,
  );

  const badSite = await Zoom.call({
    request_id: "z-3",
    expected_profile: "default",
    call: { kind: "forget", site: "not a site" },
  });
  check("zoom_call forget rejects an invalid site", badSite?.kind === "error" && badSite.error === "invalid");

  zoomStore.set("example.org", 1.5);
  contentPrefs.global = 1.25;
  const cleared = await Zoom.call({
    request_id: "z-4",
    expected_profile: "default",
    call: { kind: "forget_all" },
  });
  check(
    "zoom_call forget_all clears every site",
    zoomStore.size === 0 && levelsOf(cleared).length === 0,
  );
  check("reset all keeps the global default zoom", Math.abs(contentPrefs.global - 1.25) < 0.0001);

  zoomStore.set("kept.example", 1.5);
  const privateRead = await Zoom.call({
    request_id: "z-5",
    expected_profile: "incognito",
    call: { kind: "levels" },
  });
  check("a private profile reads no site levels", levelsOf(privateRead).length === 0);
  const privateClear = await Zoom.call({
    request_id: "z-6",
    expected_profile: "incognito",
    call: { kind: "forget_all" },
  });
  check(
    "a private profile cannot clear the normal store",
    privateClear?.kind === "levels" && zoomStore.has("kept.example"),
  );

  const badKind = await Zoom.call({ request_id: "z-7", expected_profile: "default", call: { kind: "wat" } });
  check("an unknown zoom call is invalid", badKind?.kind === "error" && badKind.error === "invalid");
}

// === Persisting a zoom change ===========================================
{
  resetHost();
  values.set("browser.zoom.siteSpecific", true);

  check("persist writes a site level", await Zoom.persist({ url: "https://zoom.example/page", zoom: 1.5 }));
  check("persist stores the fraction", Math.abs(zoomStore.get("zoom.example") - 1.5) < 0.0001);
  check("persist at 100% removes the site override", await Zoom.persist({ url: "https://zoom.example/page", zoom: 1 }));
  check("the override is gone", !zoomStore.has("zoom.example"));

  check(
    "a private tab never writes",
    (await Zoom.persist({ url: "https://private.example/", zoom: 1.5, private: true })) === false &&
      !zoomStore.has("private.example"),
  );

  values.set("browser.zoom.siteSpecific", false);
  check(
    "site-specific off never writes",
    (await Zoom.persist({ url: "https://global.example/", zoom: 1.5 })) === false &&
      !zoomStore.has("global.example"),
  );

  values.set("browser.zoom.siteSpecific", true);
  check(
    "a non-web page never writes",
    (await Zoom.persist({ url: "about:blank", zoom: 1.5 })) === false,
  );

  // zoom.in/out/reset go through Commands, which persists the active tab.
  const tab = await Tabs.create({ request_id: "z-8", url: "https://command.example/page" });
  const zoomed = await Commands.run({ id: "zoom.in" });
  check("zoom.in is admitted", zoomed.accepted === true);
  check(
    "zoom.in persisted the active site",
    Math.abs(zoomStore.get("command.example") - 1.1) < 0.0001,
    String(zoomStore.get("command.example")),
  );
  // Reset lands on the global default but removes the site override, so no
  // row is left behind at the default level.
  contentPrefs.global = 1.25;
  const resetZoom = await Commands.run({ id: "zoom.reset" });
  check("zoom.reset is admitted", resetZoom.accepted === true);
  check("zoom.reset removed the site override", !zoomStore.has("command.example"));
  const resetLevel = await Navigation.getZoom({
    request_id: "z-9",
    astra_tab_id: tab.astra_tab_id,
  });
  check("zoom.reset lands on the default zoom", Math.abs(resetLevel.zoom - 1.25) < 0.0001, String(resetLevel.zoom));

  TabsMod.__markPrivate(tab.astra_tab_id, true);
  await Commands.run({ id: "zoom.in" });
  check("a private window's zoom change never reaches the store", !zoomStore.has("command.example"));
}

// === Home command ========================================================
{
  resetHost();
  const tab = await Tabs.create({ request_id: "h-1", url: "https://before.example/" });

  const supported = await Commands.supported();
  check("nav.home is an advertised command", supported.includes("nav.home"));

  await Settings.set({ key: "tabs.home", value: "https://home.example/start" });
  const home = await Commands.run({ id: "nav.home" });
  check("nav.home is admitted", home.accepted === true);
  const afterHome = (await Tabs.get({ request_id: "h-2", astra_tab_id: tab.astra_tab_id })).tab;
  check("nav.home opens the saved home page", afterHome.url === "https://home.example/start", afterHome.url);

  // Clearing the choice falls back to the first startup page.
  await Settings.set({ key: "tabs.home", value: "" });
  prefs.setStringPref("browser.startup.homepage", "https://startup.example/|https://second.example/");
  await Commands.run({ id: "nav.home" });
  const afterStartup = (await Tabs.get({ request_id: "h-3", astra_tab_id: tab.astra_tab_id })).tab;
  check(
    "nav.home falls back to the first startup page",
    afterStartup.url === "https://startup.example/",
    afterStartup.url,
  );

  // With neither, Astra's New Tab (about:blank) is the page.
  prefs.clearUserPref("browser.startup.homepage");
  await Commands.run({ id: "nav.home" });
  const afterBlank = (await Tabs.get({ request_id: "h-4", astra_tab_id: tab.astra_tab_id })).tab;
  check("nav.home falls back to the New Tab", afterBlank.url === "about:blank", afterBlank.url);

  // An explicit about:newtab is Astra's New Tab too, not a search.
  await Settings.set({ key: "tabs.home", value: "about:newtab" });
  await Commands.run({ id: "nav.home" });
  const afterNewTab = (await Tabs.get({ request_id: "h-5", astra_tab_id: tab.astra_tab_id })).tab;
  check("about:newtab means the New Tab surface", afterNewTab.url === "about:blank", afterNewTab.url);
}

// === Window material =====================================================
{
  resetHost();
  SystemMod.__setPlatformForTests({ os: "Linux", build: "6.8.0" });
  await Settings.set({ key: "ui.material", value: "liquid_glass" });
  const linux = await System.uiInfo();
  check("Linux reports the opaque tier", linux.material === "none", linux.material);
  check(
    "Linux offers only the solid tier",
    JSON.stringify(linux.materials) === JSON.stringify(["none"]),
    JSON.stringify(linux.materials),
  );
  check(
    "Linux does not write the Windows Mica switch",
    !values.has("widget.windows.mica"),
  );

  SystemMod.__setPlatformForTests({ os: "Darwin", build: "24.0.0" });
  const mac = await System.uiInfo();
  check("macOS reports only a tier this build can draw", mac.material === "none");
  check("macOS offers only the solid tier", JSON.stringify(mac.materials) === JSON.stringify(["none"]));

  // Windows before 22H2 has no Mica.
  SystemMod.__setPlatformForTests({ os: "WINNT", build: "19045" });
  values.set("astra.settings.ui.material", "auto");
  const oldWindows = await System.uiInfo();
  check("Windows 10 offers only the solid tier", JSON.stringify(oldWindows.materials) === JSON.stringify(["none"]));
  check("Windows 10 resolves automatic to solid", oldWindows.material === "none");

  // Windows 11 22H2+ installs Mica through the widget switch.
  SystemMod.__setPlatformForTests({ os: "WINNT", build: "22631" });
  const automatic = await System.uiInfo();
  check("Windows 11 offers solid and Mica", JSON.stringify(automatic.materials) === JSON.stringify(["none", "mica"]));
  check("automatic resolves to Mica on Windows 11", automatic.material === "mica", automatic.material);
  check("Mica is applied through the widget pref", values.get("widget.windows.mica") === true);

  await Settings.set({ key: "ui.material", value: "none" });
  const solid = await System.uiInfo();
  check("choosing solid resolves to solid", solid.material === "none");
  check("solid turns the Mica switch off", values.get("widget.windows.mica") === false);

  // A stored tier the platform does not have is never announced.
  await Settings.set({ key: "ui.material", value: "liquid_glass" });
  const unsupported = await System.uiInfo();
  check(
    "an unsupported stored tier falls back to solid",
    unsupported.material === "none" && values.get("widget.windows.mica") === false,
  );
}

console.log(`\nzoom/home/material: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);

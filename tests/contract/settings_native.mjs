#!/usr/bin/env node
// Settings contract: browser settings are bound to the prefs Firefox owns.
//
//   - a mapped key reads and writes its real pref (and reads back the same
//     Astra value, so the app's verified readback succeeds)
//   - an unmapped (Astra-only) key stays in the session store
//   - a bad value is refused without touching the pref
//   - a pref changed outside the app is pushed on `ui-command`
//   - startup pages and performance exceptions may carry a newline list,
//     while other control characters stay rejected
//
// Usage: node tests/contract/settings_native.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const { Settings, __resetSettingsForTests, __setPrefsForTests, __setContentPrefsForTests } =
  await import(path.join(HOST, "Settings.sys.mjs"));
const { addEventListener, __resetEventsForTests } = await import(
  path.join(HOST, "Events.sys.mjs")
);

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
  addObserver: (_branch, observer) => observers.add(observer),
  removeObserver: (observer) => observers.delete(observer),
};

let globalZoom = 1;
const content = {
  getCachedGlobal: () => ({ value: String(globalZoom) }),
  getGlobal(_name, _context, callback) {
    callback.handleResult({ value: String(globalZoom) });
    callback.handleCompletion();
  },
  setGlobal(_name, value, _context, callback) {
    globalZoom = value;
    callback.handleCompletion();
  },
};

function reset() {
  __resetSettingsForTests();
  values.clear();
  observers.clear();
  globalZoom = 1;
  __resetEventsForTests();
  __setPrefsForTests(prefs);
  __setContentPrefsForTests(content);
}

async function read(key) {
  return Settings.get({ key });
}

async function write(key, value) {
  return Settings.set({ key, value });
}

reset();

// --- defaults come from Firefox ------------------------------------------
check("default proxy is the system proxy", (await read("network.proxy")) === "system");
check("default density is comfortable", (await read("ui.density")) === "comfortable");
check("default camera permission is Ask", (await read("privacy.camera")) === "Ask");
check("default default-zoom is 100%", (await read("zoom.default")) === "100");

// --- each mapped setting writes its pref and reads back ------------------
const cases = [
  ["tabs.new-position", "after-current", "browser.tabs.insertAfterCurrent", true],
  ["tabs.external-position", "after-current", "browser.link.open_newwindow.override.external", 7],
  ["tabs.automatic-pip", "true", "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true],
  ["tabs.startup", "continue", "browser.startup.page", 3],
  ["search.suggestions", "false", "browser.search.suggest.enabled", false],
  ["search.history", "false", "browser.urlbar.suggest.history", false],
  ["privacy.smartscreen", "false", "browser.safebrowsing.malware.enabled", false],
  ["privacy.drm", "true", "media.eme.enabled", true],
  ["privacy.cleanup", "true", "privacy.sanitize.sanitizeOnShutdown", true],
  ["privacy.camera", "Block", "permissions.default.camera", 2],
  ["privacy.microphone", "Allow", "permissions.default.microphone", 1],
  ["privacy.location", "Block", "permissions.default.geo", 2],
  ["privacy.notifications", "Allow", "permissions.default.desktop-notification", 1],
  ["performance.sleep", "true", "browser.tabs.unloadOnLowMemory", true],
  ["performance.after", "30", "browser.tabs.min_inactive_duration_before_unload", 1800000],
  ["ui.density", "compact", "browser.uidensity", 1],
  ["ui.reduce-motion", "true", "ui.prefersReducedMotion", 1],
];
for (const [key, value, pref, expected] of cases) {
  const result = await write(key, value);
  check(`${key}: write is admitted`, result.accepted === true);
  check(`${key}: writes ${pref}`, values.get(pref) === expected, String(values.get(pref)));
  check(`${key}: reads back "${value}"`, (await read(key)) === value, String(await read(key)));
}

// --- multi-pref settings -------------------------------------------------
await write("privacy.smartscreen", "true");
check(
  "smartscreen writes both checks",
  values.get("browser.safebrowsing.malware.enabled") === true &&
    values.get("browser.safebrowsing.phishing.enabled") === true,
);
await write("tabs.new-position", "end");
check(
  "new-tab position writes both insertion prefs",
  values.get("browser.tabs.insertAfterCurrent") === false &&
    values.get("browser.tabs.insertRelatedAfterCurrent") === false,
);

// --- startup pages -------------------------------------------------------
const pages = ["https://a.example/", "https://b.example/"];
check("startup pages accept a newline list", (await write("tabs.startup-pages", pages.join("\n"))).accepted);
check(
  "startup pages are stored pipe-separated",
  values.get("browser.startup.homepage") === pages.join("|"),
  String(values.get("browser.startup.homepage")),
);
check("startup pages read back", (await read("tabs.startup-pages")) === pages.join("\n"));
check("startup pages clear to the native default", (await write("tabs.startup-pages", "")).accepted);
check("a cleared homepage is the native default", !values.has("browser.startup.homepage"));

// --- proxy ---------------------------------------------------------------
check("proxy mode http is admitted", (await write("network.proxy", "http")).accepted);
check("proxy mode writes manual type", values.get("network.proxy.type") === 1);
check("proxy address is admitted", (await write("network.proxy-address", "proxy.example:3128")).accepted);
check("proxy address writes the http host", values.get("network.proxy.http") === "proxy.example");
check("proxy address writes the http port", values.get("network.proxy.http_port") === 3128);
check("proxy address reads back", (await read("network.proxy-address")) === "proxy.example:3128");
check("proxy switch to socks5 is admitted", (await write("network.proxy", "socks5")).accepted);
check("socks5 clears the http host", !values.has("network.proxy.http"));
check("socks5 without an address reads back", (await read("network.proxy")) === "socks5");
check("socks address is admitted", (await write("network.proxy-address", "socks.example:1080")).accepted);
check("socks address writes the host", values.get("network.proxy.socks") === "socks.example");
check("socks address writes the port", values.get("network.proxy.socks_port") === 1080);
check("socks address reads back", (await read("network.proxy-address")) === "socks.example:1080");
check("an address without a port is refused", !(await write("network.proxy-address", "nope")).accepted);
check("a bad port is refused", !(await write("network.proxy-address", "host:99999")).accepted);
check("proxy mode system is admitted", (await write("network.proxy", "system")).accepted);
check("system proxy writes type 5", values.get("network.proxy.type") === 5);

// --- default zoom (content pref service) ---------------------------------
check("default zoom is admitted", (await write("zoom.default", "125")).accepted);
check("default zoom writes the content pref", globalZoom === 1.25, String(globalZoom));
check("default zoom reads back", (await read("zoom.default")) === "125");
check("an out-of-range zoom is refused", !(await write("zoom.default", "900").accepted));

// --- Astra-only keys are durable in the profile -------------------------
check("an Astra-only setting is admitted", (await write("ntp.clock", "false")).accepted);
check("an Astra-only setting reads back", (await read("ntp.clock")) === "false");
check(
  "an Astra-only setting is stored under the Astra branch",
  values.get("astra.settings.ntp.clock") === "false",
  String(values.get("astra.settings.ntp.clock")),
);
check(
  "an Astra-only setting does not invent a Firefox browser pref",
  ![...values.keys()].some((name) => name.includes("ntp") && !name.startsWith("astra.settings.")),
);
check("performance exceptions accept a newline list", (await write("performance.exceptions", "a.example\nb.example")).accepted);
check(
  "performance exceptions persist under the Astra branch",
  values.get("astra.settings.performance.exceptions") === "a.example\nb.example",
);

// A restart clears the in-memory session; the profile value must remain.
__resetSettingsForTests();
__setPrefsForTests(prefs);
__setContentPrefsForTests(content);
check("an Astra-only setting survives a restart", (await read("ntp.clock")) === "false");
check("startup pages survive a restart", (await read("tabs.startup-pages")) === "");
check("density survives a restart", (await read("ui.density")) === "compact");

// --- refusals ------------------------------------------------------------
check("an unknown key is accepted as Astra state", (await write("astra.unknown", "x")).accepted);
check("a control character is refused", !(await write("ntp.wordmark", "a\u0007b")).accepted);
check("an empty key is refused", !(await write("", "x")).accepted);
check("an empty read is null", (await read("")) === null);

// --- a pref change made elsewhere is announced ---------------------------
const pushed = [];
const stop = addEventListener((event) => {
  if (event.type === "ui-command" && typeof event.data === "string") pushed.push(event.data);
});
values.set("ui.prefersReducedMotion", 0);
notify("ui.prefersReducedMotion");
values.set("astra.settings.ntp.clock", "true");
notify("astra.settings.ntp.clock");
stop();
check(
  "an external pref change pushes the decoded value",
  pushed.includes("preference.ui.reduce-motion=false"),
  pushed.join(","),
);
check(
  "an external Astra pref change is announced too",
  pushed.includes("preference.ntp.clock=true"),
  pushed.join(","),
);
check("the changed pref is re-read", (await read("ui.reduce-motion")) === "false");
check("the changed Astra pref is re-read", (await read("ntp.clock")) === "true");

// --- no chrome: mapped keys fall back to the session value ---------------
__resetSettingsForTests();
const fallback = await write("ui.density", "compact");
check("outside chrome a mapped write is still admitted", fallback.accepted === true);
check("outside chrome a mapped key reads its session value", (await read("ui.density")) === "compact");
__resetSettingsForTests();
check("outside chrome a mapped key falls back to its default", (await read("ui.density")) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

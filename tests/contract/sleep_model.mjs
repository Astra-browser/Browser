#!/usr/bin/env node
// Sleeping-tabs contract: the host driver reads the real Settings keys and
// applies the same pure policy as `crates/astra-core/src/sleeping.rs`, then
// drives the model and checks the native discard actually happened.
//
//   - `shouldSleep` matches the Rust order: active, already discarded,
//     audible, pinned, DevTools, idle timeout
//   - moderate pressure halves the delay; critical discards any inactive tab
//   - `selectForSleep` returns oldest first and honours the batch cap
//   - `readPolicy` maps performance.sleep/after/memory/exceptions, and
//     "keep-ready" turns background unload off
//   - exceptions are normalised to a host and cover subdomains
//   - a tick discards an idle tab, leaves the selected/audible/pinned/
//     excepted tabs awake, and reverts the model when the engine refuses
//   - selecting a sleeping tab clears the sleeping projection (the wake path)
//   - the driver timer and listeners are released by stop()/reset
//
// Usage: node tests/contract/sleep_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const Events = await import(path.join(HOST, "Events.sys.mjs"));
const TabsMod = await import(path.join(HOST, "Tabs.sys.mjs"));
const SettingsMod = await import(path.join(HOST, "Settings.sys.mjs"));
const PerfMod = await import(path.join(HOST, "Performance.sys.mjs"));

const { Tabs } = TabsMod;
const { Settings, __resetSettingsForTests } = SettingsMod;
const {
  Performance,
  DEFAULT_IDLE_TIMEOUT_MS,
  AFTER_MINUTES,
  effectiveTimeoutMs,
  shouldSleep,
  selectForSleep,
  tabState,
  parseExceptions,
  isExcepted,
  readPolicy,
  __setBrowserForTests,
  __setClockForTests,
  __resetPerformanceForTests,
} = PerfMod;

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

// === Pure policy: the Rust cases =========================================
{
  const config = { idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS };
  const idle = (id, ms) => tabState({ id, last_active_ms: NOW - ms });

  check("a fresh tab stays", shouldSleep(idle("fresh", 1000), NOW, config).reason === "recently-active");
  check("a stale tab sleeps", shouldSleep(idle("stale", DEFAULT_IDLE_TIMEOUT_MS + 1), NOW, config).sleep === true);
  check("exactly at the timeout sleeps", shouldSleep(idle("edge", DEFAULT_IDLE_TIMEOUT_MS), NOW, config).sleep === true);
  check(
    "a future timestamp stays",
    shouldSleep(tabState({ id: "skew", last_active_ms: NOW + MINUTE }), NOW, config).reason === "recently-active",
  );

  const stale = DEFAULT_IDLE_TIMEOUT_MS + MINUTE;
  const exclusions = [
    ["active", tabState({ id: "a", last_active_ms: NOW - stale, active: true })],
    ["already-discarded", tabState({ id: "d", last_active_ms: NOW - stale, discarded: true })],
    ["audible", tabState({ id: "s", last_active_ms: NOW - stale, audible: true })],
    ["pinned", tabState({ id: "p", last_active_ms: NOW - stale, pinned: true })],
    ["devtools", tabState({ id: "t", last_active_ms: NOW - stale, devtools_open: true })],
  ];
  for (const [reason, tab] of exclusions) {
    const decision = shouldSleep(tab, NOW, config, "critical");
    check(`${reason} never sleeps even under critical pressure`, decision.sleep === false && decision.reason === reason);
  }

  const short = { idle_timeout_ms: MINUTE };
  const half = tabState({ id: "h", last_active_ms: NOW - 30_000 });
  check("moderate pressure halves the delay", shouldSleep(half, NOW, short, "none").sleep === false && shouldSleep(half, NOW, short, "moderate").sleep === true);
  check("critical pressure sleeps anything inactive", shouldSleep(tabState({ id: "c", last_active_ms: NOW }), NOW, short, "critical").sleep === true);
  check("none keeps the full delay", effectiveTimeoutMs(60_000, "none") === 60_000);
  check("moderate halves the delay", effectiveTimeoutMs(60_001, "moderate") === 30_001);
  check("critical is zero", effectiveTimeoutMs(60_000, "critical") === 0);

  const tabs = [
    tabState({ id: "new", last_active_ms: NOW - 20_000 }),
    tabState({ id: "old", last_active_ms: NOW - 90_000 }),
    tabState({ id: "fresh", last_active_ms: NOW - 1000 }),
    tabState({ id: "excluded", last_active_ms: NOW - 90_000, audible: true }),
  ];
  const chosen = selectForSleep(tabs, NOW, { idle_timeout_ms: 10_000 }, "none", Number.MAX_SAFE_INTEGER);
  check("candidates are oldest first", chosen.map((t) => t.id).join(",") === "old,new");
  check("the cap is applied", selectForSleep(tabs, NOW, { idle_timeout_ms: 10_000 }, "none", 1).length === 1);
}

// === Settings -> policy ==================================================
{
  const values = new Map();
  const read = (key, fallback) => values.get(key) ?? fallback;
  check("sleep defaults on", readPolicy(read).enabled === true);
  check("after defaults to 15 minutes", readPolicy(read).idleMs === AFTER_MINUTES[15]);

  for (const [value, ms] of Object.entries(AFTER_MINUTES)) {
    values.set("performance.after", value);
    check(`after ${value} is ${ms} ms`, readPolicy(read).idleMs === ms);
  }

  values.set("performance.after", "15");
  values.set("performance.sleep", "false");
  check("the sleep switch is honoured", readPolicy(read).enabled === false);
  values.set("performance.sleep", "true");

  values.set("performance.memory", "save-memory");
  check("save-memory halves the delay", readPolicy(read).pressure === "moderate");
  check("save-memory caps the batch", readPolicy(read).batch < 100);
  values.set("performance.memory", "keep-ready");
  check("keep-ready turns background unload off", readPolicy(read).background === false);
  values.set("performance.memory", "balanced");
  check("balanced keeps the full delay", readPolicy(read).pressure === "none" && readPolicy(read).background === true);

  values.set("performance.exceptions", "https://www.Example.com/path\nnews.example\n\nexample.com\n");
  const exceptions = readPolicy(read).exceptions;
  check("exceptions normalise to hosts", exceptions.includes("example.com") && exceptions.includes("news.example"));
  check("exceptions de-duplicate", exceptions.filter((site) => site === "example.com").length === 1);
  check("a host matches itself", isExcepted("https://example.com/x", exceptions));
  check("a subdomain matches", isExcepted("https://www.example.com/", exceptions));
  check("a deeper subdomain matches", isExcepted("https://mail.news.example/", exceptions));
  check("a lookalike does not match", isExcepted("https://notexample.com/", exceptions) === false);
  check("an invalid URL never matches", isExcepted("about:blank", exceptions) === false);
  check("parseExceptions ignores junk", parseExceptions("   \njavascript:alert(1)").length === 0);
}

// === Driver: native discard path ========================================
const natives = new Map();
const refused = new Set();
function nativeFor(id) {
  const tab = {
    id,
    discarded: false,
    pinned: false,
    attrs: new Set(),
    getAttribute(name) {
      if (name === "astra-tab-id") return id;
      return tab.attrs.has(name) ? "true" : null;
    },
    hasAttribute(name) {
      if (name === "discarded") return tab.discarded;
      return tab.attrs.has(name);
    },
    linkedBrowser: {},
  };
  natives.set(id, tab);
  return tab;
}
function browser(tabs) {
  return {
    tabs,
    discardBrowser(tab) {
      if (refused.has(tab.id)) return false;
      tab.discarded = true;
      return true;
    },
  };
}

const stopContent = Events.addEventListener((event) => {
  const native = natives.get(event.data?.astra_tab_id);
  if (!native) return;
  if (event.type === "tab.discarded" && !refused.has(native.id)) native.discarded = true;
  if (event.type === "tab.restored") native.discarded = false;
});

function resetWorld() {
  TabsMod.__resetTabsForTests();
  __resetSettingsForTests();
  __resetPerformanceForTests();
  natives.clear();
  refused.clear();
  Settings.set({ key: "performance.after", value: "15" });
  Settings.set({ key: "performance.sleep", value: "true" });
  Settings.set({ key: "performance.memory", value: "balanced" });
  Settings.set({ key: "performance.exceptions", value: "" });
}

async function addTab(url, { idleMs = 16 * MINUTE, selected = false } = {}) {
  const created = await Tabs.create({ url, background: !selected });
  const id = created.astra_tab_id;
  TabsMod.__tabsState().tabs.get(id).last_active_ms = NOW - idleMs;
  return id;
}

// --- one eligible tab sleeps, every exclusion stays ----------------------
{
  resetWorld();
  const selected = await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = await addTab("https://idle.example/");
  const audible = await addTab("https://audio.example/");
  const pinned = await addTab("https://kept.example/");
  const excepted = await addTab("https://safe.example/");
  await Tabs.pin({ astra_tab_id: pinned });
  Settings.set({ key: "performance.exceptions", value: "safe.example" });

  const all = [selected, idle, audible, pinned, excepted].map(nativeFor);
  natives.get(audible).attrs.add("soundplaying");
  const gb = browser(all);
  __setBrowserForTests(() => gb);

  let projected = 0;
  const stopProjection = Events.addEventListener((event) => {
    if (event.type === "items-changed") projected += 1;
  });
  const result = await Performance.tick(NOW);
  stopProjection();
  check("the discard reaches the projection pump", projected > 0);
  check("the tick reports the tabs it considered", result.considered === 4);
  check("only the idle tab sleeps", result.slept.length === 1 && result.slept[0] === idle);
  check("the sleeping tab says so in the model", TabsMod.__tabsState().tabs.get(idle).discarded === true);
  check("the selected tab stays awake", TabsMod.__tabsState().tabs.get(selected).discarded === false);
  check("an audible tab stays awake", TabsMod.__tabsState().tabs.get(audible).discarded === false);
  check("a kept tab stays awake", TabsMod.__tabsState().tabs.get(pinned).discarded === false);
  check("an excepted site stays awake", TabsMod.__tabsState().tabs.get(excepted).discarded === false);

  const projection = TabsMod.__itemsSnapshot();
  const sleeping = projection.tabs.find((tab) => tab.id === idle);
  check("the projection marks the sleeping tab", sleeping?.availability?.state === "sleeping");
  check(
    "an awake tab has no sleeping state",
    projection.tabs.find((tab) => tab.id === selected)?.availability == null,
  );

  // --- wake path: selecting clears the model flag ------------------------
  await Tabs.select({ astra_tab_id: idle });
  check("selecting a sleeping tab wakes it", TabsMod.__tabsState().tabs.get(idle).discarded === false);
  check(
    "the rail no longer lists it",
    TabsMod.__itemsSnapshot().tabs.find((tab) => tab.id === idle)?.availability == null,
  );
  await Tabs.wakeup({ astra_tab_id: idle });
  check("the explicit wake restores the native tab", natives.get(idle).discarded === false);
}

// --- the engine refuses: the model must not claim sleeping --------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const stubborn = await addTab("https://stubborn.example/");
  refused.add(stubborn);
  __setBrowserForTests(() => browser([nativeFor(stubborn)]));
  const result = await Performance.tick(NOW);
  check("a refused discard is not counted", result.slept.length === 0);
  check(
    "a refused discard leaves the tab awake in the model",
    TabsMod.__tabsState().tabs.get(stubborn).discarded === false,
  );
}

// --- the delay actually changes the tick, with no restart ----------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = await addTab("https://idle.example/", { idleMs: 6 * MINUTE });
  __setBrowserForTests(() => browser([nativeFor(idle)]));

  Settings.set({ key: "performance.after", value: "60" });
  const long = await Performance.tick(NOW);
  check("a 60-minute delay leaves a 6-minute idle tab awake", long.slept.length === 0);

  Settings.set({ key: "performance.after", value: "5" });
  const short = await Performance.tick(NOW);
  check("changing to 5 minutes applies on the next tick", short.slept.length === 1 && short.slept[0] === idle);
}

// --- keep-ready leaves every tab awake -----------------------------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = await addTab("https://idle.example/");
  __setBrowserForTests(() => browser([nativeFor(idle)]));
  Settings.set({ key: "performance.memory", value: "keep-ready" });
  const result = await Performance.tick(NOW);
  check("keep-ready discards nothing", result.slept.length === 0 && TabsMod.__tabsState().tabs.get(idle).discarded === false);
}

// --- save-memory halves the delay and caps one batch --------------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = [];
  for (let i = 0; i < 6; i += 1) {
    idle.push(await addTab(`https://idle${i}.example/`, { idleMs: 4 * MINUTE }));
  }
  __setBrowserForTests(() => browser(idle.map(nativeFor)));
  Settings.set({ key: "performance.after", value: "5" });
  const none = await Performance.tick(NOW);
  check("a 4-minute idle tab is awake at the full 5-minute delay", none.slept.length === 0);

  Settings.set({ key: "performance.memory", value: "save-memory" });
  const moderate = await Performance.tick(NOW);
  check("save-memory halves the delay", moderate.slept.length > 0);
  check("one batch is capped", moderate.slept.length === 4);
}

// --- the driver timer is released ---------------------------------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = await addTab("https://idle.example/");
  const gb = browser([nativeFor(idle)]);
  __setBrowserForTests(() => gb);
  const started = Performance.start({ browser: () => gb, tickMs: 60_000 });
  check("the driver starts with a native browser", started === true && Performance.status().running === true);
  Performance.stop();
  check("stop releases the timer", Performance.status().running === false);
  Performance.stop();
  check("stop is idempotent", Performance.status().running === false);
}

// --- a private tab never sleeps ------------------------------------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const adopted = TabsMod.__adoptNative({ url: "https://secret.example/", private: true });
  TabsMod.__tabsState().tabs.get(adopted).last_active_ms = NOW - 60 * MINUTE;
  __setBrowserForTests(() => browser([nativeFor(adopted)]));
  const result = await Performance.tick(NOW);
  check("a private tab stays awake", result.slept.length === 0);
}

stopContent();
__resetPerformanceForTests();
__resetSettingsForTests();
TabsMod.__resetTabsForTests();

console.log(`\nsleep_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

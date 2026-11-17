#!/usr/bin/env node
// Sleeping-tabs contract: the host driver reads the real Settings keys and
// applies the same pure policy as `crates/astra-core/src/sleeping.rs`, then
// drives the model and checks the native discard actually happened.
//
//   - `shouldSleep` matches the Rust order: active, already discarded,
//     audible, pinned, DevTools, idle timeout
//   - moderate pressure halves the delay; critical discards any inactive tab
//   - `selectForSleep` returns oldest first and honours the batch cap
//   - the keep-warm window protects the 6 most recently active eligible tabs,
//     after the exclusions and before the idle/pressure test, clamped to one
//     fewer than the set so the oldest is always a candidate
//   - the idle default is 5 minutes in the policy and in the settings fallback
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
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

// A file URL: `import()` rejects a bare Windows absolute path ("e:" scheme).
const hostModule = (name) => import(pathToFileURL(path.join(HOST, name)).href);

const Events = await hostModule("Events.sys.mjs");
const TabsMod = await hostModule("Tabs.sys.mjs");
const SettingsMod = await hostModule("Settings.sys.mjs");
const PerfMod = await hostModule("Performance.sys.mjs");

const { Tabs } = TabsMod;
const { Settings, __resetSettingsForTests, __setPrefsForTests } = SettingsMod;
const {
  Performance,
  DEFAULT_IDLE_TIMEOUT_MS,
  AFTER_MINUTES,
  effectiveTimeoutMs,
  shouldSleep,
  selectForSleep,
  tabState,
  enrich,
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
  // Ordering/cap in isolation; the keep-warm window has its own cases below.
  const orderConfig = { idle_timeout_ms: 10_000, keep_warm_count: 0 };
  const chosen = selectForSleep(tabs, NOW, orderConfig, "none", Number.MAX_SAFE_INTEGER);
  check("candidates are oldest first", chosen.map((t) => t.id).join(",") === "old,new");
  check("the cap is applied", selectForSleep(tabs, NOW, orderConfig, "none", 1).length === 1);

  // --- keep-warm window ---------------------------------------------------
  // 8 eligible idle tabs, default keep-warm 6: only the two oldest are chosen.
  const idleMany = [];
  for (let i = 0; i < 8; i += 1) {
    idleMany.push(tabState({ id: `w${i}`, last_active_ms: NOW - (120_000 + i * MINUTE) }));
  }
  const warmPick = selectForSleep(idleMany, NOW, { idle_timeout_ms: MINUTE });
  check("the keep-warm window leaves only the two oldest idle tabs", warmPick.map((t) => t.id).join(",") === "w7,w6");
  check(
    "keep-warm holds under critical pressure too",
    selectForSleep(idleMany, NOW, { idle_timeout_ms: MINUTE }, "critical").map((t) => t.id).join(",") === "w7,w6",
  );

  const tied = [
    tabState({ id: "b", last_active_ms: NOW - 10 * MINUTE }),
    tabState({ id: "a", last_active_ms: NOW - 10 * MINUTE }),
  ];
  const tiePick = selectForSleep(tied, NOW, { idle_timeout_ms: MINUTE, keep_warm_count: 1 });
  check("keep-warm ties rank by id", tiePick.length === 1 && tiePick[0].id === "b");

  const allTied = [];
  for (let i = 0; i < 8; i += 1) {
    allTied.push(tabState({ id: `t${i}`, last_active_ms: NOW - 10 * MINUTE }));
  }
  check(
    "a full tie leaves exactly the two highest ids",
    selectForSleep(allTied, NOW, { idle_timeout_ms: MINUTE }).map((t) => t.id).join(",") === "t6,t7",
  );
  check(
    "a non-finite window falls back to the default",
    selectForSleep(allTied, NOW, { idle_timeout_ms: MINUTE, keep_warm_count: NaN }).map((t) => t.id).join(",") ===
      "t6,t7",
  );

  // Excluded tabs are the newest, so a ranking that forgets the exclusion
  // filter would hand them the warm slots and select three live tabs.
  const slots = [
    tabState({ id: "discarded-1", last_active_ms: NOW - MINUTE, discarded: true }),
    tabState({ id: "discarded-2", last_active_ms: NOW - 2 * MINUTE, discarded: true }),
    tabState({ id: "live-a", last_active_ms: NOW - 20 * MINUTE }),
    tabState({ id: "live-b", last_active_ms: NOW - 21 * MINUTE }),
    tabState({ id: "live-c", last_active_ms: NOW - 22 * MINUTE }),
  ];
  check(
    "already-discarded tabs do not consume warm slots",
    selectForSleep(slots, NOW, { idle_timeout_ms: MINUTE, keep_warm_count: 2 }).map((t) => t.id).join(",") === "live-c",
  );

  check("a negative delay clamps to zero", effectiveTimeoutMs(-300_001, "none") === 0 && effectiveTimeoutMs(-300_001, "moderate") === 0);
  check("odd negative delays clamp too", effectiveTimeoutMs(-1, "none") === 0 && effectiveTimeoutMs(-2, "moderate") === 0);
  check(
    "a negative delay sleeps a fresh tab without diverging",
    shouldSleep(tabState({ id: "x", last_active_ms: NOW }), NOW, { idle_timeout_ms: -300_001 }).sleep === true,
  );

  // Every excluded tab is newer than both live tabs: ranking them would give
  // the one warm slot to the selected tab and leave two candidates.
  const guarded = [
    tabState({ id: "selected", last_active_ms: NOW - MINUTE, active: true }),
    tabState({ id: "audible", last_active_ms: NOW - 2 * MINUTE, audible: true }),
    tabState({ id: "pinned", last_active_ms: NOW - 3 * MINUTE, pinned: true }),
    tabState({ id: "devtools", last_active_ms: NOW - 4 * MINUTE, devtools_open: true }),
    tabState({ id: "discarded", last_active_ms: NOW - 5 * MINUTE, discarded: true }),
    tabState({ id: "warm", last_active_ms: NOW - 20 * MINUTE }),
    tabState({ id: "cold", last_active_ms: NOW - 25 * MINUTE }),
  ];
  const guardedPick = selectForSleep(guarded, NOW, { idle_timeout_ms: MINUTE, keep_warm_count: 1 }, "critical");
  // Excluded tabs neither sleep nor hold a warm slot: the newest eligible tab
  // is protected and "cold" still sleeps.
  check("keep-warm never overrides an exclusion", guardedPick.map((t) => t.id).join(",") === "cold");

  const crowded = [];
  for (let i = 0; i < 12; i += 1) {
    crowded.push(tabState({ id: `m${i}`, last_active_ms: NOW - (5 + i) * MINUTE }));
  }
  const capPick = selectForSleep(crowded, NOW, { idle_timeout_ms: MINUTE }, "none", 4);
  check("the batch cap still applies after keep-warm", capPick.map((t) => t.id).join(",") === "m11,m10,m9,m8");

  // The window never protects more tabs than exist: a population at or under
  // it sleeps nothing.
  const few = [
    tabState({ id: "n0", last_active_ms: NOW - 8 * MINUTE }),
    tabState({ id: "n1", last_active_ms: NOW - 9 * MINUTE }),
    tabState({ id: "n2", last_active_ms: NOW - 10 * MINUTE }),
  ];
  check("fewer tabs than the window all stay warm", selectForSleep(few, NOW, { idle_timeout_ms: MINUTE }).length === 0);
  check(
    "keep_warm_count 0 protects nothing",
    selectForSleep(few, NOW, { idle_timeout_ms: MINUTE, keep_warm_count: 0 })
      .map((t) => t.id)
      .join(",") === "n2,n1,n0",
  );

  check("an empty set selects nothing", selectForSleep([], NOW, { idle_timeout_ms: MINUTE }).length === 0);
  check(
    "a fully excluded set selects nothing",
    selectForSleep(
      [
        tabState({ id: "a", last_active_ms: NOW - 90 * MINUTE, active: true }),
        tabState({ id: "b", last_active_ms: NOW - 90 * MINUTE, audible: true }),
        tabState({ id: "c", last_active_ms: NOW - 90 * MINUTE, pinned: true }),
        tabState({ id: "d", last_active_ms: NOW - 90 * MINUTE, devtools_open: true }),
        tabState({ id: "e", last_active_ms: NOW - 90 * MINUTE, discarded: true }),
      ],
      NOW,
      { idle_timeout_ms: MINUTE },
      "critical",
    ).length === 0,
  );
  check("maxCount 0 selects nothing", selectForSleep(few, NOW, { idle_timeout_ms: MINUTE }, "none", 0).length === 0);

  const exactly = [];
  for (let i = 0; i < 6; i += 1) {
    exactly.push(tabState({ id: `k${i}`, last_active_ms: NOW - (10 + i) * MINUTE }));
  }
  check("exactly the window size sleeps nothing", selectForSleep(exactly, NOW, { idle_timeout_ms: MINUTE }).length === 0);

  // Three ticks over the same six tabs must not eat the window one tab per
  // pass (the earlier `eligible - 1` clamp did exactly that).
  let remainingTicks = exactly.slice();
  const perTick = [];
  for (let tick = 0; tick < 3; tick += 1) {
    const chosen = selectForSleep(remainingTicks, NOW, { idle_timeout_ms: MINUTE });
    perTick.push(chosen.map((t) => t.id).join(","));
    const gone = new Set(chosen.map((t) => t.id));
    remainingTicks = remainingTicks.filter((tab) => !gone.has(tab.id));
  }
  check("three ticks never shrink the window", perTick.join("|") === "||" && remainingTicks.length === 6);
}

// === Settings -> policy ==================================================
{
  const values = new Map();
  const read = (key, fallback) => values.get(key) ?? fallback;
  check("sleep defaults on", readPolicy(read).enabled === true);
  check("after defaults to 5 minutes", readPolicy(read).idleMs === AFTER_MINUTES[5]);
  check("the policy reports the keep-warm window", readPolicy(read).keep_warm_count === 6);
  check(
    "the idle default is one constant",
    DEFAULT_IDLE_TIMEOUT_MS === 300_000 && AFTER_MINUTES[5] === DEFAULT_IDLE_TIMEOUT_MS,
  );
  // The same default ships in the build overlay and in the UI reset; these two
  // checks are what stop the five literals drifting apart again.
  const cfg = fs.readFileSync(path.join(ROOT, "overlay", "astra", "mozilla.cfg"), "utf8");
  check(
    "mozilla.cfg defaults the delay to 300000",
    /defaultPref\(\s*"browser\.tabs\.min_inactive_duration_before_unload"\s*,\s*300000\s*\)/u.test(cfg),
  );
  const uiDefaults = fs.readFileSync(
    path.join(ROOT, "ui", "app", "src", "domain", "preferences", "preferences.svelte.ts"),
    "utf8",
  );
  check("the UI reset default is 5", /"performance\.after": "5"/u.test(uiDefaults));

  for (const [value, ms] of Object.entries(AFTER_MINUTES)) {
    values.set("performance.after", value);
    check(`after ${value} is ${ms} ms`, readPolicy(read).idleMs === ms);
  }

  values.set("performance.after", "15");
  check("a stored 15 still means 15 minutes", readPolicy(read).idleMs === 15 * MINUTE);
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
  check("the batch cap is unconditional", readPolicy(read).batch === 4);
  check("an empty reader still uses the 5-minute default", readPolicy(() => undefined).idleMs === 300_000);

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

// === An absent pref reads as the same 5-minute default ===================
{
  // `Services.prefs` behaviour for an unset pref: the getter returns the
  // fallback it was given, so this checks the fallback itself.
  const absent = {
    getIntPref: (_name, fallback) => fallback,
    getBoolPref: (_name, fallback) => fallback,
    getStringPref: (_name, fallback) => fallback,
    setIntPref() {},
    setBoolPref() {},
    setStringPref() {},
    clearUserPref() {},
    prefHasUserValue: () => false,
    addObserver() {},
    removeObserver() {},
  };
  __resetSettingsForTests();
  __setPrefsForTests(absent);
  check("an unset performance.after pref reads as 5 minutes", Settings.current("performance.after") === "5");
  check("the default policy uses the 5-minute delay", readPolicy().idleMs === 300_000);
  check("the settings fallback matches the policy constant", readPolicy().idleMs === DEFAULT_IDLE_TIMEOUT_MS);

  // A 300000 pref (what mozilla.cfg now ships) still maps to the "5" option.
  __resetSettingsForTests();
  __setPrefsForTests({
    ...absent,
    getIntPref: (name, fallback) =>
      name === "browser.tabs.min_inactive_duration_before_unload" ? 300_000 : fallback,
  });
  check("a 300000 pref reads as 5 minutes", Settings.current("performance.after") === "5");
  __resetSettingsForTests();
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

// The window is 6, so a fixture that wants a sleeper needs a seventh eligible
// tab. These fillers are newer than the tab under test and stay warm.
let warmSeq = 0;
async function addWarmTabs(count, { idleMs = 16 * MINUTE } = {}) {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    warmSeq += 1;
    ids.push(await addTab(`https://warm${warmSeq}.example/`, { idleMs }));
  }
  return ids;
}

// --- one eligible tab sleeps, every exclusion stays ----------------------
{
  resetWorld();
  const selected = await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = await addTab("https://idle.example/", { idleMs: 60 * MINUTE });
  const audible = await addTab("https://audio.example/");
  const pinned = await addTab("https://kept.example/");
  const excepted = await addTab("https://safe.example/");
  const warm = await addWarmTabs(6);
  await Tabs.pin({ astra_tab_id: pinned });
  Settings.set({ key: "performance.exceptions", value: "safe.example" });

  const all = [selected, idle, audible, pinned, excepted, ...warm].map(nativeFor);
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
  check("the tick reports the tabs it considered", result.considered === 10);
  check("only the idle tab sleeps", result.slept.length === 1 && result.slept[0] === idle);
  check(
    "the warm tabs stay awake",
    warm.every((id) => TabsMod.__tabsState().tabs.get(id).discarded === false),
  );
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
  const stubborn = await addTab("https://stubborn.example/", { idleMs: 60 * MINUTE });
  const warm = await addWarmTabs(6);
  refused.add(stubborn);
  __setBrowserForTests(() => browser([nativeFor(stubborn), ...warm.map(nativeFor)]));
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
  const warm = await addWarmTabs(6, { idleMs: 4 * MINUTE });
  __setBrowserForTests(() => browser([nativeFor(idle), ...warm.map(nativeFor)]));

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

// --- save-memory halves the delay, the window still holds ---------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = [];
  // Eight tabs inside the 5-minute delay: keeping warm 6 leaves exactly the
  // two oldest as candidates, so K=0 (which would sleep 4) fails this.
  for (let i = 0; i < 8; i += 1) {
    idle.push(await addTab(`https://idle${i}.example/`, { idleMs: 4 * MINUTE + i * 6000 }));
  }
  __setBrowserForTests(() => browser(idle.map(nativeFor)));
  Settings.set({ key: "performance.after", value: "5" });
  const none = await Performance.tick(NOW);
  check("a 4-minute idle tab is awake at the full 5-minute delay", none.slept.length === 0);

  Settings.set({ key: "performance.memory", value: "save-memory" });
  const moderate = await Performance.tick(NOW);
  check("save-memory halves the delay", moderate.slept.length > 0);
  check(
    "the window still holds under pressure",
    moderate.slept.join(",") === `${idle[7]},${idle[6]}`,
  );
  check(
    "the keep-warm tabs stay awake under pressure",
    idle.slice(0, 6).every((id) => TabsMod.__tabsState().tabs.get(id).discarded === false),
  );
}

// --- the window and the batch cap, in the order the driver applies them --
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = [];
  for (let i = 0; i < 8; i += 1) {
    idle.push(await addTab(`https://keep${i}.example/`, { idleMs: 10 * MINUTE + i * MINUTE }));
  }
  __setBrowserForTests(() => browser(idle.map(nativeFor)));
  Settings.set({ key: "performance.after", value: "5" });
  const result = await Performance.tick(NOW);
  check(
    "the window leaves the two oldest idle tabs, not all eight",
    result.slept.join(",") === `${idle[7]},${idle[6]}`,
  );
  check(
    "the keep-warm tabs stay awake",
    idle.slice(0, 6).every((id) => TabsMod.__tabsState().tabs.get(id).discarded === false),
  );
}

// --- a full tie: filter first, then slice --------------------------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = [];
  for (let i = 0; i < 10; i += 1) {
    idle.push(await addTab(`https://tie${i}.example/`, { idleMs: 10 * MINUTE }));
  }
  __setBrowserForTests(() => browser(idle.map(nativeFor)));
  Settings.set({ key: "performance.after", value: "5" });
  const result = await Performance.tick(NOW);
  // Ties rank by id ascending, so the window holds the six lowest ids and the
  // four highest are the candidates. Slicing to the cap before filtering would
  // leave 0, not 4.
  const expected = [...idle].sort().slice(6);
  check("a full tie still sleeps four tabs", result.slept.length === 4);
  check("the tie fixtures are the four highest ids", result.slept.join(",") === expected.join(","));
}

// --- the batch cap is four every tick, at every memory mode -------------
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const idle = [];
  for (let i = 0; i < 12; i += 1) {
    idle.push(await addTab(`https://cap${i}.example/`, { idleMs: 10 * MINUTE + i * MINUTE }));
  }
  __setBrowserForTests(() => browser(idle.map(nativeFor)));
  Settings.set({ key: "performance.after", value: "5" });
  const result = await Performance.tick(NOW);
  check(
    "balanced sleeps four a tick, not six",
    result.slept.join(",") === `${idle[11]},${idle[10]},${idle[9]},${idle[8]}`,
  );
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

// --- extension autoDiscardable and picture-in-picture rules are honoured --
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  // Older than every warm tab: only the exclusion keeps them awake.
  const marked = await addTab("https://webrtc.example/", { idleMs: 90 * MINUTE });
  const pip = await addTab("https://pip.example/", { idleMs: 91 * MINUTE });
  const spare = await addTab("https://spare.example/", { idleMs: 20 * MINUTE });
  const warm = await addWarmTabs(6);
  const markedNative = nativeFor(marked);
  markedNative.attrs.add("undiscardable");
  const pipNative = nativeFor(pip);
  pipNative.attrs.add("pictureinpicture");
  __setBrowserForTests(() => browser([markedNative, pipNative, nativeFor(spare), ...warm.map(nativeFor)]));
  const result = await Performance.tick(NOW);
  check(
    "an extension-marked tab stays awake",
    result.slept.includes(marked) === false && TabsMod.__tabsState().tabs.get(marked).discarded === false,
  );
  check(
    "a picture-in-picture tab stays awake",
    result.slept.includes(pip) === false && TabsMod.__tabsState().tabs.get(pip).discarded === false,
  );
  check("the tick still reclaimed the one eligible tab", result.slept.length === 1 && result.slept[0] === spare);
}

// --- only media that is actually happening protects a tab (D-7, D-12) ----
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const muted = await addTab("https://muted.example/", { idleMs: 20 * MINUTE });
  const pausedSession = await addTab("https://paused.example/", { idleMs: 22 * MINUTE });
  const playingSession = await addTab("https://playing.example/");
  const deadCall = await addTab("https://dead.example/", { idleMs: 24 * MINUTE });
  const liveCall = await addTab("https://live.example/");
  const sounding = await addTab("https://sound.example/");
  const pip = await addTab("https://pip.example/");
  const warm = await addWarmTabs(6);
  const mutedNative = nativeFor(muted);
  // A muted autoplay ad: the engine says playback is active, but there is no
  // media session and no call, so it stays discardable.
  mutedNative.linkedBrowser.audioPlaybackActive = true;
  const pausedNative = nativeFor(pausedSession);
  // A session the person started but paused: nothing is playing.
  pausedNative.linkedBrowser = {
    browsingContext: { mediaController: { isActive: true, isPlaying: false } },
  };
  const playingNative = nativeFor(playingSession);
  playingNative.linkedBrowser = {
    browsingContext: { mediaController: { isActive: true, isPlaying: true } },
  };
  const deadNative = nativeFor(deadCall);
  // A call that disconnected: hasActivePeerConnections() is false again.
  deadNative.linkedBrowser = {
    browsingContext: { currentWindowGlobal: { hasActivePeerConnections: () => false } },
  };
  const liveNative = nativeFor(liveCall);
  liveNative.linkedBrowser = {
    browsingContext: { currentWindowGlobal: { hasActivePeerConnections: () => true } },
  };
  const soundingNative = nativeFor(sounding);
  soundingNative.attrs.add("soundplaying");
  const pipNative = nativeFor(pip);
  pipNative.attrs.add("pictureinpicture");
  __setBrowserForTests(() =>
    browser([
      mutedNative,
      pausedNative,
      playingNative,
      deadNative,
      liveNative,
      soundingNative,
      pipNative,
      ...warm.map(nativeFor),
    ]),
  );
  const config = { idle_timeout_ms: AFTER_MINUTES[5] };
  const model = new Map(TabsMod.__sleepState().map((tab) => [tab.id, tab]));
  const result = await Performance.tick(NOW);
  check(
    "a paused video, a disconnected call and a muted ad all sleep",
    result.slept.join(",") === `${deadCall},${pausedSession},${muted}`,
  );
  check(
    "a paused session's reason is idle",
    shouldSleep(enrich(model.get(pausedSession), pausedNative), NOW, config).reason === "idle",
  );
  check(
    "a disconnected call's reason is idle",
    shouldSleep(enrich(model.get(deadCall), deadNative), NOW, config).reason === "idle",
  );
  check(
    "the muted tab's reason is idle, not audible",
    shouldSleep(enrich(model.get(muted), mutedNative), NOW, config).reason === "idle",
  );
  check(
    "a playing session is audible",
    shouldSleep(enrich(model.get(playingSession), playingNative), NOW, config).reason === "audible",
  );
  check(
    "a live call is audible",
    shouldSleep(enrich(model.get(liveCall), liveNative), NOW, config).reason === "audible",
  );
  check(
    "a tab producing sound is audible",
    shouldSleep(enrich(model.get(sounding), soundingNative), NOW, config).reason === "audible",
  );
  check(
    "a picture-in-picture tab is audible",
    shouldSleep(enrich(model.get(pip), pipNative), NOW, config).reason === "audible",
  );
  check(
    "the playing, live-call, sound and PiP tabs stay awake",
    [playingSession, liveCall, sounding, pip].every(
      (id) => TabsMod.__tabsState().tabs.get(id).discarded === false,
    ),
  );
}

// --- beforeunload is not an exemption; extension/attention are (D-10) ----
{
  resetWorld();
  await addTab("https://front.example/", { idleMs: 0, selected: true });
  const handler = await addTab("https://handled.example/", { idleMs: 20 * MINUTE });
  const extension = await addTab("https://extension.example/");
  const attention = await addTab("https://attention.example/");
  const warm = await addWarmTabs(6);
  const handlerNative = nativeFor(handler);
  // An ad/session handler: discarding restores the snapshot, so it is no
  // reason to keep the page resident.
  handlerNative.linkedBrowser.hasBeforeUnload = true;
  const extensionNative = nativeFor(extension);
  extensionNative.attrs.add("undiscardable");
  const attentionNative = nativeFor(attention);
  attentionNative.attrs.add("attention");
  __setBrowserForTests(() => browser([handlerNative, extensionNative, attentionNative, ...warm.map(nativeFor)]));
  const config = { idle_timeout_ms: AFTER_MINUTES[5] };
  const model = new Map(TabsMod.__sleepState().map((tab) => [tab.id, tab]));
  const result = await Performance.tick(NOW);
  check("a beforeunload handler no longer keeps the tab resident", result.slept.join(",") === handler);
  check(
    "its reason is idle, not unsaved",
    enrich(model.get(handler), handlerNative).unsaved === false &&
      shouldSleep(enrich(model.get(handler), handlerNative), NOW, config).reason === "idle",
  );
  check(
    "an extension-marked tab is unsaved before the policy",
    enrich(model.get(extension), extensionNative).unsaved === true &&
      result.slept.includes(extension) === false,
  );
  check(
    "an attention tab is unsaved before the policy",
    enrich(model.get(attention), attentionNative).unsaved === true &&
      result.slept.includes(attention) === false,
  );
  check(
    "the extension and attention tabs stay awake",
    TabsMod.__tabsState().tabs.get(extension).discarded === false &&
      TabsMod.__tabsState().tabs.get(attention).discarded === false,
  );
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

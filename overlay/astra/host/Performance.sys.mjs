/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Performance module (v1). This is the live driver for the tab
// sleeping settings, not a second copy of them:
//
//   `performance.sleep`     master switch (`browser.tabs.unloadOnLowMemory`)
//   `performance.after`     idle delay (`browser.tabs.min_inactive_duration_before_unload`)
//   `performance.memory`    resource policy: balanced / save-memory / keep-ready
//   `performance.exceptions` sites that must never sleep, one per line
//
// Firefox's own TabUnloader only acts under memory pressure and reads its
// pref at module load, so a Settings change never reached the behaviour. The
// driver below reads the settings on every tick (and runs a tick immediately
// when one changes), so a new delay applies at once.
//
// The pure policy mirrors `crates/astra-core/src/sleeping.rs`
// (`should_sleep`, `effective_timeout_ms`, `select_for_sleep`); the contract
// test walks both implementations' cases. Effects go through the Host API's
// own `Tabs.discard` / `Tabs.wakeup`, which the content binding mirrors onto
// `gBrowser.discardBrowser` / tab restore. A tab the engine refuses to
// discard is put back to awake in the model, so the projection never claims
// a page is sleeping while it still holds its content process.
//
// Privacy: a private window's tabs are never auto-slept (no state is written
// and the rail hides the list). Media, pinned/essential tabs, DevTools, a
// page with a beforeunload handler, an open sign-in/failure card and the
// selected tab are excluded.
//
// Teardown: one interval, one event subscription and one `unload` listener,
// all released by `stop()` (and by the test reset). Nothing grows per tick.

import { addEventListener } from "./Events.sys.mjs";
import {
  Tabs,
  __applyExternalUpdate,
  __sleepState,
} from "./Tabs.sys.mjs";
import { Settings } from "./Settings.sys.mjs";

/** `crates/astra-core/src/sleeping.rs`. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** The values `performance.after` stores, in minutes. */
export const AFTER_MINUTES = Object.freeze({ 5: 300000, 15: 900000, 30: 1800000, 60: 3600000 });

/** How often the driver looks at the tabs. */
const TICK_MS = 30_000;

/** A batch cap under pressure so one tick does not discard everything. */
const PRESSURE_BATCH = 4;

/** Memory pressure names from the Rust policy. */
export const MEMORY_PRESSURE = Object.freeze({
  balanced: "none",
  "save-memory": "moderate",
  "keep-ready": "keep-ready",
});

/** State of one tab the policy reasons over (`TabState`). */
export function tabState({
  id = "",
  last_active_ms = 0,
  active = false,
  audible = false,
  pinned = false,
  devtools_open = false,
  discarded = false,
} = {}) {
  return {
    id,
    last_active_ms,
    active: active === true,
    audible: audible === true,
    pinned: pinned === true,
    devtools_open: devtools_open === true,
    discarded: discarded === true,
  };
}

/** Effective idle timeout under pressure (Rust `effective_timeout_ms`). */
export function effectiveTimeoutMs(idleMs, pressure = "none") {
  if (pressure === "moderate") return Math.floor(idleMs / 2) + (idleMs % 2);
  if (pressure === "critical") return 0;
  return idleMs;
}

/** Pure policy: should this tab sleep at `nowMs`? (Rust `should_sleep`). */
export function shouldSleep(tab, nowMs, config, pressure = "none") {
  if (tab.active) return { sleep: false, reason: "active" };
  if (tab.discarded) return { sleep: false, reason: "already-discarded" };
  if (tab.audible) return { sleep: false, reason: "audible" };
  if (tab.pinned) return { sleep: false, reason: "pinned" };
  if (tab.devtools_open) return { sleep: false, reason: "devtools" };
  const idle = Math.max(0, nowMs - tab.last_active_ms);
  if (idle >= effectiveTimeoutMs(config.idle_timeout_ms, pressure)) {
    return { sleep: true, reason: "idle" };
  }
  return { sleep: false, reason: "recently-active" };
}

/** Oldest-first candidates, capped (Rust `select_for_sleep`). */
export function selectForSleep(tabs, nowMs, config, pressure = "none", maxCount = Number.MAX_SAFE_INTEGER) {
  return tabs
    .filter((tab) => shouldSleep(tab, nowMs, config, pressure).sleep)
    .sort((a, b) => a.last_active_ms - b.last_active_ms)
    .slice(0, Math.max(0, maxCount));
}

/** A site entry the exception list can carry: host, URL or `www.` variant. */
export function exceptionSite(entry) {
  const text = String(entry ?? "").trim().toLowerCase();
  if (text === "") return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    let host = url.hostname.replace(/\.$/u, "");
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
}

/** The exception list, normalised and de-duplicated. */
export function parseExceptions(value) {
  const seen = new Set();
  for (const entry of String(value ?? "").split("\n")) {
    const site = exceptionSite(entry);
    if (site !== "") seen.add(site);
  }
  return [...seen];
}

/** True when `url`'s host is the exception or a subdomain of it. */
export function isExcepted(url, exceptions) {
  let host = "";
  try {
    host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return false;
  }
  if (host === "") return false;
  const site = host.startsWith("www.") ? host.slice(4) : host;
  return exceptions.some((entry) => site === entry || site.endsWith(`.${entry}`));
}

/** The policy the host should apply right now, read from the real settings. */
export function readPolicy(setting = (key, fallback) => Settings.current(key) ?? fallback) {
  const enabled = String(setting("performance.sleep", "true")) !== "false";
  const after = String(setting("performance.after", "15"));
  const memory = String(setting("performance.memory", "balanced"));
  const pressure = MEMORY_PRESSURE[memory] ?? "none";
  const exceptions = parseExceptions(setting("performance.exceptions", ""));
  return {
    enabled,
    idleMs: AFTER_MINUTES[after] ?? AFTER_MINUTES[15],
    pressure: pressure === "keep-ready" ? "none" : pressure,
    // "keep-ready" means do not unload in the background at all.
    background: pressure !== "keep-ready",
    exceptions,
    batch: pressure === "moderate" ? PRESSURE_BATCH : Number.MAX_SAFE_INTEGER,
    tickMs: TICK_MS,
  };
}

// === Live binding =========================================================

let timer = null;
let unsubscribe = null;
let unloadBound = false;
let ticking = false;
let lastTickAt = 0;
let lastSlept = [];
let started = false;
let clock = () => Date.now();
let resolveBrowserOverride = null;

/** The window's `gBrowser`, or null outside a chrome shell. */
export function nativeBrowser() {
  if (resolveBrowserOverride) return resolveBrowserOverride();
  try {
    const win = globalThis.window;
    if (win?.gBrowser && typeof win.gBrowser.discardBrowser === "function") {
      return win.gBrowser;
    }
    if (win?.top?.gBrowser && typeof win.top.gBrowser.discardBrowser === "function") {
      return win.top.gBrowser;
    }
  } catch {
    // A torn-down window.
  }
  return null;
}

/** Native tab per model id, keyed by the attribute the content binding writes. */
function nativeTabs(gb) {
  const map = new Map();
  try {
    for (const tab of gb.tabs) {
      const id = tab.getAttribute("astra-tab-id");
      if (id) map.set(id, tab);
    }
  } catch {
    // A browser that is shutting down.
  }
  return map;
}

/** Add the native facts the model does not keep (audio, DevTools, unload). */
export function enrich(tab, native) {
  let audible = false;
  let devtools = false;
  let unsaved = false;
  let pinned = tab.pinned === true;
  if (native) {
    try {
      audible =
        native.hasAttribute("soundplaying") ||
        native.linkedBrowser?.audioPlaybackActive === true;
      devtools = native.getAttribute("devtools-opened") === "true";
      unsaved =
        native.linkedBrowser?.hasBeforeUnload === true ||
        native.hasAttribute("attention");
      pinned = pinned || native.pinned === true;
    } catch {
      // A native tab mid-teardown.
    }
    try {
      // DevTools state lives in gDevTools, not on the tab element.
      const gDevTools = globalThis.window?.gDevTools ?? globalThis.gDevTools;
      if (!devtools && typeof gDevTools?.getToolboxForTab === "function") {
        devtools = !!gDevTools.getToolboxForTab(native);
      }
    } catch {
      // No DevTools integration in this build/window.
    }
  }
  return {
    ...tab,
    audible,
    devtools_open: devtools,
    pinned,
    // An open sign-in card or a failed page is unsaved work from the person's
    // point of view; keep the content process alive.
    unsaved: unsaved || tab.has_page_request === true,
  };
}

function scheduled() {
  if (timer !== null) return;
  const policy = readPolicy();
  if (!policy.enabled || !policy.background) return;
  timer = setInterval(() => {
    void Performance.tick();
  }, policy.tickMs);
}

function unscheduled() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function onHostEvent(event) {
  if (event.type !== "ui-command") return;
  const command = String(event.data ?? "");
  if (command === "preference.performance.sleep=false") {
    unscheduled();
    return;
  }
  if (command === "preference.performance.sleep=true") {
    scheduled();
    void Performance.tick();
    return;
  }
  // A policy change applies now rather than at the next interval: the driver
  // reads the pref on every tick, and a change wakes one.
  if (
    command.startsWith("preference.performance.after=") ||
    command.startsWith("preference.performance.memory=") ||
    command.startsWith("preference.performance.exceptions=")
  ) {
    void Performance.tick();
  }
}

/** One sleep pass. Returns `{ considered, slept, unavailable }`. */
async function runTick(nowMs) {
  const policy = readPolicy();
  if (!policy.enabled || !policy.background) {
    return { considered: 0, slept: [], unavailable: false };
  }
  const gb = nativeBrowser();
  if (!gb) {
    return { considered: 0, slept: [], unavailable: true };
  }
  const natives = nativeTabs(gb);
  const states = __sleepState()
    .filter((tab) => natives.has(tab.id))
    .filter((tab) => !tab.private)
    .filter((tab) => /^https?:/iu.test(tab.url ?? ""))
    .filter((tab) => !isExcepted(tab.url, policy.exceptions))
    .map((tab) => enrich(tab, natives.get(tab.id)))
    .filter((tab) => tab.unsaved !== true)
    .map((tab) => tabState(tab));
  const candidates = selectForSleep(
    states,
    nowMs,
    { idle_timeout_ms: policy.idleMs },
    policy.pressure,
    policy.batch,
  );
  const slept = [];
  for (const candidate of candidates) {
    const before = await Tabs.discard({ astra_tab_id: candidate.id });
    if (!before || before.accepted !== true) continue;
    const native = natives.get(candidate.id);
    let applied = true;
    try {
      applied = !native || native.hasAttribute("discarded");
    } catch {
      applied = false;
    }
    if (!applied) {
      // The engine refused the discard (an audio stream, a local tab). The
      // projection must not keep saying "sleeping".
      __applyExternalUpdate(candidate.id, { discarded: false });
      continue;
    }
    slept.push(candidate.id);
  }
  lastTickAt = nowMs;
  lastSlept = slept;
  return { considered: states.length, slept, unavailable: false };
}

export const Performance = {
  /**
   * Start the background driver. Safe to call twice; the first window wins
   * (the shell publishes one Host API for every chrome document).
   */
  start({ browser = null, now = null, tickMs = null } = {}) {
    if (typeof now === "function") clock = now;
    if (typeof browser === "function") resolveBrowserOverride = browser;
    if (started) {
      if (tickMs !== null) {
        unscheduled();
        const cadence = Math.max(1000, Number(tickMs) || TICK_MS);
        timer = setInterval(() => void Performance.tick(), cadence);
      }
      return true;
    }
    if (!nativeBrowser()) return false;
    // One driver per process: the shell and the app frame share `Services`.
    try {
      const services = globalThis.window?.Services ?? globalThis.Services;
      if (services) {
        if (services.astraPerformanceDriver === true) return false;
        services.astraPerformanceDriver = true;
      }
    } catch {
      // A frozen Services object; the timer guard below still bounds us.
    }
    started = true;
    unsubscribe = addEventListener(onHostEvent);
    if (tickMs !== null) {
      const cadence = Math.max(1000, Number(tickMs) || TICK_MS);
      timer = setInterval(() => void Performance.tick(), cadence);
    } else {
      scheduled();
    }
    try {
      const win = globalThis.window;
      if (win?.addEventListener && !unloadBound) {
        win.addEventListener("unload", () => Performance.stop(), { once: true });
        unloadBound = true;
      }
    } catch {
      // No window (a contract test).
    }
    return true;
  },

  /** One pass at `nowMs`; used by the interval, the setting listener and probes. */
  async tick(nowMs = clock()) {
    if (ticking) return { considered: 0, slept: [], unavailable: false, busy: true };
    ticking = true;
    try {
      return await runTick(nowMs);
    } catch {
      return { considered: 0, slept: [], unavailable: true };
    } finally {
      ticking = false;
    }
  },

  /** Release the interval, the listener and the process-wide guard. */
  stop() {
    unscheduled();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (started) {
      try {
        const services = globalThis.window?.Services ?? globalThis.Services;
        if (services) delete services.astraPerformanceDriver;
      } catch {
        // Already gone.
      }
    }
    started = false;
    ticking = false;
    lastTickAt = 0;
    lastSlept = [];
  },

  /** Diagnostics for the live probe: what the driver last did. */
  status() {
    return {
      running: timer !== null,
      started,
      last_tick_at: lastTickAt || null,
      slept: [...lastSlept],
      policy: readPolicy(),
    };
  },
};

/** True when another chrome document already owns the process driver. */
function driverOwned() {
  try {
    const services = globalThis.window?.Services ?? globalThis.Services;
    return services?.astraPerformanceDriver === true;
  } catch {
    return false;
  }
}

/**
 * The driver starts with the chrome shell. The window's `gBrowser` may not
 * exist yet at import time, so retry briefly; outside a chrome window (Node
 * contract tests, a plain tab) nothing is scheduled.
 */
function autoStart() {
  if (typeof globalThis.window === "undefined") return;
  if (driverOwned()) return;
  if (Performance.start()) return;
  let tries = 0;
  const handle = setInterval(() => {
    tries += 1;
    if (driverOwned() || Performance.start() || tries >= 20) {
      clearInterval(handle);
    }
  }, 1000);
}

autoStart();

/** Test seam: stand in for the window's `gBrowser`. */
export function __setBrowserForTests(fn) {
  resolveBrowserOverride = typeof fn === "function" ? fn : null;
}

/** Test seam: the clock the interval reads. */
export function __setClockForTests(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

/** Test-only teardown. */
export function __resetPerformanceForTests() {
  Performance.stop();
  resolveBrowserOverride = null;
  clock = () => Date.now();
}

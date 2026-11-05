/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Time module (v1). The Time surfaces and focus are projections over
// `time_call` / `focus_control`
// (`docs/astra/ipc-surface.md`, `ui/app/src/shared/ipc/bindings.ts`).
//
// Time tracking is real and device-only. The Rust `astra-time` crate has no
// protocol command yet, so the host counts what it can see — the selected
// tab in a non-private window — and persists per-profile hourly buckets and
// focus days through the same profile pref store the settings use
// (`astra.time.state.v1`). The exact command the core still needs is
// documented in `docs/astra/SLEEPING.md`/`docs/astra/STATE.md`; nothing here
// pretends the sidecar answered.
//
// Counting semantics mirror `crates/astra-time/src/tracker.rs`:
// - elapsed time is credited to the *previous* observation's site while that
//   observation was active;
// - an idle/private/non-web observation stops the clock without crediting;
// - a site change re-anchors and counts one "open".
// Time is split across local-hour boundaries, and pruned by `time.retention`
// (days) on load, read and write. `time.track=false` stops counting; it does
// not delete what was already counted.
//
// Focus is a real session clock:
// - `focus_control` drives a state machine: idle -> focus (minutes) ->
//   break (short, or long every fourth finished round) -> focus ... Every
//   instant crosses as epoch milliseconds, `focused` counts whole seconds in
//   finished rounds, and `allowed` names sites let through for a few minutes.
// - `start` begins a focus round, `stop` ends the session, `skip` ends the
//   running phase now and enters the next one, `allow` lets one site through
//   for `ALLOW_MINUTES`. All four are admitted; a malformed control is refused
//   (`accepted: false`, no operation id) and changes nothing.
// - `start` reads `focus.minutes` / `focus.breaks` when the control does not
//   carry them, so the Settings page drives the round.
// - Transitions are derived from the clock, not a background timer: every
//   `time_call` read and every control reconciles the phase end first, so a
//   round that ended while nobody was asking is advanced on the next look.
//   Whenever the projection changes, `focus-changed` carries the new
//   `FocusStatus` (`{ session, shut }`); every admitted control announces it
//   even when the clock did not move.
// - Finished rounds are added to a per-profile, per-local-day history and
//   persisted, so `focus_days` returns true rows after a restart. The running
//   session is persisted too and restored on the next launch.
// - `shut` lists the sites `focus.blocked` configures while a focus phase is
//   in force (an `allow` removes its exact site). The list is configuration:
//   request-level enforcement still needs the engine's Net hook
//   (`crates/astra-time` `FocusBlockHook`), which is not wired. The host does
//   not claim a request was cancelled.
// - `report` answers the shape the store answers: one bucket per requested
//   bucket, a `previous` span, and site rows for what was actually counted.
//   An empty profile still answers zeroed buckets and no sites, never usage
//   it did not see.
// - A malformed call, or one outside the wire's own bounds (bucket width 1 or
//   24, 1..31 buckets/days, a site of at most 253 bytes), answers
//   `{ kind: "error", error: "invalid" }`. The call never throws.
// - Every reply echoes the profile the caller asked for. Counters are stored
//   per profile and never read across the boundary.
//
// Pure logic plus the shared event pump and the profile pref store: importable
// both as a chrome ES module and from Node contract tests (which inject a
// prefs double).

import { addEventListener, emit } from "./Events.sys.mjs";
import { __tabsState } from "./Tabs.sys.mjs";
import { Settings } from "./Settings.sys.mjs";

/** The wire's own bounds (`crates/astra-time`). */
const MAX_SITE_BYTES = 253;
const MAX_REPORT_BUCKETS = 31;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Session bounds and the shape of a round (`FocusView`). */
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const BREAK_MINUTES = 5;
const LONG_BREAK_MINUTES = 15;
/** A long break replaces the short one after every fourth finished round. */
const ROUNDS_PER_LONG_BREAK = 4;
/** How long one `allow` lets a site through. */
const ALLOW_MINUTES = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Phase boundaries one read replays before it re-anchors the running phase. */
const MAX_CATCH_UP = 10_000;

/** Where the profile's counted time lives (the existing settings pref store). */
const STORE_PREF = "astra.time.state.v1";
const SETTINGS_PREFIX = "astra.settings.";
const DEFAULT_RETENTION_DAYS = 90;
const MAX_SITES_PER_HOUR = 200;
const MAX_REPORT_SITES = 100;
/** Persist at most this often from the activity events; reads force a write. */
const PERSIST_EVERY_MS = 30_000;

/** Events that can move the selected tab or its address. */
const TRACK_EVENTS = new Set([
  "tab.created",
  "tab.updated",
  "tab.closed",
  "tab.moved",
  "tab.restored",
  "tab.discarded",
  "items-changed",
  "nav.committed",
  "space.deleted",
]);

/** The running session, or `null` while idle. */
let session = null;
/** The profile the running session belongs to. */
let sessionProfile = "";
/** `{ site, until }` grants; `until` is epoch milliseconds. */
let allowances = [];
/** The last `FocusStatus` announced, so a read only speaks when it changed. */
let lastPublished = null;
/** The host clock; tests replace it to walk the session deterministically. */
let clock = () => Date.now();

// === Profile store ========================================================
// `{ v: 1, profiles: { [profile]: { hours, days, session } } }`
// hours:  { "<local hour index>": { "<site>": [seconds, opens] } }
// days:   { "<local day index>": [seconds, sessions, completed] }
let store = null;
let injectedPrefs = null;
let lastPersistAt = 0;

function prefsForUse() {
  if (injectedPrefs) return injectedPrefs;
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) scopes.push(globalThis.window);
    for (const scope of scopes) {
      const prefs = scope?.Services?.prefs;
      if (prefs && typeof prefs.getStringPref === "function" && typeof prefs.setStringPref === "function") {
        return prefs;
      }
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

function emptyStore() {
  return { v: 1, profiles: {} };
}

function loadStore() {
  if (store !== null) return store;
  store = emptyStore();
  const prefs = prefsForUse();
  if (!prefs) return store;
  try {
    const parsed = JSON.parse(prefs.getStringPref(STORE_PREF));
    if (parsed && typeof parsed === "object" && parsed.profiles && typeof parsed.profiles === "object") {
      store.v = 1;
      store.profiles = parsed.profiles;
    }
  } catch {
    // No stored state yet, or a value from a future version: start empty
    // rather than guessing.
  }
  return store;
}

function profileRecord(profile) {
  const data = loadStore();
  let record = data.profiles[profile];
  if (!record || typeof record !== "object") {
    record = { hours: {}, days: {}, session: null };
    data.profiles[profile] = record;
  }
  if (!record.hours || typeof record.hours !== "object") record.hours = {};
  if (!record.days || typeof record.days !== "object") record.days = {};
  return record;
}

/** The stored setting, preferring the profile pref the settings writer uses. */
function setting(key, fallback) {
  const prefs = prefsForUse();
  if (prefs) {
    try {
      return prefs.getStringPref(SETTINGS_PREFIX + key);
    } catch {
      // Not written yet: fall through to the in-memory adapter.
    }
  }
  const value = Settings.current(key);
  return value === null || value === undefined ? fallback : value;
}

function retentionDays() {
  const value = Number(setting("time.retention", String(DEFAULT_RETENTION_DAYS)));
  return Number.isFinite(value) && value >= 1 && value <= 3650
    ? Math.floor(value)
    : DEFAULT_RETENTION_DAYS;
}

/** Wall-clock milliseconds as the local zone counts them. */
function localMs(ms) {
  return ms - new Date(ms).getTimezoneOffset() * 60_000;
}

function localDayOf(ms) {
  return Math.floor(localMs(ms) / DAY_MS);
}

function localHourOf(ms) {
  return Math.floor(localMs(ms) / HOUR_MS);
}

/** Drop buckets older than `time.retention`; cap the sites held per hour. */
function prune(profile, now) {
  const record = profileRecord(profile);
  const cutoffDay = localDayOf(now) - retentionDays();
  const cutoffHour = cutoffDay * 24;
  for (const key of Object.keys(record.days)) {
    if (Number(key) < cutoffDay) delete record.days[key];
  }
  for (const key of Object.keys(record.hours)) {
    const hour = Number(key);
    if (!Number.isFinite(hour) || hour < cutoffHour) {
      delete record.hours[key];
      continue;
    }
    const sites = record.hours[key];
    const names = Object.keys(sites);
    if (names.length > MAX_SITES_PER_HOUR) {
      names
        .sort((a, b) => (Number(sites[b]?.[0]) || 0) - (Number(sites[a]?.[0]) || 0))
        .slice(MAX_SITES_PER_HOUR)
        .forEach((name) => delete sites[name]);
    }
  }
  return record;
}

function persist(force = false) {
  const prefs = prefsForUse();
  if (!prefs) return false;
  const now = clock();
  if (!force && now - lastPersistAt < PERSIST_EVERY_MS) return false;
  const data = loadStore();
  for (const profile of Object.keys(data.profiles)) prune(profile, now);
  try {
    prefs.setStringPref(STORE_PREF, JSON.stringify(data));
    lastPersistAt = now;
    return true;
  } catch {
    return false;
  }
}

// === Counting =============================================================

/** The canonical site a URL belongs to (`www.` and the port drop away). */
function siteOf(url) {
  try {
    let host = new URL(String(url)).hostname.toLowerCase().replace(/\.$/u, "");
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return "";
  }
}

/** The selected tab if it is a public web page; `null` stops the clock. */
function selection() {
  try {
    const { tabs, selectedId } = __tabsState();
    const tab = selectedId ? tabs.get(selectedId) : null;
    if (!tab || tab.private === true) return null;
    if (!/^https?:/iu.test(tab.url ?? "")) return null;
    const site = siteOf(tab.url);
    if (site === "") return null;
    return { site, url: tab.url, title: tab.title || "" };
  } catch {
    return null;
  }
}

function trackingOn() {
  return String(setting("time.track", "true")) !== "false";
}

/** True while this chrome window is the focused window (unknown → true). */
function windowFocused() {
  try {
    const win = globalThis.window;
    const focus = win?.Services?.focus;
    if (focus?.activeWindow) {
      return focus.activeWindow === win || focus.activeWindow === win.top;
    }
  } catch {
    // No focus service; count the selected tab.
  }
  return true;
}

/** The start of the next local hour after `ms`, or `ms + an hour`. */
function nextLocalHourStart(ms) {
  const offset = new Date(ms).getTimezoneOffset() * 60_000;
  const local = ms - offset;
  const next = (Math.floor(local / HOUR_MS) + 1) * HOUR_MS + offset;
  if (next > ms) return next;
  const intoHour = ((local % HOUR_MS) + HOUR_MS) % HOUR_MS;
  return ms + (HOUR_MS - intoHour);
}

/** Add `ms` of credit to `site`, split at local-hour boundaries. */
function credit(profile, site, fromMs, ms) {
  if (!(ms > 0) || site === "") return;
  const record = profileRecord(profile);
  let cursor = fromMs;
  let remaining = ms;
  let guard = 0;
  while (remaining > 0 && guard < MAX_CATCH_UP) {
    guard += 1;
    const hour = String(localHourOf(cursor));
    const next = nextLocalHourStart(cursor);
    const slice = Math.min(remaining, Math.max(1, next - cursor));
    const bucket = (record.hours[hour] ??= {});
    const entry = (bucket[site] ??= [0, 0]);
    entry[0] += slice / 1000;
    cursor += slice;
    remaining -= slice;
  }
}

/** Count one arrival at `site` in the hour holding `at`. */
function countOpen(profile, site, at) {
  if (site === "") return;
  const record = profileRecord(profile);
  const bucket = (record.hours[String(localHourOf(at))] ??= {});
  const entry = (bucket[site] ??= [0, 0]);
  entry[1] += 1;
}

let lastObservation = null;
let lastSite = "";

/** Credit the elapsed span, then anchor a new observation at `at`. */
function recordActivity(at = clock()) {
  const observation = selection();
  const active = trackingOn() && windowFocused() && observation !== null;
  if (lastObservation !== null && lastObservation.active) {
    credit(activeProfile, lastObservation.site, lastObservation.at, Math.max(0, at - lastObservation.at));
  }
  if (active && observation !== null) {
    if (observation.site !== lastSite) {
      countOpen(activeProfile, observation.site, at);
      lastSite = observation.site;
    }
  }
  lastObservation = observation === null
    ? { site: "", at, active: false }
    : { site: observation.site, at, active };
}

let activeProfile = "";
let trackingStarted = false;
let unsubscribeTracking = null;
let persistTimer = null;

function startTracking(profile) {
  activeProfile = profile;
  if (trackingStarted) return;
  trackingStarted = true;
  // Anchor at the current selection so the first event measures from now.
  lastObservation = null;
  lastSite = "";
  recordActivity(clock());
  unsubscribeTracking = addEventListener((event) => {
    if (event.type === "ui-command") {
      const command = String(event.data ?? "");
      // The setting changed in another surface: re-anchor at the change so
      // the clock stops (or starts) from here, not from the next event.
      if (command.startsWith("preference.time.track=") || command.startsWith("preference.time.retention=")) {
        recordActivity(clock());
        persist(true);
      }
      return;
    }
    if (!TRACK_EVENTS.has(event.type)) return;
    recordActivity(clock());
    persist(false);
  });
  if (typeof globalThis.window !== "undefined") {
    persistTimer = setInterval(() => {
      recordActivity(clock());
      persist(true);
    }, PERSIST_EVERY_MS);
    try {
      globalThis.window.addEventListener(
        "unload",
        () => {
          recordActivity(clock());
          persist(true);
        },
        { once: true },
      );
    } catch {
      // No window to hang a teardown on.
    }
  }
}

function stopTracking() {
  if (unsubscribeTracking) unsubscribeTracking();
  unsubscribeTracking = null;
  if (persistTimer !== null) clearInterval(persistTimer);
  persistTimer = null;
  if (trackingStarted) {
    recordActivity(clock());
    persist(true);
  }
  trackingStarted = false;
  lastObservation = null;
  lastSite = "";
}

/** Keep the running session with the profile that owns it. */
function ensureProfile(profile) {
  if (profile === sessionProfile) return;
  if (sessionProfile === "" || sessionProfile === "default") {
    // The round started before the app named its profile. Move it to the
    // profile that just identified itself instead of losing it.
    if (session !== null) {
      sessionProfile = profile;
      saveSession();
      return;
    }
    if (sessionProfile === "") {
      sessionProfile = profile;
      restoreSession(profile);
      return;
    }
  }
  saveSession();
  sessionProfile = profile;
  restoreSession(profile);
}

function saveSession() {
  if (sessionProfile === "") return;
  const record = profileRecord(sessionProfile);
  record.session = session === null ? null : { ...session };
  persist(false);
}

function validPhase(phase) {
  return phase === "focus" || phase === "break" || phase === "long_break" ? phase : "focus";
}

function whole(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function restoreSession(profile) {
  const record = profileRecord(profile);
  const saved = record.session;
  if (!saved || typeof saved !== "object") {
    session = null;
    return;
  }
  const minutes = whole(saved.minutes, 25, MIN_MINUTES, MAX_MINUTES);
  const phaseStarted = Number.isFinite(saved.phase_started_at)
    ? saved.phase_started_at
    : Number.isFinite(saved.started_at)
      ? saved.started_at
      : clock();
  const phaseEnds = Number.isFinite(saved.phase_ends_at)
    ? saved.phase_ends_at
    : phaseStarted + minutes * MINUTE_MS;
  session = {
    minutes,
    breaks: saved.breaks === true,
    started_at: Number.isFinite(saved.started_at) ? saved.started_at : phaseStarted,
    phase: validPhase(saved.phase),
    phase_started_at: phaseStarted,
    phase_ends_at: phaseEnds,
    rounds: Number.isInteger(saved.rounds) && saved.rounds >= 0 ? saved.rounds : 0,
    focused: Number.isInteger(saved.focused) && saved.focused >= 0 ? saved.focused : 0,
  };
}

// === Validation ===========================================================

function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function zeroBucket() {
  return { browse: 0, work: 0 };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A wire i32: integral, in range, and exactly representable. */
function isInt32(value) {
  return (
    Number.isSafeInteger(value) && value >= INT32_MIN && value <= INT32_MAX
  );
}

/** UTF-8 length, as Rust measures `MAX_SITE_BYTES`. */
function byteLength(text) {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A non-empty site within the wire's byte bound. */
function isSiteName(site) {
  return (
    typeof site === "string" &&
    site !== "" &&
    byteLength(site) <= MAX_SITE_BYTES
  );
}

/** `null`, or a non-empty site within the wire's byte bound. */
function isSite(site) {
  return site === null || isSiteName(site);
}

function isBucketCount(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_REPORT_BUCKETS;
}

/** `{ kind: "report", from_hour, bucket_hours, buckets, site }`. */
function isReportCall(call) {
  return (
    isInt32(call.from_hour) &&
    (call.bucket_hours === 1 || call.bucket_hours === 24) &&
    isBucketCount(call.buckets) &&
    isSite(call.site)
  );
}

/** `{ kind: "focus_days", from_day, days }`. */
function isFocusDaysCall(call) {
  return isInt32(call.from_day) && isBucketCount(call.days);
}

// === Reports ==============================================================

function roundedBucket(bucket) {
  return { browse: Math.max(0, Math.round(bucket.browse)), work: Math.max(0, Math.round(bucket.work)) };
}

function reportFor(profile, call) {
  const record = prune(profile, clock());
  const from = call.from_hour;
  const width = call.bucket_hours;
  const count = call.buckets;
  const start = from * HOUR_MS;
  const span = count * width * HOUR_MS;
  const buckets = Array.from({ length: count }, () => zeroBucket());
  const previous = zeroBucket();
  const sites = new Map();

  for (const [key, bySite] of Object.entries(record.hours)) {
    const hour = Number(key);
    if (!Number.isFinite(hour)) continue;
    const at = hour * HOUR_MS;
    let index = -1;
    if (at >= start && at < start + span) {
      index = Math.floor((at - start) / (width * HOUR_MS));
    } else if (at >= start - span && at < start) {
      index = -1;
    } else {
      continue;
    }
    for (const [site, values] of Object.entries(bySite)) {
      if (call.site !== null && site !== call.site) continue;
      const seconds = Array.isArray(values) ? Number(values[0]) || 0 : 0;
      const opens = Array.isArray(values) ? Number(values[1]) || 0 : 0;
      if (index < 0) {
        previous.browse += seconds;
        continue;
      }
      buckets[index].browse += seconds;
      let entry = sites.get(site);
      if (!entry) {
        entry = {
          site,
          icon: null,
          seconds: 0,
          opens: 0,
          series: Array.from({ length: count }, () => 0),
        };
        sites.set(site, entry);
      }
      entry.seconds += seconds;
      entry.opens += opens;
      entry.series[index] += seconds;
    }
  }

  const ranked = [...sites.values()]
    .map((entry) => ({
      ...entry,
      seconds: Math.round(entry.seconds),
      series: entry.series.map((value) => Math.round(value)),
    }))
    .filter((entry) => entry.seconds > 0 || entry.opens > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, MAX_REPORT_SITES);

  return {
    kind: "report",
    profile,
    buckets: buckets.map(roundedBucket),
    previous: roundedBucket(previous),
    sites: ranked,
  };
}

function focusDaysFor(profile, call) {
  const record = prune(profile, clock());
  const days = [];
  for (let offset = 0; offset < call.days; offset += 1) {
    const day = call.from_day + offset;
    const values = record.days[String(day)];
    if (!Array.isArray(values)) continue;
    const seconds = Math.max(0, Math.round(Number(values[0]) || 0));
    const sessions = Math.max(0, Math.round(Number(values[1]) || 0));
    const completed = Math.max(0, Math.round(Number(values[2]) || 0));
    if (seconds === 0 && sessions === 0 && completed === 0) continue;
    days.push({ day, seconds, sessions, completed });
  }
  return { kind: "focus_days", profile, days };
}

function answer(profile, call) {
  if (!isObject(call) || typeof call.kind !== "string") {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "report":
      return isReportCall(call) ? reportFor(profile, call) : error(profile, "invalid");
    case "focus_days":
      return isFocusDaysCall(call) ? focusDaysFor(profile, call) : error(profile, "invalid");
    default:
      return error(profile, "invalid");
  }
}

// === The focus clock ======================================================

/** How long one phase of `phase` runs in this session, in milliseconds. */
function phaseDuration(target, phase) {
  if (phase === "focus") {
    return target.minutes * MINUTE_MS;
  }
  return (
    (phase === "long_break" ? LONG_BREAK_MINUTES : BREAK_MINUTES) * MINUTE_MS
  );
}

/** The phase that follows the running one. */
function nextPhase(target) {
  if (target.phase !== "focus") {
    return "focus";
  }
  // Breaks are off: a finished round is followed by the next round.
  if (!target.breaks) {
    return "focus";
  }
  return target.rounds > 0 && target.rounds % ROUNDS_PER_LONG_BREAK === 0
    ? "long_break"
    : "break";
}

/** Enters `phase`, starting at `at`. */
function enter(target, phase, at) {
  target.phase = phase;
  target.phase_started_at = at;
  target.phase_ends_at = at + phaseDuration(target, phase);
}

function dayEntry(record, day) {
  const key = String(day);
  let entry = record.days[key];
  if (!Array.isArray(entry)) {
    entry = [0, 0, 0];
    record.days[key] = entry;
  }
  return entry;
}

/** Add a finished round's seconds (and completion) to the local day at `at`. */
function creditRound(fromMs, toMs, completed) {
  if (sessionProfile === "") return;
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds === 0 && completed !== true) return;
  const record = profileRecord(sessionProfile);
  const entry = dayEntry(record, localDayOf(toMs));
  entry[0] += seconds;
  if (completed === true) entry[2] += 1;
}

function countSessionStart(at) {
  if (sessionProfile === "") return;
  const record = profileRecord(sessionProfile);
  dayEntry(record, localDayOf(at))[1] += 1;
}

/**
 * Advances every phase boundary the clock has passed, in order. A finished
 * focus round counts its whole length; breaks count nothing.
 */
function advance(at) {
  if (session === null) {
    return;
  }
  let replayed = 0;
  while (at >= session.phase_ends_at) {
    const ended = session.phase_ends_at;
    if (session.phase === "focus") {
      session.rounds += 1;
      session.focused += Math.round((ended - session.phase_started_at) / 1000);
      creditRound(session.phase_started_at, ended, true);
    }
    enter(session, nextPhase(session), ended);
    replayed += 1;
    if (replayed >= MAX_CATCH_UP) {
      // The clock jumped further than replaying phase by phase can describe.
      // Re-anchor the running phase at `at` so the projection stays true
      // instead of walking years of rounds.
      enter(session, session.phase, at);
      break;
    }
  }
}

/**
 * Ends the running phase at `at` and enters the next one. A focus round ended
 * early still counts as finished — the round is over — and the seconds it
 * actually ran join `focused`, so the dial never loses time the person spent.
 */
function skipPhase(at) {
  if (session === null) {
    return;
  }
  if (session.phase === "focus") {
    session.rounds += 1;
    const focused = Math.max(0, Math.round((at - session.phase_started_at) / 1000));
    session.focused += focused;
    creditRound(session.phase_started_at, at, true);
  }
  enter(session, nextPhase(session), at);
}

function startSession(minutes, breaks, at) {
  session = {
    minutes,
    breaks,
    started_at: at,
    phase: "focus",
    phase_started_at: at,
    phase_ends_at: at + minutes * MINUTE_MS,
    rounds: 0,
    focused: 0,
  };
  countSessionStart(at);
}

/** Lets `site` through for a few minutes, replacing an older grant. */
function allowSite(site, at) {
  allowances = allowances.filter(
    (entry) => entry.site !== site && entry.until > at,
  );
  allowances.push({ site, until: at + ALLOW_MINUTES * MINUTE_MS });
}

/** The sites `focus.blocked` holds while the round is in force. */
function shutSites() {
  if (session === null || session.phase !== "focus") return [];
  const sites = String(setting("focus.blocked", ""))
    .split("\n")
    .map((entry) => siteOf(entry.includes("://") ? entry : `https://${entry}`))
    .filter((site) => site !== "");
  const unique = [...new Set(sites)];
  return unique
    .filter((site) => !allowances.some((entry) => entry.site === site))
    .map((site) => ({ site, icon: null }));
}

/** The `FocusStatus` at `at`, with expired grants dropped. */
function snapshot(at) {
  allowances = allowances.filter((entry) => entry.until > at);
  if (session === null) {
    return { session: null, shut: [] };
  }
  return {
    session: {
      phase: session.phase,
      started_at: session.started_at,
      phase_started_at: session.phase_started_at,
      phase_ends_at: session.phase_ends_at,
      minutes: session.minutes,
      breaks: session.breaks,
      break_minutes: BREAK_MINUTES,
      long_break_minutes: LONG_BREAK_MINUTES,
      rounds: session.rounds,
      focused: session.focused,
      allowed: allowances.map((entry) => entry.site),
    },
    shut: shutSites(),
  };
}

/**
 * Reconciles the clock, then announces the projection if it changed (or if
 * `force`, as every admitted control does). Returns the projection.
 */
function publish(at, force = false) {
  advance(at);
  if (sessionProfile !== "") saveSession();
  const status = snapshot(at);
  const key = JSON.stringify(status);
  if (force || key !== lastPublished) {
    lastPublished = key;
    emit("focus-changed", status);
  }
  return status;
}

/** `focus.minutes` as a round length, falling back to the wire's default. */
function settingMinutes() {
  const value = Number(setting("focus.minutes", "25"));
  return Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES ? value : 25;
}

function settingBreaks() {
  return String(setting("focus.breaks", "false")) === "true";
}

/** One well-formed `FocusControl` (`bindings.ts`). */
function isControl(control) {
  if (!isObject(control) || typeof control.kind !== "string") {
    return false;
  }
  switch (control.kind) {
    case "start":
      // The round length and break choice come from the control when the
      // caller carries them, otherwise from `focus.minutes`/`focus.breaks`.
      if ("minutes" in control && !(
        Number.isInteger(control.minutes) &&
        control.minutes >= MIN_MINUTES &&
        control.minutes <= MAX_MINUTES
      )) {
        return false;
      }
      return !("breaks" in control) || typeof control.breaks === "boolean";
    case "stop":
    case "skip":
      return true;
    case "allow":
      return isSiteName(control.site);
    default:
      return false;
  }
}

/** A control that was applied. There is no native operation to observe. */
function admitted() {
  return { operation_id: null, accepted: true };
}

/** A control that was not applied: malformed, or nothing to act on. */
function refused() {
  return { operation_id: null, accepted: false };
}

export const Time = {
  /**
   * Answer one `time_call`. `profile` is the caller's scope (the wire payload
   * calls it `expected_profile`; both are accepted). The reply is a
   * `TimeResponse` variant plus the echoed `profile`.
   */
  async call(input = {}) {
    const { profile, expected_profile, call } = isObject(input) ? input : {};
    const asked =
      typeof profile === "string" && profile !== "" ? profile : expected_profile;
    if (typeof asked !== "string" || asked === "") {
      return error("", "invalid");
    }
    try {
      if (activeProfile !== asked) {
        activeProfile = asked;
      }
      if (!trackingStarted) {
        startTracking(asked);
      }
      ensureProfile(asked);
      const at = clock();
      recordActivity(at);
      publish(at);
      persist(false);
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down, and the
      // wire's error union has no separate code for it.
      return error(asked, "invalid");
    }
  },

  /**
   * The focus projection at the current instant, reconciled with the clock.
   * The bridge does not route it; the UI learns the same status through
   * `focus-changed`.
   */
  status() {
    ensureProfile(activeProfile || sessionProfile || "default");
    const at = clock();
    recordActivity(at);
    return publish(at);
  },

  /**
   * Apply one `focus_control` and announce the resulting `FocusStatus`.
   * `start`, `stop`, `skip` and `allow` are admitted; a malformed control is
   * refused and changes nothing. The call never throws.
   */
  async focus(input = {}) {
    try {
      const control = isObject(input) ? input.control : null;
      if (!isControl(control)) {
        return refused();
      }
      const at = clock();
      const profile = activeProfile || sessionProfile || "default";
      if (activeProfile === "") activeProfile = profile;
      ensureProfile(profile);
      if (!trackingStarted) startTracking(profile);
      recordActivity(at);
      advance(at);
      switch (control.kind) {
        case "start":
          startSession(
            "minutes" in control ? control.minutes : settingMinutes(),
            "breaks" in control ? control.breaks : settingBreaks(),
            at,
          );
          saveSession();
          break;
        case "stop":
          session = null;
          saveSession();
          break;
        case "skip":
          skipPhase(at);
          saveSession();
          break;
        case "allow":
          allowSite(control.site, at);
          saveSession();
          break;
      }
      publish(at, true);
      persist(false);
      return admitted();
    } catch {
      // A hostile getter must not take the host down either.
      return refused();
    }
  },
};

/** Test-only clock, so a contract test can walk a session without waiting. */
export function __setClockForTests(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}

/** Test seam: stand in for the profile pref store. */
export function __setPrefsForTests(prefs) {
  stopTracking();
  store = null;
  lastPersistAt = 0;
  injectedPrefs = prefs ?? null;
}

/** Test seam: flush the current span and write the store now. */
export function __flushForTests() {
  recordActivity(clock());
  persist(true);
}

/** Test seam: drop the in-memory store so the next call re-reads the pref. */
export function __reloadStoreForTests() {
  stopTracking();
  store = null;
  lastPersistAt = 0;
  session = null;
  sessionProfile = "";
  activeProfile = "";
  lastPublished = null;
}

/** Test-only reset so contract tests start idle with no grants. */
export function __resetTimeForTests() {
  stopTracking();
  session = null;
  sessionProfile = "";
  activeProfile = "";
  allowances = [];
  lastPublished = null;
  lastObservation = null;
  lastSite = "";
  store = null;
  lastPersistAt = 0;
  injectedPrefs = null;
  clock = () => Date.now();
}

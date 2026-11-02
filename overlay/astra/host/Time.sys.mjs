/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Time module (v1). The Time surfaces and focus are projections over
// `time_call` / `focus_control`
// (`docs/astra/ipc-surface.md`, `ui/app/src/shared/ipc/bindings.ts`).
// Activity tracking still belongs to astra-core; this module answers the reads
// with the empty span it has actually counted and runs the focus clock the
// dial draws.
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
// - Transitions are derived from the clock, not a background timer: every
//   `time_call` read and every control reconciles the phase end first, so a
//   round that ended while nobody was asking is advanced on the next look.
//   Whenever the projection changes, `focus-changed` carries the new
//   `FocusStatus` (`{ session, shut }`); every admitted control announces it
//   even when the clock did not move.
// - `shut` is always empty, and that is the honest answer. Keeping a site shut
//   needs the engine's Net hook (`crates/astra-time` `FocusBlockHook`), which
//   is not wired yet. The clock, the phases and the allowances are real; the
//   enforcement is not. Nothing here claims a site is blocked.
// - `report` answers the shape the store answers for an empty span: one zeroed
//   bucket per requested bucket, a zeroed `previous`, and no sites. Zero is
//   the honest figure — the host has counted nothing — and it never invents
//   usage or a site row.
// - `focus_days` answers `days: []`. The store's answer is sparse (only days
//   holding a session appear), so no records means no rows, not a run of
//   zeroed days passed off as history.
// - A malformed call, or one outside the wire's own bounds (bucket width 1 or
//   24, 1..31 buckets/days, a site of at most 253 bytes), answers
//   `{ kind: "error", error: "invalid" }`. The call never throws.
// - Every reply echoes the profile the caller asked for. Nothing is stored per
//   profile, so nothing can be read as another profile's state.
//
// Pure logic, no Firefox internals beyond the shared event pump: importable
// both as a chrome ES module and from Node contract tests.

import { emit } from "./Events.sys.mjs";

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
/** Phase boundaries one read replays before it re-anchors the running phase. */
const MAX_CATCH_UP = 10_000;

/** The running session, or `null` while idle. */
let session = null;
/** `{ site, until }` grants; `until` is epoch milliseconds. */
let allowances = [];
/** The last `FocusStatus` announced, so a read only speaks when it changed. */
let lastPublished = null;
/** The host clock; tests replace it to walk the session deterministically. */
let clock = () => Date.now();

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

function answer(profile, call) {
  if (!isObject(call) || typeof call.kind !== "string") {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "report": {
      if (!isReportCall(call)) {
        return error(profile, "invalid");
      }
      // Every bucket the caller asked about is present and zero: an empty
      // span, not a missing answer. Nothing was counted, so no site ranks.
      return {
        kind: "report",
        profile,
        buckets: Array.from({ length: call.buckets }, () => zeroBucket()),
        previous: zeroBucket(),
        sites: [],
      };
    }

    case "focus_days": {
      if (!isFocusDaysCall(call)) {
        return error(profile, "invalid");
      }
      // The store returns only days that hold a session; with none, no rows.
      return { kind: "focus_days", profile, days: [] };
    }

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
    session.focused += Math.max(
      0,
      Math.round((at - session.phase_started_at) / 1000),
    );
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
}

/** Lets `site` through for a few minutes, replacing an older grant. */
function allowSite(site, at) {
  allowances = allowances.filter(
    (entry) => entry.site !== site && entry.until > at,
  );
  allowances.push({ site, until: at + ALLOW_MINUTES * MINUTE_MS });
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
    // Nothing is shut yet: enforcement needs the engine's Net hook.
    shut: [],
  };
}

/**
 * Reconciles the clock, then announces the projection if it changed (or if
 * `force`, as every admitted control does). Returns the projection.
 */
function publish(at, force = false) {
  advance(at);
  const status = snapshot(at);
  const key = JSON.stringify(status);
  if (force || key !== lastPublished) {
    lastPublished = key;
    emit("focus-changed", status);
  }
  return status;
}

/** One well-formed `FocusControl` (`bindings.ts`). */
function isControl(control) {
  if (!isObject(control) || typeof control.kind !== "string") {
    return false;
  }
  switch (control.kind) {
    case "start":
      return (
        Number.isInteger(control.minutes) &&
        control.minutes >= MIN_MINUTES &&
        control.minutes <= MAX_MINUTES &&
        typeof control.breaks === "boolean"
      );
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
      // Any read reconciles the clock: a phase that ended while nobody was
      // asking is advanced here, and the change is announced.
      publish(clock());
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
    return publish(clock());
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
      advance(at);
      switch (control.kind) {
        case "start":
          startSession(control.minutes, control.breaks, at);
          break;
        case "stop":
          session = null;
          break;
        case "skip":
          skipPhase(at);
          break;
        case "allow":
          allowSite(control.site, at);
          break;
      }
      publish(at, true);
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

/** Test-only reset so contract tests start idle with no grants. */
export function __resetTimeForTests() {
  session = null;
  allowances = [];
  lastPublished = null;
  clock = () => Date.now();
}

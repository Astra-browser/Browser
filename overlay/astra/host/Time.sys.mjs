/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Time module (v1, wiring). The Time surfaces and focus are
// projections over `time_call` / `focus_control`
// (`docs/astra/ipc-surface.md`, `ui/app/src/shared/ipc/bindings.ts`).
// Activity tracking and the focus engine belong to astra-core; this module is
// the host-side answer while neither is connected, so the surfaces render
// their real state (nothing counted, no session) instead of failing with
// `unknown_command`.
//
// What this module will and will not say:
// - `report` answers the shape the store answers for an empty span: one
//   zeroed bucket per requested bucket, a zeroed `previous`, and no sites.
//   Zero is the honest figure — the host has counted nothing — and it never
//   invents usage or a site row.
// - `focus_days` answers `days: []`. The store's answer is sparse (only days
//   holding a session appear), so no records means no rows, not a run of
//   zeroed days passed off as history.
// - A malformed call, or one outside the wire's own bounds (bucket width 1
//   or 24, 1..31 buckets/days, a site of at most 253 bytes), answers
//   `{ kind: "error", error: "invalid" }`. The call never throws.
// - `focus` admits nothing. Without the focus engine a round cannot shut a
//   site, so every control is refused (`accepted: false`, no operation id)
//   rather than reported as applied. A session that cannot block is not a
//   session, and claiming one started would lie to the dial. A malformed
//   control is refused the same way: the admission has no error channel.
// - Every reply echoes the profile the caller asked for. Nothing is stored
//   per profile, so nothing can be read as another profile's state.
//
// Pure logic, no Firefox internals, no Events import: nothing here changes
// state, so there is no `focus-changed` to announce. The shell projects focus
// status once the engine exists.

/** The wire's own bounds (`zephium-core/src/time.rs`). */
const MAX_SITE_BYTES = 253;
const MAX_REPORT_BUCKETS = 31;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

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

/** `null`, or a non-empty site within the wire's byte bound. */
function isSite(site) {
  return (
    site === null ||
    (typeof site === "string" && site !== "" && byteLength(site) <= MAX_SITE_BYTES)
  );
}

function isBucketCount(value) {
  return (
    Number.isInteger(value) && value >= 1 && value <= MAX_REPORT_BUCKETS
  );
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

/**
 * The admission shape `focusControl` returns. There is no focus engine to
 * hold, so no control is ever applied; `operation_id` stays null because
 * there is no native operation to observe.
 */
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
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down, and the
      // wire's error union has no separate code for it.
      return error(asked, "invalid");
    }
  },

  /**
   * Admit one `focus_control`. A round that cannot shut a site must not
   * report that it started, so every control — start, stop, skip, allow — is
   * refused. The dial shows the failure instead of a session that never was.
   */
  async focus(input = {}) {
    try {
      // Reading `control` keeps the accepted shape explicit. A malformed one
      // is refused exactly like a valid one: the admission has no error
      // channel, and nothing can be applied without the engine.
      const control = isObject(input) ? input.control : null;
      void control;
      return refused();
    } catch {
      // A hostile getter must not take the host down either.
      return refused();
    }
  },
};

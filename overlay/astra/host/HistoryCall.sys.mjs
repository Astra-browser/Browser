/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API History module (v1, wiring). The History page and the History panel
// are projections over `history_call` (`docs/astra/ipc-surface.md`;
// `HistoryCall`, `HistoryResponse` and `HistoryError` in
// `ui/app/src/shared/ipc/bindings.ts`). The visit store itself belongs to
// astra-core; this module is the host-side answer while that store is not
// connected, so the surfaces render their real state (nothing held) instead
// of failing with `unknown_command`.
//
// Why this is not `History.sys.mjs`: that module owns the P2-T07 Places
// mirror, a write-through cache of core-owned visits so `:visited` link
// styling works. It is keyed by normalized URL, has no row ids, no cursor,
// no range and no search, and it only holds what the sidecar pushed — reading
// it back would present a partial styling cache as the person's history.
// This module therefore answers from nothing rather than from the mirror, and
// imports nothing (not even History.sys.mjs), so it stays loadable by path in
// Node contract tests and in chrome without pulling another lane in.
//
// What this module will and will not say:
// - `page` — the paged list and the search — answers a well-formed empty page
//   with `next: null`. The host holds no visits yet and never invents one.
//   Every `range` and `query` the panel sends is accepted; `before` is a
//   cursor into a list that has no rows, so any page is the last page.
// - Day grouping is not a call. `ui/app/src/features/history/lib/history-model.ts`
//   groups the visits it receives by `visited_at` on the client, so the host
//   sends flat visits and has no grouping variant to answer.
// - `closed_tabs` answers `tabs: []`: no closed-tab record is held here, and
//   this module does not borrow Session's startup snapshot to fake one.
// - Every destructive call answers the reply's own `error: "unavailable"`.
//   `forget`, `clear` and `reopen_closed` are never reported as `removed` or
//   `reopened`: deleting history is destructive, and the host cannot prove a
//   deletion or a reopen it did not perform.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an
//   unknown `kind` is `invalid` too. The call never throws.
// - Every reply echoes the profile the caller asked for. Nothing is stored per
//   profile, so nothing can be read as another profile's state.
//
// Pure logic, no Firefox internals, no Places import: nothing here changes
// state, so there is no history event to announce.

/** Longest search string the page may carry, as the panel slices it. */
const MAX_QUERY = 512;

/** Largest page the UI may ask for; it asks for 100 while listing. */
const MAX_PAGE_LIMIT = 1000;

/** Most addresses one `forget` call may name, so a call stays bounded. */
const MAX_FORGET_URLS = 1024;

/** Longest single address or cursor, so one call cannot grow unbounded. */
const MAX_TEXT = 8192;

/** The scopes `HistoryRange` allows; Clear removes exactly what it names. */
const RANGES = new Set(["hour", "day", "week", "everything"]);

/** The reply's own error variant: the panel renders `error` as it is. */
function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function isText(value) {
  return typeof value === "string" && value !== "" && value.length <= MAX_TEXT;
}

function isRange(value) {
  return typeof value === "string" && RANGES.has(value);
}

/** `before` is the id of the last visit seen: a decimal string, or null. */
function isCursor(value) {
  return value === null || (isText(value) && value.length <= 64);
}

/** `{ query, range, before, limit }`, exactly as the panel sends it. */
function isPageCall(call) {
  const { query, range, before, limit } = call;
  return (
    typeof query === "string" &&
    query.length <= MAX_QUERY &&
    isRange(range) &&
    isCursor(before) &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= MAX_PAGE_LIMIT
  );
}

/** `urls: string[]`, non-empty and bounded: a forget of nothing is no call. */
function isForgetUrls(urls) {
  return (
    Array.isArray(urls) &&
    urls.length > 0 &&
    urls.length <= MAX_FORGET_URLS &&
    urls.every(isText)
  );
}

function answer(profile, call) {
  if (
    call === null ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    typeof call.kind !== "string"
  ) {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "page":
      if (!isPageCall(call)) {
        return error(profile, "invalid");
      }
      // The store holds nothing, so the honest page is empty and final.
      // Visits are flat; the panel groups them by day itself.
      return { kind: "page", visits: [], next: null, profile };

    case "forget":
      // Nothing can be removed, and a deletion is never claimed.
      return isForgetUrls(call.urls)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "clear":
      return isRange(call.range)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "closed_tabs":
      // No closed-tab record is held here; an empty list is the honest answer.
      return { kind: "closed_tabs", tabs: [], profile };

    case "reopen_closed":
      // Reopening needs a closed tab this host does not have, and a reopen is
      // never claimed.
      return isText(call.id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    default:
      return error(profile, "invalid");
  }
}

export const HistoryCall = {
  /**
   * Answer one `history_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `HistoryResponse` variant plus the echoed `profile`.
   */
  async call(args = {}) {
    let asked = "";
    let call = null;
    try {
      const scope = args === null || typeof args !== "object" ? {} : args;
      call = scope.call;
      asked = isText(scope.profile)
        ? scope.profile
        : isText(scope.expected_profile)
          ? scope.expected_profile
          : "";
    } catch {
      // A payload whose properties throw cannot name a profile or a call.
      return error("", "invalid");
    }
    if (!asked) {
      return error("", "invalid");
    }
    try {
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down. `runtime`
      // is not one of `HistoryError`, so the refusal stays in the reply's own
      // vocabulary: history is not reachable, which is what `unavailable`
      // says.
      return error(asked, "unavailable");
    }
  },
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API History module (v1, wiring). The History page and the History panel
// are projections over `history_call` (`docs/astra/ipc-surface.md`;
// `HistoryCall`, `HistoryResponse` and `HistoryError` in
// `ui/app/src/shared/ipc/bindings.ts`). The visit store itself belongs to
// astra-core; until that store is connected this module answers from the
// engine's own Places history, which is the store the content browsers write
// (see the `useGlobalHistory` note in Content.sys.mjs).
//
// Why this is not `History.sys.mjs`: that module owns the P2-T07 Places
// mirror, a write-through cache of core-owned visits so `:visited` link
// styling works. It is keyed by normalized URL, has no row ids, no cursor,
// no range and no search, and it only holds what the sidecar pushed — reading
// it back would present a partial styling cache as the person's history.
// This module reads Places directly and imports nothing at module scope, so it
// stays loadable by path in Node contract tests and in chrome without pulling
// another lane in.
//
// What this module will and will not say:
// - `page` — the paged list and the search — answers newest-first visits with
//   `{ id, url, title, visited_at, icon }`, where `id` is the Places visit id
//   (the cursor) and `visited_at` is unix seconds, both as decimal strings
//   because the wire never asks JavaScript to parse a Rust i64.
//   `next` is the last row's id when another page exists, else null.
// - Day grouping is not a call. `ui/app/src/features/history/lib/history-model.ts`
//   groups the visits it receives by `visited_at` on the client, so the host
//   sends flat visits and has no grouping variant to answer.
// - `forget` removes the named pages through Places and reports how many were
//   actually removed; `clear` removes the visits the same range names and
//   reports how many visits went.
// - `closed_tabs` answers `tabs: []`: no closed-tab record is held here, and
//   this module does not borrow Session's startup snapshot to fake one.
// - `reopen_closed` stays `unavailable`: reopening needs a closed tab this
//   host does not have, and a reopen is never claimed.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an
//   unknown `kind` is `invalid` too. The call never throws.
// - Every reply echoes the profile the caller asked for.
//
// Cursor note (why this reads SQL rather than `nsINavHistoryQuery`): the wire
// pages by visit id, and a history query has no "id less than" predicate — it
// can only bound visits by time. Paging a timestamp cursor would either repeat
// rows or skip them whenever two visits share a second. The read therefore
// runs over the same Places connection (`PlacesUtils.withConnectionWrapper`)
// with an explicit `v.id < :before` predicate, which is exact and stays
// bounded to one page. Deletions go through the verified Places History API
// (`History.remove` / `History.clear` / `History.removeVisitsByFilter`).
//
// Backend selection: an injected backend wins (Node contract tests), else a
// lazy live Places backend is used when running in chrome, else `null` (Node
// default), which keeps the documented empty-page / unavailable answers.

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

/** Rolling windows, in milliseconds, matching the scopes above. */
const RANGE_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

/** `nsINavHistoryService.TRANSITION_EMBED`: a frame load is not a page visit. */
const TRANSITION_EMBED = 4;

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

/** The visit time the range names; `everything` reaches back to the epoch. */
function rangeBegin(range, now) {
  const span = RANGE_MS[range];
  return span ? now - span : 0;
}

/**
 * The cursor as a number Places can bind. The wire promises a decimal id, but
 * a malformed cursor is a page from the start rather than a crash; the panel
 * only ever sends ids this module handed it.
 */
function cursorId(before) {
  if (typeof before !== "string" || before === "") {
    return 0;
  }
  const id = Number(before);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** `LIKE` metacharacters are search text here, not wildcards. */
function escapeLike(value) {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

/** One Places row as a `HistoryVisitView`; `icon` arrives with the projection. */
function toVisit(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    visited_at: String(row.visited_at),
    icon: null,
  };
}

// --- Injectable seam (Node contract tests, alternate stores) ---------------

let _backend = null; // { list(args), forget(urls), clear(range) } | null
let _liveBackendPromise = null;

// Replacement backend; returns a reset function so a suite can undo it.
export function __setHistoryCallBackend(backend) {
  _backend = backend || null;
  return () => {
    if (_backend === backend) {
      _backend = null;
    }
  };
}

function inChrome() {
  return (
    typeof globalThis.ChromeUtils !== "undefined" &&
    globalThis.ChromeUtils &&
    typeof globalThis.ChromeUtils.importESModule === "function"
  );
}

async function backend() {
  if (_backend) {
    return _backend;
  }
  if (!inChrome()) {
    return null;
  }
  if (!_liveBackendPromise) {
    // A failed import is not fatal: the module keeps answering empty pages and
    // `unavailable`, and a later call retries once the lazy import is ready.
    _liveBackendPromise = (async () => {
      const { PlacesUtils } = await import(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      return createPlacesBackend(PlacesUtils);
    })().catch(() => {
      _liveBackendPromise = null;
      return null;
    });
  }
  return _liveBackendPromise;
}

// --- Places backend ---------------------------------------------------------

/**
 * Read one page of visits. Newest first because the cursor is a visit id, and
 * visits are written in the order they happen. Hidden places (downloads,
 * redirect bookkeeping) and embed visits are not page visits.
 */
async function listRows(PlacesUtils, { beginTime, before, limit, search }) {
  const pattern = search ? `%${escapeLike(search)}%` : "";
  // `beginTime` is milliseconds (the model's clock); Places stores PRTime in
  // microseconds, and mixing the two would make every range reach the epoch.
  const begin = beginTime * 1000;
  return PlacesUtils.withConnectionWrapper(
    "Astra.HistoryCall.page",
    async (db) => {
      const rows = await db.execute(
        `SELECT v.id AS visit_id, p.url AS url,
                IFNULL(p.title, '') AS title, v.visit_date AS visited_at
           FROM moz_historyvisits v
           JOIN moz_places p ON p.id = v.place_id
          WHERE p.hidden = 0
            AND v.visit_type != :embed
            AND v.visit_date >= :begin
            AND (:before = 0 OR v.id < :before)
            AND (:pattern = ''
                 OR p.url LIKE :pattern ESCAPE '\\'
                 OR IFNULL(p.title, '') LIKE :pattern ESCAPE '\\')
          ORDER BY v.id DESC
          LIMIT :limit`,
        {
          embed: TRANSITION_EMBED,
          begin,
          before,
          pattern,
          limit,
        },
      );
      return rows.map((row) => ({
        id: String(row.getResultByName("visit_id")),
        url: String(row.getResultByName("url")),
        title: String(row.getResultByName("title") || ""),
        // Places stores PRTime microseconds; the wire carries unix seconds.
        visited_at: Math.floor(
          Number(row.getResultByName("visited_at")) / 1_000_000,
        ),
      }));
    },
  );
}

async function countVisits(PlacesUtils, beginTime) {
  const begin = beginTime * 1000;
  return PlacesUtils.withConnectionWrapper(
    "Astra.HistoryCall.count",
    async (db) => {
      const rows = await db.execute(
        `SELECT COUNT(*) AS total
           FROM moz_historyvisits
          WHERE visit_date >= :begin`,
        { begin },
      );
      return rows.length ? Number(rows[0].getResultByName("total")) : 0;
    },
  );
}

function createPlacesBackend(PlacesUtils) {
  return {
    list({ beginTime, before, limit, search }) {
      return listRows(PlacesUtils, { beginTime, before, limit, search });
    },

    async forget(urls) {
      const uris = [];
      for (const url of urls) {
        try {
          uris.push(PlacesUtils.toURI(url));
        } catch {
          // Not an address Places can hold: nothing to remove for it.
        }
      }
      if (!uris.length) {
        return 0;
      }
      let removed = 0;
      await PlacesUtils.history.remove(uris, () => {
        removed += 1;
      });
      return removed;
    },

    async clear(range) {
      const beginTime = rangeBegin(range, Date.now());
      const count = await countVisits(PlacesUtils, beginTime);
      if (range === "everything") {
        await PlacesUtils.history.clear();
      } else {
        await PlacesUtils.history.removeVisitsByFilter({
          beginDate: new Date(beginTime),
        });
      }
      return count;
    },
  };
}

// --- Replies ----------------------------------------------------------------

async function pageReply(profile, call) {
  const store = await backend();
  if (!store) {
    // No store to read: the honest page is empty and final. Visits are flat;
    // the panel groups them by day itself.
    return { kind: "page", visits: [], next: null, profile };
  }
  const limit = call.limit;
  const rows = await store.list({
    beginTime: rangeBegin(call.range, Date.now()),
    before: cursorId(call.before),
    // One extra row tells us whether a following page exists without a
    // second round trip.
    limit: limit + 1,
    search: call.query.trim(),
  });
  const visits = rows.slice(0, limit).map(toVisit);
  const next =
    rows.length > limit ? (visits[visits.length - 1]?.id ?? null) : null;
  return { kind: "page", visits, next, profile };
}

async function forgetReply(profile, urls) {
  const store = await backend();
  if (!store) {
    // Nothing can be removed here, and a deletion is never claimed.
    return error(profile, "unavailable");
  }
  const count = await store.forget(urls);
  return { kind: "removed", count, profile };
}

async function clearReply(profile, range) {
  const store = await backend();
  if (!store) {
    return error(profile, "unavailable");
  }
  const count = await store.clear(range);
  return { kind: "removed", count, profile };
}

async function answer(profile, call) {
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
      return isPageCall(call)
        ? pageReply(profile, call)
        : error(profile, "invalid");

    case "forget":
      return isForgetUrls(call.urls)
        ? forgetReply(profile, call.urls)
        : error(profile, "invalid");

    case "clear":
      return isRange(call.range)
        ? clearReply(profile, call.range)
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
      return await answer(asked, call);
    } catch {
      // Defensive: a hostile payload or a Places failure must not take the
      // host down. `runtime` is not one of `HistoryError`, so the refusal
      // stays in the reply's own vocabulary: history is not reachable, which
      // is what `unavailable` says.
      return error(asked, "unavailable");
    }
  },
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Per-space browsing history.
//
// Places keeps one visit database per running profile directory, and this
// build must not fork it. Aster therefore owns a visit-to-space index and the
// History surface reads through this module: a visit made in space A is not
// listed, counted or searched while space B is in front. The raw Places file
// is not partitioned; that limit is stated in Settings and in
// `NATIVE_SURFACES.md`.
//
// Index shape: url -> { space_id, title, visited_at }. URL is normalised
// without its fragment, so a fragment scroll does not create a second entry.
// The index is bounded (MAX_ENTRIES); the oldest rows are dropped. Writes are
// debounced, and the one timer is cleared by `__resetSpaceHistoryForTests`.
//
// Isolation: a private window calls `note` with `private: true` and nothing is
// recorded. A space id that does not belong to the active profile is refused
// without confirming that it exists.

import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import {
  __activeProfileId,
  __activeSpaceId,
  __spacesState,
  __tabsState,
} from "./Tabs.sys.mjs";
import { HistoryCall } from "./HistoryCall.sys.mjs";
import { __nativeBinding } from "./SplitView.sys.mjs";

export const INDEX_PREF = "astra.history.spaces.v1";
export const MAX_ENTRIES = 5000;
export const PAGE_LIMIT = 100;
const MAX_SCAN_PAGES = 8;

let _index = null; // Map url -> entry
let _timer = null;

function services() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

function privateWindow(window_id = "") {
  try {
    const win =
      __nativeBinding(window_id)?.win ??
      services()?.wm?.getMostRecentWindow("navigator:browser") ??
      null;
    const CU = globalThis.ChromeUtils;
    if (win && CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      return PrivateBrowsingUtils.isWindowPrivate(win) === true;
    }
    return win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary";
  } catch {
    return false;
  }
}

function settingFlag(name, fallback) {
  try {
    const prefs = services()?.prefs;
    if (!prefs) return fallback;
    const raw = prefs.getStringPref(name, "");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

function normalise(url) {
  if (typeof url !== "string" || url === "") return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

function load() {
  if (_index) return _index;
  _index = new Map();
  try {
    const raw = services()?.prefs?.getStringPref(INDEX_PREF, "[]") ?? "[]";
    const rows = JSON.parse(raw);
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!row || typeof row.url !== "string" || typeof row.space_id !== "string") continue;
        _index.set(`${row.space_id}\u0000${row.url}`, {
          url: row.url,
          space_id: row.space_id,
          title: typeof row.title === "string" ? row.title : "",
          visited_at: Number.isFinite(row.visited_at) ? row.visited_at : 0,
        });
      }
    }
  } catch {
    _index = new Map();
  }
  return _index;
}

function flush() {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
  // Merge with the store before writing: another window's module has its own
  // cache and last-writer-wins would erase its visits.
  const merged = new Map();
  try {
    const existing = JSON.parse(services()?.prefs?.getStringPref(INDEX_PREF, "[]") ?? "[]");
    for (const row of Array.isArray(existing) ? existing : []) {
      if (row?.url && row?.space_id) merged.set(`${row.space_id}\u0000${row.url}`, row);
    }
  } catch {
    // A corrupt row is replaced by this window's index.
  }
  for (const [key, row] of load()) merged.set(key, row);
  const rows = [...merged.values()]
    .sort((a, b) => b.visited_at - a.visited_at)
    .slice(0, MAX_ENTRIES);
  try {
    services()?.prefs?.setStringPref(INDEX_PREF, JSON.stringify(rows));
  } catch {
    // No profile prefs (Node tests) or a closed profile.
  }
}

function scheduleFlush() {
  if (_timer !== null) return;
  _timer = setTimeout(() => {
    _timer = null;
    flush();
  }, 1500);
}

/** A space is addressable only while it belongs to the profile in front. */
function ownedSpace(spaceId) {
  const id = typeof spaceId === "string" && spaceId !== "" ? spaceId : __activeSpaceId();
  const spaces = __spacesState()?.spaces ?? [];
  const space = spaces.find((row) => row.id === id);
  if (!space || space.profile_id !== __activeProfileId()) return null;
  return id;
}

/** Pure filter used by the list path and the contract test. */
export function filterVisits(rows, allowedUrls, { showOther = false } = {}) {
  if (showOther) return rows;
  const allowed = allowedUrls instanceof Set ? allowedUrls : new Set(allowedUrls ?? []);
  return rows.filter((row) => allowed.has(normalise(row.url)));
}

/** Record one committed visit for the tab's own space. */
export function noteVisit({ url, space_id = "", title = "", visited_at = 0, private: isPrivate = false } = {}) {
  if (isPrivate) return { recorded: false, reason: "private_context" };
  const clean = normalise(url);
  if (clean === "") return { recorded: false, reason: "not_storable" };
  const space = ownedSpace(space_id);
  if (!space) return { recorded: false, reason: "space_not_owned" };
  const index = load();
  // A URL may be visited in two spaces. The index therefore keys by
  // (space, url), so one space's visit never moves or hides another's.
  index.set(`${space}\u0000${clean}`, {
    url: clean,
    space_id: space,
    title: typeof title === "string" ? title.slice(0, 300) : "",
    visited_at: Number.isFinite(visited_at) && visited_at > 0 ? visited_at : Date.now(),
  });
  if (index.size > MAX_ENTRIES) {
    const oldest = [...index.values()].sort((a, b) => a.visited_at - b.visited_at).slice(0, index.size - MAX_ENTRIES);
    for (const row of oldest) index.delete(`${row.space_id}\u0000${row.url}`);
  }
  scheduleFlush();
  return { recorded: true };
}

/** Record a visit from a native tab, resolving its space in the model. */
export function noteTabVisit(astraTabId, url, title = "") {
  try {
    const tab = __tabsState()?.tabs?.get(astraTabId);
    if (!tab) return { recorded: false, reason: "no_such_tab" };
    return noteVisit({
      url,
      space_id: tab.space_id,
      title,
      private: tab.private === true,
    });
  } catch {
    return { recorded: false, reason: "no_such_tab" };
  }
}

export const SpaceHistory = {
  /**
   * The `history_call` seam used by the History page and panel. A page read
   * is scoped to the space in front; the other kinds keep the engine's own
   * answers so a closed tab and a forget behave exactly as before.
   */
  async call({ request_id = "", profile = "", expected_profile = "", call = null, window_id = "" } = {}) {
    const scope = typeof profile === "string" && profile !== "" ? profile : expected_profile;
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window keeps no history");
    }
    if (!call || typeof call !== "object") return err(request_id, "invalid", "a history call is required");
    if (call.kind === "page") {
      return SpaceHistory.list({
        request_id,
        profile: scope,
        window_id,
        query: call.query,
        before: call.before,
        limit: call.limit,
        range: call.range,
        show_other:
          services()?.prefs?.getStringPref("astra.settings.history.scope", "space") === "profile" ||
          settingFlag("astra.settings.history.show-other", false),
      });
    }
    if (call.kind === "clear") {
      const cleared = await SpaceHistory.clear({ request_id, space_id: "", profile: scope, window_id });
      if (cleared.error) return cleared;
      return { kind: "removed", removed: cleared.removed, profile: scope };
    }
    return HistoryCall.call({ request_id, profile: scope, call });
  },

  /** Record a visit (the content binding calls this on a real commit). */
  async note({ request_id = "", url = "", space_id = "", title = "", visited_at = 0, private: isPrivate = false, window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window keeps no history");
    }
    const result = noteVisit({ url, space_id, title, visited_at, private: isPrivate });
    if (!result.recorded) {
      return err(request_id, result.reason, "this visit is not recorded");
    }
    return ok(request_id, result);
  },

  /** The History page's page cursor, scoped to one space. */
  async list(
    {
      request_id = "",
      space_id = "",
      query = "",
      before = null,
      limit = PAGE_LIMIT,
      range = "everything",
      show_other = false,
      profile = "default",
      window_id = "",
    } = {},
  ) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window keeps no history");
    }
    const space = ownedSpace(space_id);
    if (!space) return err(request_id, "space_not_owned", "that space is not in this profile");
    const size = Math.min(500, Math.max(1, Number(limit) || PAGE_LIMIT));
    const index = load();
    const showOther = show_other === true;
    const allowed = new Set([...index.values()].filter((row) => row.space_id === space).map((row) => row.url));
    let cursor = typeof before === "string" && before !== "" ? before : null;
    let out = [];
    let rawLast = null;
    let exhausted = false;
    for (let page = 0; page < MAX_SCAN_PAGES && out.length < size && !exhausted; page += 1) {
      const reply = await HistoryCall.call({
        profile,
        call: {
          kind: "page",
          query: typeof query === "string" ? query : "",
          range: typeof range === "string" ? range : "everything",
          before: cursor,
          limit: 200,
        },
      });
      if (!reply || reply.kind !== "page") return err(request_id, "history_unavailable", "the history store is not reachable");
      const rows = Array.isArray(reply.visits) ? reply.visits : [];
      const kept = filterVisits(rows, allowed, { showOther });
      out = out.concat(kept);
      rawLast = rows.length > 0 ? rows[rows.length - 1].id : null;
      cursor = reply.next ?? null;
      exhausted = cursor === null || rows.length === 0;
    }
    out = out.slice(0, size);
    return ok(request_id, {
      kind: "page",
      profile,
      scope: showOther ? "profile" : "space",
      space_id: space,
      visits: out,
      next: exhausted ? null : (out[out.length - 1]?.id ?? rawLast),
    });
  },

  /**
   * Clear one space's history. A URL that no sibling space also recorded is
   * removed from Places; a shared URL stays for the sibling and only its
   * index row for this space goes.
   */
  async clear({ request_id = "", space_id = "", profile = "default", window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window keeps no history");
    }
    const space = ownedSpace(space_id);
    if (!space) return err(request_id, "space_not_owned", "that space is not in this profile");
    const index = load();
    const mine = [...index.values()].filter((row) => row.space_id === space);
    const otherUrls = new Set(
      [...index.values()].filter((row) => row.space_id !== space).map((row) => row.url),
    );
    for (const row of mine) index.delete(`${row.space_id}\u0000${row.url}`);
    flush();
    const urls = mine.map((row) => row.url).filter((url) => !otherUrls.has(url));
    let removed = 0;
    if (urls.length > 0) {
      try {
        const reply = await HistoryCall.call({ profile, call: { kind: "forget", urls } });
        if (reply?.kind === "forgotten") removed = Number(reply.removed) || 0;
      } catch {
        // The index is still cleared; the panel sees the bounded result.
      }
    }
    return ok(request_id, { cleared: mine.length, removed, space_id: space });
  },

  /** The index size for one space, for the Settings row and the probe. */
  async status({ request_id = "", space_id = "", window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window keeps no history");
    }
    const space = ownedSpace(space_id);
    if (!space) return err(request_id, "space_not_owned", "that space is not in this profile");
    const rows = [...load().values()];
    return ok(request_id, {
      space_id: space,
      entries: rows.filter((row) => row.space_id === space).length,
      total: rows.length,
      scope: "space",
    });
  },
};

/** Flush a pending index write before a window goes away. */
export function __flushSpaceHistory() {
  if (_timer !== null) flush();
}

export function __resetSpaceHistoryForTests() {
  if (_timer !== null) clearTimeout(_timer);
  _timer = null;
  _index = null;
}

/** Test-only index injection (no profile prefs in Node). */
export function __setSpaceHistoryIndexForTests(rows) {
  _index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.url) continue;
    _index.set(`${row.space_id ?? "space-1"}\u0000${row.url}`, { ...row });
  }
}

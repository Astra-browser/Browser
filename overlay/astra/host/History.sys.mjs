/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API History module (P2-T07, resolves U-06). Mirrors core-owned
// history (astra-store `history` table) into the engine Places store so
// `:visited` link styling works.
//
// Design (core owns, host mirrors):
//   - Core is the source of truth. The sidecar pushes visits over IPC;
//     this module records each visit into Places via the verified API:
//       engine/toolkit/components/places/History.sys.mjs
//       - History.insert({ url, title?, visits: [{ date? }] })
//         (transition defaults to TRANSITION_LINK; date defaults to now)
//       - History.fetch(url) -> PageInfo | null
//       - History.clear() -> Promise<void>
//   - D-15 (no telemetry): this module touches Places history only. It
//     reads/writes no prefs, enables no telemetry, and performs no network
//     I/O. `visit()`/`clear()`/`isVisited()` take no telemetry parameters.
//   - Mirror policy M-1: only http(s) URLs are mirrored. Places refuses to
//     store chrome:/about:/resource:/data: schemes (CanAddURI/CanStore in
//     nsNavHistory.cpp / History.cpp); such visits are acknowledged with
//     `{ mirrored: false, reason }` instead of failing the call.
//
// Lane isolation: this module's only static import is `Envelope.sys.mjs`,
// which imports nothing, so it can be imported by file path in Node contract
// tests AND in chrome via
// `ChromeUtils.importESModule("resource://astra/host/History.sys.mjs")`
// (or a file:// URL in tests) without pulling in the P2-T06 lane. Event
// emission goes through an injectable sink: HostAPI wiring connects it to
// the Events pump (`history.visited` / `history.cleared`); unconnected it
// is a no-op. Backend selection: an injected backend wins (Node tests),
// else a lazy live Places backend is used when running in chrome, else an
// in-memory backend (Node default).

import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";

// --- Injectable seams (test + HostAPI wiring) -------------------------------

let _backend = null; // { insert(info), fetch(url), clear() } | null
let _eventSink = null; // (type, data) => void | null
let _liveBackendPromise = null;

function emit(type, data) {
  if (_eventSink) {
    try {
      _eventSink(type, data);
    } catch {
      // A broken listener must never break the mirror.
    }
  }
}

export function __setHistoryBackend(backend) {
  _backend = backend;
  return () => {
    if (_backend === backend) {
      _backend = null;
    }
  };
}

export function __setHistoryEventSink(fn) {
  _eventSink = fn || null;
}

// --- Backends ----------------------------------------------------------------

// In-memory backend: Node default. Mirrors Places semantics at stub level:
// keyed by normalized URL, titles update on revisit, visits accumulate.
function createMemoryBackend() {
  const pages = new Map(); // normalizedUrl -> { url, title, visits: [{ date }] }
  return {
    __pages: pages,
    async insert({ url, title, visits }) {
      let page = pages.get(url);
      if (!page) {
        page = { url, title: "", visits: [] };
        pages.set(url, page);
      }
      if (typeof title === "string" && title !== "") {
        page.title = title;
      }
      for (const v of visits) {
        page.visits.push({ date: v.date instanceof Date ? v.date.getTime() : v.date });
      }
      return { url: page.url, title: page.title, visits: [...page.visits] };
    },
    async fetch(url) {
      const page = pages.get(url);
      return page ? { url: page.url, title: page.title, visits: [...page.visits] } : null;
    },
    async clear() {
      pages.clear();
    },
  };
}

// Live backend: thin adapter over the verified Places History API. Resolved
// lazily so merely importing this module never touches Firefox internals.
async function liveBackend() {
  if (!_liveBackendPromise) {
    _liveBackendPromise = (async () => {
      // Dynamic import keeps this module importable from Node by path.
      const { History: PlacesHistory } = await import(
        "resource://gre/modules/History.sys.mjs"
      );
      return {
        insert: (info) => PlacesHistory.insert(info),
        fetch: (url) => PlacesHistory.fetch(url),
        clear: () => PlacesHistory.clear(),
      };
    })();
  }
  return _liveBackendPromise;
}

async function backend() {
  if (_backend) {
    return _backend;
  }
  const inChrome =
    typeof globalThis.ChromeUtils !== "undefined" &&
    globalThis.ChromeUtils &&
    typeof globalThis.ChromeUtils.importESModule === "function";
  if (inChrome) {
    return liveBackend();
  }
  _backend = createMemoryBackend();
  return _backend;
}

// --- URL policy (M-1) ----------------------------------------------------------

function normalizeUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, code: "invalid_url", message: "url must be a non-empty string" };
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, code: "invalid_url", message: `unparseable url ${raw}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // Mirrors CanAddURI/CanStore: Places cannot store this scheme.
    return { ok: false, skipped: true, reason: `scheme ${parsed.protocol} is not stored by Places` };
  }
  return { ok: true, url: parsed.href };
}

function coerceDate(visit_time) {
  if (visit_time === undefined || visit_time === null) {
    return new Date();
  }
  if (visit_time instanceof Date) {
    return visit_time;
  }
  if (typeof visit_time === "number" && Number.isFinite(visit_time)) {
    return new Date(visit_time);
  }
  return null;
}

// --- Public API ----------------------------------------------------------------

export const History = {
  // Mirror one core-owned visit into Places. `visit_time` is ms since the
  // epoch (astra-store `history.visit_time`) or a Date; defaults to now.
  async visit({ request_id = "", url = "", title = "", visit_time } = {}) {
    const norm = normalizeUrl(url);
    if (!norm.ok && !norm.skipped) {
      return err(request_id, norm.code, norm.message);
    }
    if (norm.skipped) {
      return ok(request_id, { url, mirrored: false, reason: norm.reason });
    }
    const date = coerceDate(visit_time);
    if (!date) {
      return err(request_id, "invalid_url", "visit_time must be ms since epoch, a Date, or omitted");
    }
    const info = { url: norm.url, visits: [{ date }] };
    if (typeof title === "string" && title !== "") {
      info.title = title;
    }
    try {
      await (await backend()).insert(info);
    } catch (e) {
      return err(request_id, "mirror_failed", String((e && e.message) || e));
    }
    const visitTimeMs = date.getTime();
    emit("history.visited", { url: norm.url, title: title || "", visit_time: visitTimeMs });
    return ok(request_id, {
      url: norm.url,
      title: title || "",
      visit_time: visitTimeMs,
      mirrored: true,
    });
  },

  // Mirror a core history wipe into Places (removes ALL visits).
  async clear({ request_id = "" } = {}) {
    try {
      await (await backend()).clear();
    } catch (e) {
      return err(request_id, "mirror_failed", String((e && e.message) || e));
    }
    emit("history.cleared", {});
    return ok(request_id, { cleared: true });
  },

  // Read helper for tests/UI: is this URL visited per the mirror?
  // Emits no events.
  async isVisited({ request_id = "", url = "" } = {}) {
    const norm = normalizeUrl(url);
    if (!norm.ok) {
      if (norm.skipped) {
        return ok(request_id, { url, visited: false });
      }
      return err(request_id, norm.code, norm.message);
    }
    let page;
    try {
      page = await (await backend()).fetch(norm.url);
    } catch (e) {
      return err(request_id, "mirror_failed", String((e && e.message) || e));
    }
    return ok(request_id, { url: norm.url, visited: !!page });
  },
};

// Test-only reset so contract tests start from a clean slate. Does NOT
// clear a live Places database; use History.clear() for that.
export function __resetHistoryForTests() {
  _backend = null;
  _eventSink = null;
  _liveBackendPromise = null;
}

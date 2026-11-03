/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Navigation module (v1). Moves tabs through their history stacks
// and reports every commit as `nav.committed` + `tab.updated`
// (Appendix C). Per-tab zoom, find-in-page state and reader-mode flags are
// tracked here; the live `<browser>` actions (stop, zoom, find, print,
// reader) are performed by Content.sys.mjs against the real browser
// element and report back through `__commitExternal`. Pure logic, no
// Firefox internals.
//
// Zoom range mirrors Firefox FullZoom limits (0.3–3.0); the model clamps
// and the live binding applies via `ZoomManager`/`FullZoom`.

import { emit } from "./Events.sys.mjs";
import { emitItemsChanged } from "./Tabs.sys.mjs";
import { resolve as resolveInput } from "./Search.sys.mjs";
import { HOST_API_VERSION, __historyFor, __pushHistory, __tabsState } from "./Tabs.sys.mjs";

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 3.0;

const _zoom = new Map(); // astra_tab_id -> zoom level (default 1)
const _find = new Map(); // astra_tab_id -> { query, matchCount, activeMatch }
const _reader = new Map(); // astra_tab_id -> { enabled, available }

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function tabOf(astra_tab_id) {
  const { tabs, selectedId } = __tabsState();
  const id = astra_tab_id || selectedId;
  const tab = tabs.get(id);
  return { id, tab };
}

/** A New Tab is a place, not a step: it is never a Back/Forward entry. */
function isBlankUrl(url) {
  return url === "" || url === "about:blank";
}

// Push a committed URL onto a tab's stack without leaving a New Tab behind it.
// `Tabs.create` seeds the stack with `about:blank`, so a plain push would make
// the first real page sit on top of the New Tab and Back would land there.
// Replacing that head (index stays 0) is what makes the first page reachable
// with Back disabled, like a native browser. A URL equal to the head is a
// reload and adds nothing; only a genuinely new URL truncates the forward
// branch (`__pushHistory`). `__historyFor` returns the live object, so the
// replacement happens in place.
function pushOrReplaceHistory(id, url) {
  const h = __historyFor(id);
  if (!h) {
    __pushHistory(id, url);
    return;
  }
  const head = h.index >= 0 ? h.entries[h.index] : null;
  if (head === url) {
    return;
  }
  if (isBlankUrl(head)) {
    if (h.index === 0) {
      // The fresh tab's New Tab: the real page takes its place.
      h.entries[0] = url;
      return;
    }
    // A blank head above real entries should not happen; drop it rather than
    // keep a New Tab the person has to step through.
    h.entries.splice(h.index, 1);
    h.index -= 1;
  }
  __pushHistory(id, url);
}

function commit(id, url, extra = {}) {
  const { tabs } = __tabsState();
  const tab = tabs.get(id);
  tab.url = url;
  // A commit is not the end of the load: the model commits the address the
  // moment the person asks for it, and the content binding keeps it loading
  // until the document lands. An external commit passes the browser's own
  // flag, so an in-page pushState does not leave the tab spinning.
  tab.loading =
    typeof extra.loading === "boolean"
      ? extra.loading
      : extra.external === true
        ? false
        : true;
  const h = __historyFor(id);
  emit("nav.committed", { astra_tab_id: id, url, ...extra });
  emit("tab.updated", {
    astra_tab_id: id,
    url,
    title: tab.title,
    selected: tab.selected,
    loading: tab.loading,
    canGoBack: h ? h.index > 0 : false,
    canGoForward: h ? h.index < h.entries.length - 1 : false,
  });
  // The product UI renders from the items projection, so a committed address
  // has to reach it or the field would keep showing the old one.
  emitItemsChanged();
}

export const Navigation = {
  async loadURL({ request_id = "", astra_tab_id = "", url = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return {
        ...err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`),
        accepted: false,
      };
    }
    if (!url) {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    // Words typed into an address field are a search, not a broken address;
    // Search owns that decision, so every box agrees.
    const target = resolveInput(url);
    if (!target) {
      return { ...err(request_id, "invalid_url", "nothing to navigate to"), accepted: false };
    }
    url = target.url;
    // The row and the stage show a load from the first moment, so a slow page
    // is visibly loading instead of a blank window.
    const { tabs } = __tabsState();
    const loadingTab = tabs.get(id);
    if (loadingTab) loadingTab.loading = true;
    emit("nav.started", { astra_tab_id: id, url });
    emit("tab.updated", { astra_tab_id: id, url, loading: true });
    // Pressing Enter on the address already in the bar is a reload, not a
    // second visit: a duplicated entry makes Back look like it does nothing.
    // A fresh tab's head is its New Tab, so the first real page replaces it
    // instead of stacking on top of a blank the person can never revisit.
    const head = __historyFor(id);
    const reloading = !!head && head.index >= 0 && head.entries[head.index] === url;
    if (!reloading) {
      pushOrReplaceHistory(id, url);
    }
    commit(id, url, reloading ? { reloaded: true, loading: true } : { loading: true });
    return { ...ok(request_id, { astra_tab_id: id, url }), accepted: true, operation_id: null };
  },

  async goBack({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const h = __historyFor(id);
    if (!h || h.index <= 0) {
      return ok(request_id, { astra_tab_id: id, went_back: false, url: tab.url });
    }
    h.index -= 1;
    commit(id, h.entries[h.index], { loading: true });
    return ok(request_id, { astra_tab_id: id, went_back: true, url: tab.url });
  },

  async goForward({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const h = __historyFor(id);
    if (!h || h.index >= h.entries.length - 1) {
      return ok(request_id, { astra_tab_id: id, went_forward: false, url: tab.url });
    }
    h.index += 1;
    commit(id, h.entries[h.index], { loading: true });
    return ok(request_id, { astra_tab_id: id, went_forward: true, url: tab.url });
  },

  async reload({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    commit(id, tab.url, { reloaded: true, loading: true });
    return ok(request_id, { astra_tab_id: id, reloaded: true, url: tab.url });
  },

  // Reload with the HTTP cache bypassed. The model marks the tab loading;
  // the content binding performs `reloadWithFlags(BYPASS_CACHE)` so a stale
  // cache entry cannot answer the same URL.
  async hardReload({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    tab.loading = true;
    emit("nav.hard-reload", { astra_tab_id: id, url: tab.url });
    emit("tab.updated", {
      astra_tab_id: id,
      url: tab.url,
      title: tab.title,
      selected: tab.selected,
      loading: true,
      canGoBack: (__historyFor(id)?.index ?? 0) > 0,
      canGoForward: false,
    });
    emitItemsChanged();
    return ok(request_id, { astra_tab_id: id, reloaded: true, hard: true, url: tab.url });
  },

  // Stop an in-flight load. The model records the intent; the live
  // binding calls `browser.stop()` when a real browser is attached.
  async stop({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    emit("nav.stopped", { astra_tab_id: id, url: tab.url });
    return ok(request_id, { astra_tab_id: id, stopped: true, url: tab.url });
  },

  async setZoom({ request_id = "", astra_tab_id = "", zoom = 1 } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    if (typeof zoom !== "number" || !Number.isFinite(zoom)) {
      return err(request_id, "invalid_zoom", "zoom must be a finite number");
    }
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    _zoom.set(id, clamped);
    emit("nav.zoom-changed", { astra_tab_id: id, zoom: clamped });
    return ok(request_id, { astra_tab_id: id, zoom: clamped });
  },

  async getZoom({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    return ok(request_id, { astra_tab_id: id, zoom: _zoom.get(id) ?? 1 });
  },

  // Find-in-page. The model stores the query and reports it; live match
  // counts come from the content binding (`browser.finder`) and are merged
  // via `setFindResult`. Counts of 0 mean "no live count yet", not "none".
  async findInPage({ request_id = "", astra_tab_id = "", query = "", direction = "forward" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    if (typeof query !== "string" || query === "") {
      return err(request_id, "invalid_query", "query must be a non-empty string");
    }
    if (direction !== "forward" && direction !== "backward") {
      return err(request_id, "invalid_direction", "direction must be forward or backward");
    }
    const prev = _find.get(id);
    const state = { query, matchCount: prev?.query === query ? prev.matchCount : 0, activeMatch: 0 };
    _find.set(id, state);
    emit("nav.find-result", { astra_tab_id: id, ...state });
    return ok(request_id, { astra_tab_id: id, ...state });
  },

  // Live-binding ingress: merge a real match count from `browser.finder`.
  async setFindResult({ request_id = "", astra_tab_id = "", matchCount = 0, activeMatch = 0 } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const prev = _find.get(id) ?? { query: "" };
    const state = { query: prev.query, matchCount, activeMatch };
    _find.set(id, state);
    emit("nav.find-result", { astra_tab_id: id, ...state });
    return ok(request_id, { astra_tab_id: id, ...state });
  },

  // Print dispatch. The model records intent and emits; Content.printPage
  // performs the live print via `PrintUtils` when attached.
  async print({ request_id = "", astra_tab_id = "" } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    emit("nav.print-requested", { astra_tab_id: id, url: tab.url });
    return ok(request_id, { astra_tab_id: id, dispatched: true });
  },

  // Reader-mode flag. Availability is determined live (AboutReader); the
  // model tracks the requested state so restore/session code can re-apply.
  async setReaderMode({ request_id = "", astra_tab_id = "", enabled = true } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const prev = _reader.get(id) ?? { available: false };
    const state = { enabled: enabled === true, available: prev.available };
    _reader.set(id, state);
    emit("nav.reader-changed", { astra_tab_id: id, ...state });
    return ok(request_id, { astra_tab_id: id, ...state });
  },

  // Live-binding ingress: report whether the current page offers reader mode.
  async setReaderAvailable({ request_id = "", astra_tab_id = "", available = false } = {}) {
    const { id, tab } = tabOf(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id || "(none selected)"}`);
    }
    const prev = _reader.get(id) ?? { enabled: false };
    const state = { enabled: prev.enabled, available: available === true };
    _reader.set(id, state);
    emit("nav.reader-changed", { astra_tab_id: id, ...state });
    return ok(request_id, { astra_tab_id: id, ...state });
  },
};

// Live-binding ingress (Content.sys.mjs progress listeners): an external
// load (link click, history.pushState, redirect) observed in a real
// browser. A URL equal to the current head is a reload (no history push);
// a New Tab head is replaced by the real page; anything else pushes a new
// history entry. Never throws.
export function __commitExternal(id, url, extra = {}) {
  const { tabs } = __tabsState();
  const tab = tabs.get(id);
  if (!tab || typeof url !== "string" || url === "") {
    return null;
  }
  const h = __historyFor(id);
  const head = h && h.index >= 0 ? h.entries[h.index] : null;
  if (head === url) {
    commit(id, url, { ...extra, reloaded: true, external: true });
  } else {
    pushOrReplaceHistory(id, url);
    if (typeof extra.title === "string") {
      tab.title = extra.title;
    }
    commit(id, url, { ...extra, external: true });
  }
  emit("content.location-changed", { astra_tab_id: id, url });
  return tab.url;
}

// Test-only reset so contract tests start from a clean slate.
export function __resetNavigationForTests() {
  _zoom.clear();
  _find.clear();
  _reader.clear();
}

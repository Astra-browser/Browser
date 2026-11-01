/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Tabs module (P1-T10). Firefox owns live tab objects (D-05);
// this stub owns the *model*: stable `astra_tab_id`s, selection, and a
// per-tab history stack driving back/forward. The P2-T06 host binding keeps
// this protocol and swaps the model for real `gBrowser` tabs. Pure logic,
// no Firefox internals.

import { emit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;

const _tabs = new Map(); // astra_tab_id -> { astra_tab_id, url, title, selected }
const _history = new Map(); // astra_tab_id -> { entries: [url], index: n }
let _nextId = 1;
let _selectedId = "";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function snapshot(id) {
  const tab = _tabs.get(id);
  if (!tab) {
    return null;
  }
  const h = _history.get(id) ?? { entries: [], index: -1 };
  return {
    ...tab,
    canGoBack: h.index > 0,
    canGoForward: h.index >= 0 && h.index < h.entries.length - 1,
  };
}

function selectInternal(id) {
  for (const tab of _tabs.values()) {
    tab.selected = tab.astra_tab_id === id;
  }
  _selectedId = id;
  const snap = snapshot(id);
  emit("tab.updated", { ...snap, selected: true });
  return snap;
}

export function __tabsState() {
  return { tabs: _tabs, history: _history, get selectedId() { return _selectedId; } };
}

// Test-only: Navigation drives history through these without events of its own.
export function __pushHistory(id, url) {
  let h = _history.get(id);
  if (!h) {
    h = { entries: [], index: -1 };
    _history.set(id, h);
  }
  h.entries = h.entries.slice(0, h.index + 1);
  h.entries.push(url);
  h.index = h.entries.length - 1;
}

export function __historyFor(id) {
  return _history.get(id) ?? null;
}

export const Tabs = {
  async create({ request_id = "", url = "about:blank", background = false } = {}) {
    const astra_tab_id = `tab-${_nextId++}`;
    _tabs.set(astra_tab_id, { astra_tab_id, url, title: "", selected: false });
    __pushHistory(astra_tab_id, url);
    emit("tab.created", { astra_tab_id, url });
    if (!background || _selectedId === "") {
      selectInternal(astra_tab_id);
    }
    return ok(request_id, { astra_tab_id, url });
  },

  async select({ request_id = "", astra_tab_id = "" } = {}) {
    if (!_tabs.has(astra_tab_id)) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    const snap = selectInternal(astra_tab_id);
    return ok(request_id, { astra_tab_id, url: snap.url });
  },

  async close({ request_id = "", astra_tab_id = "" } = {}) {
    const existed = _tabs.delete(astra_tab_id);
    _history.delete(astra_tab_id);
    if (existed) {
      emit("tab.closed", { astra_tab_id });
      if (_selectedId === astra_tab_id) {
        _selectedId = "";
        const first = _tabs.keys().next();
        if (!first.done) {
          selectInternal(first.value);
        }
      }
    }
    return ok(request_id, { closed: existed });
  },

  async list({ request_id = "" } = {}) {
    return ok(request_id, {
      tabs: [..._tabs.keys()].map((id) => snapshot(id)),
      selected_tab_id: _selectedId,
    });
  },
};

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetTabsForTests() {
  _tabs.clear();
  _history.clear();
  _nextId = 1;
  _selectedId = "";
}

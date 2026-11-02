/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Tabs module (v1). Firefox owns live tab objects (D-05); this
// module owns the *model*: stable `astra_tab_id`s, window association,
// ordering, pin/discard state, selection, and a per-tab history stack
// driving back/forward. The live `gBrowser` binding lives in
// Content.sys.mjs, which calls these model ops and mirrors them into real
// `<browser>` elements (verified ESR 153 APIs: `gBrowser.addTab(uri,
// {triggeringPrincipal, inBackground})`, `removeTab`, `selectedTab`,
// `moveTabTo(tab, {tabIndex})`, `pinTab`/`unpinTab`,
// `discardBrowser(tab)`, `reloadTab(tab)`, `duplicateTab(tab)`).
// Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;

export const DEFAULT_WINDOW_ID = "win-1";

const _tabs = new Map(); // astra_tab_id -> tab record
const _order = []; // astra_tab_id in display order
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
    index: _order.indexOf(id),
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

// Test-only + Windows.close: close every tab in a window.
export function __closeTabsInWindow(window_id) {
  const ids = [..._order].filter((id) => _tabs.get(id)?.window_id === window_id);
  for (const id of ids) {
    _tabs.delete(id);
    _history.delete(id);
    const i = _order.indexOf(id);
    if (i >= 0) {
      _order.splice(i, 1);
    }
    emit("tab.closed", { astra_tab_id: id, window_id });
  }
  if (_selectedId && !_tabs.has(_selectedId)) {
    _selectedId = "";
    const first = _order[0];
    if (first !== undefined) {
      selectInternal(first);
    }
  }
  return ids;
}

// Live-binding ingress (Content.sys.mjs progress listeners): patch a tab's
// externally-observed fields and announce it. Never throws.
export function __applyExternalUpdate(id, patch = {}) {
  const tab = _tabs.get(id);
  if (!tab) {
    return null;
  }
  if (typeof patch.title === "string") {
    tab.title = patch.title;
  }
  if (typeof patch.url === "string" && patch.url !== "") {
    tab.url = patch.url;
  }
  if (typeof patch.discarded === "boolean") {
    tab.discarded = patch.discarded;
  }
  const snap = snapshot(id);
  emit("tab.updated", { ...snap });
  emitItemsChanged();
  return snap;
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

// --- Projection for the product UI (P3-T20) -------------------------------
// The ported app renders from `items-changed` snapshots (ItemsState), not
// from `tab.created`/`tab.updated` deltas. Until astra-core owns this
// projection, the host derives one from its own tab model so the shell can
// paint the real sidebar + New Tab instead of an empty stage.

const PROFILE_ID = "default";

// --- Spaces ---------------------------------------------------------------
// A space is an ordered group of tabs inside one profile. Native owns the
// list and each tab's membership; the projection carries both, so switching
// a space never has to re-open anything.
const DEFAULT_SPACE_ID = "space-1";
let _spaces = [
  { id: DEFAULT_SPACE_ID, name: "Space", icon: null, color: 0, theme: null },
];
let _activeSpaceId = DEFAULT_SPACE_ID;
let _nextSpaceId = 2;

function spaceOf(space_id) {
  return _spaces.find((space) => space.id === space_id) ?? null;
}

/** The active space's tabs, in display order. */
function activeOrder() {
  return _order.filter((id) => _tabs.get(id)?.space_id === _activeSpaceId);
}

/** A new space takes the first unused "Space N". */
function nextSpaceName() {
  for (let n = 2; n < 1000; n += 1) {
    const name = `Space ${n}`;
    if (!_spaces.some((space) => space.name === name)) return name;
  }
  return "Space";
}
let _projection = 0;

/** Fixed-width hex so JS string compare orders revisions without BigInt. */
function nextRevision() {
  _projection += 1;
  return _projection.toString(16).padStart(16, "0");
}

/** A tab with no committed page is a New Tab: `url` is null, not about:blank. */
function tabView(id) {
  const tab = _tabs.get(id);
  if (!tab) {
    return null;
  }
  const h = _history.get(id) ?? { entries: [], index: -1 };
  const blank = !tab.url || tab.url === "about:blank";
  return {
    id,
    projection_revision: nextRevision(),
    title: tab.title || (blank ? "New Tab" : ""),
    url: blank ? null : tab.url,
    loading: false,
    can_go_back: h.index > 0,
    can_go_forward: h.index >= 0 && h.index < h.entries.length - 1,
    icon: null,
  };
}

/** Build the ItemsState the product UI renders (bindings.ts: ItemsState). */
export function __itemsSnapshot() {
  const order = activeOrder();
  const tabs = order.map(tabView).filter(Boolean);
  const active = _selectedId && order.includes(_selectedId) ? _selectedId : (order[0] ?? null);
  return {
    projection_revision: nextRevision(),
    profile: { id: PROFILE_ID, name: "Personal", kind: "default" },
    spaces: _spaces.map((space) => ({
      ...space,
      tabs: _order.filter((id) => _tabs.get(id)?.space_id === space.id).length,
      previews: [],
    })),
    active_space_id: _activeSpaceId,
    nodes: tabs.map((tab) => ({
      id: tab.id,
      parent_id: null,
      section: "today",
      kind: { type: "tab", tab_id: tab.id },
    })),
    tabs,
    active,
    split_group: null,
  };
}

/** Announce the full projection; the app replaces its tree with it. */
export function emitItemsChanged() {
  emit("items-changed", __itemsSnapshot());
}

export const Tabs = {
  // The app calls this on boot (and retries) to receive its first snapshot.
  // A window always has one tab, so an empty model gets a fresh New Tab.
  async bootstrap({ request_id = "" } = {}) {
    if (_order.length === 0) {
      const astra_tab_id = `tab-${_nextId++}`;
      _tabs.set(astra_tab_id, {
        astra_tab_id,
        url: "",
        title: "",
        selected: true,
        window_id: DEFAULT_WINDOW_ID,
        space_id: _activeSpaceId,
        pinned: false,
        discarded: false,
        muted: false,
      });
      _order.push(astra_tab_id);
      _selectedId = astra_tab_id;
    }
    emitItemsChanged();
    return ok(request_id, { bootstrapped: true, selected_tab_id: _selectedId });
  },

  async create({ request_id = "", url = "about:blank", background = false, window_id = DEFAULT_WINDOW_ID, index = -1 } = {}) {
    if (typeof url !== "string" || url === "") {
      return err(request_id, "invalid_url", "url must be a non-empty string");
    }
    const astra_tab_id = `tab-${_nextId++}`;
    _tabs.set(astra_tab_id, {
      astra_tab_id,
      url,
      title: "",
      selected: false,
      window_id,
      space_id: _activeSpaceId,
      pinned: false,
      discarded: false,
      muted: false,
    });
    if (Number.isInteger(index) && index >= 0 && index <= _order.length) {
      _order.splice(index, 0, astra_tab_id);
    } else {
      _order.push(astra_tab_id);
    }
    __pushHistory(astra_tab_id, url);
    emit("tab.created", { astra_tab_id, url, window_id });
    if (!background || _selectedId === "") {
      selectInternal(astra_tab_id);
    }
    emitItemsChanged();
    return ok(request_id, { astra_tab_id, url, window_id });
  },

  async select({ request_id = "", astra_tab_id = "" } = {}) {
    if (!_tabs.has(astra_tab_id)) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    const snap = selectInternal(astra_tab_id);
    emitItemsChanged();
    return ok(request_id, { astra_tab_id, url: snap.url, window_id: snap.window_id });
  },

  async close({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    const existed = _tabs.delete(astra_tab_id);
    _history.delete(astra_tab_id);
    const i = _order.indexOf(astra_tab_id);
    if (i >= 0) {
      _order.splice(i, 1);
    }
    if (existed) {
      emit("tab.closed", { astra_tab_id, window_id: tab.window_id });
      if (_selectedId === astra_tab_id) {
        _selectedId = "";
        const first = _order[0];
        if (first !== undefined) {
          selectInternal(first);
        }
      }
    }
    emitItemsChanged();
    return ok(request_id, { closed: existed });
  },

  // --- Spaces -------------------------------------------------------------
  // Each answers an OperationAdmission: the projection that follows is the
  // result, so the UI never guesses what native did.

  async createSpace({ request_id = "", name = "", look = null } = {}) {
    const id = `space-${_nextSpaceId++}`;
    _spaces.push({
      id,
      name: typeof name === "string" && name.trim() !== "" ? name.trim() : nextSpaceName(),
      icon: look?.icon ?? null,
      color: Number.isInteger(look?.color) ? look.color : 0,
      theme: look?.theme ?? null,
    });
    _activeSpaceId = id;
    _selectedId = "";
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async updateSpace({ request_id = "", space = "", name = "", look = null } = {}) {
    const target = spaceOf(space);
    if (!target) return { operation_id: null, accepted: false };
    if (typeof name === "string" && name.trim() !== "") target.name = name.trim();
    if (look) {
      target.icon = look.icon ?? null;
      target.color = Number.isInteger(look.color) ? look.color : target.color;
      target.theme = look.theme ?? null;
    }
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async deleteSpace({ request_id = "", space = "" } = {}) {
    if (_spaces.length <= 1) return { operation_id: null, accepted: false };
    const at = _spaces.findIndex((entry) => entry.id === space);
    if (at < 0) return { operation_id: null, accepted: false };
    // Its tabs close with it: a tab cannot outlive the space that held it.
    for (const id of [..._order].filter((id) => _tabs.get(id)?.space_id === space)) {
      _tabs.delete(id);
      _history.delete(id);
      const i = _order.indexOf(id);
      if (i >= 0) _order.splice(i, 1);
      emit("tab.closed", { astra_tab_id: id, window_id: DEFAULT_WINDOW_ID });
    }
    _spaces.splice(at, 1);
    if (_activeSpaceId === space) {
      _activeSpaceId = _spaces[Math.min(at, _spaces.length - 1)].id;
      _selectedId = "";
      const first = activeOrder()[0];
      if (first !== undefined) selectInternal(first);
    }
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async reorderSpace({ request_id = "", space = "", before = null } = {}) {
    const at = _spaces.findIndex((entry) => entry.id === space);
    if (at < 0) return { operation_id: null, accepted: false };
    const [moved] = _spaces.splice(at, 1);
    const to = before === null ? _spaces.length : _spaces.findIndex((entry) => entry.id === before);
    _spaces.splice(to < 0 ? _spaces.length : to, 0, moved);
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async switchSpace({ request_id = "", space = "" } = {}) {
    if (!spaceOf(space)) return { operation_id: null, accepted: false };
    _activeSpaceId = space;
    const first = activeOrder()[0];
    _selectedId = "";
    if (first !== undefined) selectInternal(first);
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async stepSpace({ request_id = "", step = 1 } = {}) {
    if (!Number.isInteger(step) || step === 0) return { operation_id: null, accepted: false };
    const at = _spaces.findIndex((entry) => entry.id === _activeSpaceId);
    if (at < 0) return { operation_id: null, accepted: false };
    const next = (at + (step > 0 ? 1 : -1) + _spaces.length) % _spaces.length;
    return Tabs.switchSpace({ request_id, space: _spaces[next].id });
  },

  async moveTabToSpace({ request_id = "", tab = "", space = "" } = {}) {
    const target = _tabs.get(tab);
    if (!target || !spaceOf(space)) return { operation_id: null, accepted: false };
    target.space_id = space;
    if (space !== _activeSpaceId) {
      const i = _order.indexOf(tab);
      if (i >= 0) _order.splice(i, 1);
      _order.push(tab);
      if (_selectedId === tab) {
        _selectedId = "";
        const first = activeOrder()[0];
        if (first !== undefined) selectInternal(first);
      }
    }
    emitItemsChanged();
    return { operation_id: null, accepted: true };
  },

  async list({ request_id = "", window_id = "" } = {}) {
    const ids = window_id
      ? _order.filter((id) => _tabs.get(id)?.window_id === window_id)
      : [..._order];
    return ok(request_id, {
      tabs: ids.map((id) => snapshot(id)),
      selected_tab_id: _selectedId,
    });
  },

  async get({ request_id = "", astra_tab_id = "" } = {}) {
    const snap = snapshot(astra_tab_id);
    if (!snap) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    return ok(request_id, { tab: snap });
  },

  // Reorder a tab within its window's display order.
  async move({ request_id = "", astra_tab_id = "", index = 0 } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    if (!Number.isInteger(index) || index < 0) {
      return err(request_id, "invalid_index", "index must be a non-negative integer");
    }
    const from = _order.indexOf(astra_tab_id);
    _order.splice(from, 1);
    const clamped = Math.min(index, _order.length);
    _order.splice(clamped, 0, astra_tab_id);
    emit("tab.moved", { astra_tab_id, from_index: from, to_index: clamped });
    return ok(request_id, { astra_tab_id, index: clamped });
  },

  // Fork a tab: same URL/history, new id, placed next to the source.
  async duplicate({ request_id = "", astra_tab_id = "", background = false } = {}) {
    const src = _tabs.get(astra_tab_id);
    if (!src) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    const created = await Tabs.create({
      request_id,
      url: src.url,
      background: true,
      window_id: src.window_id,
      index: _order.indexOf(astra_tab_id) + 1,
    });
    if (created.error) {
      return created;
    }
    const dupId = created.astra_tab_id;
    const srcHist = _history.get(astra_tab_id);
    if (srcHist) {
      _history.set(dupId, { entries: [...srcHist.entries], index: srcHist.index });
    }
    const dup = _tabs.get(dupId);
    dup.title = src.title;
    dup.pinned = src.pinned;
    if (!background) {
      selectInternal(dupId);
    }
    return ok(request_id, { astra_tab_id: dupId, url: src.url, source_tab_id: astra_tab_id });
  },

  async pin({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    tab.pinned = true;
    emit("tab.pinned", { astra_tab_id });
    return ok(request_id, { astra_tab_id, pinned: true });
  },

  async unpin({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    tab.pinned = false;
    emit("tab.unpinned", { astra_tab_id });
    return ok(request_id, { astra_tab_id, pinned: false });
  },

  // Sleep a tab (live: `gBrowser.discardBrowser`). Keeps history +
  // selection model intact; the content process may be dropped.
  async discard({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    tab.discarded = true;
    emit("tab.discarded", { astra_tab_id });
    return ok(request_id, { astra_tab_id, discarded: true });
  },

  async wakeup({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    tab.discarded = false;
    emit("tab.restored", { astra_tab_id, url: tab.url });
    return ok(request_id, { astra_tab_id, discarded: false, url: tab.url });
  },

  // Title updates from live progress listeners (Content binding) or the
  // core (session restore) flow through here so `tab.updated` fires.
  async setTitle({ request_id = "", astra_tab_id = "", title = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    if (typeof title !== "string") {
      return err(request_id, "invalid_title", "title must be a string");
    }
    tab.title = title;
    const snap = snapshot(astra_tab_id);
    emit("tab.updated", { ...snap });
    return ok(request_id, { astra_tab_id, title });
  },

  async setMuted({ request_id = "", astra_tab_id = "", muted = false } = {}) {
    const tab = _tabs.get(astra_tab_id);
    if (!tab) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    tab.muted = muted === true;
    const snap = snapshot(astra_tab_id);
    emit("tab.updated", { ...snap });
    return ok(request_id, { astra_tab_id, muted: tab.muted });
  },
};

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetTabsForTests() {
  _tabs.clear();
  _order.length = 0;
  _history.clear();
  _nextId = 1;
  _selectedId = "";
}

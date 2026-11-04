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

// Schemes a tab may carry. The content binding loads under the system
// principal and refuses everything but http(s), so an address the stage can
// never show (data:, file:, javascript:, blob:, chrome:, resource:, and any
// about: page other than blank) becomes a New Tab here rather than travelling
// into the model and the projection.
const TAB_SCHEMES = new Set(["http:", "https:"]);

/** The address a tab stores: a loadable web address, or a New Tab. */
export function safeTabUrl(url) {
  if (typeof url !== "string" || url === "") {
    return "about:blank";
  }
  if (url === "about:blank") {
    return url;
  }
  try {
    return TAB_SCHEMES.has(new URL(url).protocol) ? url : "about:blank";
  } catch {
    return "about:blank";
  }
}

const _tabs = new Map(); // astra_tab_id -> tab record
const _order = []; // astra_tab_id in display order
const _history = new Map(); // astra_tab_id -> { entries: [url], index: n }
let _nextId = 1;
let _selectedId = "";
/** The tab last looked at in each space, so a switch back returns to it. */
const _selectedBySpace = new Map();

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
    // Private windows must never reach the on-disk organisation store; the
    // Content mount marks their tabs as soon as the native tab is bound.
    private: tab.private === true,
    // A mark belongs to the site that produced it: a navigation that lands on
    // another origin (typed address, `Navigation.commit`) must never keep the
    // old site's reference in a projection.
    icon: tab.icon && originOf(tab.url) === tab.icon.origin ? tab.icon : null,
    // P6c: the sign-in card the app renders under the address field.
    page_request: tab.page_request ?? null,
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
  const tab = _tabs.get(id);
  if (tab) {
    _selectedBySpace.set(tab.space_id, id);
  }
  const snap = snapshot(id);
  emit("tab.updated", { ...snap, selected: true });
  return snap;
}

export function __tabsState() {
  return { tabs: _tabs, history: _history, get selectedId() { return _selectedId; } };
}

/**
 * Mark a tab as belonging to a private window (P5b). Content calls this when
 * it binds a native tab, because the model itself never learns about window
 * privacy; the organisation store refuses anything not explicitly public.
 */
export function __markPrivate(astra_tab_id, isPrivate) {
  const tab = _tabs.get(astra_tab_id);
  if (!tab) return false;
  tab.private = isPrivate === true;
  return true;
}

/** The sign-in card for one tab (P6c). `null` closes it. */
export function __setPageRequest(astra_tab_id, request = null) {
  const tab = _tabs.get(astra_tab_id);
  if (!tab) return false;
  tab.page_request = request;
  emit("tab.updated", { astra_tab_id, page_request: request });
  emitItemsChanged();
  return true;
}

/** Spaces and the active space, without building a projection. */
export function __spacesState() {
  return {
    spaces: _spaces.map((space) => ({ ...space })),
    active_space_id: _activeSpaceId,
  };
}

/**
 * Replace the space list from a restored organisation snapshot (P5b). Runs
 * before bootstrap so adopted tabs land in a space that already exists.
 */
export function __applySpaces(spaces, active_space_id = "") {
  if (!Array.isArray(spaces) || spaces.length === 0) return false;
  const seen = new Set();
  const next = [];
  for (const space of spaces) {
    const id = typeof space?.id === "string" ? space.id : "";
    if (!/^space-\d+$/u.test(id) || seen.has(id)) continue;
    seen.add(id);
    next.push({
      id,
      name: typeof space.name === "string" && space.name !== "" ? space.name : id,
      icon: typeof space.icon === "string" ? space.icon : null,
      color: Number.isInteger(space.color) ? space.color : 0,
      theme: typeof space.theme === "string" ? space.theme : null,
    });
  }
  if (next.length === 0) return false;
  _spaces = next;
  _activeSpaceId = seen.has(active_space_id) ? active_space_id : next[0].id;
  const highest = next.reduce((max, space) => {
    const n = Number(/^space-(\d+)$/u.exec(space.id)?.[1] ?? 0);
    return Math.max(max, n);
  }, 1);
  _nextSpaceId = highest + 1;
  return true;
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
    // Never fall back to a tab from another space: the page in front would
    // belong to a space the person is not looking at.
    const first = activeOrder()[0];
    if (first !== undefined) {
      selectInternal(first);
    }
  }
  return ids;
}

/** The origin a tab's icon is keyed under, or "" when the URL has none. */
function originOf(url) {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

/** `IconRef` validation: only `{ origin, revision }` reaches the projection. */
function asIconRef(value) {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { origin, revision } = value;
  if (
    typeof origin !== "string" ||
    origin === "" ||
    typeof revision !== "string" ||
    revision === ""
  ) {
    return undefined;
  }
  return { origin, revision };
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
    // A navigation ends any sign-in prompt from the previous document.
    tab.page_request = null;
    // An icon belongs to the site that produced it. Landing on another origin
    // (typed address, link, redirect) must clear it at once, or the old site's
    // mark stays on the new page until its own icon arrives.
    const origin = originOf(patch.url);
    if (tab.icon && origin && tab.icon.origin !== origin) {
      tab.icon = null;
    }
    tab.url = patch.url;
  }
  if ("icon" in patch) {
    const icon = asIconRef(patch.icon);
    if (icon !== undefined) {
      tab.icon = icon;
    }
  }
  if (typeof patch.loading === "boolean") {
    tab.loading = patch.loading;
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

/** The active space without building a projection (and without bumping its
 *  revision); host modules use this to scope their own stores. */
export function __activeSpaceId() {
  return _activeSpaceId;
}

/** Each space is its own Firefox container: cookies, logins and site storage
 *  are visible only inside it. Space 1 is the default (no container). */
export function __spaceUserContextId(space) {
  const match = /^space-(\d+)$/u.exec(String(space ?? ""));
  if (!match) return 0;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 1 ? n - 1 : 0;
}
let _nextSpaceId = 2;

function spaceOf(space_id) {
  return _spaces.find((space) => space.id === space_id) ?? null;
}

/** The active space's tabs, in display order. */
function activeOrder() {
  return _order.filter((id) => _tabs.get(id)?.space_id === _activeSpaceId);
}

/** The space in front always has somewhere to go: a window whose active space
 *  holds no tab has nothing to put on the stage, and every caller downstream
 *  (address bar, navigation, content) resolves a selected tab first. A space
 *  keeps its own New Tab, created on demand, in its own display order. */
async function ensureTabInActiveSpace(request_id = "") {
  if (activeOrder().length > 0) {
    return false;
  }
  await Tabs.create({ request_id, url: "about:blank" });
  return true;
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
    loading: tab.loading === true,
    can_go_back: h.index > 0,
    can_go_forward: h.index >= 0 && h.index < h.entries.length - 1,
    // The reference, never the pixels: chrome keeps rasters from
    // `favicons-changed` and repaints only when the revision changes. A ref
    // from another origin is a stale mark and is not projected.
    icon:
      tab.icon && originOf(tab.url) === tab.icon.origin ? tab.icon : null,
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
      // The switcher stacks the mark of the space's first tabs beside its
      // name. A tab with no icon yet is null, which the app draws as a globe.
      previews: _order
        .filter((id) => _tabs.get(id)?.space_id === space.id)
        .slice(0, 3)
        .map((id) => _tabs.get(id)?.icon ?? null),
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
    url = safeTabUrl(url);
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
      private: false,
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
    const target = _tabs.get(astra_tab_id);
    if (!target) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    // Selecting a tab from another space brings that space forward: a
    // selection outside the active space would leave the stage, the sidebar
    // and the address bar naming different tabs.
    if (target.space_id !== _activeSpaceId) {
      _activeSpaceId = target.space_id;
    }
    const snap = selectInternal(astra_tab_id);
    emitItemsChanged();
    return ok(request_id, { astra_tab_id, url: snap.url, window_id: snap.window_id });
  },

  async close({ request_id = "", astra_tab_id = "" } = {}) {
    const tab = _tabs.get(astra_tab_id);
    // Where it sat in the space that is on screen, before it leaves the order.
    const closedAt = activeOrder().indexOf(astra_tab_id);
    const existed = _tabs.delete(astra_tab_id);
    _history.delete(astra_tab_id);
    const i = _order.indexOf(astra_tab_id);
    if (i >= 0) {
      _order.splice(i, 1);
    }
    if (existed) {
      emit("tab.closed", { astra_tab_id, window_id: tab.window_id });
      // The closed tab is no longer anyone's remembered selection.
      for (const [space, id] of _selectedBySpace) {
        if (id === astra_tab_id) _selectedBySpace.delete(space);
      }
      if (_selectedId === astra_tab_id) {
        _selectedId = "";
        // The tab that took its place, then the one before it; only inside
        // the space being looked at. A native browser does not jump to the
        // first tab on every close.
        const at = closedAt;
        const after = activeOrder();
        const next =
          after[Math.min(Math.max(at, 0), after.length - 1)] ?? after[after.length - 1];
        if (next !== undefined) {
          selectInternal(next);
        } else {
          await ensureTabInActiveSpace(request_id);
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
    // The new space is in front, so it needs its own New Tab rather than an
    // empty stage. `create` announces it; the snapshot below is the result.
    await ensureTabInActiveSpace(request_id);
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
    emit("space.deleted", { space });
    if (_activeSpaceId === space) {
      _activeSpaceId = _spaces[Math.min(at, _spaces.length - 1)].id;
      _selectedId = "";
      const first = activeOrder()[0];
      if (first !== undefined) {
        selectInternal(first);
      } else {
        // The space that takes over may hold none of the closed space's tabs.
        await ensureTabInActiveSpace(request_id);
      }
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
    const candidates = activeOrder();
    const remembered = _selectedBySpace.get(space);
    const chosen =
      remembered !== undefined && candidates.includes(remembered) ? remembered : candidates[0];
    _selectedId = "";
    if (chosen !== undefined) {
      selectInternal(chosen);
    } else {
      // Coming back to a space that was left without tabs lands on its own
      // New Tab instead of a stage nothing owns.
      await ensureTabInActiveSpace(request_id);
    }
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
    const previousSpace = target.space_id;
    target.space_id = space;
    if (previousSpace !== space) {
      emit("tab.space-changed", {
        astra_tab_id: tab,
        from_space_id: previousSpace,
        space_id: space,
      });
    }
    if (space !== _activeSpaceId) {
      const i = _order.indexOf(tab);
      if (i >= 0) _order.splice(i, 1);
      _order.push(tab);
      if (_selectedId === tab) {
        _selectedId = "";
        const first = activeOrder()[0];
        if (first !== undefined) {
          selectInternal(first);
        } else {
          // The moved tab was the space's last one; the space that stays in
          // front gets its own New Tab rather than an empty stage.
          await ensureTabInActiveSpace(request_id);
        }
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
    if (from >= 0) {
      _order.splice(from, 1);
    }
    const clamped = Math.min(index, _order.length);
    _order.splice(clamped, 0, astra_tab_id);
    emit("tab.moved", { astra_tab_id, from_index: from, to_index: clamped });
    // The projection owns sidebar order, so a moved row has to reach it.
    emitItemsChanged();
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
      // A New Tab has no committed address; its copy is another New Tab, not
      // an `invalid_url` refusal.
      url: src.url || "about:blank",
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
    // A fork of a loaded page usually lands on the same origin while it
    // reloads, so it may keep the source's mark until its own arrives.
    dup.icon = src.icon ?? null;
    if (!background) {
      selectInternal(dupId);
    }
    // `create` announced the fork before the title/history were copied; the
    // sidebar would otherwise show the new row as an untitled blank.
    emitItemsChanged();
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
    // Live progress listeners land here. The sidebar and the window title are
    // painted from the projection, so a title the page reports has to reach
    // it or the row keeps saying "New Tab" for the life of the tab.
    emitItemsChanged();
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
    // `settle()` needs an admission; Content applies the native mute. Keep the
    // standard envelope fields so the Host API v1 contract still holds.
    return {
      request_id,
      host_api_version: HOST_API_VERSION,
      operation_id: null,
      accepted: true,
      astra_tab_id,
      muted: tab.muted,
    };
  },
};

/**
 * Adopt a native tab the engine created (window.open, target=_blank, restore)
 * into the model without announcing it yet. The caller binds its native tab to
 * the returned id, then calls `__announceAdopted` so the projection sees it.
 */
export function __adoptNative({
  url = "about:blank",
  selected = false,
  window_id = DEFAULT_WINDOW_ID,
  space_id = _activeSpaceId,
  private: privateWindow = false,
} = {}) {
  const astra_tab_id = `tab-${_nextId++}`;
  _tabs.set(astra_tab_id, {
    astra_tab_id,
    url: safeTabUrl(url),
    title: "",
    selected: false,
    window_id,
    space_id,
    pinned: false,
    discarded: false,
    muted: false,
    private: privateWindow === true,
  });
  _order.push(astra_tab_id);
  __pushHistory(astra_tab_id, safeTabUrl(url));
  if (selected) {
    _selectedId = astra_tab_id;
  }
  return astra_tab_id;
}

/** Announce an adopted native tab after its native element is bound. */
export function __announceAdopted(astra_tab_id, { selected = false } = {}) {
  const tab = _tabs.get(astra_tab_id);
  if (!tab) return null;
  if (selected) {
    selectInternal(astra_tab_id);
  }
  emit("tab.created", {
    astra_tab_id,
    url: tab.url,
    window_id: tab.window_id,
    native: true,
    selected,
  });
  emitItemsChanged();
  return snapshot(astra_tab_id);
}

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetTabsForTests() {
  _tabs.clear();
  _order.length = 0;
  _history.clear();
  _nextId = 1;
  _selectedId = "";
  _selectedBySpace.clear();
  // Spaces are part of the same model: leaving them behind made a suite's
  // spaces visible to the next one in the same process.
  _spaces = [{ id: DEFAULT_SPACE_ID, name: "Space", icon: null, color: 0, theme: null }];
  _activeSpaceId = DEFAULT_SPACE_ID;
  _nextSpaceId = 2;
  _projection = 0;
}

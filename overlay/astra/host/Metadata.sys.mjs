/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Metadata module (P5b). Firefox `SessionStore` owns the live tab
// set; this module owns Astra *organisation* — spaces, space membership,
// pins and order — in the Rust sidecar's `astra-store` database.
//
// Privacy is the primary constraint, and every rule here fails closed:
// - only tabs explicitly marked public (`private === false`) are captured;
//   Content stamps that from the window when it binds the native tab;
// - a window that is private (or unknown) contributes nothing, and a capture
//   that cannot read the window list persists nothing;
// - only `http:`/`https:` URLs are persisted, so New Tab, `about:` pages and
//   file/blob URLs never reach disk;
// - restore is best-effort by URL: `SessionStore` decides which tabs exist,
//   and this module only re-applies their space and pin.
//
// The pure functions (`buildSnapshot`, `planRestore`) are the contract and are
// tested in Node; `prepare`/`restore`/`save` are the chrome wiring.

import { addEventListener } from "./Events.sys.mjs";
import { Boot } from "./Boot.sys.mjs";
import { Tabs, __applySpaces, __spacesState } from "./Tabs.sys.mjs";
import { Windows } from "./Windows.sys.mjs";

const NAME = "organisation";
const SNAPSHOT_VERSION = 1;
const SAVE_DELAY_MS = 600;

/** Events that change organisation. `items-changed` is the catch-all the
 *  model already emits after a space or pin mutation. */
const SAVE_EVENTS = new Set([
  "items-changed",
  "space.deleted",
  "tab.created",
  "tab.closed",
  "tab.moved",
  "tab.pinned",
  "tab.unpinned",
  "tab.space-changed",
  "tab.updated",
  "nav.committed",
  "window.closed",
]);

const DEFAULT_SPACE = {
  id: "space-1",
  name: "Space",
  icon: null,
  color: 0,
  theme: null,
};

/** What may be written to disk. */
export function isPersistableUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the `SessionSnapshot` for the sidecar. `tabs` are `Tabs.list`
 * snapshots; `windows` are `Windows.list` entries.
 *
 * Pure: no clock beyond `now`, no I/O, so the privacy filter is testable.
 */
export function buildSnapshot({
  spaces = [],
  active_space_id = "",
  tabs = [],
  windows = [],
  selected_tab_id = "",
  now = Date.now(),
} = {}) {
  const privateWindows = new Set(
    windows.filter((win) => win?.private === true).map((win) => win.window_id),
  );
  const kept = tabs.filter(
    (tab) =>
      tab &&
      tab.private === false &&
      !privateWindows.has(tab.window_id) &&
      isPersistableUrl(tab.url),
  );
  const positions = new Map(kept.map((tab, index) => [tab.astra_tab_id, index]));
  const windowIds = new Set(
    windows.filter((win) => win?.private !== true).map((win) => win.window_id),
  );
  for (const tab of kept) {
    if (!windowIds.has(tab.window_id)) windowIds.add(tab.window_id);
  }
  const spaceIds = new Set(spaces.map((space) => space.id));
  const activeKept = kept.some((tab) => tab.astra_tab_id === selected_tab_id);
  return {
    version: SNAPSHOT_VERSION,
    name: NAME,
    created_at: Math.floor(now / 1000),
    spaces: spaces.map((space, index) => ({
      uuid: space.id,
      name: space.name,
      position: index,
      container_ref: null,
    })),
    folders: [],
    windows: [...windowIds].map((window_id) => ({
      window_id,
      focused: windows.find((win) => win.window_id === window_id)?.focused === true,
      title: windows.find((win) => win.window_id === window_id)?.title ?? "",
    })),
    tabs: kept.map((tab) => ({
      astra_tab_id: tab.astra_tab_id,
      space_uuid: spaceIds.has(tab.space_id) ? tab.space_id : null,
      url: tab.url,
      title: typeof tab.title === "string" ? tab.title : "",
      pinned: tab.pinned === true,
      position: positions.get(tab.astra_tab_id) ?? 0,
      window_id: tab.window_id ?? "",
      history: [tab.url],
      history_index: 0,
      muted: tab.muted === true,
      discarded: tab.discarded === true,
    })),
    active_tab_id: activeKept ? selected_tab_id : null,
    layout: null,
  };
}

/**
 * Compute what restore should change, without touching the model.
 *
 * `SessionStore` decides which tabs exist; ids differ after a restart, so
 * snapshot tabs are consumed by URL in position order, one live tab per
 * snapshot tab. Live tabs with no snapshot entry keep their current place.
 */
export function planRestore(snapshot, liveTabs = []) {
  const savedSpaces = Array.isArray(snapshot?.spaces) ? snapshot.spaces : [];
  const spaces = savedSpaces
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .filter((space) => typeof space?.uuid === "string" && space.uuid !== "")
    .map((space) => ({
      id: space.uuid,
      name: typeof space.name === "string" && space.name !== "" ? space.name : space.uuid,
      icon: null,
      color: 0,
      theme: null,
    }));
  if (spaces.length === 0) {
    return { spaces: [{ ...DEFAULT_SPACE }], activeSpaceId: DEFAULT_SPACE.id, assignments: [], active: null };
  }
  const known = new Set(spaces.map((space) => space.id));

  const byUrl = new Map();
  const savedTabs = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const tab of savedTabs) {
    if (typeof tab?.url !== "string" || !isPersistableUrl(tab.url)) continue;
    const queue = byUrl.get(tab.url);
    if (queue) queue.push(tab);
    else byUrl.set(tab.url, [tab]);
  }

  const assignments = [];
  let active = null;
  for (const live of liveTabs) {
    if (!live || live.private !== false) continue;
    const queue = byUrl.get(live.url);
    if (!queue || queue.length === 0) continue;
    const saved = queue.shift();
    if (!known.has(saved.space_uuid)) continue;
    assignments.push({
      astra_tab_id: live.astra_tab_id,
      space_id: saved.space_uuid,
      pinned: saved.pinned === true,
    });
    if (saved.astra_tab_id === snapshot.active_tab_id) active = live.astra_tab_id;
  }

  const activeSpaceId =
    assignments.find((entry) => entry.astra_tab_id === active)?.space_id ?? spaces[0].id;
  return { spaces, activeSpaceId, assignments, active };
}

// --- Chrome wiring -----------------------------------------------------------

let _private = false;
let _available = false;
let _restored = false;
let _snapshot = null;
let _timer = null;
let _off = null;
let _lastSavedAt = null;
let _lastError = null;
// The last snapshot that actually landed. Quit rewrites this instead of
// capturing again: by then the window may already be tearing its tabs down,
// and a fresh capture would replace a good organisation with an empty one.
let _lastSnapshot = null;

function resetTimer() {
  if (_timer !== null) clearTimeout(_timer);
  _timer = null;
}

function scheduleSave() {
  if (!_available) return;
  resetTimer();
  _timer = setTimeout(() => {
    _timer = null;
    void Metadata.save();
  }, SAVE_DELAY_MS);
}

function parseSnapshot(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== SNAPSHOT_VERSION) return null;
    if (!Array.isArray(parsed.spaces) || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function windowState() {
  const listed = await Windows.list({ request_id: "metadata-windows" });
  if (listed?.error || !Array.isArray(listed?.windows)) return null;
  return listed.windows;
}

export const Metadata = {
  /**
   * Load the organisation snapshot and install the spaces before the model
   * bootstraps, so adopted native tabs land in an existing space.
   */
  async prepare({ private: isPrivate = false } = {}) {
    // A private window keeps nothing: no spaces restored, nothing written.
    _private = isPrivate === true;
    if (_private) {
      _available = false;
      return { state: "private" };
    }
    const reply = await Boot.coreCall({
      request_id: "metadata-load",
      name: "session.load",
      payload: { name: NAME },
    });
    if (reply?.error) {
      _available = false;
      _lastError = reply.error.code ?? "core_unavailable";
      return { state: "unavailable", error: reply.error.code ?? "core_unavailable" };
    }
    _available = true;
    _lastError = null;
    _snapshot = parseSnapshot(reply.payload?.snapshot);
    if (_snapshot === null) return { state: "empty" };
    const plan = planRestore(_snapshot, []);
    if (!__applySpaces(plan.spaces, plan.activeSpaceId)) {
      _lastError = "invalid_spaces";
      return { state: "invalid" };
    }
    return { state: "loaded", spaces: plan.spaces.length, tabs: _snapshot.tabs.length };
  },

  /**
   * Re-apply each restored tab's space and pin. Called after the native tab
   * mount adopted the `SessionStore` tabs.
   */
  async restore() {
    if (_private) return { restored: false, reason: "private" };
    if (!_available || _snapshot === null) {
      return { restored: false, reason: _available ? "no_snapshot" : "unavailable" };
    }
    const listed = await Tabs.list({ request_id: "metadata-tabs" });
    const liveTabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
    const plan = planRestore(_snapshot, liveTabs);
    const byId = new Map(liveTabs.map((tab) => [tab.astra_tab_id, tab]));
    let moved = 0;
    let pinned = 0;
    for (const entry of plan.assignments) {
      const tab = byId.get(entry.astra_tab_id);
      if (!tab || tab.space_id !== entry.space_id) {
        await Tabs.moveTabToSpace({
          request_id: "metadata-restore-move",
          tab: entry.astra_tab_id,
          space: entry.space_id,
        });
        moved += 1;
      }
      if (entry.pinned && tab?.pinned !== true) {
        await Tabs.pin({ request_id: "metadata-restore-pin", astra_tab_id: entry.astra_tab_id });
        pinned += 1;
      }
    }
    if (plan.activeSpaceId) {
      await Tabs.switchSpace({ request_id: "metadata-restore-space", space: plan.activeSpaceId });
    }
    _restored = true;
    _snapshot = null;
    return { restored: true, spaces: plan.spaces.length, moved, pinned };
  },

  /** Write the current organisation. Never called before `prepare`. */
  async save() {
    resetTimer();
    if (_private) return { saved: false, reason: "private" };
    if (!_available) {
      return { saved: false, reason: "unavailable" };
    }
    const windows = await windowState();
    if (windows === null) {
      _lastError = "windows_unavailable";
      return { saved: false, reason: "windows_unavailable" };
    }
    const listed = await Tabs.list({ request_id: "metadata-save-tabs" });
    const { spaces, active_space_id } = __spacesState();
    const snapshot = buildSnapshot({
      spaces,
      active_space_id,
      tabs: Array.isArray(listed?.tabs) ? listed.tabs : [],
      windows,
      selected_tab_id: listed?.selected_tab_id ?? "",
    });
    // Nothing persistable yet: SessionStore may not have restored or loaded a
    // real page, and a window of New Tabs carries no organisation. Never
    // replace a saved organisation with an empty capture; the next real
    // navigation or space/pin change writes again.
    if (snapshot.tabs.length === 0) {
      return { saved: false, reason: "empty_capture" };
    }
    const reply = await Boot.coreCall({
      request_id: "metadata-save",
      name: "session.save",
      payload: { name: NAME, snapshot: JSON.stringify(snapshot) },
    });
    if (reply?.error) {
      _lastError = reply.error.code ?? "core_failed";
      return { saved: false, reason: _lastError };
    }
    _lastSnapshot = snapshot;
    _lastSavedAt = Number(reply.payload?.updated_at) || null;
    _lastError = null;
    return { saved: true, tabs: snapshot.tabs.length, spaces: snapshot.spaces.length };
  },

  /**
   * Rewrite the last accepted snapshot on quit. A pending debounce is flushed
   * first; if nothing was ever saved, this is a no-op rather than an empty
   * write that would erase the person's organisation.
   */
  async flush() {
    resetTimer();
    if (_private || !_available) return { saved: false, reason: _private ? "private" : "unavailable" };
    if (_lastSnapshot === null) {
      return this.save();
    }
    const reply = await Boot.coreCall({
      request_id: "metadata-flush",
      name: "session.save",
      payload: { name: NAME, snapshot: JSON.stringify(_lastSnapshot) },
    });
    if (reply?.error) {
      _lastError = reply.error.code ?? "core_failed";
      return { saved: false, reason: _lastError };
    }
    _lastSavedAt = Number(reply.payload?.updated_at) || _lastSavedAt;
    _lastError = null;
    return { saved: true, tabs: _lastSnapshot.tabs.length, spaces: _lastSnapshot.spaces.length };
  },

  /** Subscribe once and keep the store current after every organisation change. */
  init({ private: isPrivate = _private } = {}) {
    _private = isPrivate === true;
    if (_private) return;
    if (_off !== null) return;
    _off = addEventListener((event) => {
      if (typeof event?.type === "string" && SAVE_EVENTS.has(event.type)) {
        scheduleSave();
      }
    });
    scheduleSave();
  },

  dispose() {
    resetTimer();
    _off?.();
    _off = null;
    _private = false;
    _available = false;
    _restored = false;
    _snapshot = null;
    _lastSavedAt = null;
    _lastError = null;
    _lastSnapshot = null;
  },

  status() {
    return {
      private: _private,
      available: _available,
      restored: _restored,
      pending: _timer !== null,
      last_saved_at: _lastSavedAt,
      last_error: _lastError,
    };
  },

  // Test seam: exact-input capture/plan without the chrome stores.
  capture: buildSnapshot,
  plan: planRestore,

  __resetForTests() {
    Metadata.dispose();
  },
};

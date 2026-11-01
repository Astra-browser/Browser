/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Session module (v1). Startup snapshot/restore for the
// core-owned organisation (plan §5.4, P2-T09).
//
// Split of responsibilities:
// - `astra-core` (`crates/astra-core/src/session.rs`) owns the organisation:
//   spaces, folders, pins, order, per-tab scroll/zoom/history. It persists
//   the versioned `SessionSnapshot` JSON in the `astra-store` `sessions`
//   table under the name `"last"`.
// - This module applies a snapshot through the `Tabs`/`Windows` API on
//   startup and captures the live side back via `describe` so the core can
//   merge and persist it. Private windows (and their tabs) are never
//   snapshotted — private browsing keeps nothing.
// - Conflict rule (§5.4): live-existence wins for tabs (never close a live
//   tab; recreate snapshot tabs missing live — after a kill -9 the live set
//   is empty so the whole snapshot is recreated), core wins for organisation
//   (order, pins, titles, selection come from the snapshot; live-only tabs
//   are appended in live order).
//
// Tab identity note: `Tabs.create` mints fresh `astra_tab_id`s, so restored
// tabs get new ids. `restore` returns the `created` mapping
// (`snapshot_tab_id` → live `astra_tab_id`) plus the final `order`; the core
// re-keys its organisation to the live ids. Organisation equality is by
// content + placement (URL, space, folder, pin, scroll, position), not by id.
//
// Scroll: the `Tabs` model carries no scroll state (the live `Content`
// actor owns the viewport). This module keeps a `_scroll` sidecar map
// (`setScroll` ingress from `Content`, `scroll` on each snapshot tab) so
// scroll round-trips through kill -9; `restore` re-populates the map and
// returns `scroll_intents` for the `Content` binding to `scrollTo`.

import { HOST_API_VERSION, Tabs } from "./Tabs.sys.mjs";
import { Windows } from "./Windows.sys.mjs";

export const SESSION_SNAPSHOT_VERSION = 1;
export const SESSION_NAME_LAST = "last";

// Per-tab scroll sidecar: astra_tab_id -> { x, y }. Fed by the Content
// actor (`setScroll`); snapshotted by `describe`; re-applied by `restore`.
const _scroll = new Map();

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validScroll(s) {
  return (
    isRecord(s) &&
    Number.isInteger(s.x) &&
    Number.isInteger(s.y)
  );
}

// Structural validation mirroring `SessionSnapshot::validate` in
// `astra-core` (ids, URLs, referential integrity, history index, zoom range,
// at most one focused window, active tab present). Returns `null` when valid,
// otherwise a human-readable reason.
export function validateSnapshot(snapshot) {
  if (!isRecord(snapshot)) {
    return "snapshot must be an object";
  }
  if (snapshot.version !== SESSION_SNAPSHOT_VERSION) {
    return `unsupported snapshot version ${snapshot.version} (expected ${SESSION_SNAPSHOT_VERSION})`;
  }
  if (typeof snapshot.name !== "string" || snapshot.name === "") {
    return "snapshot name must be a non-empty string";
  }
  const spaces = snapshot.spaces ?? [];
  const folders = snapshot.folders ?? [];
  const windows = snapshot.windows ?? [];
  const tabs = snapshot.tabs ?? [];
  if (!Array.isArray(spaces) || !Array.isArray(folders) || !Array.isArray(windows) || !Array.isArray(tabs)) {
    return "spaces, folders, windows and tabs must be arrays";
  }
  const spaceIds = new Set();
  for (const s of spaces) {
    if (!isRecord(s) || typeof s.uuid !== "string" || s.uuid === "") {
      return "space uuid must be a non-empty string";
    }
    if (spaceIds.has(s.uuid)) {
      return `duplicate space ${s.uuid}`;
    }
    spaceIds.add(s.uuid);
  }
  const folderIds = new Set();
  for (const f of folders) {
    if (!isRecord(f) || typeof f.uuid !== "string" || f.uuid === "") {
      return "folder uuid must be a non-empty string";
    }
    if (folderIds.has(f.uuid)) {
      return `duplicate folder ${f.uuid}`;
    }
    folderIds.add(f.uuid);
    if (typeof f.space_uuid !== "string" || !spaceIds.has(f.space_uuid)) {
      return `folder ${f.uuid} references unknown space ${f.space_uuid}`;
    }
    if (f.parent_uuid !== undefined && f.parent_uuid !== null) {
      if (typeof f.parent_uuid !== "string" || !folderIds.has(f.parent_uuid) && !folders.some((x) => x.uuid === f.parent_uuid)) {
        return `folder ${f.uuid} references unknown parent ${f.parent_uuid}`;
      }
      if (f.parent_uuid === f.uuid) {
        return `folder ${f.uuid} is its own parent`;
      }
    }
  }
  const windowIds = new Set();
  let focused = 0;
  for (const w of windows) {
    if (!isRecord(w) || typeof w.window_id !== "string" || w.window_id === "") {
      return "window_id must be a non-empty string";
    }
    if (windowIds.has(w.window_id)) {
      return `duplicate window ${w.window_id}`;
    }
    windowIds.add(w.window_id);
    if (w.focused === true) {
      focused += 1;
    }
  }
  if (focused > 1) {
    return "at most one window may be focused";
  }
  const tabIds = new Set();
  for (const t of tabs) {
    if (!isRecord(t) || typeof t.astra_tab_id !== "string" || t.astra_tab_id === "") {
      return "astra_tab_id must be a non-empty string";
    }
    if (tabIds.has(t.astra_tab_id)) {
      return `duplicate tab ${t.astra_tab_id}`;
    }
    tabIds.add(t.astra_tab_id);
    if (typeof t.url !== "string" || t.url === "") {
      return `tab ${t.astra_tab_id} url must be a non-empty string`;
    }
    if (t.space_uuid !== undefined && t.space_uuid !== null && !spaceIds.has(t.space_uuid)) {
      return `tab ${t.astra_tab_id} references unknown space ${t.space_uuid}`;
    }
    if (t.folder_uuid !== undefined && t.folder_uuid !== null && !folderIds.has(t.folder_uuid)) {
      return `tab ${t.astra_tab_id} references unknown folder ${t.folder_uuid}`;
    }
    if (typeof t.window_id === "string" && t.window_id !== "" && !windowIds.has(t.window_id)) {
      return `tab ${t.astra_tab_id} references unknown window ${t.window_id}`;
    }
    if (t.scroll !== undefined && t.scroll !== null && !validScroll(t.scroll)) {
      return `tab ${t.astra_tab_id} scroll must be { x, y } integers`;
    }
    if (t.zoom !== undefined && t.zoom !== null) {
      if (typeof t.zoom !== "number" || !Number.isFinite(t.zoom) || t.zoom < 0.3 || t.zoom > 3.0) {
        return `tab ${t.astra_tab_id} zoom out of range`;
      }
    }
    if (t.history !== undefined && !Array.isArray(t.history)) {
      return `tab ${t.astra_tab_id} history must be an array`;
    }
    if (t.history_index !== undefined && t.history_index !== null) {
      const h = t.history ?? [];
      if (!Number.isInteger(t.history_index) || t.history_index < 0 || t.history_index >= h.length) {
        return `tab ${t.astra_tab_id} history_index out of range`;
      }
    }
  }
  if (snapshot.active_tab_id !== undefined && snapshot.active_tab_id !== null) {
    if (!tabIds.has(snapshot.active_tab_id)) {
      return `active tab ${snapshot.active_tab_id} not in snapshot`;
    }
  }
  // Split-view layout (P3-T06): optional; mirrors `SplitLayout::validate`
  // in `astra-core` (version, 1–4 slots, unique ids, ratios in (0,1]
  // summing to 1.0, active slot present). Absent layout stays valid
  // (pre-P3-T06 rows have no key; core uses `#[serde(default)]`).
  if (snapshot.layout !== undefined && snapshot.layout !== null) {
    const reason = validLayout(snapshot.layout);
    if (reason) {
      return reason;
    }
  }
  return null;
}

// Structural validation for the P3-T06 split layout payload.
function validLayout(layout) {
  if (!isRecord(layout)) {
    return "layout must be an object";
  }
  if (layout.version !== 1) {
    return `unsupported layout version ${layout.version} (expected 1)`;
  }
  const slots = layout.slots;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 4) {
    return "layout slots must be an array of 1..=4 entries";
  }
  const seen = new Set();
  let sum = 0;
  for (const s of slots) {
    if (!isRecord(s) || typeof s.slot_id !== "string" || s.slot_id === "") {
      return "layout slot_id must be a non-empty string";
    }
    if (seen.has(s.slot_id)) {
      return `duplicate layout slot ${s.slot_id}`;
    }
    seen.add(s.slot_id);
    if (typeof s.ratio !== "number" || !Number.isFinite(s.ratio) || s.ratio <= 0 || s.ratio > 1) {
      return `layout slot ${s.slot_id} ratio out of range`;
    }
    sum += s.ratio;
  }
  if (Math.abs(sum - 1) > 1e-6) {
    return `layout slot ratios must sum to 1.0 (got ${sum})`;
  }
  if (layout.active_slot_id !== undefined && layout.active_slot_id !== null) {
    if (typeof layout.active_slot_id !== "string" || !seen.has(layout.active_slot_id)) {
      return `layout active slot ${layout.active_slot_id} not in layout`;
    }
  }
  return null;
}

function tabToEntry(tab, position) {
  const scroll = _scroll.get(tab.astra_tab_id) ?? null;
  return {
    astra_tab_id: tab.astra_tab_id,
    space_uuid: tab.space_uuid ?? null,
    folder_uuid: tab.folder_uuid ?? null,
    url: tab.url,
    title: tab.title ?? "",
    pinned: tab.pinned ?? false,
    position,
    scroll,
    zoom: tab.zoom ?? null,
    muted: tab.muted ?? false,
    discarded: tab.discarded ?? false,
    window_id: tab.window_id ?? "win-1",
    history: tab.history ?? [],
    history_index: tab.history_index ?? null,
  };
}

export const Session = {
  // Capture the live side (windows + tabs) into snapshot shape. Spaces and
  // folders live in core, so `spaces`/`folders` are empty here — the core
  // merges its organisation before persisting. Private windows and their
  // tabs are excluded.
  async describe({ request_id = "" } = {}) {
    const { windows } = await Windows.list({ request_id });
    const live = windows.filter((w) => !w.private);
    const liveIds = new Set(live.map((w) => w.window_id));
    const { tabs, selected_tab_id } = await Tabs.list({ request_id });
    const visible = tabs.filter((t) => liveIds.has(t.window_id));
    const ordered = [...visible].sort((a, b) => a.index - b.index);
    return ok(request_id, {
      snapshot: {
        version: SESSION_SNAPSHOT_VERSION,
        name: SESSION_NAME_LAST,
        created_at: Math.floor(Date.now() / 1000),
        spaces: [],
        folders: [],
        windows: live.map((w) => ({
          window_id: w.window_id,
          focused: w.focused,
          title: w.title ?? "",
        })),
        tabs: ordered.map((t, i) => tabToEntry(t, i)),
        active_tab_id: ordered.some((t) => t.astra_tab_id === selected_tab_id)
          ? selected_tab_id
          : null,
        // The host model owns no layout state (P3-T06: core owns the
        // SplitLayout); explicit null so core knows there is no host
        // contribution to merge.
        layout: null,
      },
    });
  },

  // Validate-only entry point (mirrors core `SessionSnapshot::validate`).
  async validate({ request_id = "", snapshot = null } = {}) {
    const reason = validateSnapshot(snapshot);
    if (reason) {
      return err(request_id, "invalid_snapshot", reason);
    }
    return ok(request_id, { valid: true });
  },

  // Scroll ingress from the Content actor (viewport observed live).
  async setScroll({ request_id = "", astra_tab_id = "", x = 0, y = 0 } = {}) {
    const got = await Tabs.get({ request_id, astra_tab_id });
    if (got.error) {
      return err(request_id, "no_such_tab", `unknown tab ${astra_tab_id}`);
    }
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return err(request_id, "invalid_scroll", "x and y must be integers");
    }
    _scroll.set(astra_tab_id, { x, y });
    return ok(request_id, { astra_tab_id, scroll: { x, y } });
  },

  async getScroll({ request_id = "", astra_tab_id = "" } = {}) {
    return ok(request_id, { astra_tab_id, scroll: _scroll.get(astra_tab_id) ?? null });
  },

  // Apply a core-owned snapshot through Tabs/Windows on startup.
  // Live-existence wins for tabs (never close live tabs; recreate snapshot
  // tabs missing live); core wins for organisation (pins, titles, order,
  // selection from the snapshot; live-only tabs appended in live order).
  async restore({ request_id = "", snapshot = null } = {}) {
    const reason = validateSnapshot(snapshot);
    if (reason) {
      return err(request_id, "invalid_snapshot", reason);
    }
    const snapTabs = [...(snapshot.tabs ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    // 1. Windows: reuse live windows with matching ids, create the rest.
    //    Private snapshot windows are skipped (defence in depth; core
    //    already filters them at capture).
    const snapWindows = (snapshot.windows ?? []).filter((w) => w.private !== true);
    const listed = await Windows.list({ request_id });
    const liveWindows = new Map(listed.windows.map((w) => [w.window_id, w]));
    const windowMap = {}; // snapshot window_id -> live window_id
    const windowsCreated = [];
    for (const w of snapWindows) {
      if (liveWindows.has(w.window_id)) {
        windowMap[w.window_id] = w.window_id;
      } else {
        const created = await Windows.create({ request_id });
        if (created.error) {
          return err(request_id, "window_create_failed", `could not create window for ${w.window_id}`);
        }
        windowMap[w.window_id] = created.window_id;
        liveWindows.set(created.window_id, { window_id: created.window_id });
        windowsCreated.push({ snapshot_window_id: w.window_id, window_id: created.window_id });
      }
    }
    const defaultLive = (await Windows.list({ request_id })).focused_window_id ?? "win-1";

    // 2. Tabs: index live tabs, recreate snapshot tabs missing live.
    const liveList = await Tabs.list({ request_id });
    const liveById = new Map(liveList.tabs.map((t) => [t.astra_tab_id, t]));
    const liveOnlyOrder = liveList.tabs.map((t) => t.astra_tab_id);
    const created = []; // [{ snapshot_tab_id, astra_tab_id }]
    const idMap = {}; // snapshot tab id -> live tab id
    for (const t of snapTabs) {
      if (liveById.has(t.astra_tab_id)) {
        idMap[t.astra_tab_id] = t.astra_tab_id;
        continue;
      }
      const targetWindow = (t.window_id && windowMap[t.window_id]) || windowMap[t.window_id] || defaultLive;
      const made = await Tabs.create({
        request_id,
        url: t.url,
        background: true,
        window_id: liveWindows.has(targetWindow) ? targetWindow : defaultLive,
      });
      if (made.error) {
        return err(request_id, "tab_create_failed", `could not recreate tab ${t.astra_tab_id}`);
      }
      idMap[t.astra_tab_id] = made.astra_tab_id;
      created.push({ snapshot_tab_id: t.astra_tab_id, astra_tab_id: made.astra_tab_id });
    }

    // 3. Organisation from core: pins, titles, mute flags, scroll sidecar.
    const scrollIntents = [];
    for (const t of snapTabs) {
      const liveId = idMap[t.astra_tab_id];
      const live = liveById.get(liveId) ?? (await Tabs.get({ request_id, astra_tab_id: liveId })).tab;
      if (!live) {
        continue;
      }
      if ((t.pinned === true) !== (live.pinned === true)) {
        if (t.pinned === true) {
          await Tabs.pin({ request_id, astra_tab_id: liveId });
        } else {
          await Tabs.unpin({ request_id, astra_tab_id: liveId });
        }
      }
      if (typeof t.title === "string" && t.title !== "" && t.title !== live.title) {
        await Tabs.setTitle({ request_id, astra_tab_id: liveId, title: t.title });
      }
      if (typeof t.muted === "boolean" && t.muted !== live.muted) {
        await Tabs.setMuted({ request_id, astra_tab_id: liveId, muted: t.muted });
      }
      if (t.scroll !== undefined && t.scroll !== null) {
        _scroll.set(liveId, { x: t.scroll.x, y: t.scroll.y });
        scrollIntents.push({ astra_tab_id: liveId, scroll: { x: t.scroll.x, y: t.scroll.y } });
      }
    }

    // 4. Order: snapshot order (mapped to live ids) then live-only tabs in
    //    live order. Applied sequentially so each `move` lands exactly.
    const snapshotIds = new Set(snapTabs.map((t) => t.astra_tab_id));
    const finalOrder = [
      ...snapTabs.map((t) => idMap[t.astra_tab_id]),
      ...liveOnlyOrder.filter((id) => ![...Object.values(idMap)].includes(id) && !snapshotIds.has(id)),
    ];
    // Live tabs unknown to the snapshot keep their relative order at the end
    // (live-existence wins); refresh the live-only tail from current state in
    // case step 2 changed indices.
    for (let i = 0; i < finalOrder.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Tabs.move({ request_id, astra_tab_id: finalOrder[i], index: i });
    }

    // 5. Selection: snapshot active tab (mapped) when still present.
    let activeTabId = null;
    if (snapshot.active_tab_id && idMap[snapshot.active_tab_id]) {
      activeTabId = idMap[snapshot.active_tab_id];
      await Tabs.select({ request_id, astra_tab_id: activeTabId });
    }

    return ok(request_id, {
      restored: true,
      created,
      window_map: windowMap,
      windows_created: windowsCreated,
      order: finalOrder,
      active_tab_id: activeTabId,
      scroll_intents: scrollIntents,
      // Split layout rides through untouched (P3-T06): the host applies
      // tabs/windows; the shell applies the layout from this echo.
      layout: snapshot.layout ?? null,
    });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetSessionForTests() {
  _scroll.clear();
}

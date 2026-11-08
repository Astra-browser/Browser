/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API SplitView module (native engine split views).
//
// The engine is the source of truth. This module never paints panes and never
// keeps its own tab list: it calls `gBrowser.addTabSplitView` (and the
// `TabSplitView` methods) on the real tabs the content stage already owns, and
// projects the resulting membership as `ItemsState.split_group`. Geometry and
// divider ratios remain native; only a named arrangement is persisted so it
// can be re-applied after a restart.
//
// Window binding: `Content.mountNative` owns the Astra-tab-id <-> native-tab
// map and calls `__bindSplitWindow` once per window. Unbinding removes every
// listener, so a closed window keeps nothing alive.
//
// Private windows may split, but they never write an arrangement or a ratio:
// `arrangements` and `recall` refuse with `private_context`.

import { emit } from "./Events.sys.mjs";
import {
  HOST_API_VERSION,
  __activeSpaceId,
  __setSplitGroup,
  __tabsState,
  emitItemsChanged,
} from "./Tabs.sys.mjs";

export const MAX_PANES = 3;
export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;
export const ARRANGEMENTS_PREF = "astra.split.arrangements.v1";
export const MAX_ARRANGEMENTS = 200;
const STORE_VERSION = 1;
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const _bindings = new Map(); // window_id -> binding

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function services() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

function settingBool(name, fallback) {
  try {
    const prefs = services()?.prefs;
    if (!prefs) return fallback;
    // Astra-owned settings are stored as strings by Settings.sys.mjs.
    const raw = prefs.getStringPref(name, "");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

function settingString(name, fallback) {
  try {
    return services()?.prefs?.getStringPref(name, fallback) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The product's pane cap, clamped by the engine's own maximum. */
function configuredPanes() {
  return paneCount(Number(settingString("astra.settings.split.max-panes", String(MAX_PANES))), 2);
}

function splitEnabled() {
  return settingBool("astra.settings.split.enabled", true);
}

function isPrivateWindow(win) {
  try {
    if (win?.PrivateBrowsingUtils?.isWindowPrivate?.(win) === true) return true;
  } catch {
    // Fall through.
  }
  try {
    const CU = globalThis.ChromeUtils;
    if (CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      if (PrivateBrowsingUtils.isWindowPrivate(win) === true) return true;
    }
  } catch {
    // Fall through to the document marker.
  }
  try {
    return win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary";
  } catch {
    return false;
  }
}

/** Clamp a divider share into the usable band. Pure, exported for tests. */
export function clampRatio(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

/** Normalise a requested pane count. Pure, exported for tests. */
export function paneCount(value, fallback = 2) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 2) return fallback;
  return Math.min(MAX_PANES, n);
}

/**
 * Build the pane order for an "open as pane" request. `source` is the pane
 * already in front; `target` is the tab being added. Pure, exported for tests.
 */
export function paneOrder({ source, target, placement = "right" }) {
  if (!source || !target || source === target) return [];
  return placement === "left" ? [target, source] : [source, target];
}

/** Members that remain after one tab leaves a split. Pure, exported for tests. */
export function membersAfterLeave(members, leaving) {
  return (Array.isArray(members) ? members : []).filter((id) => id !== leaving);
}

/** Validate one saved arrangement. Pure, exported for tests. */
export function validArrangement(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.id !== "string" || value.id === "") return null;
  if (typeof value.name !== "string" || value.name.trim() === "") return null;
  if (!Array.isArray(value.panes) || value.panes.length < 2 || value.panes.length > MAX_PANES) {
    return null;
  }
  const panes = [];
  for (const pane of value.panes) {
    if (!pane || typeof pane.url !== "string" || pane.url === "") return null;
    try {
      const parsed = new URL(pane.url);
      if (!["http:", "https:"].includes(parsed.protocol)) return null;
    } catch {
      return null;
    }
    panes.push({
      url: pane.url,
      title: typeof pane.title === "string" ? pane.title : "",
    });
  }
  const ratio = clampRatio(Number(value.ratio)) ?? 0.5;
  return {
    id: value.id,
    name: value.name.trim().slice(0, 80),
    space_id: typeof value.space_id === "string" ? value.space_id : "",
    ratio,
    panes,
    created_at: Number.isFinite(value.created_at) ? value.created_at : 0,
  };
}

// --- native window registry ------------------------------------------------

function bindingFor(window_id) {
  if (window_id) {
    const binding = _bindings.get(window_id) ?? null;
    return binding && binding.win?.closed !== true ? binding : null;
  }
  // A direct (non-relayed) caller has no window id. Resolve the focused
  // window, never "the first window that happens to be bound".
  try {
    const focused = services()?.wm?.getMostRecentWindow("navigator:browser") ?? null;
    for (const binding of _bindings.values()) {
      if (binding.win === focused && focused.closed !== true) return binding;
    }
  } catch {
    // Fall through to no window.
  }
  return null;
}

function nativeTab(binding, astraTabId) {
  if (!binding || typeof astraTabId !== "string" || astraTabId === "") return null;
  return binding.tabOf.get(astraTabId) ?? null;
}

function idOf(binding, tab) {
  if (!binding || !tab) return "";
  return binding.idOf.get(tab) ?? tab.getAttribute?.("astra-tab-id") ?? "";
}

function selectedTab(binding) {
  return binding?.gb?.selectedTab ?? null;
}

/** Give every pane boundary its own draggable divider. */
function syncResizers(binding, splitview) {
  const container = binding?.gb?.tabpanels;
  const doc = binding?.win?.document;
  if (!container || !doc) return;
  for (const old of binding.resizers ?? []) {
    try {
      old.remove();
    } catch {
      // Already removed with the split.
    }
  }
  binding.resizers = [];
  const panels = splitview?.panels ?? [];
  if (panels.length < 2) return;
  for (const [index, panel] of panels.entries()) {
    try {
      panel.style.order = String(index * 2);
    } catch {
      // A detached panel.
    }
  }
  for (let index = 0; index < panels.length - 1; index += 1) {
    const resizer = doc.createElementNS(XHTML_NS, "div");
    resizer.className = "astra-pane-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("tabindex", "0");
    resizer.style.order = String(index * 2 + 1);
    panels[index].after(resizer);
    binding.resizers.push(resizer);
    bindResizer(binding, resizer, index);
  }
}

function bindResizer(binding, resizer, index) {
  const panels = () => selectedTab(binding)?.splitview?.panels ?? [];
  const nudge = (event) => {
    const all = panels();
    const left = all[index];
    const right = all[index + 1];
    if (!left || !right) return;
    const step = event.shiftKey ? 36 : 12;
    let direction = 0;
    if (event.key === "ArrowLeft") direction = -1;
    if (event.key === "ArrowRight") direction = 1;
    if (direction === 0) return;
    event.preventDefault();
    const leftWidth = left.getBoundingClientRect().width + direction * step;
    resizePair(left, right, leftWidth);
  };
  const down = (event) => {
    if (event.button !== 0) return;
    const all = panels();
    const left = all[index];
    const right = all[index + 1];
    if (!left || !right) return;
    event.preventDefault();
    const startX = event.clientX;
    const startLeft = left.getBoundingClientRect().width;
    const startRight = right.getBoundingClientRect().width;
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // Capture is optional; the window listeners still finish the drag.
    }
    const move = (moveEvent) => {
      resizePair(left, right, startLeft + (moveEvent.clientX - startX), startLeft, startRight);
    };
    const stop = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", stop);
      resizer.removeEventListener("pointercancel", stop);
      resizer.removeEventListener("lostpointercapture", stop);
      try {
        if (resizer.hasPointerCapture?.(event.pointerId)) {
          resizer.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Capture was never taken or is already gone.
      }
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", stop);
    resizer.addEventListener("pointercancel", stop);
    resizer.addEventListener("lostpointercapture", stop);
  };
  resizer.addEventListener("pointerdown", down);
  resizer.addEventListener("keydown", nudge);
  resizer.addEventListener("dblclick", () => {
    if (!settingBool("astra.settings.split.double-click-reset", true)) return;
    for (const panel of panels()) {
      try {
        panel.style.removeProperty("width");
        panel.style.removeProperty("flex");
        panel.removeAttribute("width");
      } catch {
        // Detached.
      }
    }
  });
}

/** Resize one adjacent pair, keeping the rest of the split untouched. */
function resizePair(left, right, nextLeft, startLeft = 0, startRight = 0) {
  if (!left || !right) return;
  const leftWidth = startLeft || left.getBoundingClientRect().width;
  const rightWidth = startRight || right.getBoundingClientRect().width;
  const total = leftWidth + rightWidth;
  const min = 140;
  const clamped = Math.min(total - min, Math.max(min, nextLeft));
  for (const panel of [left, right]) {
    try {
      panel.style.flex = "0 0 auto";
    } catch {
      // Detached.
    }
  }
  try {
    left.style.width = `${Math.round(clamped)}px`;
    left.setAttribute("width", String(Math.round(clamped)));
    right.style.width = `${Math.round(total - clamped)}px`;
    right.setAttribute("width", String(Math.round(total - clamped)));
  } catch {
    // Detached.
  }
}

function refresh(binding) {
  try {
    const tab = selectedTab(binding);
    const splitview = tab?.splitview ?? null;
    syncResizers(binding, splitview);
    const members = splitview ? splitview.tabs.map((t) => idOf(binding, t)).filter(Boolean) : [];
    const changed = __setSplitGroup(members);
    if (changed) {
      emitItemsChanged();
      emit("split.changed", { members });
    }
  } catch {
    // A window torn down mid-event.
  }
}

function scheduleRefresh(binding) {
  if (binding.scheduled) return;
  binding.scheduled = true;
  const run = () => {
    binding.scheduled = false;
    if (!binding.disposed) refresh(binding);
  };
  try {
    binding.win.queueMicrotask(run);
  } catch {
    run();
  }
}

/**
 * Bind a chrome window. `tabOf`/`idOf` are the maps Content.mountNative owns;
 * they are passed in, never re-derived, so there is exactly one mapping.
 */
export function __bindSplitWindow({ window_id, win, tabOf, idOf: idMap }) {
  if (!window_id || !win) return null;
  __unbindSplitWindow(window_id);
  const binding = {
    window_id,
    win,
    gb: win.gBrowser,
    tabOf,
    idOf: idMap,
    ratio: 0.5,
    scheduled: false,
    disposed: false,
    listeners: [],
    resizers: [],
  };
  const container = binding.gb?.tabContainer;
  const onChange = () => scheduleRefresh(binding);
  const events = [
    "TabSplitViewActivate",
    "TabSplitViewDeactivate",
    "SplitViewCreated",
    "SplitViewRemoved",
    "SplitViewTabChange",
    "TabSelect",
    "TabOpen",
    "TabClose",
    "TabMove",
  ];
  if (container) {
    for (const type of events) {
      container.addEventListener(type, onChange);
      binding.listeners.push([container, type, onChange]);
    }
  }
  try {
    const splitter = binding.gb?.tabpanels?.splitViewSplitter;
    if (splitter) {
      const onDouble = () => {
        if (settingBool("astra.settings.split.double-click-reset", true)) {
          resetRatio(binding);
          scheduleRefresh(binding);
        }
      };
      splitter.addEventListener("dblclick", onDouble);
      binding.listeners.push([splitter, "dblclick", onDouble]);
    }
  } catch {
    // A tabpanels implementation without a splitter keeps native resize only.
  }
  _bindings.set(window_id, binding);
  scheduleRefresh(binding);
  return binding;
}

export function __unbindSplitWindow(window_id) {
  const binding = _bindings.get(window_id);
  if (!binding) return false;
  binding.disposed = true;
  for (const [target, type, fn] of binding.listeners) {
    try {
      target.removeEventListener(type, fn);
    } catch {
      // Already gone with the window.
    }
  }
  binding.listeners.length = 0;
  for (const resizer of binding.resizers ?? []) {
    try {
      resizer.remove();
    } catch {
      // Already gone with the tabpanels.
    }
  }
  binding.resizers = [];
  _bindings.delete(window_id);
  return true;
}

/** The native maps and window for another surface (clone, peek, split). */
export function __nativeBinding(window_id = "") {
  return bindingFor(window_id);
}

export function __resetSplitForTests() {
  for (const id of [..._bindings.keys()]) __unbindSplitWindow(id);
  _store = null;
}

// --- test seam -------------------------------------------------------------

let _store = null;

/** Test-only store override: `{get, set}` over the arrangements JSON. */
export function __setSplitStoreForTests(store) {
  _store = store;
}

function readStore(binding) {
  if (_store) {
    try {
      return JSON.parse(_store.get() || "[]");
    } catch {
      return [];
    }
  }
  try {
    const raw = services()?.prefs?.getStringPref(ARRANGEMENTS_PREF, "[]");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(value) {
  const rows = Array.isArray(value) ? value.slice(0, MAX_ARRANGEMENTS) : [];
  if (_store) {
    _store.set(JSON.stringify(rows));
    return true;
  }
  try {
    services()?.prefs?.setStringPref(ARRANGEMENTS_PREF, JSON.stringify(rows));
    return true;
  } catch {
    return false;
  }
}

function newId() {
  try {
    return `split-${crypto.randomUUID()}`;
  } catch {
    return `split-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// --- native helpers --------------------------------------------------------

function systemPrincipal() {
  try {
    return services()?.scriptSecurityManager?.getSystemPrincipal?.() ?? null;
  } catch {
    return null;
  }
}

function containerFor(binding) {
  const selected = selectedTab(binding);
  return {
    userContextId: Number.isSafeInteger(selected?.userContextId) ? selected.userContextId : 0,
    principal: systemPrincipal() ?? selected?.linkedBrowser?.contentPrincipal ?? null,
  };
}

/** A pinned tab cannot live in a split; show its page in an unpinned pane. */
function materialisePinned(binding, tab) {
  if (!tab?.pinned) return tab;
  let url = "about:blank";
  try {
    url = tab.linkedBrowser?.currentURI?.spec || url;
  } catch {
    // A pinned tab still restoring.
  }
  if (!/^https?:/u.test(url)) return null;
  const made = addNativeTab(binding, url, { userContextId: tab.userContextId ?? 0, background: true });
  return made ?? null;
}

function addNativeTab(binding, url, { userContextId = 0, background = true } = {}) {
  const { gb } = binding;
  if (!gb || typeof gb.addTab !== "function") return null;
  const principal = systemPrincipal();
  const options = {
    inBackground: background === true,
    triggeringPrincipal: principal,
    userContextId: Number.isSafeInteger(userContextId) ? userContextId : 0,
  };
  let tab = null;
  try {
    tab = gb.addTab(url, options);
  } catch {
    try {
      tab = gb.addTab(url, { inBackground: background === true, triggeringPrincipal: principal });
    } catch {
      return null;
    }
  }
  // TabOpen is dispatched synchronously by addTab; Content adopts it and
  // stamps the Astra id before addTab returns. Fall back to the last tab for a
  // native tab that was created outside that listener.
  if (!tab) tab = gb.tabs[gb.tabs.length - 1] ?? null;
  return tab;
}

function splitViewsIn(binding) {
  const out = [];
  for (const tab of binding.gb?.tabs ?? []) {
    if (tab.splitview && !out.includes(tab.splitview)) out.push(tab.splitview);
  }
  return out;
}

/** A background tab can still be about:blank; a split must show its page. */
function ensurePaneLoaded(binding, tab) {
  const id = idOf(binding, tab);
  const url = id ? __tabsState()?.tabs?.get(id)?.url : "";
  if (!tab || !/^https?:/u.test(url ?? "")) return;
  try {
    const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
    if (spec && spec !== "about:blank" && !spec.startsWith("chrome://browser/content/blanktab")) {
      return;
    }
    tab.linkedBrowser?.fixupAndLoadURIString(url, {
      triggeringPrincipal: systemPrincipal(),
    });
  } catch {
    // A tab that is still being created loads on its own activation.
  }
}

function addToSplit(binding, tabs) {
  const gb = binding.gb;
  if (!gb || tabs.length < 2) return null;
  const container = tabs[0]?.userContextId ?? 0;
  if (tabs.some((tab) => (tab.userContextId ?? 0) !== container)) return null;
  for (const tab of tabs) ensurePaneLoaded(binding, tab);
  const existing = tabs[0]?.splitview ?? null;
  if (existing) {
    const current = existing.tabs;
    if (current.length + tabs.slice(1).length > configuredPanes()) return null;
    existing.addTabs(tabs.slice(1));
    return existing;
  }
  try {
    return gb.addTabSplitView(tabs, { trigger: null });
  } catch {
    return null;
  }
}

function sameSpace(binding, a, b) {
  if (!a || !b) return false;
  // Native userContextId is the authoritative container. Model ids can be
  // stale across a move; the containers cannot be.
  return (a.userContextId ?? 0) === (b.userContextId ?? 0);
}

/** Visit each pane once so a background tab's pending URL is committed. */
async function warmPanes(binding, splitview, sourceId) {
  if (!splitview) return;
  for (const paneTab of splitview.tabs) {
    const id = idOf(binding, paneTab);
    if (!id || id === sourceId) continue;
    try {
      await Tabs.select({ request_id: `split-warm-${id}`, astra_tab_id: id });
    } catch {
      // A pane that cannot be selected still loads on its own first commit.
    }
  }
  if (sourceId) {
    try {
      await Tabs.select({ request_id: `split-source-${sourceId}`, astra_tab_id: sourceId });
    } catch {
      // Keep the native selection.
    }
  }
}

function focusTab(binding, tab) {
  if (!binding.gb || !tab) return;
  if (binding.gb.selectedTab !== tab) binding.gb.selectedTab = tab;
}

function applyRatio(binding, value) {
  const ratio = clampRatio(value);
  if (ratio === null) return null;
  if (!settingBool("astra.settings.split.remember-width", true)) return ratio;
  binding.ratio = ratio;
  const splitview = selectedTab(binding)?.splitview ?? null;
  if (!splitview || splitview.tabs.length < 2) return ratio;
  const panels = splitview.panels;
  const first = panels[0];
  if (!first) return ratio;
  const width = Math.max(1, Math.round((binding.gb.tabpanels.clientWidth || 0) * ratio));
  try {
    first.setAttribute("width", String(width));
    first.style.width = `${width}px`;
  } catch {
    // A panel that has not been laid out yet keeps equal shares.
  }
  return ratio;
}

function resetRatio(binding) {
  binding.ratio = 0.5;
  for (const splitview of splitViewsIn(binding)) {
    for (const panel of splitview.panels ?? []) {
      try {
        panel.removeAttribute("width");
        panel.style.removeProperty("width");
      } catch {
        // A panel that has already left the deck.
      }
    }
  }
}

function paneSnapshot(binding, tabs) {
  return tabs.map((tab) => {
    let url = "";
    let title = "";
    try {
      url = tab.linkedBrowser?.currentURI?.spec ?? "";
      title = tab.label || tab.linkedBrowser?.contentTitle || url;
    } catch {
      // A pane that has not committed.
    }
    return { url, title };
  });
}

// --- test-facing pure matcher ---------------------------------------------

/**
 * Decide which open tab (if any) can satisfy a saved pane. A URL match in the
 * same space is reused, so restoring never duplicates a page that is already
 * open. Pure, exported for tests.
 */
export function matchPane(panes, openTabs) {
  const used = new Set();
  const matched = [];
  for (const pane of panes) {
    let found = null;
    for (const tab of openTabs) {
      if (used.has(tab.astra_tab_id)) continue;
      if (tab.url === pane.url) {
        found = tab;
        break;
      }
    }
    if (found) used.add(found.astra_tab_id);
    matched.push(found ? { ...found, reuse: true } : { ...pane, reuse: false });
  }
  return matched;
}

// --- public surface --------------------------------------------------------

export const SplitView = {
  /** Split the focused pane with another live tab (the tab menu's action). */
  async open({ request_id = "", other = "", source = "", window_id = "", placement = "right" } = {}) {
    if (!splitEnabled()) return err(request_id, "disabled", "split view is turned off");
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    let sourceTab = nativeTab(binding, source) ?? selectedTab(binding);
    sourceTab = materialisePinned(binding, sourceTab);
    const otherTab = materialisePinned(binding, nativeTab(binding, other));
    if (!sourceTab || !otherTab) return err(request_id, "no_such_tab", "both panes need a live tab");
    if (sourceTab === otherTab) return err(request_id, "same_tab", "a tab cannot split with itself");
    if (!sameSpace(binding, sourceTab, otherTab)) {
      return err(request_id, "space_mismatch", "a split view never spans spaces");
    }
    const ordered =
      placement === "left" ? [otherTab, sourceTab] : [sourceTab, otherTab];
    const splitview = addToSplit(binding, ordered);
    if (!splitview) return err(request_id, "split_refused", "the engine refused this split view");
    await warmPanes(binding, splitview, idOf(binding, sourceTab));
    focusTab(binding, sourceTab);
    applyRatio(binding, binding.ratio);
    scheduleRefresh(binding);
    return ok(request_id, {
      split: true,
      members: splitview.tabs.map((tab) => idOf(binding, tab)).filter(Boolean),
      panes: splitview.tabs.length,
    });
  },

  /** Open a URL as a new tab or as a pane beside the front tab. */
  async openUrl({ request_id = "", url = "", mode = "split", placement = "right", pane = "", window_id = "" } = {}) {
    if (mode !== "tab" && !splitEnabled()) {
      return err(request_id, "disabled", "split view is turned off");
    }
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    if (typeof url !== "string" || url === "") return err(request_id, "invalid_url", "url is required");
    let targetUrl = url;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return err(request_id, "invalid_url", "only http(s) URLs can open in a tab or pane");
      }
      targetUrl = parsed.href;
    } catch {
      return err(request_id, "invalid_url", "url is required");
    }
    if (mode === "tab") {
      const { userContextId } = containerFor(binding);
      const tab = addNativeTab(binding, targetUrl, { userContextId, background: false });
      if (!tab) return err(request_id, "tab_refused", "the engine refused the tab");
      focusTab(binding, tab);
      scheduleRefresh(binding);
      return ok(request_id, { opened: true, astra_tab_id: idOf(binding, tab) });
    }
    // Refuse before creating a tab: a rejected fourth pane must not steal the
    // front tab or add an orphan tab to the strip.
    const prospectiveSource = nativeTab(binding, pane) ?? selectedTab(binding);
    if (prospectiveSource?.splitview && prospectiveSource.splitview.tabs.length >= configuredPanes()) {
      return err(request_id, "pane_limit", `at most ${configuredPanes()} panes`);
    }
    // A split pane keeps the front tab's container, so a link from a private
    // or space tab cannot land in a different partition.
    const { userContextId } = containerFor(binding);
    const made = addNativeTab(binding, targetUrl, { userContextId, background: true });
    if (!made) return err(request_id, "tab_refused", "the engine refused the pane tab");
    const source = nativeTab(binding, pane) ?? selectedTab(binding);
    if (!source || source === made) {
      focusTab(binding, made);
      scheduleRefresh(binding);
      return ok(request_id, { opened: true, astra_tab_id: idOf(binding, made) });
    }
    const ordered = placement === "left" ? [made, source] : [source, made];
    const splitview = addToSplit(binding, ordered);
    if (!splitview) {
      // The tab still opened; report that honestly rather than pretending a
      // pane exists.
      focusTab(binding, made);
      scheduleRefresh(binding);
      return ok(request_id, { opened: true, split: false, astra_tab_id: idOf(binding, made) });
    }
    focusTab(binding, source);
    applyRatio(binding, binding.ratio);
    scheduleRefresh(binding);
    return ok(request_id, {
      opened: true,
      split: true,
      astra_tab_id: idOf(binding, made),
      members: splitview.tabs.map((tab) => idOf(binding, tab)).filter(Boolean),
    });
  },

  /** Replace one pane's tab without closing the tab that was there. */
  async replace({ request_id = "", pane = "", other = "", url = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const paneTab = nativeTab(binding, pane) ?? selectedTab(binding);
    if (!paneTab) return err(request_id, "no_such_tab", "the pane is gone");
    const splitview = paneTab.splitview ?? null;
    if (!splitview || splitview.tabs.length < 2) {
      return err(request_id, "not_split", "the pane is not in a split view");
    }
    let replacement = nativeTab(binding, other);
    if (!replacement && typeof url === "string" && url !== "") {
      const { userContextId } = containerFor(binding);
      replacement = addNativeTab(binding, url, { userContextId, background: true });
    }
    if (!replacement) return err(request_id, "no_such_tab", "no replacement tab");
    if (replacement === paneTab) return err(request_id, "same_tab", "the replacement is the pane");
    if (!sameSpace(binding, paneTab, replacement)) {
      return err(request_id, "space_mismatch", "a split view never spans spaces");
    }
    const members = splitview.tabs.filter((tab) => tab !== paneTab);
    if (members.includes(replacement)) {
      return err(request_id, "already_member", "that tab is already a pane");
    }
    members.push(replacement);
    try {
      splitview.unsplitTabs("astra_replace");
    } catch {
      // The wrapper may already be gone.
    }
    const rebuilt = addToSplit(binding, members);
    if (!rebuilt) return err(request_id, "split_refused", "the engine refused the replacement");
    if (paneTab.selected) focusTab(binding, replacement);
    applyRatio(binding, binding.ratio);
    scheduleRefresh(binding);
    return ok(request_id, { replaced: true, members: members.map((tab) => idOf(binding, tab)) });
  },

  /** Remove one tab from its split, leaving the tab open in the strip. */
  async leave({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const tab = nativeTab(binding, id);
    const splitview = tab?.splitview ?? null;
    if (!tab || !splitview) return err(request_id, "not_split", "that tab is not in a split view");
    const remaining = splitview.tabs.filter((member) => member !== tab);
    try {
      splitview.unsplitTabs("astra_leave");
    } catch {
      return err(request_id, "split_refused", "the engine refused to unsplit");
    }
    if (remaining.length >= 2 && !addToSplit(binding, remaining)) {
      return err(request_id, "split_refused", "the remaining panes could not stay split");
    }
    if (tab.selected) focusTab(binding, remaining[0] ?? tab);
    scheduleRefresh(binding);
    return ok(request_id, { left: true, members: remaining.map((member) => idOf(binding, member)) });
  },

  /** End the split above the front tab; every tab stays open. */
  async unsplit({ request_id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const splitview = selectedTab(binding)?.splitview ?? null;
    if (!splitview) return ok(request_id, { unsplit: false, members: [] });
    const members = splitview.tabs.map((tab) => idOf(binding, tab));
    splitview.unsplitTabs("astra_unsplit");
    resetRatio(binding);
    scheduleRefresh(binding);
    return ok(request_id, { unsplit: true, members });
  },

  /** Make one pane the focused tab (the page that owns the address bar). */
  async focus({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const tab = nativeTab(binding, id);
    if (!tab) return err(request_id, "no_such_tab", "that pane has no live tab");
    focusTab(binding, tab);
    scheduleRefresh(binding);
    return ok(request_id, { focused: id });
  },

  /** Set the first divider share (0.05..0.95). */
  async ratio({ request_id = "", ratio = null, window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const applied = applyRatio(binding, ratio);
    if (applied === null) return err(request_id, "bad_ratio", "ratio must be finite");
    return ok(request_id, { ratio: applied });
  },

  /**
   * Drag feedback for the page edge. The app sends every pointer move; this
   * answers whether the current point is a split edge without mutating state.
   */
  async dragOver({ request_id = "", x = null, window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return ok(request_id, { edge: null, accepted: false });
    const width = Number(binding.win?.innerWidth) || 0;
    const point = Number(x);
    if (width <= 0 || !Number.isFinite(point)) return ok(request_id, { edge: null, accepted: false });
    let left = 0;
    let right = width;
    try {
      const rect = binding.win.document.querySelector("[data-astra-content]")?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        left = rect.left;
        right = rect.right;
      }
    } catch {
      // Window bounds.
    }
    const edgeWidth = Math.min(120, Math.round((right - left) * 0.12));
    const edge = point <= left + edgeWidth ? "left" : point >= right - edgeWidth ? "right" : null;
    return ok(request_id, { edge, accepted: edge !== null });
  },

  /**
   * Tab dragged onto the page's left/right edge becomes a pane. The app sends
   * frame coordinates; a drop in the middle is not a split.
   */
  async drop({ request_id = "", id = "", x = null, y = null, window_id = "" } = {}) {
    if (!splitEnabled() || !settingBool("astra.settings.split.drag-edge", true)) {
      return ok(request_id, { accepted: false, reason: "disabled" });
    }
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const tab = nativeTab(binding, id);
    if (!tab) return err(request_id, "no_such_tab", "the dragged tab is gone");
    const width = Number(binding.win?.innerWidth) || 0;
    const point = Number(x);
    if (width <= 0 || !Number.isFinite(point)) {
      return ok(request_id, { accepted: false, reason: "no_point" });
    }
    // The page stage is inset beside the sidebar and below the top chrome.
    // Measure it, rather than treating the whole window edge as the page edge.
    let left = 0;
    let right = width;
    try {
      const slot = binding.win.document.querySelector("[data-astra-content]");
      const rect = slot?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        left = rect.left;
        right = rect.right;
      }
    } catch {
      // Keep the window bounds.
    }
    const edge = Math.min(120, Math.round((right - left) * 0.12));
    const placement =
      point <= left + edge ? "left" : point >= right - edge ? "right" : null;
    if (placement === null) return ok(request_id, { accepted: false, reason: "not_edge" });
    const source = selectedTab(binding);
    if (!source || source === tab) return ok(request_id, { accepted: false, reason: "same_tab" });
    // If the front tab is already in a split, the dragged tab joins that
    // split instead of pulling the front tab into a new two-pane one.
    const existing = source.splitview ?? tab.splitview ?? null;
    let splitview = null;
    if (existing) {
      const already = existing.tabs;
      const adding = already.includes(source) ? tab : source;
      if (already.includes(adding)) {
        return ok(request_id, { accepted: false, reason: "already_member" });
      }
      if (already.length >= configuredPanes()) {
        return ok(request_id, { accepted: false, reason: "pane_limit" });
      }
      existing.addTabs([adding]);
      splitview = existing;
    } else {
      const ordered = placement === "left" ? [tab, source] : [source, tab];
      splitview = addToSplit(binding, ordered);
    }
    if (!splitview) return ok(request_id, { accepted: false, reason: "split_refused" });
    await warmPanes(binding, splitview, idOf(binding, source));
    focusTab(binding, source);
    scheduleRefresh(binding);
    return ok(request_id, {
      accepted: true,
      placement,
      members: splitview.tabs.map((member) => idOf(binding, member)),
    });
  },

  /** Save the front split as a named arrangement (never in a private window). */
  async bookmarkSave({ request_id = "", name = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(request_id, "private_context", "a private window keeps no arrangement");
    }
    const splitview = selectedTab(binding)?.splitview ?? null;
    if (!splitview || splitview.tabs.length < 2) {
      return err(request_id, "not_split", "there is no split view to save");
    }
    const panes = paneSnapshot(binding, splitview.tabs);
    if (panes.some((pane) => !pane.url || !/^https?:/u.test(pane.url))) {
      return err(request_id, "empty_pane", "a pane has no web address yet");
    }
    // Read the divider that is actually on screen; a native drag is not
    // routed through this module, so a stored `binding.ratio` can be stale.
    try {
      const panels = splitview.panels;
      const total = panels.reduce((sum, panel) => sum + panel.getBoundingClientRect().width, 0);
      if (total > 0 && panels[0]) {
        binding.ratio = clampRatio(panels[0].getBoundingClientRect().width / total) ?? binding.ratio;
      }
    } catch {
      // Keep the last known ratio.
    }
    const label = String(name ?? "").trim() || panes.map((pane) => pane.title || pane.url).join(" · ");
    const arrangement = validArrangement({
      id: newId(),
      name: label,
      space_id: __activeSpaceId(),
      ratio: binding.ratio,
      panes,
      created_at: Date.now(),
    });
    if (!arrangement) return err(request_id, "invalid", "the arrangement is not valid");
    const rows = [arrangement, ...readStore(binding)].filter(Boolean).slice(0, MAX_ARRANGEMENTS);
    if (!writeStore(rows)) return err(request_id, "store_failed", "the arrangement could not be saved");
    emit("split.arrangements-changed", {});
    return ok(request_id, { saved: true, arrangement });
  },

  async bookmarkList({ request_id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(request_id, "private_context", "a private window keeps no arrangement");
    }
    const rows = readStore(binding).map(validArrangement).filter(Boolean);
    return ok(request_id, { version: STORE_VERSION, arrangements: rows });
  },

  async bookmarkDelete({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(request_id, "private_context", "a private window keeps no arrangement");
    }
    const rows = readStore(binding).filter((row) => row?.id !== id);
    writeStore(rows);
    emit("split.arrangements-changed", {});
    return ok(request_id, { deleted: true });
  },

  /**
   * Re-apply a saved arrangement in the front tab's space. Open tabs with a
   * matching URL are reused; only missing pages are created. This is what
   * makes a restore idempotent and duplicate-free.
   */
  async bookmarkRestore({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(request_id, "private_context", "a private window restores no arrangement");
    }
    const rows = readStore(binding).map(validArrangement).filter(Boolean);
    const arrangement = rows.find((row) => row.id === id);
    if (!arrangement) return err(request_id, "no_such_arrangement", "unknown arrangement");
    if (arrangement.space_id && arrangement.space_id !== __activeSpaceId()) {
      return err(request_id, "space_mismatch", "switch to the arrangement's space first");
    }
    const { userContextId } = containerFor(binding);
    const openTabs = [];
    for (const tab of binding.gb?.tabs ?? []) {
      const astra = idOf(binding, tab);
      if (!astra || tab.pinned) continue;
      if ((tab.userContextId ?? 0) !== userContextId) continue;
      let url = "";
      try {
        url = tab.linkedBrowser?.currentURI?.spec ?? "";
      } catch {
        url = "";
      }
      if (/^https?:/u.test(url)) openTabs.push({ astra_tab_id: astra, tab, url });
    }
    const matches = matchPane(arrangement.panes, openTabs);
    const chosen = [];
    for (const match of matches) {
      if (match.reuse) {
        chosen.push(match.tab);
        continue;
      }
      const made = addNativeTab(binding, match.url, { userContextId, background: true });
      if (made) chosen.push(made);
    }
    if (chosen.length < 2) {
      return err(request_id, "incomplete", "fewer than two panes could be opened");
    }
    for (const splitview of splitViewsIn(binding)) {
      // Only a split that owns one of the panes we are about to place is
      // replaced; an unrelated split elsewhere keeps its arrangement.
      if (!splitview.tabs.some((tab) => chosen.includes(tab))) continue;
      try {
        splitview.unsplitTabs("astra_restore");
      } catch {
        // Already gone.
      }
    }
    const splitview = addToSplit(binding, chosen.slice(0, MAX_PANES));
    if (!splitview) return err(request_id, "split_refused", "the engine refused the arrangement");
    binding.ratio = arrangement.ratio;
    applyRatio(binding, arrangement.ratio);
    focusTab(binding, chosen[0]);
    scheduleRefresh(binding);
    return ok(request_id, {
      restored: true,
      members: splitview.tabs.map((tab) => idOf(binding, tab)).filter(Boolean),
    });
  },

  /** The live split for the front tab, for a panel or a probe. */
  async state({ request_id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding) return err(request_id, "no_window", "no chrome window is bound");
    const splitview = selectedTab(binding)?.splitview ?? null;
    const members = splitview ? splitview.tabs.map((tab) => idOf(binding, tab)).filter(Boolean) : [];
    return ok(request_id, {
      members,
      ratio: binding.ratio,
      panes: splitview ? splitview.tabs.length : 0,
      private: isPrivateWindow(binding.win),
    });
  },
};

// The content stage calls this after it has a native tab whose Astra id it did
// not know yet (a tab created by a link or by `openUrl`), so the projection
// catches up without a full bootstrap.
export function __splitNotify() {
  for (const binding of _bindings.values()) scheduleRefresh(binding);
}

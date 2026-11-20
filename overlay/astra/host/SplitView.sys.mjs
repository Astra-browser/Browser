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
  __setSplitGroups,
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

/** The narrowest a pane may become, matching the engine's own split CSS. */
export const MIN_PANE_PX = 140;
/** Pane shares keyed by the engine's split view, so a tab switch or a stage
 *  resize re-applies the same proportions instead of stale pixel widths. */
let _paneRatios = new WeakMap();

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return {
    request_id,
    host_api_version: HOST_API_VERSION,
    error: { code, message },
  };
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
  return paneCount(
    Number(settingString("astra.settings.split.max-panes", String(MAX_PANES))),
    2,
  );
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
    return (
      win?.document?.documentElement?.getAttribute("privatebrowsingmode") ===
      "temporary"
    );
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
  if (
    !Array.isArray(value.panes) ||
    value.panes.length < 2 ||
    value.panes.length > MAX_PANES
  ) {
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
    const focused =
      services()?.wm?.getMostRecentWindow("navigator:browser") ?? null;
    for (const binding of _bindings.values()) {
      if (binding.win === focused && focused.closed !== true) return binding;
    }
  } catch {
    // Fall through to no window.
  }
  return null;
}

function nativeTab(binding, astraTabId) {
  if (!binding || typeof astraTabId !== "string" || astraTabId === "")
    return null;
  return binding.tabOf.get(astraTabId) ?? null;
}

function idOf(binding, tab) {
  if (!binding || !tab) return "";
  return binding.idOf.get(tab) ?? tab.getAttribute?.("astra-tab-id") ?? "";
}

function selectedTab(binding) {
  return binding?.gb?.selectedTab ?? null;
}

/** The selected tab's split panels in tab order (the engine's flex order). */
function activePanels(binding) {
  return selectedTab(binding)?.splitview?.panels ?? [];
}

/** The stage width panes share, or 0 while the stage has no geometry. */
function stageWidth(binding) {
  const width = Number(binding?.gb?.tabpanels?.clientWidth) || 0;
  return width > 0 ? width : 0;
}

/** The shares for one split view, seeded from the panels' current widths. */
function ratiosOf(splitview) {
  const panels = splitview?.panels ?? [];
  if (panels.length < 2) return null;
  let ratios = _paneRatios.get(splitview) ?? null;
  if (Array.isArray(ratios) && ratios.length !== panels.length) ratios = null;
  if (!ratios) {
    const widths = panels.map((panel) => {
      try {
        return panel.getBoundingClientRect().width;
      } catch {
        return 0;
      }
    });
    const sum = widths.reduce((total, width) => total + width, 0);
    ratios =
      sum > 0
        ? widths.map((width) => width / sum)
        : panels.map(() => 1 / panels.length);
    _paneRatios.set(splitview, ratios);
  }
  return ratios;
}

/** Pixel widths for every pane but the last, which stays flexible.
 *
 * Pure, exported for tests. `total` is the stage width the panes share; the
 * engine's 4px margins are left out so the flex row cannot overflow. */
export function paneWidths(total, shares, min = MIN_PANE_PX) {
  const count = shares?.length ?? 0;
  if (!(total > 0) || !Number.isFinite(total) || count < 2) return null;
  const budget = Math.max(total - 8 * count, min * count);
  const widths = [];
  let used = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const remaining = count - index - 1;
    const room = budget - used - min * remaining;
    const want = Math.round(budget * shares[index]);
    const width = Math.max(min, Math.min(want, Math.max(min, room)));
    widths.push(width);
    used += width;
  }
  widths.push(null);
  return widths;
}

function setPanelWidth(panel, width) {
  try {
    panel.style.flex = "0 0 auto";
    panel.style.width = `${Math.round(width)}px`;
    panel.setAttribute("width", String(Math.round(width)));
  } catch {
    // Detached.
  }
}

function clearPanelWidth(panel) {
  try {
    panel.removeAttribute("width");
    panel.style.removeProperty("width");
    panel.style.removeProperty("flex");
  } catch {
    // Detached.
  }
}

/** Apply the remembered shares to the current stage width.
 *
 * The engine stores pane sizes as pixel `width` attributes. Those go stale
 * when the stage changes width (the sidebar hides or shows) or when a split is
 * suspended and re-activated by a tab switch. Every pane but the last is set
 * from its share; the last stays flexible so rounding and the engine's 4px
 * margins never overflow the stage. */
function applyPaneWidths(binding) {
  // A drag has just written live pixel widths that have not been read back
  // into shares yet. Re-applying the old shares now would snap the panes back
  // to their pre-drag split; the pending capture applies the new shares.
  if (binding.capturing) return;
  const splitview = selectedTab(binding)?.splitview ?? null;
  const panels = splitview?.panels ?? [];
  if (!splitview || panels.length < 2) return;
  const total = stageWidth(binding);
  if (total <= 0) {
    positionResizers(binding);
    return;
  }
  const ratios = ratiosOf(splitview);
  if (!ratios) return;
  const widths = paneWidths(total, ratios);
  if (!widths) return;
  for (let index = 0; index < panels.length - 1; index += 1)
    setPanelWidth(panels[index], widths[index]);
  clearPanelWidth(panels[panels.length - 1]);
  // Reading the panel rects in the same turn as the width change can still
  // see the previous flex layout. Place the handles on the next frame so a
  // sidebar change never leaves them on the old boundary.
  scheduleResizerPosition(binding);
}

function scheduleResizerPosition(binding) {
  if (binding.disposed) return;
  // The sidebar slides over ~400ms, and every frame moves and resizes the
  // stage; the final frame's rects are not known until the transition ends.
  // Keep placing the handles for a short settle window instead of trusting a
  // single post-width measurement (which can land mid-transition).
  binding.positionUntil = Date.now() + 800;
  if (binding.positioning) return;
  binding.positioning = true;
  const tick = () => {
    if (binding.disposed) {
      binding.positioning = false;
      return;
    }
    positionResizers(binding);
    if (Date.now() < binding.positionUntil) {
      try {
        binding.win.requestAnimationFrame(tick);
        return;
      } catch {
        // Fall through to the final placement.
      }
    }
    binding.positioning = false;
    positionResizers(binding);
  };
  try {
    binding.win.requestAnimationFrame(tick);
  } catch {
    binding.positioning = false;
    positionResizers(binding);
  }
}

/** Capture the settled widths after a drag frame.
 *
 * `getBoundingClientRect()` in the same turn as an inline width change can
 * still report the previous flex layout. Waiting one flushed frame keeps the
 * ratio readback honest, and then re-applies it so the last pane becomes
 * flexible again. */
function scheduleRatioCapture(binding) {
  if (binding.capturing || binding.disposed) return;
  binding.capturing = true;
  const run = () => {
    binding.capturing = false;
    if (binding.disposed) return;
    rememberPaneRatios(binding);
    applyPaneWidths(binding);
  };
  try {
    binding.win.requestAnimationFrame(() => {
      try {
        const flushed = binding.win.promiseDocumentFlushed?.(() => {});
        if (flushed && typeof flushed.then === "function")
          flushed.then(run, run);
        else run();
      } catch {
        run();
      }
    });
  } catch {
    run();
  }
}

/** Read the pane widths a drag just produced back into the share table. */
function rememberPaneRatios(binding) {
  // A pair just wrote its exact shares; a late rect read must not replace
  // them with the animation's still-old geometry.
  if (Date.now() < (binding.captureHoldUntil ?? 0)) return;
  const splitview = selectedTab(binding)?.splitview ?? null;
  const panels = splitview?.panels ?? [];
  if (!splitview || panels.length < 2) return;
  const widths = panels.map((panel) => {
    // The engine animates a pane's width over 50ms, so a rect read one frame
    // after a drag can still be the old size. The inline width is the size the
    // drag asked for; use it, and measure only the flexible last pane.
    const inline = Number.parseFloat(panel.style?.width ?? "");
    if (Number.isFinite(inline) && inline > 0) return inline;
    const attr = Number(panel.getAttribute?.("width"));
    if (Number.isFinite(attr) && attr > 0) return attr;
    try {
      return panel.getBoundingClientRect().width;
    } catch {
      return 0;
    }
  });
  const sum = widths.reduce((total, width) => total + width, 0);
  if (!(sum > 0)) return;
  const ratios = widths.map((width) => width / sum);
  _paneRatios.set(splitview, ratios);
  binding.ratio = clampRatio(ratios[0]) ?? binding.ratio;
}

/** Give every pane boundary its own draggable divider, reusing existing nodes
 *  so a tab switch never drops pointer capture mid-drag. */
function syncResizers(binding, splitview) {
  const tabbox = binding?.gb?.tabbox ?? binding?.gb?.tabpanels?.parentElement;
  const doc = binding?.win?.document;
  if (!tabbox || !doc) return;
  const panels = splitview?.panels ?? [];
  const wanted = panels.length >= 2 ? panels.length - 1 : 0;
  const resizers = binding.resizers ?? [];
  while (resizers.length > wanted) {
    const entry = resizers.pop();
    try {
      entry.node.remove();
    } catch {
      // Already removed with the split.
    }
  }
  for (const [index, entry] of resizers.entries()) entry.index = index;
  for (let index = resizers.length; index < wanted; index += 1) {
    // A chrome box in the tabbox, above the native panel deck. It is not a
    // browser and owns no page; it only turns pointer travel into panel width.
    const resizer = doc.createXULElement("box");
    resizer.className = "astra-pane-resizer";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("tabindex", "0");
    resizer.style.position = "absolute";
    resizer.style.zIndex = "10";
    resizer.style.inlineSize = "10px";
    resizer.style.cursor = "col-resize";
    resizer.style.pointerEvents = "auto";
    resizer.style.margin = "0";
    tabbox.appendChild(resizer);
    const entry = { node: resizer, index };
    resizers.push(entry);
    bindResizer(binding, entry);
  }
  binding.resizers = resizers;
  applyPaneWidths(binding);
}

function positionResizers(binding) {
  const panels = activePanels(binding);
  const tabbox = binding?.gb?.tabbox ?? binding?.gb?.tabpanels?.parentElement;
  if (!tabbox || panels.length < 2) return;
  const box = tabbox.getBoundingClientRect();
  for (const entry of binding.resizers ?? []) {
    const left = panels[entry.index];
    const right = panels[entry.index + 1];
    if (!left || !right) continue;
    try {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      entry.node.style.left = `${Math.round(Math.max(a.right, b.left) - box.left - 5)}px`;
      entry.node.style.top = `${Math.round(Math.min(a.top, b.top) - box.top)}px`;
      entry.node.style.blockSize = `${Math.round(Math.max(a.height, b.height))}px`;
    } catch {
      // A panel that left the deck.
    }
  }
}

function bindResizer(binding, entry) {
  const resizer = entry.node;
  const nudge = (event) => {
    // The node is reused when the deck's pane count changes; its boundary is
    // whatever the current split says, not the index it was created with.
    const index = entry.index;
    const all = activePanels(binding);
    const left = all[index];
    const right = all[index + 1];
    if (!left || !right) return;
    const step = event.shiftKey ? 36 : 12;
    let direction = 0;
    if (event.key === "ArrowLeft") direction = -1;
    if (event.key === "ArrowRight") direction = 1;
    if (direction === 0) return;
    event.preventDefault();
    resizePair(
      left,
      right,
      left.getBoundingClientRect().width + direction * step,
      0,
      0,
      binding,
    );
    scheduleRatioCapture(binding);
  };
  const down = (event) => {
    if (event.button !== 0) return;
    const index = entry.index;
    const all = activePanels(binding);
    const left = all[index];
    const right = all[index + 1];
    if (!left || !right) return;
    event.preventDefault();
    binding.dragging = true;
    const startX = event.clientX;
    const startLeft = left.getBoundingClientRect().width;
    const startRight = right.getBoundingClientRect().width;
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // Capture is optional; the element listeners still finish the drag.
    }
    const move = (moveEvent) => {
      resizePair(
        left,
        right,
        startLeft + (moveEvent.clientX - startX),
        startLeft,
        startRight,
        binding,
      );
      positionResizers(binding);
      scheduleResizerPosition(binding);
      scheduleRatioCapture(binding);
    };
    const stop = () => {
      binding.dragging = false;
      scheduleRatioCapture(binding);
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
    const splitview = selectedTab(binding)?.splitview ?? null;
    const all = splitview?.panels ?? [];
    if (splitview && all.length >= 2) {
      _paneRatios.set(
        splitview,
        all.map(() => 1 / all.length),
      );
      binding.ratio = 0.5;
    }
    applyPaneWidths(binding);
  });
}

/** Resize one adjacent pair, keeping the rest of the split untouched. */
function rememberPairRatios(binding, left, right, leftWidth, rightWidth) {
  if (!binding) return;
  const splitview = selectedTab(binding)?.splitview ?? null;
  const panels = splitview?.panels ?? [];
  const at = panels.indexOf(left);
  if (at < 0 || panels[at + 1] !== right) return;
  const widths = panels.map((panel) => {
    try {
      return Math.max(0, panel.getBoundingClientRect().width);
    } catch {
      return 0;
    }
  });
  widths[at] = Math.max(0, leftWidth);
  widths[at + 1] = Math.max(0, rightWidth);
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= 0) return;
  _paneRatios.set(
    splitview,
    widths.map((width) => width / total),
  );
  binding.captureHoldUntil = Date.now() + 800;
}

function resizePair(
  left,
  right,
  nextLeft,
  startLeft = 0,
  startRight = 0,
  binding = null,
) {
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
  // Record the shares from the values just written. Reading the rects a frame
  // later can see the engine's 50 ms pane animation (or an occluded window),
  // capture the pre-drag widths and snap the drag back.
  rememberPairRatios(binding, left, right, clamped, total - clamped);
}

/** Re-apply shares after the engine has flushed the new split's layout.
 *  Panel rects and the re-activated split deck settle one frame after a tab
 *  switch; measuring before that leaves the handles on the old boundary. */
function scheduleReflow(binding) {
  if (binding.reflowing || binding.disposed) return;
  binding.reflowing = true;
  const run = () => {
    binding.reflowing = false;
    if (binding.disposed) return;
    if (!binding.dragging) applyPaneWidths(binding);
    else positionResizers(binding);
  };
  try {
    binding.win.requestAnimationFrame(() => {
      try {
        const flushed = binding.win.promiseDocumentFlushed?.(() => {});
        if (flushed && typeof flushed.then === "function")
          flushed.then(run, run);
        else run();
      } catch {
        run();
      }
    });
  } catch {
    run();
  }
}

function refresh(binding) {
  try {
    const tab = selectedTab(binding);
    const splitview = tab?.splitview ?? null;
    syncResizers(binding, splitview);
    scheduleReflow(binding);
    const members = splitview
      ? splitview.tabs.map((t) => idOf(binding, t)).filter(Boolean)
      : [];
    const allGroups = splitViewsIn(binding)
      .map((sv) => ({
        members: sv.tabs.map((t) => idOf(binding, t)).filter(Boolean),
      }))
      .filter((group) => group.members.length > 1);
    __setSplitGroups(allGroups);
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
    reflowing: false,
    positioning: false,
    positionUntil: 0,
    capturing: false,
    dragging: false,
    disposed: false,
    listeners: [],
    resizers: [],
    panelObserver: null,
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
  const onResize = () => {
    if (binding.dragging) positionResizers(binding);
    else applyPaneWidths(binding);
    scheduleReflow(binding);
  };
  try {
    win.addEventListener("resize", onResize);
    binding.listeners.push([win, "resize", onResize]);
  } catch {
    // A window with no resize event still keeps its last geometry.
  }
  // The stage changes width without a window resize when the person hides or
  // shows the sidebar (and the bar's flow/overlay shape). Observe the panel
  // deck itself so the pane shares follow that width and the dividers stay on
  // the boundaries.
  try {
    const Resize = win.ResizeObserver;
    const deck = binding.gb?.tabpanels;
    if (Resize && deck) {
      const observer = new Resize(() => {
        if (binding.disposed) return;
        if (binding.dragging) positionResizers(binding);
        else applyPaneWidths(binding);
      });
      observer.observe(deck);
      binding.panelObserver = observer;
    }
  } catch {
    // A window without ResizeObserver keeps the window-resize path.
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
  try {
    binding.panelObserver?.disconnect();
  } catch {
    // Already gone with the window.
  }
  binding.panelObserver = null;
  for (const resizer of binding.resizers ?? []) {
    try {
      resizer.node?.remove();
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
  _paneRatios = new WeakMap();
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
    userContextId: Number.isSafeInteger(selected?.userContextId)
      ? selected.userContextId
      : 0,
    principal:
      systemPrincipal() ?? selected?.linkedBrowser?.contentPrincipal ?? null,
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
  const made = addNativeTab(binding, url, {
    userContextId: tab.userContextId ?? 0,
    background: true,
  });
  return made ?? null;
}

function addNativeTab(
  binding,
  url,
  { userContextId = 0, background = true } = {},
) {
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
      tab = gb.addTab(url, {
        inBackground: background === true,
        triggeringPrincipal: principal,
      });
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
function ensurePaneLoaded(binding, tab, attempt = 0) {
  if (!tab) return;
  const id = idOf(binding, tab);
  const url = id ? __tabsState()?.tabs?.get(id)?.url : "";
  const blank = () => {
    try {
      const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
      return !spec || spec === "about:blank" || spec.startsWith("chrome://browser/content/blanktab");
    } catch {
      return false;
    }
  };
  const retry = (limit) => {
    if (attempt >= limit) return;
    try {
      setTimeout(() => {
        try {
          if (tab.linkedBrowser) ensurePaneLoaded(binding, tab, attempt + 1);
        } catch {
          // The tab closed while waiting.
        }
      }, 120 * (attempt + 1));
    } catch {
      // No timer available in this environment.
    }
  };
  // A tab created for the split is adopted a turn or two later; until then it
  // has no Astra id and no URL to load, and giving up here is what left a pane
  // showing about:blank.
  if (!/^https?:/u.test(url ?? "")) {
    retry(10);
    return;
  }
  try {
    if (!blank()) return;
    tab.linkedBrowser?.fixupAndLoadURIString(url, {
      triggeringPrincipal: systemPrincipal(),
    });
  } catch {
    // A tab that is still being created loads on its own activation.
  }
  // The first load can land while the background browser is still being
  // created and be dropped, leaving the pane blank. Retry a few times, but
  // only while the document is still blank: a page the person stopped or the
  // engine replaced is not ours to reload.
  if (blank()) retry(6);
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
    const added = tabs.slice(1).filter((tab) => !current.includes(tab));
    if (added.length === 0) return existing;
    if (current.length + added.length > configuredPanes()) return null;
    existing.addTabs(added);
    // Joining a split can hand the tab a fresh pane browser; the load started
    // above belonged to the pre-split one, so start it again on the pane.
    for (const tab of added) ensurePaneLoaded(binding, tab);
    return existing;
  }
  if (tabs.some((tab) => tab.splitview)) return null;
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
    let uri = "";
    try {
      uri = paneTab.linkedBrowser?.currentURI?.spec ?? "";
    } catch {
      uri = "";
    }
    // Only a pane still on the blank starting document needs a selection to
    // commit its URL. Selecting every loaded pane made a split switch the
    // front document twice while pages were arriving, which is the freeze the
    // owner sees after dragging a tab into a split.
    if (uri && uri !== "about:blank" && !uri.startsWith("chrome://browser/content/blanktab")) {
      continue;
    }
    try {
      await Tabs.select({ request_id: `split-warm-${id}`, astra_tab_id: id });
      // Activation gives the pane its docShell; a browser created for the
      // split has none, and a load asked for before that is dropped. Ask
      // again now that the pane is live.
      ensurePaneLoaded(binding, paneTab, 6);
    } catch {
      // A pane that cannot be selected still loads on its own first commit.
    }
  }
  if (sourceId) {
    try {
      await Tabs.select({
        request_id: `split-source-${sourceId}`,
        astra_tab_id: sourceId,
      });
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
  if (!panels[0]) return ratio;
  // The first divider's share; a third pane splits the remainder evenly.
  const rest = (1 - ratio) / (panels.length - 1);
  _paneRatios.set(splitview, [ratio, ...panels.slice(1).map(() => rest)]);
  applyPaneWidths(binding);
  return ratio;
}

function resetRatio(binding) {
  binding.ratio = 0.5;
  for (const splitview of splitViewsIn(binding)) {
    const panels = splitview.panels ?? [];
    if (panels.length >= 2)
      _paneRatios.set(
        splitview,
        panels.map(() => 1 / panels.length),
      );
    for (const panel of panels) clearPanelWidth(panel);
  }
  applyPaneWidths(binding);
  positionResizers(binding);
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
  async open({
    request_id = "",
    other = "",
    source = "",
    window_id = "",
    placement = "right",
  } = {}) {
    if (!splitEnabled())
      return err(request_id, "disabled", "split view is turned off");
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    let sourceTab = nativeTab(binding, source) ?? selectedTab(binding);
    sourceTab = materialisePinned(binding, sourceTab);
    const otherTab = materialisePinned(binding, nativeTab(binding, other));
    if (!sourceTab || !otherTab)
      return err(request_id, "no_such_tab", "both panes need a live tab");
    if (sourceTab === otherTab)
      return err(request_id, "same_tab", "a tab cannot split with itself");
    if (!sameSpace(binding, sourceTab, otherTab)) {
      return err(
        request_id,
        "space_mismatch",
        "a split view never spans spaces",
      );
    }
    // A tab that is already in a split is never added twice: joining that
    // split means selecting the existing view, and two different splits are
    // not merged behind the person's back.
    const sourceSplit = sourceTab.splitview ?? null;
    const otherSplit = otherTab.splitview ?? null;
    if (sourceSplit && otherSplit) {
      if (sourceSplit !== otherSplit) {
        return err(
          request_id,
          "already_in_split",
          "both tabs are already in a split view",
        );
      }
      focusTab(binding, sourceTab);
      return ok(request_id, {
        split: true,
        members: sourceSplit.tabs
          .map((tab) => idOf(binding, tab))
          .filter(Boolean),
        panes: sourceSplit.tabs.length,
        already: true,
      });
    }
    let splitview = null;
    if (sourceSplit || otherSplit) {
      const existing = sourceSplit ?? otherSplit;
      const outsider = sourceSplit ? otherTab : sourceTab;
      if (existing.tabs.includes(outsider)) {
        splitview = existing;
      } else if (existing.tabs.length + 1 <= configuredPanes()) {
        try {
          existing.addTabs([outsider]);
          splitview = existing;
        } catch {
          return err(
            request_id,
            "split_refused",
            "the engine refused this pane",
          );
        }
      } else {
        return err(
          request_id,
          "pane_limit",
          `at most ${configuredPanes()} panes`,
        );
      }
    } else {
      const ordered =
        placement === "left" ? [otherTab, sourceTab] : [sourceTab, otherTab];
      splitview = addToSplit(binding, ordered);
    }
    if (!splitview)
      return err(
        request_id,
        "split_refused",
        "the engine refused this split view",
      );
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
  async openUrl({
    request_id = "",
    url = "",
    mode = "split",
    placement = "right",
    pane = "",
    window_id = "",
  } = {}) {
    if (mode !== "tab" && !splitEnabled()) {
      return err(request_id, "disabled", "split view is turned off");
    }
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    if (typeof url !== "string" || url === "")
      return err(request_id, "invalid_url", "url is required");
    let targetUrl = url;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return err(
          request_id,
          "invalid_url",
          "only http(s) URLs can open in a tab or pane",
        );
      }
      targetUrl = parsed.href;
    } catch {
      return err(request_id, "invalid_url", "url is required");
    }
    if (mode === "tab") {
      const { userContextId } = containerFor(binding);
      const tab = addNativeTab(binding, targetUrl, {
        userContextId,
        background: false,
      });
      if (!tab)
        return err(request_id, "tab_refused", "the engine refused the tab");
      focusTab(binding, tab);
      scheduleRefresh(binding);
      return ok(request_id, { opened: true, astra_tab_id: idOf(binding, tab) });
    }
    // Refuse before creating a tab: a rejected fourth pane must not steal the
    // front tab or add an orphan tab to the strip.
    const prospectiveSource = nativeTab(binding, pane) ?? selectedTab(binding);
    if (
      prospectiveSource?.splitview &&
      prospectiveSource.splitview.tabs.length >= configuredPanes()
    ) {
      return err(
        request_id,
        "pane_limit",
        `at most ${configuredPanes()} panes`,
      );
    }
    // A split pane keeps the front tab's container, so a link from a private
    // or space tab cannot land in a different partition.
    const { userContextId } = containerFor(binding);
    const made = addNativeTab(binding, targetUrl, {
      userContextId,
      background: true,
    });
    if (!made)
      return err(request_id, "tab_refused", "the engine refused the pane tab");
    const source = nativeTab(binding, pane) ?? selectedTab(binding);
    if (!source || source === made) {
      focusTab(binding, made);
      scheduleRefresh(binding);
      return ok(request_id, {
        opened: true,
        astra_tab_id: idOf(binding, made),
      });
    }
    const ordered = placement === "left" ? [made, source] : [source, made];
    const splitview = addToSplit(binding, ordered);
    if (!splitview) {
      // The tab still opened; report that honestly rather than pretending a
      // pane exists.
      focusTab(binding, made);
      scheduleRefresh(binding);
      return ok(request_id, {
        opened: true,
        split: false,
        astra_tab_id: idOf(binding, made),
      });
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
  async replace({
    request_id = "",
    pane = "",
    other = "",
    url = "",
    window_id = "",
  } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    const paneTab = nativeTab(binding, pane) ?? selectedTab(binding);
    if (!paneTab) return err(request_id, "no_such_tab", "the pane is gone");
    const splitview = paneTab.splitview ?? null;
    if (!splitview || splitview.tabs.length < 2) {
      return err(request_id, "not_split", "the pane is not in a split view");
    }
    let replacement = nativeTab(binding, other);
    if (!replacement && typeof url === "string" && url !== "") {
      const { userContextId } = containerFor(binding);
      replacement = addNativeTab(binding, url, {
        userContextId,
        background: true,
      });
    }
    if (!replacement)
      return err(request_id, "no_such_tab", "no replacement tab");
    if (replacement === paneTab)
      return err(request_id, "same_tab", "the replacement is the pane");
    if (!sameSpace(binding, paneTab, replacement)) {
      return err(
        request_id,
        "space_mismatch",
        "a split view never spans spaces",
      );
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
    if (!rebuilt)
      return err(
        request_id,
        "split_refused",
        "the engine refused the replacement",
      );
    if (paneTab.selected) focusTab(binding, replacement);
    applyRatio(binding, binding.ratio);
    scheduleRefresh(binding);
    return ok(request_id, {
      replaced: true,
      members: members.map((tab) => idOf(binding, tab)),
    });
  },

  /** Remove one tab from its split, leaving the tab open in the strip. */
  async leave({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    const tab = nativeTab(binding, id);
    const splitview = tab?.splitview ?? null;
    if (!tab || !splitview)
      return err(request_id, "not_split", "that tab is not in a split view");
    const remaining = splitview.tabs.filter((member) => member !== tab);
    try {
      splitview.unsplitTabs("astra_leave");
    } catch {
      return err(request_id, "split_refused", "the engine refused to unsplit");
    }
    if (remaining.length >= 2 && !addToSplit(binding, remaining)) {
      return err(
        request_id,
        "split_refused",
        "the remaining panes could not stay split",
      );
    }
    if (tab.selected) focusTab(binding, remaining[0] ?? tab);
    scheduleRefresh(binding);
    return ok(request_id, {
      left: true,
      members: remaining.map((member) => idOf(binding, member)),
    });
  },

  /** End the split above the front tab; every tab stays open. */
  async unsplit({ request_id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
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
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    const tab = nativeTab(binding, id);
    if (!tab)
      return err(request_id, "no_such_tab", "that pane has no live tab");
    focusTab(binding, tab);
    scheduleRefresh(binding);
    return ok(request_id, { focused: id });
  },

  /** Set the first divider share (0.05..0.95). */
  async ratio({ request_id = "", ratio = null, window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    const applied = applyRatio(binding, ratio);
    if (applied === null)
      return err(request_id, "bad_ratio", "ratio must be finite");
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
    if (width <= 0 || !Number.isFinite(point))
      return ok(request_id, { edge: null, accepted: false });
    let left = 0;
    let right = width;
    try {
      const rect = binding.win.document
        .querySelector("[data-astra-content]")
        ?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        left = rect.left;
        right = rect.right;
      }
    } catch {
      // Window bounds.
    }
    const edgeWidth = Math.min(120, Math.round((right - left) * 0.12));
    const edge =
      point <= left + edgeWidth
        ? "left"
        : point >= right - edgeWidth
          ? "right"
          : null;
    return ok(request_id, { edge, accepted: edge !== null });
  },

  /**
   * Tab dragged onto the page's left/right edge becomes a pane. The app sends
   * frame coordinates; a drop in the middle is not a split.
   */
  async drop({
    request_id = "",
    id = "",
    x = null,
    y = null,
    window_id = "",
  } = {}) {
    if (
      !splitEnabled() ||
      !settingBool("astra.settings.split.drag-edge", true)
    ) {
      return ok(request_id, { accepted: false, reason: "disabled" });
    }
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
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
    if (placement === null)
      return ok(request_id, { accepted: false, reason: "not_edge" });
    const source = selectedTab(binding);
    if (!source || source === tab)
      return ok(request_id, { accepted: false, reason: "same_tab" });
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
    if (!splitview)
      return ok(request_id, { accepted: false, reason: "split_refused" });
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
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(
        request_id,
        "private_context",
        "a private window keeps no arrangement",
      );
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
      const total = panels.reduce(
        (sum, panel) => sum + panel.getBoundingClientRect().width,
        0,
      );
      if (total > 0 && panels[0]) {
        binding.ratio =
          clampRatio(panels[0].getBoundingClientRect().width / total) ??
          binding.ratio;
      }
    } catch {
      // Keep the last known ratio.
    }
    const label =
      String(name ?? "").trim() ||
      panes.map((pane) => pane.title || pane.url).join(" · ");
    const arrangement = validArrangement({
      id: newId(),
      name: label,
      space_id: __activeSpaceId(),
      ratio: binding.ratio,
      panes,
      created_at: Date.now(),
    });
    if (!arrangement)
      return err(request_id, "invalid", "the arrangement is not valid");
    const rows = [arrangement, ...readStore(binding)]
      .filter(Boolean)
      .slice(0, MAX_ARRANGEMENTS);
    if (!writeStore(rows))
      return err(
        request_id,
        "store_failed",
        "the arrangement could not be saved",
      );
    emit("split.arrangements-changed", {});
    return ok(request_id, { saved: true, arrangement });
  },

  async bookmarkList({ request_id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(
        request_id,
        "private_context",
        "a private window keeps no arrangement",
      );
    }
    const rows = readStore(binding).map(validArrangement).filter(Boolean);
    return ok(request_id, { version: STORE_VERSION, arrangements: rows });
  },

  async bookmarkDelete({ request_id = "", id = "", window_id = "" } = {}) {
    const binding = bindingFor(window_id);
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(
        request_id,
        "private_context",
        "a private window keeps no arrangement",
      );
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
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    if (isPrivateWindow(binding.win)) {
      return err(
        request_id,
        "private_context",
        "a private window restores no arrangement",
      );
    }
    const rows = readStore(binding).map(validArrangement).filter(Boolean);
    const arrangement = rows.find((row) => row.id === id);
    if (!arrangement)
      return err(request_id, "no_such_arrangement", "unknown arrangement");
    if (arrangement.space_id && arrangement.space_id !== __activeSpaceId()) {
      return err(
        request_id,
        "space_mismatch",
        "switch to the arrangement's space first",
      );
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
      if (/^https?:/u.test(url))
        openTabs.push({ astra_tab_id: astra, tab, url });
    }
    const matches = matchPane(arrangement.panes, openTabs);
    const chosen = [];
    for (const match of matches) {
      if (match.reuse) {
        chosen.push(match.tab);
        continue;
      }
      const made = addNativeTab(binding, match.url, {
        userContextId,
        background: true,
      });
      if (made) chosen.push(made);
    }
    if (chosen.length < 2) {
      return err(
        request_id,
        "incomplete",
        "fewer than two panes could be opened",
      );
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
    if (!splitview)
      return err(
        request_id,
        "split_refused",
        "the engine refused the arrangement",
      );
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
    if (!binding)
      return err(request_id, "no_window", "no chrome window is bound");
    const splitview = selectedTab(binding)?.splitview ?? null;
    const members = splitview
      ? splitview.tabs.map((tab) => idOf(binding, tab)).filter(Boolean)
      : [];
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

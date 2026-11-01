/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Astra content slots (spike S-01, P3-T02): one AND many `<browser>`
 * elements positioned by CSS into Astra's content slots (split/Work panes)
 * WITHOUT reparenting.
 *
 * Design: a fixed pool of at most MAX_SLOTS remote `<browser>` elements is
 * created once, each permanently parented inside its own grid cell. Layout
 * changes (1 -> 2 -> 4 panes) only toggle the container's `data-layout`
 * attribute and per-cell `hidden` flags — DOM nodes are never moved, so no
 * docshell, session history, or focused state is ever at risk. Which tab a
 * cell shows is a model-side binding (slot -> astra_tab_id); rebinding
 * loads a URL into the cell's OWN browser, never another cell's node.
 *
 * Pure model (layoutFor/createSlotsState/bindTab/...) has no DOM and is
 * exercised by tests/contract/slots_model.mjs with a fake DOM. mountSlots
 * uses only a tiny DOM surface (createElementNS/createElement,
 * setAttribute, appendChild, hidden, focus, getBoundingClientRect, optional
 * ResizeObserver) so the same code runs in chrome and in Node fakes.
 */

export const MAX_SLOTS = 4;

// Visible-count -> grid variant (mirrors slots.css `[data-layout=...]`).
export function layoutFor(visibleCount) {
  if (visibleCount <= 1) {
    return "single";
  }
  if (visibleCount === 2) {
    return "cols-2";
  }
  return "grid-2x2";
}

// All layout variants the CSS must provide. The stub contract asserts the
// model and the stylesheet agree on exactly this set.
export function knownLayouts() {
  return ["single", "cols-2", "grid-2x2"];
}

export function createSlotsState(maxSlots = MAX_SLOTS) {
  if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > MAX_SLOTS) {
    throw new Error(`[astra-slots] maxSlots must be 1..${MAX_SLOTS}`);
  }
  const slots = [];
  for (let i = 0; i < maxSlots; i += 1) {
    slots.push({
      slotId: `slot-${i + 1}`,
      visible: i === 0,
      astra_tab_id: null,
      rect: null,
    });
  }
  return { slots, layout: layoutFor(1) };
}

export function visibleSlots(state) {
  return state.slots.filter((s) => s.visible);
}

function refreshLayout(state) {
  state.layout = layoutFor(visibleSlots(state).length);
  return state.layout;
}

// Show exactly the first `n` slots (1..maxSlots). Returns the layout name.
// Browsers are never created, moved, or destroyed here — visibility only.
export function setVisibleCount(state, n) {
  if (!Number.isInteger(n) || n < 1 || n > state.slots.length) {
    return { error: { code: "bad_count", message: `n must be 1..${state.slots.length}` } };
  }
  state.slots.forEach((s, i) => {
    s.visible = i < n;
  });
  return { layout: refreshLayout(state) };
}

// Model-side tab binding: no DOM moves. Returns error for unknown slots.
export function bindTab(state, slotId, astraTabId) {
  const slot = state.slots.find((s) => s.slotId === slotId);
  if (!slot) {
    return { error: { code: "no_such_slot", message: `unknown slot ${slotId}` } };
  }
  slot.astra_tab_id = astraTabId;
  return { slotId, astra_tab_id: astraTabId };
}

export function slotForTab(state, astraTabId) {
  return state.slots.find((s) => s.astra_tab_id === astraTabId) ?? null;
}

// Live DOM binding. `host` is the Host API surface used ({ Tabs,
// Navigation }); `createBrowser(slotEl, slot)` builds the ONE browser per
// cell (default builds a remote type=content browser like Content.sys.mjs).
// `onRect(slotId, rect)` receives ResizeObserver measurements (feeds
// Panes.setRect); when ResizeObserver is unavailable it is simply skipped.
export function mountSlots(container, { maxSlots = MAX_SLOTS, host = null, createBrowser = null, onRect = null } = {}) {
  const state = createSlotsState(maxSlots);
  const doc = container.ownerDocument;
  const View = doc.defaultView ?? {};
  // The XUL namespace (NOT ...there.is.only.xhtml): only elements created
  // in this namespace upgrade to MozBrowser. Verified live 2026-11-02:
  // createElementNS(xhtml-ns, "browser") stays a plain Element forever
  // (no fixupAndLoadURIString), while the xul-ns node is a MozBrowser
  // immediately. See docs/astra/spikes/S-01.md finding F-01.
  const NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

  const makeBrowser =
    createBrowser ??
    ((slotEl) => {
      const browser = doc.createElementNS(NS, "browser");
      browser.setAttribute("type", "content");
      browser.setAttribute("remote", "true");
      browser.setAttribute("remoteType", "web");
      browser.setAttribute("maychangeremoteness", "true");
      browser.setAttribute("data-astra-browser", "slots");
      browser.setAttribute("data-astra-slot", slotEl.getAttribute("data-slot-id") ?? "");
      slotEl.appendChild(browser);
      return browser;
    });

  const cells = new Map(); // slotId -> { cell, browser }
  for (const slot of state.slots) {
    const cell = doc.createElement("div");
    cell.setAttribute("class", "astra-slot");
    cell.setAttribute("data-slot-id", slot.slotId);
    container.appendChild(cell);
    const browser = makeBrowser(cell, slot);
    cells.set(slot.slotId, { cell, browser });
  }

  let observer = null;
  if (onRect && typeof View.ResizeObserver === "function") {
    observer = new View.ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target?.getAttribute?.("data-slot-id");
        const r = entry.contentRect;
        if (id && r) {
          onRect(id, { x: r.x, y: r.y, width: r.width, height: r.height });
        }
      }
    });
    for (const { cell } of cells.values()) {
      observer.observe(cell);
    }
  }

  function applyToDom() {
    container.setAttribute("data-layout", state.layout);
    container.setAttribute("class", "astra-slots");
    for (const slot of state.slots) {
      const { cell } = cells.get(slot.slotId);
      cell.hidden = !slot.visible;
    }
  }
  applyToDom();

  return {
    state,
    cells,
    get layout() {
      return state.layout;
    },
    // Visibility only — element identity is preserved (asserted by stub).
    setVisibleCount(n) {
      const res = setVisibleCount(state, n);
      if (!res.error) {
        applyToDom();
      }
      return res;
    },
    bind(slotId, astraTabId) {
      return bindTab(state, slotId, astraTabId);
    },
    // Focus switch: DOM focus on the cell's OWN browser + model select.
    // Returns the focused element so tests can assert activeElement flow.
    async focusSlot(slotId, { request_id = "slots-focus" } = {}) {
      const entry = cells.get(slotId);
      if (!entry) {
        return { error: { code: "no_such_slot", message: `unknown slot ${slotId}` } };
      }
      const slot = state.slots.find((s) => s.slotId === slotId);
      try {
        entry.browser.focus();
      } catch {
        // Headless/fake DOMs may not implement focus; model select still applies.
      }
      if (host && slot?.astra_tab_id) {
        await host.Tabs.select({ request_id, astra_tab_id: slot.astra_tab_id });
      }
      return { slotId, focused: true };
    },
    // Navigate the cell's OWN browser at its bound tab. Per-pane history
    // independence falls out of the Tabs model (one stack per astra_tab_id).
    async navigateSlot(slotId, url, { request_id = "slots-nav" } = {}) {
      const slot = state.slots.find((s) => s.slotId === slotId);
      if (!slot) {
        return { error: { code: "no_such_slot", message: `unknown slot ${slotId}` } };
      }
      if (!slot.astra_tab_id) {
        if (!host) {
          return { error: { code: "no_tab_bound", message: `slot ${slotId} has no tab` } };
        }
        const created = await host.Tabs.create({ request_id, url });
        slot.astra_tab_id = created.astra_tab_id;
        return { slotId, astra_tab_id: slot.astra_tab_id, url };
      }
      if (!host) {
        return { slotId, astra_tab_id: slot.astra_tab_id, url };
      }
      return host.Navigation.loadURL({ request_id, astra_tab_id: slot.astra_tab_id, url });
    },
    measure(slotId) {
      const entry = cells.get(slotId);
      if (!entry || typeof entry.cell.getBoundingClientRect !== "function") {
        return null;
      }
      const r = entry.cell.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    detach() {
      try {
        observer?.disconnect?.();
      } catch {
        // Best-effort teardown.
      }
    },
  };
}

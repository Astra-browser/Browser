// P3-T06 shell split-view renderer (chrome). Imperative DOM like
// `../tabs/tab-strip.js`: Svelte templates cannot carry interactive markup
// in a chrome XUL document, so plain DOM calls sidestep that entirely.
//
// Fixed pool of MAX_SLOTS cells, visibility only (S-01 no-reparenting
// rule): layout switches toggle the container's `data-layout` and per-cell
// `hidden` — nodes are never moved. Which tab a cell shows is model-side
// (`split-model.js`); the cell's content div carries `data-slot-id` so the
// content binding (S-01 `Slots.sys.mjs`) can mount that slot's own
// `<browser>` into it. Driven only by the injected Host API
// (`{ Tabs, addEventListener }`) plus a tab list from the caller.
import {
  bindTab,
  blankSplit,
  closeSlot,
  layoutFor,
  loadLayout,
  MAX_SLOTS,
  openSplit,
  resizeSlot,
  saveLayout,
  setActive,
  swapSlots,
} from "./split-model.js";
import { newRequestId } from "../host.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

function el(doc, tag, cls, text) {
  const node = doc.createElementNS(XHTML_NS, tag);
  if (cls) node.setAttribute("class", cls);
  if (text !== undefined) node.textContent = text;
  return node;
}

function titleOf(tabs, tabId) {
  const tab = tabs.find((entry) => entry.id === tabId);
  if (!tab) return tabId === null ? "Empty pane" : tabId;
  return tab.title || tab.url || tab.id;
}

export function mountSplit(container, host, options = {}) {
  const doc = container.ownerDocument;
  // NOTE: even `typeof localStorage` can throw NS_ERROR_NOT_AVAILABLE in a
  // chrome window without DOM storage (headless). Never touch it unguarded.
  let storage = options.storage ?? null;
  if (storage === null || storage === undefined) {
    try {
      storage = typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      storage = null;
    }
  }
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  let tabs = Array.isArray(options.tabs) ? options.tabs : [];
  let state = blankSplit();
  if (options.initialState) {
    state = options.initialState;
  } else {
    try {
      state = loadLayout(storage);
    } catch {
      state = blankSplit();
    }
  }
  let disposed = false;

  const root = el(doc, "div", "astra-split");
  container.appendChild(root);

  // Fixed cell pool: created once, never moved or destroyed (S-01).
  const cells = new Map();
  for (let i = 0; i < MAX_SLOTS; i += 1) {
    const id = `slot-${i + 1}`;
    const cell = el(doc, "section", "astra-split-cell");
    cell.setAttribute("data-slot-id", id);
    cell.setAttribute("role", "region");
    cell.setAttribute("aria-label", `Pane ${i + 1}`);

    const header = el(doc, "div", "astra-split-header");
    const title = el(doc, "span", "astra-split-title", "Empty pane");
    const actions = el(doc, "div", "astra-split-actions");
    const swapButton = el(doc, "button", "astra-split-swap", "Swap");
    swapButton.setAttribute("aria-label", `Swap pane ${i + 1} with next`);
    swapButton.setAttribute("title", "Swap with next pane");
    const closeButton = el(doc, "button", "astra-split-close", "Close");
    closeButton.setAttribute("aria-label", `Close pane ${i + 1}`);
    closeButton.setAttribute("title", "Close pane");
    actions.appendChild(swapButton);
    actions.appendChild(closeButton);
    header.appendChild(title);
    header.appendChild(actions);

    const divider = el(doc, "div", "astra-split-divider");
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", `Resize pane ${i + 1}`);
    divider.setAttribute("tabindex", "0");

    const content = el(doc, "div", "astra-split-content");
    content.setAttribute("data-slot-id", id);

    cell.appendChild(header);
    cell.appendChild(content);
    cell.appendChild(divider);
    root.appendChild(cell);
    cells.set(id, { cell, title, content, divider, swapButton, closeButton, header });

    header.addEventListener("click", (event) => {
      if (event.target === swapButton || event.target === closeButton) return;
      void api.focus(id);
    });
    closeButton.addEventListener("click", () => void api.close(id));
    swapButton.addEventListener("click", () => {
      const ids = state.slots.map((slot) => slot.id);
      const at = ids.indexOf(id);
      if (at !== -1) void api.swap(id, ids[(at + 1) % ids.length]);
    });
    divider.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      try {
        divider.setPointerCapture?.(event.pointerId);
      } catch {
        // Fake/minimal DOMs may not implement capture; drag still applies.
      }
      const startX = event.clientX;
      const startRatio = state.slots.find((s) => s.id === id)?.ratio ?? 0.5;
      const move = (moveEvent) => {
        const rect = root.getBoundingClientRect?.();
        if (!rect || rect.width <= 0) return;
        void api.resize(id, startRatio + (moveEvent.clientX - startX) / rect.width);
      };
      const up = () => {
        divider.removeEventListener?.("pointermove", move);
        divider.removeEventListener?.("pointerup", up);
      };
      divider.addEventListener?.("pointermove", move);
      divider.addEventListener?.("pointerup", up);
    });
    divider.addEventListener("keydown", (event) => {
      const current = state.slots.find((s) => s.id === id)?.ratio ?? 0.5;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        void api.resize(id, current - (event.shiftKey ? 0.1 : 0.02));
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        void api.resize(id, current + (event.shiftKey ? 0.1 : 0.02));
      }
    });
  }

  function persist() {
    saveLayout(storage, state);
    if (onChange) {
      try {
        onChange(state);
      } catch {
        // Listener failures never break the view.
      }
    }
  }

  function applyToDom() {
    root.setAttribute("data-layout", layoutFor(state.slots.length));
    const visible = new Set(state.slots.map((slot) => slot.id));
    const ratios = state.slots.map((slot) => slot.ratio);
    if (state.slots.length === 2) {
      root.style.gridTemplateColumns = `${ratios[0] * 100}% ${ratios[1] * 100}%`;
      root.style.gridTemplateRows = "";
    } else if (state.slots.length > 2) {
      const half = Math.ceil(state.slots.length / 2);
      const left = ratios.slice(0, half).reduce((a, b) => a + b, 0);
      root.style.gridTemplateColumns = `${left * 100}% ${(1 - left) * 100}%`;
      root.style.gridTemplateRows = "";
    } else {
      root.style.gridTemplateColumns = "";
      root.style.gridTemplateRows = "";
    }
    for (const [id, refs] of cells) {
      const slot = state.slots.find((s) => s.id === id);
      refs.cell.hidden = !slot || !visible.has(id);
      refs.cell.classList?.toggle("is-active", state.activeId === id);
      if (slot) {
        refs.title.textContent = titleOf(tabs, slot.tabId);
        refs.content.setAttribute("data-tab-id", slot.tabId ?? "");
      }
    }
  }

  const api = {
    getState: () => state,
    update(nextTabs) {
      tabs = Array.isArray(nextTabs) ? nextTabs : [];
      applyToDom();
    },
    split(tabId = null) {
      const next = openSplit(state, tabId);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      return { slots: state.slots.length };
    },
    close(id) {
      const next = closeSlot(state, id);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      return { slots: state.slots.length };
    },
    resize(id, ratio) {
      const next = resizeSlot(state, id, ratio);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      return { ratio: state.slots.find((s) => s.id === id)?.ratio ?? null };
    },
    swap(a, b) {
      const next = swapSlots(state, a, b);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      return { swapped: true };
    },
    bind(id, tabId) {
      const next = bindTab(state, id, tabId);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      return { slotId: id };
    },
    async focus(id) {
      const next = setActive(state, id);
      if (next.error) return next;
      state = next;
      persist();
      applyToDom();
      const slot = state.slots.find((s) => s.id === id);
      if (host?.Tabs && slot?.tabId) {
        try {
          await host.Tabs.select({ request_id: newRequestId(), astra_tab_id: slot.tabId });
        } catch {
          // Model focus still applies when the host call fails.
        }
      }
      return { slotId: id, focused: true };
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      try {
        container.removeChild(root);
      } catch {
        // Already detached.
      }
    },
  };

  applyToDom();
  return api;
}

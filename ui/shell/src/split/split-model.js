// P3-T06 shell split view: pure model (no DOM). The renderer (`split.js`)
// keeps all document access; this module owns slot organisation, ratio math
// and persistence shapes so `node --test` covers it with no browser.
//
// Mirrors `crates/astra-core/src/layout.rs` (core owns the truth; this is
// the chrome-side working copy) and spike S-01 (`Slots.sys.mjs`): a fixed
// pool of at most MAX_SLOTS cells, visibility only — a *slot* keeps its
// identity for life and only the *tab binding* moves, so `swapSlots`
// exchanges bindings, never positions.

export const MAX_SLOTS = 4;
export const MIN_RATIO = 0.05;
export const MAX_RATIO = 0.95;
export const LAYOUT_VERSION = 1;

const STORAGE_KEY = "astra.split.layout.v1";

// Visible-count -> grid variant (mirrors S-01 `layoutFor` and `split.css`
// `[data-layout=...]`): 1 -> single, 2 -> cols-2, 3/4 -> grid-2x2.
export function layoutFor(visibleCount) {
  if (visibleCount <= 1) return "single";
  if (visibleCount === 2) return "cols-2";
  return "grid-2x2";
}

export function blankSplit() {
  return {
    version: LAYOUT_VERSION,
    slots: [{ id: "slot-1", tabId: null, ratio: 1 }],
    activeId: "slot-1",
  };
}

function equalise(slots) {
  const share = 1 / slots.length;
  return slots.map((slot) => ({ ...slot, ratio: share }));
}

function fail(code, message) {
  return { error: { code, message } };
}

export function findSlot(state, id) {
  return state.slots.find((slot) => slot.id === id) ?? null;
}

// Split the focused pane to show `tabId` (at most MAX_SLOTS). The new slot
// becomes active; shares re-equalise so the axis still sums to 1.
export function openSplit(state, tabId = null) {
  if (state.slots.length >= MAX_SLOTS) {
    return { ...state, error: fail("too_many_slots", `at most ${MAX_SLOTS} split slots`).error };
  }
  const slots = equalise([
    ...state.slots,
    { id: `slot-${state.slots.length + 1}`, tabId, ratio: 0 },
  ]);
  return { version: LAYOUT_VERSION, slots, activeId: slots[slots.length - 1].id };
}

// Close a slot. Closing the final slot resets to a single empty pane (S-01
// never drops below one visible cell); otherwise the share redistributes
// equally and focus falls back to slot-1.
export function closeSlot(state, id) {
  if (!findSlot(state, id)) return { ...state, error: fail("no_such_slot", `unknown slot ${id}`).error };
  const kept = state.slots.filter((slot) => slot.id !== id);
  if (kept.length === 0) return blankSplit();
  const slots = equalise(kept);
  return {
    version: LAYOUT_VERSION,
    slots,
    activeId: state.activeId === id ? "slot-1" : state.activeId,
  };
}

// Resize a slot to `ratio` of the split axis. Clamped into the
// MIN/MAX_RATIO band; siblings scale proportionally so the axis sums to 1.
// A lone slot is always full-width.
export function resizeSlot(state, id, ratio) {
  const slot = findSlot(state, id);
  if (!slot) return { ...state, error: fail("no_such_slot", `unknown slot ${id}`).error };
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return { ...state, error: fail("bad_ratio", `slot ${id} ratio must be finite`).error };
  }
  if (state.slots.length === 1) {
    return { ...state, slots: [{ ...slot, ratio: 1 }] };
  }
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const rest = 1 - clamped;
  const siblings = state.slots.filter((s) => s.id !== id);
  const oldRest = siblings.reduce((sum, s) => sum + s.ratio, 0);
  const slots = state.slots.map((s) => {
    if (s.id === id) return { ...s, ratio: clamped };
    if (oldRest > 0) return { ...s, ratio: (s.ratio / oldRest) * rest };
    return { ...s, ratio: rest / siblings.length };
  });
  return { ...state, slots };
}

// Exchange which tabs two slots show. Cell identity is stable (the S-01
// no-reparenting rule) — only the bindings move.
export function swapSlots(state, a, b) {
  if (a === b) return { ...state };
  const sa = findSlot(state, a);
  const sb = findSlot(state, b);
  if (!sa || !sb) {
    return { ...state, error: fail("no_such_slot", `unknown slot in swap ${a} <-> ${b}`).error };
  }
  const slots = state.slots.map((slot) => {
    if (slot.id === a) return { ...slot, tabId: sb.tabId };
    if (slot.id === b) return { ...slot, tabId: sa.tabId };
    return slot;
  });
  return { ...state, slots };
}

export function bindTab(state, id, tabId) {
  if (!findSlot(state, id)) {
    return { ...state, error: fail("no_such_slot", `unknown slot ${id}`).error };
  }
  return { ...state, slots: state.slots.map((s) => (s.id === id ? { ...s, tabId } : s)) };
}

export function setActive(state, id) {
  if (!findSlot(state, id)) {
    return { ...state, error: fail("no_such_slot", `unknown slot ${id}`).error };
  }
  return { ...state, activeId: id };
}

// Organisation view for equality checks: `(slot_id, tab_id)` in order.
export function organisationView(state) {
  return state.slots.map((slot) => [slot.id, slot.tabId]);
}

// Serialize to the string embedded as the session snapshot's `layout` key
// (core `SplitLayout` shape: version/slots/active plus per-slot ratio).
export function serializeSplit(state) {
  return JSON.stringify({
    version: LAYOUT_VERSION,
    slots: state.slots.map((slot, i) => ({
      slot_id: slot.id,
      astra_tab_id: slot.tabId,
      ratio: slot.ratio,
      position: i,
    })),
    active_slot_id: state.activeId,
  });
}

// Parse + version-check + validate. Corrupt input resets to a single pane
// (with the reason) instead of throwing — a bad row must never break startup.
export function restoreSplit(json) {
  let parsed;
  try {
    parsed = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return { state: blankSplit(), error: fail("bad_json", "layout JSON unparseable").error };
  }
  const invalid = (message) => ({ state: blankSplit(), error: fail("invalid", message).error });
  if (!parsed || parsed.version !== LAYOUT_VERSION) {
    return invalid(`unsupported layout version ${parsed?.version} (expected ${LAYOUT_VERSION})`);
  }
  if (!Array.isArray(parsed.slots) || parsed.slots.length < 1 || parsed.slots.length > MAX_SLOTS) {
    return invalid(`slot count must be 1..=${MAX_SLOTS}`);
  }
  const seen = new Set();
  let sum = 0;
  const slots = [];
  for (const [i, raw] of parsed.slots.entries()) {
    if (!raw || typeof raw.slot_id !== "string" || raw.slot_id === "") {
      return invalid("slot_id must not be empty");
    }
    if (seen.has(raw.slot_id)) return invalid(`duplicate slot ${raw.slot_id}`);
    seen.add(raw.slot_id);
    if (typeof raw.ratio !== "number" || !Number.isFinite(raw.ratio) || raw.ratio <= 0 || raw.ratio > 1) {
      return invalid(`slot ${raw.slot_id} ratio out of range`);
    }
    sum += raw.ratio;
    slots.push({
      id: raw.slot_id,
      tabId: typeof raw.astra_tab_id === "string" ? raw.astra_tab_id : null,
      ratio: raw.ratio,
      _position: Number.isInteger(raw.position) ? raw.position : i,
    });
  }
  if (Math.abs(sum - 1) > 1e-6) return invalid(`slot ratios must sum to 1.0 (got ${sum})`);
  slots.sort((a, b) => a._position - b._position);
  const activeId =
    typeof parsed.active_slot_id === "string" && seen.has(parsed.active_slot_id)
      ? parsed.active_slot_id
      : slots[0].id;
  return {
    state: {
      version: LAYOUT_VERSION,
      slots: slots.map(({ id, tabId, ratio }) => ({ id, tabId, ratio })),
      activeId,
    },
  };
}

// Layout survives restarts next to the tab-strip folders: a corrupt entry
// resets to a single pane. The session snapshot remains the canonical store
// (this is the chrome-side working copy, same seam as `tab-strip-model.js`).
export function saveLayout(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, serializeSplit(state));
  } catch {
    // A full or blocked store never breaks the split view.
  }
}

export function loadLayout(storage) {
  try {
    if (!storage) return blankSplit();
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return blankSplit();
    return restoreSplit(raw).state;
  } catch {
    return blankSplit();
  }
}

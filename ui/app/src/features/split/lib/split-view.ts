/**
 * P3-T06 split-view state for the app layer. Pure TypeScript (no Svelte
 * runes, no DOM): the `SplitView` component renders this state and the
 * unit project covers every operation. Field names match the core
 * `SplitLayout` JSON (`slot_id`, `astra_tab_id`, `ratio`, `position`,
 * `active_slot_id`) so `serializeSplitState` output drops straight into the
 * session snapshot's `layout` key.
 */

export const MAX_SPLIT_SLOTS = 3;
export const MIN_SPLIT_RATIO = 0.05;
export const MAX_SPLIT_RATIO = 0.95;
export const SPLIT_LAYOUT_VERSION = 1;

export type SplitVariant = "single" | "cols-2" | "grid-2x2";

export interface SplitSlot {
  id: string;
  tabId: string | null;
  ratio: number;
}

export interface SplitState {
  version: number;
  slots: SplitSlot[];
  activeId: string;
}

export class SplitLayoutError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SplitLayoutError";
    this.code = code;
  }
}

/** Visible-count -> grid variant (mirrors S-01 `layoutFor`). */
export function layoutVariant(visibleCount: number): SplitVariant {
  if (visibleCount <= 1) return "single";
  if (visibleCount === 2) return "cols-2";
  return "grid-2x2";
}

export function blankSplitState(): SplitState {
  return {
    version: SPLIT_LAYOUT_VERSION,
    slots: [{ id: "slot-1", tabId: null, ratio: 1 }],
    activeId: "slot-1",
  };
}

function findSlot(state: SplitState, id: string): SplitSlot {
  const slot = state.slots.find((entry) => entry.id === id);
  if (!slot) throw new SplitLayoutError("no_such_slot", `unknown slot ${id}`);
  return slot;
}

/**
 * Split the focused pane to show `tabId` (at most MAX_SPLIT_SLOTS). The new
 * slot becomes active; shares re-equalise so the axis still sums to 1.
 */
export function openSplitPane(state: SplitState, tabId: string | null = null): SplitState {
  if (state.slots.length >= MAX_SPLIT_SLOTS) {
    throw new SplitLayoutError("too_many_slots", `at most ${MAX_SPLIT_SLOTS} split slots`);
  }
  const share = 1 / (state.slots.length + 1);
  const slots = [...state.slots.map((slot) => ({ ...slot, ratio: share }))];
  const id = `slot-${slots.length + 1}`;
  slots.push({ id, tabId, ratio: share });
  return { version: SPLIT_LAYOUT_VERSION, slots, activeId: id };
}

/**
 * Close a slot. Closing the final slot resets to a single empty pane (S-01
 * never drops below one visible cell); otherwise the share redistributes
 * equally and focus falls back to slot-1.
 */
export function closeSplitPane(state: SplitState, id: string): SplitState {
  findSlot(state, id);
  const kept = state.slots.filter((slot) => slot.id !== id);
  if (kept.length === 0) return blankSplitState();
  const share = 1 / kept.length;
  return {
    version: SPLIT_LAYOUT_VERSION,
    slots: kept.map((slot) => ({ ...slot, ratio: share })),
    activeId: state.activeId === id ? "slot-1" : state.activeId,
  };
}

/**
 * Resize a slot to `ratio` of the split axis. Clamped into the
 * MIN/MAX_SPLIT_RATIO band; siblings scale proportionally so the axis sums
 * to 1. A lone slot is always full-width.
 */
export function resizeSplitPane(state: SplitState, id: string, ratio: number): SplitState {
  const current = findSlot(state, id);
  if (!Number.isFinite(ratio)) {
    throw new SplitLayoutError("bad_ratio", `slot ${id} ratio must be finite`);
  }
  if (state.slots.length === 1) {
    return { ...state, slots: [{ ...current, ratio: 1 }] };
  }
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  const rest = 1 - clamped;
  const siblings = state.slots.filter((slot) => slot.id !== id);
  const oldRest = siblings.reduce((sum, slot) => sum + slot.ratio, 0);
  return {
    ...state,
    slots: state.slots.map((slot) => {
      if (slot.id === id) return { ...slot, ratio: clamped };
      if (oldRest > 0) return { ...slot, ratio: (slot.ratio / oldRest) * rest };
      return { ...slot, ratio: rest / siblings.length };
    }),
  };
}

/**
 * Exchange which tabs two slots show. Cell identity is stable (the S-01
 * no-reparenting rule) — only the bindings move.
 */
export function swapSplitPanes(state: SplitState, a: string, b: string): SplitState {
  if (a === b) return { ...state, slots: state.slots.map((slot) => ({ ...slot })) };
  const first = findSlot(state, a);
  const second = findSlot(state, b);
  return {
    ...state,
    slots: state.slots.map((slot) => {
      if (slot.id === a) return { ...slot, tabId: second.tabId };
      if (slot.id === b) return { ...slot, tabId: first.tabId };
      return { ...slot };
    }),
  };
}

export function bindSplitTab(state: SplitState, id: string, tabId: string | null): SplitState {
  findSlot(state, id);
  return {
    ...state,
    slots: state.slots.map((slot) => (slot.id === id ? { ...slot, tabId } : { ...slot })),
  };
}

export function activateSplitPane(state: SplitState, id: string): SplitState {
  findSlot(state, id);
  return { ...state, activeId: id };
}

/** Organisation view for equality checks: `(slot_id, tab_id)` in order. */
export function splitOrganisation(state: SplitState): Array<[string, string | null]> {
  return state.slots.map((slot) => [slot.id, slot.tabId]);
}

/** Serialize to the string embedded as the session snapshot's `layout` key. */
export function serializeSplitState(state: SplitState): string {
  return JSON.stringify({
    version: SPLIT_LAYOUT_VERSION,
    slots: state.slots.map((slot, index) => ({
      slot_id: slot.id,
      astra_tab_id: slot.tabId,
      ratio: slot.ratio,
      position: index,
    })),
    active_slot_id: state.activeId,
  });
}

export interface RestoredSplit {
  state: SplitState;
  error?: { code: string; message: string };
}

/**
 * Parse + version-check + validate. Corrupt input resets to a single pane
 * (with the reason) instead of throwing — a bad row must never break startup.
 */
export function restoreSplitState(json: string): RestoredSplit {
  const invalid = (message: string): RestoredSplit => ({
    state: blankSplitState(),
    error: { code: "invalid", message },
  });
  let parsed: {
    version?: unknown;
    slots?: unknown;
    active_slot_id?: unknown;
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      state: blankSplitState(),
      error: { code: "bad_json", message: "layout JSON unparseable" },
    };
  }
  if (!parsed || parsed.version !== SPLIT_LAYOUT_VERSION) {
    return invalid(
      `unsupported layout version ${String(parsed?.version)} (expected ${SPLIT_LAYOUT_VERSION})`,
    );
  }
  const raw = parsed.slots;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SPLIT_SLOTS) {
    return invalid(`slot count must be 1..=${MAX_SPLIT_SLOTS}`);
  }
  const seen = new Set<string>();
  let sum = 0;
  const slots: Array<SplitSlot & { position: number }> = [];
  for (const [index, entry] of raw.entries()) {
    const record = entry as {
      slot_id?: unknown;
      astra_tab_id?: unknown;
      ratio?: unknown;
      position?: unknown;
    };
    if (!record || typeof record.slot_id !== "string" || record.slot_id === "") {
      return invalid("slot_id must not be empty");
    }
    if (seen.has(record.slot_id)) return invalid(`duplicate slot ${record.slot_id}`);
    seen.add(record.slot_id);
    if (
      typeof record.ratio !== "number" ||
      !Number.isFinite(record.ratio) ||
      record.ratio <= 0 ||
      record.ratio > 1
    ) {
      return invalid(`slot ${record.slot_id} ratio out of range`);
    }
    sum += record.ratio;
    slots.push({
      id: record.slot_id,
      tabId: typeof record.astra_tab_id === "string" ? record.astra_tab_id : null,
      ratio: record.ratio,
      position: Number.isInteger(record.position) ? (record.position as number) : index,
    });
  }
  if (Math.abs(sum - 1) > 1e-6) return invalid(`slot ratios must sum to 1.0 (got ${sum})`);
  slots.sort((a, b) => a.position - b.position);
  const activeId =
    typeof parsed.active_slot_id === "string" && seen.has(parsed.active_slot_id)
      ? parsed.active_slot_id
      : slots[0]!.id;
  return {
    state: {
      version: SPLIT_LAYOUT_VERSION,
      slots: slots.map(({ id, tabId, ratio }) => ({ id, tabId, ratio })),
      activeId,
    },
  };
}

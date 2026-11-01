/**
 * P3-T06 app split-view state tests: create/resize/swap/close plus
 * persist/restore round-trip. Pure logic, runs in the unit project.
 */
import { describe, expect, it } from "vitest";
import {
  activateSplitPane,
  bindSplitTab,
  blankSplitState,
  closeSplitPane,
  layoutVariant,
  MAX_SPLIT_SLOTS,
  openSplitPane,
  resizeSplitPane,
  restoreSplitState,
  serializeSplitState,
  splitOrganisation,
  SplitLayoutError,
  swapSplitPanes,
} from "../lib/split-view";

function edited() {
  let state = bindSplitTab(blankSplitState(), "slot-1", "tab-a");
  state = openSplitPane(state, "tab-b");
  state = resizeSplitPane(state, "slot-2", 0.35);
  state = swapSplitPanes(state, "slot-1", "slot-2");
  return state;
}

describe("layoutVariant", () => {
  it("maps counts to grid variants like S-01", () => {
    expect(layoutVariant(0)).toBe("single");
    expect(layoutVariant(1)).toBe("single");
    expect(layoutVariant(2)).toBe("cols-2");
    expect(layoutVariant(3)).toBe("grid-2x2");
    expect(layoutVariant(4)).toBe("grid-2x2");
  });
});

describe("openSplitPane", () => {
  it("grows 1 -> 2 -> 4 and caps the pool", () => {
    let state = blankSplitState();
    state = openSplitPane(state, "tab-a");
    expect(state.slots).toHaveLength(2);
    expect(state.activeId).toBe("slot-2");
    state = openSplitPane(state, "tab-b");
    state = openSplitPane(state, "tab-c");
    expect(state.slots).toHaveLength(MAX_SPLIT_SLOTS);
    expect(layoutVariant(state.slots.length)).toBe("grid-2x2");
    expect(() => openSplitPane(state, "tab-d")).toThrow(SplitLayoutError);
  });

  it("re-equalises ratios so the axis sums to 1", () => {
    const state = openSplitPane(blankSplitState(), "tab-a");
    const sum = state.slots.reduce((total, slot) => total + slot.ratio, 0);
    expect(sum).toBeCloseTo(1, 9);
  });
});

describe("resizeSplitPane", () => {
  it("sets the share and scales siblings proportionally", () => {
    let state = openSplitPane(blankSplitState(), "tab-a");
    state = resizeSplitPane(state, "slot-1", 0.7);
    expect(state.slots[0]!.ratio).toBeCloseTo(0.7, 9);
    expect(state.slots.reduce((total, slot) => total + slot.ratio, 0)).toBeCloseTo(1, 9);
  });

  it("clamps into the band and rejects unknown slots and NaN", () => {
    let state = openSplitPane(blankSplitState(), "tab-a");
    state = resizeSplitPane(state, "slot-1", 99);
    expect(state.slots[0]!.ratio).toBeLessThanOrEqual(0.95);
    state = resizeSplitPane(state, "slot-2", -3);
    expect(state.slots[1]!.ratio).toBeGreaterThanOrEqual(0.05);
    expect(() => resizeSplitPane(state, "slot-9", 0.5)).toThrow(SplitLayoutError);
    expect(() => resizeSplitPane(state, "slot-1", Number.NaN)).toThrow(SplitLayoutError);
  });

  it("keeps a lone slot full-width", () => {
    expect(resizeSplitPane(blankSplitState(), "slot-1", 0.3).slots[0]!.ratio).toBe(1);
  });
});

describe("swapSplitPanes", () => {
  it("exchanges bindings, never cell identity", () => {
    let state = bindSplitTab(blankSplitState(), "slot-1", "tab-a");
    state = openSplitPane(state, "tab-b");
    state = swapSplitPanes(state, "slot-1", "slot-2");
    expect(state.slots[0]!.tabId).toBe("tab-b");
    expect(state.slots[1]!.tabId).toBe("tab-a");
    expect(state.slots[0]!.id).toBe("slot-1");
    expect(splitOrganisation(state)).toEqual([
      ["slot-1", "tab-b"],
      ["slot-2", "tab-a"],
    ]);
  });

  it("treats self-swap as a no-op and rejects unknown ids", () => {
    const state = openSplitPane(blankSplitState(), "tab-a");
    expect(swapSplitPanes(state, "slot-1", "slot-1").slots).toEqual(state.slots);
    expect(() => swapSplitPanes(state, "slot-1", "slot-9")).toThrow(SplitLayoutError);
  });
});

describe("closeSplitPane", () => {
  it("redistributes the share and moves focus off the closed slot", () => {
    let state = openSplitPane(blankSplitState(), "tab-a");
    state = openSplitPane(state, "tab-b");
    state = activateSplitPane(state, "slot-3");
    state = closeSplitPane(state, "slot-3");
    expect(state.slots).toHaveLength(2);
    expect(state.activeId).toBe("slot-1");
    expect(state.slots.reduce((total, slot) => total + slot.ratio, 0)).toBeCloseTo(1, 9);
    expect(() => closeSplitPane(state, "slot-9")).toThrow(SplitLayoutError);
  });

  it("resets to a single empty pane instead of dropping below one cell", () => {
    let state = openSplitPane(blankSplitState(), "tab-a");
    state = closeSplitPane(state, "slot-1");
    state = closeSplitPane(state, "slot-2");
    expect(state).toEqual(blankSplitState());
  });
});

describe("persist and restore round-trip", () => {
  it("serializes to the core SplitLayout shape and restores identically", () => {
    const state = edited();
    const wire = JSON.parse(serializeSplitState(state)) as {
      version: number;
      slots: Array<{ slot_id: string }>;
    };
    expect(wire.version).toBe(1);
    expect(wire.slots.map((slot) => slot.slot_id)).toEqual(["slot-1", "slot-2"]);
    const { state: restored, error } = restoreSplitState(serializeSplitState(state));
    expect(error).toBeUndefined();
    expect(restored).toEqual({
      version: 1,
      slots: [
        { id: "slot-1", tabId: "tab-b", ratio: 0.65 },
        { id: "slot-2", tabId: "tab-a", ratio: 0.35 },
      ],
      activeId: "slot-2",
    });
    expect(splitOrganisation(restored)).toEqual(splitOrganisation(state));
  });

  it("resets corrupt rows to a single pane instead of throwing", () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ version: 999, slots: [], active_slot_id: null }),
      JSON.stringify({ version: 1, slots: [], active_slot_id: null }),
      JSON.stringify({
        version: 1,
        slots: [{ slot_id: "slot-1", ratio: 0.5 }],
        active_slot_id: "slot-1",
      }),
      JSON.stringify({
        version: 1,
        slots: [
          { slot_id: "slot-1", ratio: 0.5 },
          { slot_id: "slot-1", ratio: 0.5 },
        ],
        active_slot_id: "slot-1",
      }),
    ]) {
      const { state, error } = restoreSplitState(bad);
      expect(state).toEqual(blankSplitState());
      expect(error).toBeDefined();
    }
  });
});

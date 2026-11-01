// P3-T06 shell split-view model tests. Pure logic, no DOM: run with
// `node --test` (or `bun test`) from the workspace root.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bindTab,
  blankSplit,
  closeSlot,
  layoutFor,
  loadLayout,
  MAX_SLOTS,
  openSplit,
  organisationView,
  resizeSlot,
  restoreSplit,
  saveLayout,
  serializeSplit,
  setActive,
  swapSlots,
} from "./split-model.js";

function memoryStore(value = null) {
  let held = value;
  return {
    getItem: () => held,
    setItem: (_key, next) => {
      held = String(next);
    },
  };
}

describe("layoutFor", () => {
  it("maps counts to grid variants like S-01", () => {
    assert.equal(layoutFor(0), "single");
    assert.equal(layoutFor(1), "single");
    assert.equal(layoutFor(2), "cols-2");
    assert.equal(layoutFor(3), "grid-2x2");
    assert.equal(layoutFor(4), "grid-2x2");
  });
});

describe("openSplit", () => {
  it("grows 1 -> 2 -> 4 and caps the pool", () => {
    let state = blankSplit();
    assert.equal(state.slots.length, 1);
    state = openSplit(state, "tab-a");
    assert.equal(state.slots.length, 2);
    assert.equal(state.activeId, "slot-2");
    state = openSplit(state, "tab-b");
    state = openSplit(state, "tab-c");
    assert.equal(state.slots.length, MAX_SLOTS);
    assert.equal(layoutFor(state.slots.length), "grid-2x2");
    const capped = openSplit(state, "tab-d");
    assert.ok(capped.error);
    assert.equal(capped.slots.length, MAX_SLOTS);
  });

  it("re-equalises ratios so the axis sums to 1", () => {
    let state = openSplit(blankSplit(), "tab-a");
    const sum = state.slots.reduce((total, slot) => total + slot.ratio, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });
});

describe("resizeSlot", () => {
  it("sets the share and scales siblings proportionally", () => {
    let state = openSplit(blankSplit(), "tab-a");
    state = resizeSlot(state, "slot-1", 0.7);
    assert.ok(Math.abs(state.slots[0].ratio - 0.7) < 1e-9);
    const sum = state.slots.reduce((total, slot) => total + slot.ratio, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it("clamps into the band and rejects unknown slots and NaN", () => {
    let state = openSplit(blankSplit(), "tab-a");
    state = resizeSlot(state, "slot-1", 99);
    assert.ok(state.slots[0].ratio <= 0.95);
    state = resizeSlot(state, "slot-2", -3);
    assert.ok(state.slots[1].ratio >= 0.05);
    assert.ok(resizeSlot(state, "slot-9", 0.5).error);
    assert.ok(resizeSlot(state, "slot-1", Number.NaN).error);
  });

  it("keeps a lone slot full-width", () => {
    const state = resizeSlot(blankSplit(), "slot-1", 0.3);
    assert.equal(state.slots[0].ratio, 1);
  });
});

describe("swapSlots", () => {
  it("exchanges bindings, never cell identity", () => {
    let state = bindTab(blankSplit(), "slot-1", "tab-a");
    state = openSplit(state, "tab-b");
    state = swapSlots(state, "slot-1", "slot-2");
    assert.equal(state.slots[0].tabId, "tab-b");
    assert.equal(state.slots[1].tabId, "tab-a");
    assert.equal(state.slots[0].id, "slot-1");
    assert.deepEqual(organisationView(state), [
      ["slot-1", "tab-b"],
      ["slot-2", "tab-a"],
    ]);
  });

  it("treats self-swap as a no-op and rejects unknown ids", () => {
    const state = openSplit(blankSplit(), "tab-a");
    assert.deepEqual(swapSlots(state, "slot-1", "slot-1").slots, state.slots);
    assert.ok(swapSlots(state, "slot-1", "slot-9").error);
  });
});

describe("closeSlot", () => {
  it("redistributes the share and moves focus off the closed slot", () => {
    let state = openSplit(blankSplit(), "tab-a");
    state = openSplit(state, "tab-b");
    state = setActive(state, "slot-3");
    state = closeSlot(state, "slot-3");
    assert.equal(state.slots.length, 2);
    assert.equal(state.activeId, "slot-1");
    const sum = state.slots.reduce((total, slot) => total + slot.ratio, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(closeSlot(state, "slot-9").error);
  });

  it("resets to a single empty pane instead of dropping below one cell", () => {
    let state = openSplit(blankSplit(), "tab-a");
    state = closeSlot(state, "slot-1");
    state = closeSlot(state, "slot-2");
    assert.deepEqual(state, blankSplit());
  });
});

describe("setActive and bindTab", () => {
  it("rejects unknown slots", () => {
    assert.ok(setActive(blankSplit(), "slot-9").error);
    assert.ok(bindTab(blankSplit(), "slot-9", "tab-a").error);
    let state = setActive(blankSplit(), "slot-1");
    assert.equal(state.activeId, "slot-1");
    state = bindTab(state, "slot-1", "tab-a");
    assert.equal(state.slots[0].tabId, "tab-a");
  });
});

describe("persist + restore round-trip", () => {
  function edited() {
    let state = bindTab(blankSplit(), "slot-1", "tab-a");
    state = openSplit(state, "tab-b");
    state = resizeSlot(state, "slot-2", 0.35);
    state = swapSlots(state, "slot-1", "slot-2");
    return state;
  }

  it("serializes to the core SplitLayout shape and restores identically", () => {
    const state = edited();
    const json = serializeSplit(state);
    const wire = JSON.parse(json);
    assert.equal(wire.version, 1);
    assert.deepEqual(
      wire.slots.map((slot) => slot.slot_id),
      ["slot-1", "slot-2"],
    );
    const { state: restored, error } = restoreSplit(json);
    assert.equal(error, undefined);
    assert.deepEqual(restored, {
      version: 1,
      slots: [
        { id: "slot-1", tabId: "tab-b", ratio: 0.65 },
        { id: "slot-2", tabId: "tab-a", ratio: 0.35 },
      ],
      activeId: "slot-2",
    });
    assert.deepEqual(organisationView(restored), organisationView(state));
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
      const { state, error } = restoreSplit(bad);
      assert.deepEqual(state, blankSplit());
      assert.ok(error);
    }
  });

  it("survives the storage seam (kill -> restart)", () => {
    const store = memoryStore();
    saveLayout(store, edited());
    const revived = loadLayout(store);
    assert.deepEqual(organisationView(revived), [
      ["slot-1", "tab-b"],
      ["slot-2", "tab-a"],
    ]);
    assert.equal(loadLayout(memoryStore("garbage")).slots.length, 1);
    assert.deepEqual(loadLayout(null), blankSplit());
  });
});

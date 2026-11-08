// P3-T06 shell split-view renderer tests. A minimal fake DOM proves the
// wiring (fixed cell pool, layout switches, focus/select, swap, close,
// persist) with `node --test` — no browser needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mountSplit } from "./split.js";

function fakeElement(tag) {
  const listeners = new Map();
  const element = {
    tag,
    children: [],
    attributes: {},
    style: {},
    hidden: false,
    textContent: "",
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(key, value) {
      element.attributes[key] = String(value);
    },
    getAttribute(key) {
      return element.attributes[key] ?? null;
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      element.children = element.children.filter((entry) => entry !== child);
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== fn));
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn({ ...event, target: element });
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, left: 0, width: 200, height: 200 };
    },
  };
  return element;
}

function fakeDoc() {
  return { createElementNS: (_ns, tag) => fakeElement(tag) };
}

function mount(options = {}) {
  const doc = fakeDoc();
  const container = fakeElement("div");
  container.ownerDocument = doc;
  const selected = [];
  const host = {
    Tabs: {
      select: async (args) => {
        selected.push(args);
        return { ...args, ok: true };
      },
    },
  };
  const changes = [];
  const api = mountSplit(container, host, {
    tabs: [
      { id: "tab-a", title: "Alpha", url: "https://a.example/" },
      { id: "tab-b", title: "Beta", url: "https://b.example/" },
    ],
    onChange: (state) => changes.push(state),
    ...options,
  });
  const root = container.children[0];
  return { api, root, selected, changes };
}

function visibleCells(root) {
  return root.children.filter((cell) => cell.hidden !== true);
}

function contentOf(root, slotId) {
  const cell = root.children.find((entry) => entry.getAttribute("data-slot-id") === slotId);
  return cell.children.find((entry) => (entry.getAttribute("class") ?? "").includes("content"));
}

describe("mountSplit", () => {
  it("creates a fixed pool of three cells with one visible", () => {
    const { root } = mount();
    assert.equal(root.getAttribute("data-layout"), "single");
    assert.equal(root.children.length, 3);
    assert.equal(visibleCells(root).length, 1);
    // Cell identity is stable: the same four nodes back every cell.
    assert.deepEqual(
      root.children.map((cell) => cell.getAttribute("data-slot-id")),
      ["slot-1", "slot-2", "slot-3"],
    );
  });

  it("splits 1 -> 2 -> 3 with layout switches and stable nodes", () => {
    const { api, root } = mount();
    const before = [...root.children];
    api.split("tab-a");
    assert.equal(root.getAttribute("data-layout"), "cols-2");
    assert.equal(visibleCells(root).length, 2);
    api.split("tab-b");
    assert.equal(root.getAttribute("data-layout"), "grid-2x2");
    assert.equal(visibleCells(root).length, 3);
    assert.deepEqual(root.children, before);
    assert.ok(api.split("tab-b").error);
  });

  it("binds tabs, focuses through the host, and swaps bindings", async () => {
    const { api, root, selected } = mount();
    api.split("tab-b");
    api.bind("slot-1", "tab-a");
    api.bind("slot-2", "tab-b");
    await api.focus("slot-2");
    assert.equal(selected.length, 1);
    assert.equal(selected[0].astra_tab_id, "tab-b");
    api.swap("slot-1", "slot-2");
    assert.equal(contentOf(root, "slot-1").getAttribute("data-tab-id"), "tab-b");
    assert.equal(contentOf(root, "slot-2").getAttribute("data-tab-id"), "tab-a");
  });

  it("resizes within the band and closes back down", () => {
    const { api, root } = mount();
    api.split("tab-b");
    const { ratio } = api.resize("slot-1", 0.7);
    assert.ok(Math.abs(ratio - 0.7) < 1e-9);
    assert.ok(api.resize("slot-1", 99).ratio <= 0.95);
    api.close("slot-2");
    assert.equal(root.getAttribute("data-layout"), "single");
    assert.equal(visibleCells(root).length, 1);
  });

  it("persists across mounts via the storage seam", () => {
    let held = null;
    const storage = {
      getItem: () => held,
      setItem: (_key, next) => {
        held = String(next);
      },
    };
    const first = mount({ storage });
    first.api.split("tab-b");
    first.api.resize("slot-2", 0.35);
    const second = mount({ storage });
    assert.equal(second.api.getState().slots.length, 2);
    const revived = second.api.getState().slots.find((slot) => slot.id === "slot-2");
    assert.ok(Math.abs(revived.ratio - 0.35) < 1e-9);
  });

  it("notifies listeners and destroys cleanly", () => {
    const { api, root, changes } = mount();
    api.split("tab-a");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].slots.length, 2);
    api.destroy();
    assert.equal(root.children.length, 3);
  });
});

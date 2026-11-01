// P3-T04 shell tab-strip model tests. Pure logic + a fake Host: no DOM, no
// browser. Run with `node --test` (or `bun test`) from the workspace root.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignToFolder,
  blankFolders,
  createFolder,
  deleteFolder,
  fallbackLetter,
  globalDropIndex,
  groupRows,
  isCollapsed,
  loadFolderState,
  menuItems,
  normalizeHostTab,
  renameFolder,
  saveFolderState,
  splitSections,
  toggleFolder,
} from "./tab-strip-model.js";

function snap(overrides = {}) {
  return {
    astra_tab_id: "tab-1",
    title: "Example",
    url: "https://example.com/",
    pinned: false,
    discarded: false,
    muted: false,
    selected: false,
    index: 0,
    ...overrides,
  };
}

function memoryStore(value) {
  let held = value === undefined ? null : value;
  return {
    getItem: () => held,
    setItem: (_key, next) => {
      held = String(next);
    },
  };
}

describe("normalizeHostTab", () => {
  it("reads the Host snapshot shape", () => {
    const tab = normalizeHostTab(
      snap({ astra_tab_id: "a", pinned: true, discarded: true, muted: true, selected: true }),
    );
    assert.deepEqual(tab, {
      id: "a",
      title: "Example",
      url: "https://example.com/",
      pinned: true,
      sleeping: true,
      muted: true,
      selected: true,
      favIconUrl: null,
      index: 0,
    });
  });

  it("rejects payloads without an id and tolerates missing fields", () => {
    assert.equal(normalizeHostTab(null), null);
    assert.equal(normalizeHostTab({}), null);
    assert.equal(normalizeHostTab(snap({ title: undefined, url: undefined })).title, "");
  });

  it("falls back to a letter tile", () => {
    assert.equal(fallbackLetter({ title: "  hello", url: null }), "H");
    assert.equal(fallbackLetter({ title: "", url: "https://x.example/" }), "H");
    assert.equal(fallbackLetter({ title: "", url: null }), "•");
  });
});

describe("sections", () => {
  it("leads with pinned tabs", () => {
    const tabs = [
      normalizeHostTab(snap({ astra_tab_id: "a" })),
      normalizeHostTab(snap({ astra_tab_id: "b", pinned: true })),
      normalizeHostTab(snap({ astra_tab_id: "c" })),
    ];
    const { pinned, open } = splitSections(tabs);
    assert.deepEqual(pinned.map((tab) => tab.id), ["b"]);
    assert.deepEqual(open.map((tab) => tab.id), ["a", "c"]);
  });
});

describe("folders", () => {
  it("round-trips through storage and resets on corrupt data", () => {
    const storage = memoryStore();
    let state = blankFolders();
    let seq = 0;
    state = createFolder(state, "Work", () => `f-${++seq}`);
    state = assignToFolder(state, "tab-1", "f-1");
    state = toggleFolder(state, "f-1");
    saveFolderState(storage, state);
    const loaded = loadFolderState(storage);
    assert.deepEqual(loaded, state);
    assert.equal(isCollapsed(loaded, "f-1"), true);

    assert.deepEqual(loadFolderState(memoryStore("not json")), blankFolders());
    assert.deepEqual(loadFolderState(memoryStore('{"folders":"nope"}')), blankFolders());
    assert.deepEqual(loadFolderState(null), blankFolders());
  });

  it("renames, spills on delete, and guards unknown folders", () => {
    let seq = 0;
    let state = createFolder(blankFolders(), "W", () => `f-${++seq}`);
    state = renameFolder(state, "f-1", "Play");
    assert.equal(state.folders[0].name, "Play");
    state = assignToFolder(state, "a", "f-1");
    state = assignToFolder(state, "b", "missing");
    assert.deepEqual(state.assignment, { a: "f-1" });
    state = deleteFolder(state, "f-1");
    assert.deepEqual(state, blankFolders());
  });

  it("groups open tabs, hides folded children, keeps the active one visible", () => {
    let seq = 0;
    let state = createFolder(blankFolders(), "F", () => `f-${++seq}`);
    state = assignToFolder(state, "a", "f-1");
    state = assignToFolder(state, "b", "f-1");
    const tabs = ["a", "b", "c"].map((id) => normalizeHostTab(snap({ astra_tab_id: id })));
    let rows = groupRows(tabs, state, null);
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["folder", "tab"],
    );
    assert.deepEqual(rows[0].children.map((tab) => tab.id), ["a", "b"]);

    state = toggleFolder(state, "f-1");
    rows = groupRows(tabs, state, null);
    assert.equal(rows[0].expanded, false);
    rows = groupRows(tabs, state, "b");
    assert.equal(rows[0].expanded, true);
  });

  it("never puts pinned tabs in folders", () => {
    let seq = 0;
    let state = createFolder(blankFolders(), "F", () => `f-${++seq}`);
    state = assignToFolder(state, "p", "f-1");
    const tabs = [
      normalizeHostTab(snap({ astra_tab_id: "p", pinned: true })),
      normalizeHostTab(snap({ astra_tab_id: "a" })),
    ];
    const { pinned, open } = splitSections(tabs);
    assert.deepEqual(pinned.map((tab) => tab.id), ["p"]);
    const rows = groupRows(open, state, null);
    assert.deepEqual(rows.map((row) => row.kind), ["folder", "tab"]);
    assert.deepEqual(rows[0].children, []);
    assert.deepEqual(rows[1].tab.id, "a");
  });
});

describe("globalDropIndex", () => {
  const sections = {
    pinned: [{ id: "p" }],
    open: [{ id: "a" }, { id: "b" }, { id: "c" }],
  };

  it("lands before its target and at the end on null", () => {
    assert.equal(globalDropIndex(sections, "a", "c"), 2);
    assert.equal(globalDropIndex(sections, "c", "a"), 1);
    assert.equal(globalDropIndex(sections, "a", null), 3);
  });

  it("leaves a drop where it started alone", () => {
    assert.equal(globalDropIndex(sections, "b", "b"), 2);
  });

  it("reorders pinned runs apart from open runs", () => {
    const two = { pinned: [{ id: "p1" }, { id: "p2" }], open: [{ id: "a" }] };
    assert.equal(globalDropIndex(two, "p2", "p1"), 0);
    assert.equal(globalDropIndex(two, "p1", null), 1);
  });

  it("clamps an unknown target to the run end", () => {
    assert.equal(globalDropIndex(sections, "a", "missing"), 3);
  });
});

describe("menuItems", () => {
  it("offers pin/mute/sleep toggles matching the tab", () => {
    const labels = (tab) => Object.fromEntries(menuItems(tab).map((item) => [item.id, item.label]));
    assert.equal(labels(normalizeHostTab(snap())).pin, "Pin tab");
    assert.equal(labels(normalizeHostTab(snap({ pinned: true }))).unpin, "Unpin tab");
    assert.equal(labels(normalizeHostTab(snap({ muted: true }))).unmute, "Unmute tab");
    assert.equal(labels(normalizeHostTab(snap({ discarded: true }))).wakeup, "Wake up tab");
    assert.equal(labels(normalizeHostTab(snap({ url: null })))["copy-link"], "Copy link");
    assert.equal(menuItems(normalizeHostTab(snap({ url: null })))[6].disabled, true);
    assert.equal(menuItems(normalizeHostTab(snap({ selected: true })))[0].disabled, true);
  });
});

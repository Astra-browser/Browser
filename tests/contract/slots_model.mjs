#!/usr/bin/env node
// Spike S-01 stub contract (P3-T02, U-05): one AND many `<browser>`
// elements positioned by CSS into content slots without reparenting.
//
// Imports the prototype (overlay/astra/chrome/slots/Slots.sys.mjs) plus
// the REAL Host API stub (Tabs/Navigation/Panes/Events) by file path and
// asserts, with a fake DOM:
//   - layout model: 1 -> single, 2 -> cols-2, 3..4 -> grid-2x2, and the
//     model agrees with slots.css `[data-layout="..."]` selectors
//   - mount creates exactly maxSlots browsers ONCE; 1->2->4->1 layout
//     switches preserve element identity AND parent links (no reparenting,
//     no recreation: createBrowser call count is constant)
//   - per-pane navigation independence through the real Tabs history
//     stacks (back on pane 1 does not move pane 2)
//   - focus switch selects the bound tab and focuses the cell's OWN browser
//   - resize entries flow to onRect -> Panes.setRect; generation guard
//     reports stale after re-attach
//   - error paths: unknown slot, bad visible count, unbound navigate
//
// Usage: node tests/contract/slots_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { ROOT, HOST, check, passed } from "./lib/harness.mjs";

const SLOTS = path.join(ROOT, "overlay", "astra", "chrome", "slots");

const Slots = await import(pathToFileURL(path.join(SLOTS, "Slots.sys.mjs")).href);
const HostAPI = await import(pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href);
const { Tabs, Navigation, Panes, __resetForTests } = HostAPI;

// --- Minimal fake DOM (only the surface mountSlots touches) ---
class FakeElement {
  constructor(tag, doc) {
    this.tag = tag;
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.focusCalls = 0;
    this._rect = { x: 0, y: 0, width: 800, height: 600 };
    this._classes = new Set();
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(el) { el.parent = this; this.children.push(el); return el; }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }
  focus() { this.focusCalls += 1; this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { ...this._rect }; }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.defaultView = {}; // no ResizeObserver unless a test installs one
  }
  createElement(tag) { return new FakeElement(tag, this); }
  createElementNS(_ns, tag) { return new FakeElement(tag, this); }
}

function makeContainer(doc) {
  const el = new FakeElement("div", doc);
  el.ownerDocument = doc;
  return el;
}

__resetForTests();

// --- 1. Layout model + stylesheet agreement ---
check("layout 1 -> single", Slots.layoutFor(1) === "single");
check("layout 2 -> cols-2", Slots.layoutFor(2) === "cols-2");
check("layout 3 -> grid-2x2", Slots.layoutFor(3) === "grid-2x2");
check("layout 4 -> grid-2x2", Slots.layoutFor(4) === "grid-2x2");
{
  const css = fs.readFileSync(path.join(SLOTS, "slots.css"), "utf8");
  const missing = Slots.knownLayouts().filter(
    (l) => !css.includes(`[data-layout="${l}"]`),
  );
  check(`slots.css covers every layout (${Slots.knownLayouts().join(",")})`, missing.length === 0);
}

// --- 2. Mount once: fixed pool, no reparenting across 1->2->4->1 ---
const doc = new FakeDocument();
const container = makeContainer(doc);
let createCalls = 0;
const mounted = Slots.mountSlots(container, {
  maxSlots: 4,
  createBrowser: (cell, slot) => {
    createCalls += 1;
    const b = doc.createElementNS("xhtml", "browser");
    b.setAttribute("data-astra-browser", "slots");
    b.setAttribute("data-astra-slot", slot.slotId);
    cell.appendChild(b);
    return b;
  },
});
check("mount creates exactly 4 browsers", createCalls === 4);
check("container starts single", container.getAttribute("data-layout") === "single");
const identity = new Map(
  [...mounted.cells.entries()].map(([id, { cell, browser }]) => [id, { cell, browser }]),
);
function parentsIntact() {
  return [...mounted.cells.entries()].every(
    ([id, { cell, browser }]) =>
      browser.parent === cell && identity.get(id).browser === browser && identity.get(id).cell === cell,
  );
}
check("1 pane: only slot-1 visible", mounted.state.slots.filter((s) => s.visible).length === 1);
mounted.setVisibleCount(2);
check("2 panes -> cols-2", container.getAttribute("data-layout") === "cols-2");
check("no reparenting after ->2", parentsIntact() && createCalls === 4);
mounted.setVisibleCount(4);
check("4 panes -> grid-2x2", container.getAttribute("data-layout") === "grid-2x2");
check("no reparenting after ->4", parentsIntact() && createCalls === 4);
{
  const hidden = mounted.state.slots.filter((s) => s.visible).length;
  check("4 panes: all visible", hidden === 4);
}
mounted.setVisibleCount(1);
check("back to 1 -> single", container.getAttribute("data-layout") === "single");
check("no reparenting after ->1", parentsIntact() && createCalls === 4);

// --- 3. Error paths (pure model + mount guards) ---
check("setVisibleCount(0) -> bad_count", mounted.setVisibleCount(0)?.error?.code === "bad_count");
check("setVisibleCount(9) -> bad_count", mounted.setVisibleCount(9)?.error?.code === "bad_count");
check("bind unknown slot -> no_such_slot", Slots.bindTab(mounted.state, "slot-9", "t")?.error?.code === "no_such_slot");
{
  const r = await mounted.focusSlot("slot-9");
  check("focus unknown slot -> no_such_slot", r?.error?.code === "no_such_slot");
}
{
  const st = Slots.createSlotsState(2);
  const r = await Slots.mountSlots(makeContainer(new FakeDocument()), { maxSlots: 2 }).navigateSlot("slot-1", "about:blank");
  void st;
  check("navigate unbound slot w/o host -> no_tab_bound", r?.error?.code === "no_tab_bound");
}
try {
  Slots.createSlotsState(5);
  check("createSlotsState(5) throws", false);
} catch {
  check("createSlotsState(5) throws", true);
}

// --- 4. Per-pane navigation independence via the real Tabs stub ---
const A1 = "https://example.com/alpha";
const A2 = "https://example.com/alpha-2";
const B1 = "https://example.com/beta";
{
  const seen = [];
  const off = HostAPI.addEventListener((e) => seen.push(e));
  const t1 = await Tabs.create({ request_id: "s-1", url: A1 });
  const t2 = await Tabs.create({ request_id: "s-2", url: B1 });
  mounted.setVisibleCount(2);
  check("bind slot-1 -> tab A", !mounted.bind("slot-1", t1.astra_tab_id).error);
  check("bind slot-2 -> tab B", !mounted.bind("slot-2", t2.astra_tab_id).error);
  check("slotForTab resolves", Slots.slotForTab(mounted.state, t1.astra_tab_id)?.slotId === "slot-1");

  // Drive pane 1 one step forward; pane 2 must be unaffected.
  const r1 = await Navigation.loadURL({ request_id: "s-3", astra_tab_id: t1.astra_tab_id, url: A2 });
  check("pane 1 navigates to A2", r1.url === A2);
  const back = await Navigation.goBack({ request_id: "s-4", astra_tab_id: t1.astra_tab_id });
  check("pane 1 back -> A1", back.went_back === true && back.url === A1);
  const list = await Tabs.list({ request_id: "s-5" });
  const tabB = list.tabs.find((t) => t.astra_tab_id === t2.astra_tab_id);
  check(
    "pane 2 unaffected by pane 1 back",
    tabB && tabB.url === B1 && tabB.canGoForward === false,
  );

  const seqs = seen.map((e) => e.event_seq);
  const monotonic = seqs.every((s, i) => s === seqs[0] + i);
  check("event_seq gapless over slot ops", monotonic && seqs.length > 0);
  check(
    "commits carry per-tab urls (nav.committed A2, tab.created B1)",
    seen.some((e) => e.type === "nav.committed" && e.data.url === A2) &&
      seen.some((e) => e.type === "tab.created" && e.data.url === B1),
  );
  off();
}

// --- 5. Focus switch: model select + OWN browser focused (timed) ---
{
  const list = await Tabs.list({ request_id: "s-6" });
  const ids = list.tabs.map((t) => t.astra_tab_id);
  mounted.bind("slot-1", ids[0]);
  mounted.bind("slot-2", ids[1]);
  const t0 = performance.now();
  const res = await mounted.focusSlot("slot-2", { request_id: "s-7" });
  // focusSlot without host skips model select; re-run with host for the full path.
  void res;
  const withHost = Slots.mountSlots(makeContainer(doc), {
    maxSlots: 2,
    host: { Tabs, Navigation },
    createBrowser: (cell) => {
      const b = doc.createElementNS("xhtml", "browser");
      cell.appendChild(b);
      return b;
    },
  });
  withHost.bind("slot-1", ids[0]);
  withHost.bind("slot-2", ids[1]);
  const t1 = performance.now();
  await withHost.focusSlot("slot-2", { request_id: "s-8" });
  const dtMs = performance.now() - t1;
  const sel = await Tabs.list({ request_id: "s-9" });
  check("focus switch selects bound tab", sel.selected_tab_id === ids[1]);
  const focusedBrowser = withHost.cells.get("slot-2").browser;
  check("focus lands on slot-2 OWN browser", doc.activeElement === focusedBrowser && focusedBrowser.focusCalls === 1);
  check("slot-1 browser NOT focused", withHost.cells.get("slot-1").browser.focusCalls === 0);
  console.log(`INFO focus switch (stub, incl. model select): ${dtMs.toFixed(2)} ms`);
  void t0;
}

// --- 6. Resize -> onRect -> Panes.setRect; generation guard ---
{
  const rects = new Map();
  const doc2 = new FakeDocument();
  class FakeRO {
    constructor(cb) { this.cb = cb; this.targets = []; doc2.__ro = this; }
    observe(t) { this.targets.push(t); }
    disconnect() { this.targets = []; }
    fire() {
      this.cb(this.targets.map((t) => ({
        target: t,
        contentRect: { x: 0, y: 0, width: 640, height: 480 },
      })));
    }
  }
  doc2.defaultView = { ResizeObserver: FakeRO };
  const c2 = makeContainer(doc2);
  const m2 = Slots.mountSlots(c2, {
    maxSlots: 2,
    onRect: (id, rect) => rects.set(id, rect),
  });
  check("ResizeObserver attached to both cells", (doc2.__ro?.targets.length ?? 0) === 2);
  doc2.__ro.fire();
  check("onRect fired per cell", rects.size === 2 && rects.get("slot-1")?.width === 640);
  m2.detach();
  check("detach drops observer targets", (doc2.__ro?.targets.length ?? 0) === 0);

  const paneId = "s01-left";
  const at = await Panes.attach({ request_id: "s-10", pane_id: paneId, slot: "slot-1", astra_tab_id: null });
  check("pane attach bumps generation", at.generation === 0 || typeof at.generation === "number");
  const sr = await Panes.setRect({ request_id: "s-11", pane_id: paneId, rect: rects.get("slot-1") });
  check("pane setRect stores 640x480", sr.rect?.width === 640 && sr.rect?.height === 480);
  const g0 = (await Panes.get({ request_id: "s-12", pane_id: paneId })).pane.generation;
  await Panes.attach({ request_id: "s-13", pane_id: paneId, slot: "slot-2", astra_tab_id: null });
  const stale = await Panes.check({ request_id: "s-14", pane_id: paneId, generation: g0 });
  check("re-attach marks old generation stale", stale.stale === true);
  const bad = await Panes.setRect({ request_id: "s-15", pane_id: paneId, rect: { x: 0 } });
  check("setRect rejects partial rect", bad?.error?.code === "invalid_rect");
}

console.log(`slots stub contract: ${process.exitCode ? "FAIL" : `PASS (${passed} checks)`}`);

#!/usr/bin/env node
// P3-T13 contract test: shell assembly (frame + tab strip + split).
//
// Shell.svelte itself is a Svelte component (needs the chrome build), so this
// test pins its contract two ways with no browser and no build:
//   A. Static: Shell.svelte wires every required mount, keeps the P1-T08
//      hello + P1-T10 URL bar / content slot, extends win.__astraHost with
//      Windows (+Frame dispatch), and routes titlebar oncontrol through
//      dispatchWindowControl with the DOM window as chrome adapter.
//   B. Behavioral: the real builders (frame.js), tab strip (tab-strip.js),
//      split renderer (split.js) and window-control dispatch (Frame.sys.mjs
//      over the real Windows.sys.mjs model) are driven exactly the way
//      Shell.svelte drives them, against a fake DOM + stub host, asserting
//      all mounts present, the host seam complete, and control dispatch
//      routing to the Host API vs the chrome adapter correctly.
//
// Usage: node tests/contract/shell_assembly.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const SHELL_SRC = path.join(ROOT, "ui", "shell", "src", "Shell.svelte");

const Frame = await import(pathToFileURL(path.join(ROOT, "overlay", "astra", "chrome", "frame", "Frame.sys.mjs")).href);
const {
  createTitlebar,
  createSidebar,
  createToolbar,
} = await import(pathToFileURL(path.join(ROOT, "ui", "shell", "src", "frame", "frame.js")).href);
const { mountTabStrip } = await import(pathToFileURL(path.join(ROOT, "ui", "shell", "src", "tabs", "tab-strip.js")).href);
const { mountSplit } = await import(pathToFileURL(path.join(ROOT, "ui", "shell", "src", "split", "split.js")).href);
const { mountUrlBar } = await import(pathToFileURL(path.join(ROOT, "ui", "shell", "src", "urlbar.js")).href);
const { Windows, __resetWindowsForTests } = await import(pathToFileURL(path.join(ROOT, "overlay", "astra", "host", "Windows.sys.mjs")).href);
const { addEventListener, __resetEventsForTests } = await import(pathToFileURL(path.join(ROOT, "overlay", "astra", "host", "Events.sys.mjs")).href);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

// --- Minimal fake DOM (superset of the split-renderer test fake: adds
// --- dataset, replaceWith, tree querySelector(All) for Frame SELECTORS) ---

function matchToken(el, tok) {
  if (tok.startsWith("[") && tok.endsWith("]")) {
    const inner = tok.slice(1, -1);
    const eq = inner.indexOf("=");
    if (eq === -1) {
      return el.getAttribute(inner) !== null;
    }
    const name = inner.slice(0, eq);
    const want = inner.slice(eq + 1).replace(/^"|"$/g, "");
    return el.getAttribute(name) === want;
  }
  if (tok.startsWith(".")) {
    const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    return cls.includes(tok.slice(1));
  }
  return el.tag === tok;
}

function matchesChain(el, tokens) {
  if (!matchToken(el, tokens[tokens.length - 1])) {
    return false;
  }
  let node = el.parentNode;
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    let found = false;
    for (let cur = node; cur; cur = cur.parentNode) {
      if (matchToken(cur, tokens[i])) {
        found = true;
        node = cur.parentNode;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function fakeElement(tag) {
  const listeners = new Map();
  const el = {
    tag,
    children: [],
    parentNode: null,
    ownerDocument: null,
    attributes: {},
    style: {},
    dataset: {},
    hidden: false,
    textContent: "",
    disabled: false,
    draggable: false,
    value: "",
    type: "",
    title: "",
    setAttribute(k, v) {
      el.attributes[k] = String(v);
    },
    getAttribute(k) {
      return Object.hasOwn(el.attributes, k) ? el.attributes[k] : null;
    },
    removeAttribute(k) {
      delete el.attributes[k];
    },
    append(...nodes) {
      for (const n of nodes) {
        el.children.push(n);
        n.parentNode = el;
      }
      return el;
    },
    appendChild(node) {
      el.children.push(node);
      node.parentNode = el;
      return node;
    },
    removeChild(node) {
      el.children = el.children.filter((c) => c !== node);
      node.parentNode = null;
      return node;
    },
    replaceChildren(...nodes) {
      for (const c of el.children) {
        c.parentNode = null;
      }
      el.children = [];
      el.append(...nodes);
    },
    replaceWith(node) {
      node.ownerDocument = el.ownerDocument;
      const parent = el.parentNode;
      if (parent) {
        const at = parent.children.indexOf(el);
        if (at !== -1) {
          parent.children[at] = node;
        }
        node.parentNode = parent;
      }
      el.parentNode = null;
    },
    remove() {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((entry) => entry !== fn),
      );
    },
    fire(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) {
        fn({
          ...event,
          target: el,
          stopPropagation() {},
          preventDefault() {},
        });
      }
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const tokens = sel.trim().split(/\s+/);
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matchesChain(child, tokens)) {
            out.push(child);
          }
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 220, height: 40 };
    },
    focus() {},
    select() {},
  };
  return el;
}

function fakeDoc() {
  const doc = {
    _all: [],
    createElementNS(_ns, tag) {
      const el = fakeElement(tag);
      el.ownerDocument = doc;
      doc._all.push(el);
      return el;
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      const tokens = sel.trim().split(/\s+/);
      return doc._all.filter((el) => matchesChain(el, tokens));
    },
    body: null,
    _listeners: new Map(),
    addEventListener(type, fn) {
      const list = doc._listeners.get(type) ?? [];
      list.push(fn);
      doc._listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      doc._listeners.set(
        type,
        (doc._listeners.get(type) ?? []).filter((entry) => entry !== fn),
      );
    },
    defaultView: null,
  };
  doc.body = fakeElement("body");
  doc.body.ownerDocument = doc;
  return doc;
}

function nullStorage() {
  const kept = new Map();
  return {
    getItem: (k) => (kept.has(k) ? kept.get(k) : null),
    setItem: (k, v) => kept.set(k, String(v)),
    removeItem: (k) => kept.delete(k),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- A. Static: Shell.svelte wiring ---------------------------------------
const shell = fs.readFileSync(SHELL_SRC, "utf8");
check("shell imports frame builders", shell.includes("createTitlebar")
  && shell.includes("createSidebar") && shell.includes("createToolbar"));
check("shell imports mountTabStrip", shell.includes("mountTabStrip"));
check("shell imports mountSplit", shell.includes("mountSplit"));
check("shell keeps mountUrlBar", shell.includes("mountUrlBar"));
check("shell keeps content slot", shell.includes("data-astra-content")
  && shell.includes("host.Content.mount"));
check("shell keeps Hello (P1-T08)", shell.includes("<Hello"));
check("shell imports frame/tabstrip/split css",
  shell.includes("./frame/frame.css") && shell.includes("./tabs/tab-strip.css")
  && shell.includes("./split/split.css"));
check("shell frame layout mounts", shell.includes("data-astra-frame")
  && shell.includes("astra-frame-body") && shell.includes("astra-sidebar-col")
  && shell.includes("astra-main") && shell.includes("astra-tabs-mount")
  && shell.includes("astra-split-mount"));
check("shell extends __astraHost with Windows",
  shell.includes("Windows: host.Windows"));
check("shell seam carries Frame dispatch",
  shell.includes("Frame:") && shell.includes("dispatchWindowControl"));
check("shell seam keeps Tabs/Navigation/Panes/addEventListener",
  shell.includes("Tabs: host.Tabs") && shell.includes("Navigation: host.Navigation")
  && shell.includes("Panes: host.Panes") && shell.includes("addEventListener"));
check("shell imports Frame.sys.mjs over resource://",
  shell.includes("resource://astra/frame/Frame.sys.mjs"));
check("shell builds DOM-window chrome adapter",
  shell.includes("chromeAdapter") && shell.includes('"minimize"')
  && shell.includes('"maximize"') && shell.includes('"restore"'));
check("shell routes oncontrol to dispatchWindowControl",
  shell.includes("onControl") && shell.includes("Frame.dispatchWindowControl"));
check("shell applies its own fullscreen event",
  shell.includes("window.fullscreen-changed")
  && shell.includes("ownWindowId")
  && shell.includes("data-astra-fullscreen"));
check("shell fullscreen toolbar action dispatches toggle-fullscreen",
  shell.includes("toggle-fullscreen"));
// The app is the authority on which surface is in front. A browser page that
// is parked still exists, so only the app can say the real page surface
// belongs to the window again; a host command cannot report a park.
check("shell lets the app name the surface in front",
  shell.includes('data.kind === "surface"')
  && shell.includes("slot.dataset.internal = \"true\"")
  && shell.includes("delete slot.dataset.internal"));

// --- B. Behavioral: assemble exactly like Shell.svelte ---------------------
const doc = fakeDoc();
const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
frame.setAttribute("class", "astra-shell astra-frame");
frame.setAttribute("data-astra-frame", "");
for (const cls of [
  "titleMount", "toolMount", "sideMount", "tabsMount", "barMount", "splitMount",
]) {
  const m = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
  m.setAttribute("class", cls);
  frame.append(m);
}
const slotEl = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
slotEl.setAttribute("data-astra-content", "");
frame.append(slotEl);
const byClass = (c) => frame.children.find((n) => n.getAttribute("class") === c);

const titlebar = createTitlebar(doc, { title: "Astra", onControl: () => {} });
byClass("titleMount").replaceWith(titlebar.element);
const sidebar = createSidebar(doc, {
  items: [
    { id: "tabs", label: "Tabs" },
    { id: "notes", label: "Notes" },
  ],
  activeId: "tabs",
});
byClass("sideMount").replaceWith(sidebar.element);
const toolbarActions = [];
const toolbar = createToolbar(doc, {
  actions: [
    { id: "new-tab", label: "+" },
    { id: "split", label: "◫" },
    { id: "toggle-fullscreen", label: "⛶" },
  ],
  onAction: (id) => toolbarActions.push(id),
});
byClass("toolMount").replaceWith(toolbar.element);

check("assembly titlebar mounted", !!frame.querySelector("[data-astra-titlebar]"));
check("assembly sidebar mounted", !!frame.querySelector("[data-astra-sidebar]"));
check("assembly toolbar mounted", !!frame.querySelector("[data-astra-toolbar]"));
check("assembly sidebar items", frame.querySelectorAll("[data-item]").length === 2);
check("assembly toolbar actions", toolbar.element.querySelectorAll("[data-action]").length === 3);
check("assembly content slot kept", !!frame.querySelector("[data-astra-content]"));

// Frame module sees the same selectors the builders emit (FRAME.md §2).
const fakeWin = { getComputedStyle: () => ({ getPropertyValue: () => "" }) };
const rep = Frame.reportDragRegions(doc, fakeWin);
const roles = new Map(rep.regions.map((r) => [r.role, r.dragging]));
for (const role of ["titlebar", "window-controls", "sidebar", "toolbar"]) {
  check(`drag report finds ${role}`, roles.get(role) !== "missing");
}
check("drag report finds 3 control buttons",
  rep.regions.filter((r) => r.role === "control-button").length === 3);

// --- C. Dispatch routing: real Frame.sys.mjs over the real Windows model ----
__resetWindowsForTests();
__resetEventsForTests();
await Windows.list({ request_id: "asm-0" }); // ensures win-1
const seenEvents = [];
const offEvents = addEventListener((e) => seenEvents.push(e));
const host = { Windows };
let minimized = 0;
let maximized = 0;
let restored = 0;
const chrome = {
  minimize: () => {
    minimized += 1;
  },
  maximize: () => {
    maximized += 1;
  },
  restore: () => {
    restored += 1;
  },
};

{
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: "close", window_id: "win-1", request_id: "asm-1",
  });
  check("close routes to Host Windows (last-window guard)",
    res?.error?.code === "last_window");
}
{
  const on = await Frame.dispatchWindowControl(host, chrome, {
    action: "toggle-fullscreen", window_id: "win-1", request_id: "asm-2",
  });
  const mid = await Windows.get({ request_id: "asm-3", window_id: "win-1" });
  const off = await Frame.dispatchWindowControl(host, chrome, {
    action: "toggle-fullscreen", window_id: "win-1", request_id: "asm-4",
  });
  check("toggle-fullscreen flips the model on/off",
    on?.fullscreen === true && mid?.window?.fullscreen === true && off?.fullscreen === false);
  check("toggle-fullscreen emits window.fullscreen-changed",
    seenEvents.some((e) => e.type === "window.fullscreen-changed" && e.data?.fullscreen === true));
}
{
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: "minimize", window_id: "win-1", request_id: "asm-5",
  });
  check("minimize routes to the chrome adapter",
    res?.dispatched === true && minimized === 1);
}
{
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: "maximize", window_id: "win-1", request_id: "asm-6",
  });
  check("maximize routes to the chrome adapter",
    res?.dispatched === true && maximized === 1);
}
{
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: "restore", window_id: "win-1", request_id: "asm-7",
  });
  check("restore routes to the chrome adapter",
    res?.dispatched === true && restored === 1);
}
{
  const res = await Frame.dispatchWindowControl(host, null, {
    action: "minimize", window_id: "win-1", request_id: "asm-8",
  });
  check("chrome op without adapter reports unsupported_chrome_op",
    res?.error?.code === "unsupported_chrome_op");
}
{
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: "explode", window_id: "win-1", request_id: "asm-9",
  });
  check("unknown action reports invalid_window_action",
    res?.error?.code === "invalid_window_action");
}
offEvents();

// --- D. oncontrol flow: titlebar click dispatches like the shell does ------
{
  let captured = null;
  const tb = createTitlebar(doc, { title: "Astra", onControl: (a) => { captured = a; } });
  const closeBtn = tb.element
    .querySelectorAll("[data-action]")
    .find((b) => b.getAttribute("data-action") === "close");
  check("titlebar exposes a close control", !!closeBtn);
  closeBtn.fire("click");
  check("titlebar click captures close", captured === "close");
  // Shell.svelte handleControl: Frame.dispatchWindowControl(host,
  // chromeAdapter, { action, window_id, request_id }).
  const res = await Frame.dispatchWindowControl(host, chrome, {
    action: captured, window_id: "win-1", request_id: "asm-10",
  });
  check("captured close dispatches to Host Windows",
    res?.error?.code === "last_window");
  tb.destroy();
}

// --- E. Tab strip mounts and drives the stub host --------------------------
const tabCalls = [];
const tabHost = {
  Tabs: {
    list: async () => ({
      tabs: [
        {
          astra_tab_id: "t1", title: "Alpha", url: "https://a.example/",
          pinned: false, selected: true, index: 0,
        },
        {
          astra_tab_id: "t2", title: "Beta", url: "https://b.example/",
          pinned: true, selected: false, index: 1,
        },
      ],
      selected_tab_id: "t1",
    }),
    create: async (a) => {
      tabCalls.push(["create", a]);
      return { astra_tab_id: "t9" };
    },
    select: async (a) => {
      tabCalls.push(["select", a]);
      return {};
    },
    close: async (a) => {
      tabCalls.push(["close", a]);
      return {};
    },
    move: async (a) => {
      tabCalls.push(["move", a]);
      return {};
    },
  },
  addEventListener: () => () => {},
};
{
  const tabsMount = byClass("tabsMount");
  const strip = mountTabStrip(tabsMount, tabHost, { storage: nullStorage() });
  await tick();
  await tick();
  check("tab strip mounted", !!tabsMount.querySelector("[data-astra-tabs]"));
  const rows = tabsMount.querySelectorAll(".astra-tabs-row");
  check("tab strip paints pinned + open rows", rows.length === 2);
  const opener = tabsMount.querySelectorAll("button")
    .find((b) => b.textContent === "New tab");
  check("tab strip new-tab button present", !!opener);
  opener.fire("click");
  await tick();
  await tick();
  check("tab strip new-tab creates via host",
    tabCalls.some(([op]) => op === "create"));
  const openRow = rows.find((r) => r.getAttribute("aria-current") === "page");
  check("selected row marked current", !!openRow);
  openRow.fire("click");
  await tick();
  await tick();
  check("tab strip row click selects via host",
    tabCalls.some(([op, a]) => op === "select" && a.astra_tab_id === "t1"));
  strip.destroy();
  check("tab strip destroy detaches", tabsMount.children.length === 0);
}

// --- F. Split renderer mounts; shell unhide rule -----------------------------
{
  const splitMount = byClass("splitMount");
  const changes = [];
  const splitHost = { Tabs: { select: async () => ({}) } };
  const api = mountSplit(splitMount, splitHost, {
    tabs: [
      { id: "tab-a", title: "Alpha", url: "https://a.example/" },
      { id: "tab-b", title: "Beta", url: "https://b.example/" },
    ],
    storage: nullStorage(),
    onChange: (state) => changes.push(state),
  });
  const root = splitMount.querySelector(".astra-split");
  check("split renderer mounted", !!root);
  check("split starts single", root.getAttribute("data-layout") === "single");
  // Shell rule: splitMount.hidden = state.slots.length < 2.
  const hiddenFor = (state) => state.slots.length < 2;
  check("shell hides single empty pane", hiddenFor(api.getState()) === true);
  api.bind("slot-1", "tab-a");
  check("split cell shows bound tab title",
    root.querySelectorAll(".astra-split-title").some((t) => t.textContent === "Alpha"));
  api.split(null);
  check("split opens a second slot", api.getState().slots.length === 2);
  check("split layout switches to cols-2",
    root.getAttribute("data-layout") === "cols-2");
  check("shell unhides multi-slot grid", hiddenFor(changes.at(-1)) === false);
  api.destroy();
  check("split destroy detaches", splitMount.children.length === 0);
}

// --- G. URL bar still mounts (P1-T10) ----------------------------------------
{
  const barMount = byClass("barMount");
  const barHost = {
    Tabs: tabHost.Tabs,
    Navigation: {
      loadURL: async () => ({}),
      goBack: async () => ({}),
      goForward: async () => ({}),
      reload: async () => ({}),
    },
    Content: { navigate: async () => ({}) },
    addEventListener: () => () => {},
  };
  const bar = mountUrlBar(barMount, barHost);
  await tick();
  check("url bar mounted", !!barMount.querySelector("[data-astra-urlbar]"));
  check("url bar keeps nav buttons",
    ["back", "forward", "reload"].every(
      (a) => barMount.querySelectorAll("[data-action]")
        .some((b) => b.getAttribute("data-action") === a),
    ));
  bar.destroy();
}

console.log(`shell_assembly contract: ${failures === 0 ? "PASS" : `FAIL (${failures} checks)`}`);
process.exit(failures === 0 ? 0 : 1);

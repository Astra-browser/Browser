#!/usr/bin/env node
// P3-T03 contract test (stub side): frame model + builders.
// Imports overlay/astra/chrome/frame/Frame.sys.mjs and
// ui/shell/src/frame/frame.js with fake DOM/window objects — no browser,
// no build needed. Exit 0 PASS, 1 FAIL.
import {
  FRAME_VERSION,
  WINDOW_ACTIONS,
  SELECTORS,
  reportDragRegions,
  dispatchWindowControl,
  csdMode,
} from "../../overlay/astra/chrome/frame/Frame.sys.mjs";
import {
  createTitlebar,
  createSidebar,
  createToolbar,
} from "../../ui/shell/src/frame/frame.js";

let failures = [];
function check(name, ok) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) {
    failures.push(name);
  }
}

// --- Minimal fake DOM -------------------------------------------------
function fakeElement() {
  const attrs = new Map();
  const listeners = new Map();
  return {
    children: [],
    textContent: "",
    disabled: false,
    ownerDocument: null,
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    append(c) {
      this.children.push(c);
    },
    addEventListener(t, fn) {
      if (!listeners.has(t)) {
        listeners.set(t, []);
      }
      listeners.get(t).push(fn);
    },
    fire(t) {
      for (const fn of listeners.get(t) ?? []) {
        fn();
      }
    },
    remove() {
      this.removed = true;
    },
  };
}

function fakeDoc() {
  const elements = [];
  const doc = {
    createElementNS(ns, tag) {
      const e = fakeElement();
      e.tag = tag;
      e.ns = ns;
      e.ownerDocument = doc;
      elements.push(e);
      return e;
    },
    _bySelector: new Map(),
  };
  return { doc, elements };
}

// --- Frame.sys.mjs: drag-region reporting ------------------------------
{
  const titlebar = fakeElement();
  titlebar.getBoundingClientRect = () => ({ x: 0, y: 0, width: 800, height: 36 });
  const controls = fakeElement();
  const btn = fakeElement();
  btn.setAttribute("data-action", "close");
  const doc = {
    querySelector(sel) {
      if (sel === SELECTORS.titlebar) {
        return titlebar;
      }
      if (sel === SELECTORS.windowControls) {
        return controls;
      }
      return null; // sidebar/toolbar absent -> "missing"
    },
    querySelectorAll(sel) {
      return sel === SELECTORS.controlButton ? [btn] : [];
    },
  };
  const win = {
    getComputedStyle(e) {
      const v =
        e === titlebar ? "drag" : e === controls || e === btn ? "no-drag" : "";
      return { getPropertyValue: (p) => (p === "-moz-window-dragging" ? v : "") };
    },
  };
  const rep = reportDragRegions(doc, win);
  check("report version is 1", rep.version === FRAME_VERSION && FRAME_VERSION === 1);
  const by = Object.fromEntries(rep.regions.map((r) => [r.role, r]));
  check("titlebar reports drag", by["titlebar"]?.dragging === "drag");
  check("titlebar rect reported", by["titlebar"]?.rect?.width === 800);
  check("window-controls reports no-drag", by["window-controls"]?.dragging === "no-drag");
  check("missing sidebar reported", by["sidebar"]?.dragging === "missing");
  check("missing toolbar reported", by["toolbar"]?.dragging === "missing");
  const ctl = rep.regions.find((r) => r.role === "control-button");
  check("control button reports no-drag", ctl?.dragging === "no-drag");
}

// --- Frame.sys.mjs: window-control dispatch -----------------------------
function fakeHost() {
  const calls = [];
  return {
    calls,
    Windows: {
      async close(o) {
        calls.push(["close", o]);
        return { ...o, closed: true };
      },
      async get(o) {
        calls.push(["get", o]);
        return { ...o, window: { window_id: o.window_id, fullscreen: false } };
      },
      async setFullscreen(o) {
        calls.push(["setFullscreen", o]);
        return { ...o, fullscreen: o.fullscreen };
      },
    },
  };
}

{
  check(
    "five window actions",
    JSON.stringify([...WINDOW_ACTIONS].sort()) ===
      JSON.stringify(["close", "maximize", "minimize", "restore", "toggle-fullscreen"]),
  );
  const host = fakeHost();
  const bad = await dispatchWindowControl(host, null, { action: "explode", window_id: "win-1" });
  check("unknown action rejected", bad?.error?.code === "invalid_window_action");
  const nowin = await dispatchWindowControl(host, null, { action: "close" });
  check("missing window_id rejected", nowin?.error?.code === "no_such_window");

  const closed = await dispatchWindowControl(host, null, {
    action: "close",
    window_id: "win-1",
    request_id: "r1",
  });
  check(
    "close dispatches through Host Windows API",
    closed?.closed === true && host.calls.some((c) => c[0] === "close"),
  );

  const fs = await dispatchWindowControl(host, null, {
    action: "toggle-fullscreen",
    window_id: "win-1",
    request_id: "r2",
  });
  check(
    "toggle-fullscreen flips via get+setFullscreen",
    fs?.fullscreen === true &&
      host.calls.some((c) => c[0] === "setFullscreen" && c[1].fullscreen === true),
  );

  const noAdapter = await dispatchWindowControl(host, null, {
    action: "minimize",
    window_id: "win-1",
  });
  check("minimize without adapter errors", noAdapter?.error?.code === "unsupported_chrome_op");

  let minimized = 0;
  const ok = await dispatchWindowControl(host, { minimize: () => minimized++ }, {
    action: "minimize",
    window_id: "win-1",
    request_id: "r3",
  });
  check("minimize via chrome adapter dispatches", ok?.dispatched === true && minimized === 1);

  check("csd/ssd modes", csdMode(true) === "csd" && csdMode(false) === "ssd");
}

// --- ui frame builders (fake document) ----------------------------------
{
  const { doc } = fakeDoc();
  const seen = [];
  const t = createTitlebar(doc, { title: "Astra", onControl: (a) => seen.push(a) });
  check("titlebar has drag attr", t.element.getAttribute("data-astra-titlebar") === "");
  const btns = t.element.children[1].children;
  check("titlebar has 3 window controls", btns.length === 3);
  check(
    "control actions are minimize/maximize/close",
    btns.map((b) => b.getAttribute("data-action")).join(",") === "minimize,maximize,close",
  );
  btns[2].fire("click");
  check("control click bubbles action", seen.join(",") === "close");
  t.setTitle("Next");
  check("setTitle updates label", t.element.children[0].textContent === "Next");
  t.destroy();
  check("titlebar destroy removes", t.element.removed === true);

  const picked = [];
  const s = createSidebar(doc, {
    items: [
      { id: "tabs", label: "Tabs" },
      { id: "spaces", label: "Spaces" },
    ],
    activeId: "tabs",
    onSelect: (id) => picked.push(id),
  });
  check("sidebar has 2 items", s.element.children.length === 2);
  check("active item marked", s.element.children[0].getAttribute("aria-current") === "page");
  s.element.children[1].fire("click");
  check("sidebar select bubbles + repaints", picked.join(",") === "spaces" && s.activeId === "spaces");
  s.setCollapsed(true);
  check("sidebar collapse flag", s.element.getAttribute("data-collapsed") === "true");

  const acted = [];
  const tb = createToolbar(doc, {
    actions: [{ id: "new-tab", label: "New tab" }],
    onAction: (id) => acted.push(id),
  });
  tb.element.children[0].fire("click");
  check("toolbar action bubbles", acted.join(",") === "new-tab");
  tb.setDisabled("new-tab", true);
  check("toolbar setDisabled", tb.element.children[0].disabled === true);
}

if (failures.length) {
  console.log(`frame model contract: FAIL (${failures.length} checks)`);
  process.exit(1);
}
console.log("frame model contract: PASS");

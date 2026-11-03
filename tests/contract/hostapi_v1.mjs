#!/usr/bin/env node
// P2-T06 contract test: Host API v1 — Boot, Windows, Tabs, Navigation,
// Panes, Events (envelope + event_seq gap resync, §5.4) and the Content
// progress-listener feedback path.
//
// Imports the chrome modules by file path (pure logic, no Firefox
// internals) and asserts the v1 shape from docs/astra/HOST_API_v1.md:
//   - every call echoes `request_id` + `host_api_version: 1`
//   - failures return `{ request_id, host_api_version, error: { code, message } }`
//   - every event carries a monotonic `event_seq`; `eventsSince` replays
//     the gap and flags eviction
//
// Usage: node tests/contract/hostapi_v1.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Boot, Windows, Tabs, Navigation, Panes, Sidebar, WebExtensions } = HostAPI;
const { addEventListener, eventSeq, eventsSince, emit } = HostAPI;
const ContentMod = await import(path.join(HOST, "Content.sys.mjs"));
const { Content, makeProgressListener } = ContentMod;
const NavMod = await import(path.join(HOST, "Navigation.sys.mjs"));
const { __commitExternal } = NavMod;
const TabsMod = await import(path.join(HOST, "Tabs.sys.mjs"));

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

// Envelope assertion for every call result.
function checkEnv(name, res, rid) {
  check(`${name} echoes request_id`, res.request_id === rid);
  check(`${name} carries host_api_version 1`, res.host_api_version === 1);
}

function checkErr(name, res, rid, code) {
  checkEnv(name, res, rid);
  check(`${name} errors ${code}`, !!res.error && res.error.code === code);
}

HostAPI.__resetForTests();

// --- Event capture for envelope checks ---
const seen = [];
const off = addEventListener((e) => seen.push(e));

// === Boot ===
{
  const res = await Boot.handshake({ request_id: "b-1", core_version: 7 });
  checkEnv("boot.handshake", res, "b-1");
  check("handshake returns core_version", res.core_version === 7);
  check("handshake returns default window", res.window_id === "win-1");
  check("handshake returns event_seq number", typeof res.event_seq === "number");
  check("handshake emitted boot.ready",
    seen.some((e) => e.type === "boot.ready" && e.data.host_api_version === 1));

  const bad = await Boot.handshake({ request_id: "b-2", min_host_api_version: 99 });
  checkErr("boot.handshake incompatible", bad, "b-2", "incompatible_host");

  const st = await Boot.status({ request_id: "b-3" });
  checkEnv("boot.status", st, "b-3");
  check("status ready + event_seq", st.ready === true && typeof st.event_seq === "number");

  const sd = await Boot.shutdown({ request_id: "b-4", reason: "test" });
  checkEnv("boot.shutdown", sd, "b-4");
  check("shutdown ok", sd.shutdown === true);
  check("shutdown emitted boot.shutdown",
    seen.some((e) => e.type === "boot.shutdown" && e.data.reason === "test"));
}

// === Windows ===
let win2;
{
  const l0 = await Windows.list({ request_id: "w-0" });
  checkEnv("windows.list", l0, "w-0");
  check("default window win-1 present",
    l0.windows.some((w) => w.window_id === "win-1" && w.focused));
  check("default window not private", l0.windows.find((w) => w.window_id === "win-1").private === false);
  check("focused_window_id win-1", l0.focused_window_id === "win-1");

  const c = await Windows.create({ request_id: "w-1", private: true });
  checkEnv("windows.create", c, "w-1");
  check("private flag kept", c.private === true);
  win2 = c.window_id;
  check("new window id distinct", win2 !== "win-1");
  const l1 = await Windows.list({ request_id: "w-1b" });
  check("new window focused by default", l1.focused_window_id === win2);

  const bg = await Windows.create({ request_id: "w-2", background: true, title: "bg" });
  checkEnv("windows.create background", bg, "w-2");
  const l2 = await Windows.list({ request_id: "w-2b" });
  check("background create keeps focus", l2.focused_window_id === win2);
  const bgId = bg.window_id;

  const f = await Windows.focus({ request_id: "w-3", window_id: "win-1" });
  checkEnv("windows.focus", f, "w-3");
  const l3 = await Windows.list({ request_id: "w-3b" });
  check("focus moves", l3.focused_window_id === "win-1");

  const fs = await Windows.setFullscreen({ request_id: "w-4", window_id: win2, fullscreen: true });
  checkEnv("windows.setFullscreen", fs, "w-4");
  check("fullscreen true", fs.fullscreen === true);
  check("emitted window.fullscreen-changed",
    seen.some((e) => e.type === "window.fullscreen-changed" && e.data.window_id === win2));
  const fs2 = await Windows.setFullscreen({ request_id: "w-4b", window_id: win2, fullscreen: false });
  check("fullscreen false", fs2.fullscreen === false);

  const t = await Windows.setTitle({ request_id: "w-5", window_id: win2, title: "Work" });
  checkEnv("windows.setTitle", t, "w-5");
  check("title kept", t.title === "Work");
  const g = await Windows.get({ request_id: "w-6", window_id: win2 });
  checkEnv("windows.get", g, "w-6");
  check("get returns window", g.window.window_id === win2 && g.window.title === "Work");

  checkErr("windows.focus unknown", await Windows.focus({ request_id: "w-7", window_id: "win-nope" }), "w-7", "no_such_window");
  checkErr("windows.get unknown", await Windows.get({ request_id: "w-8", window_id: "win-nope" }), "w-8", "no_such_window");
  checkErr("windows.setFullscreen unknown",
    await Windows.setFullscreen({ request_id: "w-9", window_id: "win-nope" }), "w-9", "no_such_window");
  checkErr("windows.setTitle bad type",
    await Windows.setTitle({ request_id: "w-10", window_id: win2, title: 42 }), "w-10", "invalid_title");

  // Window-scoped tab: closing a window closes its tabs.
  const wt = await Tabs.create({ request_id: "w-11", url: "https://example.com/", window_id: win2 });
  checkEnv("tabs.create in window", wt, "w-11");
  const closeBg = await Windows.close({ request_id: "w-12", window_id: bgId });
  checkEnv("windows.close background", closeBg, "w-12");
  check("close reports tabs_closed array", Array.isArray(closeBg.tabs_closed));

  const cl = await Windows.close({ request_id: "w-13", window_id: win2 });
  checkEnv("windows.close", cl, "w-13");
  check("close reports window tabs closed", cl.tabs_closed.includes(wt.astra_tab_id));
  check("closed tab gone from list",
    !(await Tabs.list({ request_id: "w-13b" })).tabs.some((x) => x.astra_tab_id === wt.astra_tab_id));
  check("emitted window.closed", seen.some((e) => e.type === "window.closed" && e.data.window_id === win2));
  checkErr("windows.close unknown", await Windows.close({ request_id: "w-14", window_id: "win-nope" }), "w-14", "no_such_window");
  checkErr("windows.close last refused", await Windows.close({ request_id: "w-15", window_id: "win-1" }), "w-15", "last_window");
}

// === Tabs v1 (extends P1-T10: move/duplicate/pin/discard/title/mute) ===
let tA, tB, tC;
{
  const a = await Tabs.create({ request_id: "t-1", url: "https://a.example/" });
  checkEnv("tabs.create", a, "t-1");
  tA = a.astra_tab_id;
  check("create defaults window win-1", a.window_id === "win-1");
  const b = await Tabs.create({ request_id: "t-2", url: "https://b.example/", background: true });
  tB = b.astra_tab_id;
  const c = await Tabs.create({ request_id: "t-3", url: "https://c.example/", background: true, index: 1 });
  tC = c.astra_tab_id;
  let list = await Tabs.list({ request_id: "t-4" });
  checkEnv("tabs.list", list, "t-4");
  check("indexed create inserts at position",
    list.tabs.map((x) => x.astra_tab_id).join() === [tA, tC, tB].join());
  check("snapshots carry index + window + flags",
    list.tabs.every((x) => typeof x.index === "number" && x.window_id === "win-1"
      && x.pinned === false && x.discarded === false));

  const get = await Tabs.get({ request_id: "t-5", astra_tab_id: tB });
  checkEnv("tabs.get", get, "t-5");
  check("get returns tab", get.tab.astra_tab_id === tB && get.tab.url === "https://b.example/");
  checkErr("tabs.get unknown", await Tabs.get({ request_id: "t-6", astra_tab_id: "tab-nope" }), "t-6", "no_such_tab");

  const mv = await Tabs.move({ request_id: "t-7", astra_tab_id: tB, index: 0 });
  checkEnv("tabs.move", mv, "t-7");
  check("move clamps + reports", mv.index === 0);
  list = await Tabs.list({ request_id: "t-7b" });
  check("order after move", list.tabs[0].astra_tab_id === tB);
  check("emitted tab.moved", seen.some((e) => e.type === "tab.moved" && e.data.astra_tab_id === tB));
  checkErr("tabs.move unknown", await Tabs.move({ request_id: "t-8", astra_tab_id: "tab-nope", index: 0 }), "t-8", "no_such_tab");
  checkErr("tabs.move bad index", await Tabs.move({ request_id: "t-9", astra_tab_id: tB, index: -1 }), "t-9", "invalid_index");
  const mvBig = await Tabs.move({ request_id: "t-10", astra_tab_id: tB, index: 99 });
  check("move beyond end clamps", mvBig.index === 2);

  const dup = await Tabs.duplicate({ request_id: "t-11", astra_tab_id: tA });
  checkEnv("tabs.duplicate", dup, "t-11");
  check("duplicate new id + source", dup.astra_tab_id !== tA && dup.source_tab_id === tA && dup.url === "https://a.example/");
  list = await Tabs.list({ request_id: "t-11b" });
  check("duplicate selects foreground", list.selected_tab_id === dup.astra_tab_id);
  const dupBg = await Tabs.duplicate({ request_id: "t-12", astra_tab_id: tA, background: true });
  check("background duplicate keeps selection",
    (await Tabs.list({ request_id: "t-12b" })).selected_tab_id === dup.astra_tab_id);
  checkErr("tabs.duplicate unknown",
    await Tabs.duplicate({ request_id: "t-13", astra_tab_id: "tab-nope" }), "t-13", "no_such_tab");
  // History copied: source has 1 entry here; extend then duplicate.
  await Navigation.loadURL({ request_id: "t-14a", astra_tab_id: tA, url: "https://a2.example/" });
  const dup2 = await Tabs.duplicate({ request_id: "t-14", astra_tab_id: tA, background: true });
  const back = await Navigation.goBack({ request_id: "t-14b", astra_tab_id: dup2.astra_tab_id });
  check("duplicate copies history", back.went_back === true && back.url === "https://a.example/");

  const pin = await Tabs.pin({ request_id: "t-15", astra_tab_id: tA });
  checkEnv("tabs.pin", pin, "t-15");
  check("pinned true", pin.pinned === true);
  check("emitted tab.pinned", seen.some((e) => e.type === "tab.pinned"));
  const unp = await Tabs.unpin({ request_id: "t-16", astra_tab_id: tA });
  check("unpinned false", unp.pinned === false);
  check("emitted tab.unpinned", seen.some((e) => e.type === "tab.unpinned"));
  checkErr("tabs.pin unknown", await Tabs.pin({ request_id: "t-17", astra_tab_id: "tab-nope" }), "t-17", "no_such_tab");

  const dis = await Tabs.discard({ request_id: "t-18", astra_tab_id: tB });
  checkEnv("tabs.discard", dis, "t-18");
  check("discarded true", dis.discarded === true);
  check("emitted tab.discarded", seen.some((e) => e.type === "tab.discarded"));
  const wake = await Tabs.wakeup({ request_id: "t-19", astra_tab_id: tB });
  check("wakeup clears + url", wake.discarded === false && wake.url === "https://b.example/");
  check("emitted tab.restored", seen.some((e) => e.type === "tab.restored"));
  checkErr("tabs.discard unknown", await Tabs.discard({ request_id: "t-20", astra_tab_id: "tab-nope" }), "t-20", "no_such_tab");

  const st = await Tabs.setTitle({ request_id: "t-21", astra_tab_id: tA, title: "A page" });
  checkEnv("tabs.setTitle", st, "t-21");
  check("title kept + updated event",
    st.title === "A page" && seen.some((e) => e.type === "tab.updated" && e.data.title === "A page"));
  checkErr("tabs.setTitle unknown", await Tabs.setTitle({ request_id: "t-22", astra_tab_id: "tab-nope", title: "x" }), "t-22", "no_such_tab");
  checkErr("tabs.setTitle bad type", await Tabs.setTitle({ request_id: "t-23", astra_tab_id: tA, title: 7 }), "t-23", "invalid_title");

  const mu = await Tabs.setMuted({ request_id: "t-24", astra_tab_id: tA, muted: true });
  checkEnv("tabs.setMuted", mu, "t-24");
  check("muted true", mu.muted === true);
  checkErr("tabs.setMuted unknown", await Tabs.setMuted({ request_id: "t-25", astra_tab_id: "tab-nope" }), "t-25", "no_such_tab");

  checkErr("tabs.create empty url", await Tabs.create({ request_id: "t-26", url: "" }), "t-26", "invalid_url");

  const winList = await Tabs.list({ request_id: "t-27", window_id: "win-1" });
  check("list filters by window", winList.tabs.every((x) => x.window_id === "win-1") && winList.tabs.length > 0);
}

// === Navigation v1 ===
{
  const tabId = (await Tabs.list({ request_id: "n-0" })).selected_tab_id;
  const st = await Navigation.stop({ request_id: "n-1", astra_tab_id: tabId });
  checkEnv("nav.stop", st, "n-1");
  check("stop ok", st.stopped === true);
  check("emitted nav.stopped", seen.some((e) => e.type === "nav.stopped"));
  checkErr("nav.stop unknown", await Navigation.stop({ request_id: "n-2", astra_tab_id: "tab-nope" }), "n-2", "no_such_tab");

  const z0 = await Navigation.getZoom({ request_id: "n-3", astra_tab_id: tabId });
  checkEnv("nav.getZoom", z0, "n-3");
  check("default zoom 1", z0.zoom === 1);
  const z1 = await Navigation.setZoom({ request_id: "n-4", astra_tab_id: tabId, zoom: 1.5 });
  checkEnv("nav.setZoom", z1, "n-4");
  check("zoom kept", z1.zoom === 1.5);
  check("emitted nav.zoom-changed", seen.some((e) => e.type === "nav.zoom-changed" && e.data.zoom === 1.5));
  const zHi = await Navigation.setZoom({ request_id: "n-5", astra_tab_id: tabId, zoom: 99 });
  check("zoom clamps to max", zHi.zoom === 3.0);
  const zLo = await Navigation.setZoom({ request_id: "n-6", astra_tab_id: tabId, zoom: 0.01 });
  check("zoom clamps to min", zLo.zoom === 0.3);
  checkErr("nav.setZoom bad type", await Navigation.setZoom({ request_id: "n-7", astra_tab_id: tabId, zoom: "big" }), "n-7", "invalid_zoom");
  checkErr("nav.setZoom unknown", await Navigation.setZoom({ request_id: "n-8", astra_tab_id: "tab-nope", zoom: 1 }), "n-8", "no_such_tab");

  const f = await Navigation.findInPage({ request_id: "n-9", astra_tab_id: tabId, query: "hello" });
  checkEnv("nav.findInPage", f, "n-9");
  check("find stores query", f.query === "hello" && f.matchCount === 0);
  check("emitted nav.find-result", seen.some((e) => e.type === "nav.find-result"));
  const fr = await Navigation.setFindResult({ request_id: "n-10", astra_tab_id: tabId, matchCount: 4, activeMatch: 2 });
  check("live counts merge", fr.matchCount === 4 && fr.activeMatch === 2);
  checkErr("nav.findInPage empty", await Navigation.findInPage({ request_id: "n-11", astra_tab_id: tabId, query: "" }), "n-11", "invalid_query");
  checkErr("nav.findInPage bad dir",
    await Navigation.findInPage({ request_id: "n-12", astra_tab_id: tabId, query: "x", direction: "up" }), "n-12", "invalid_direction");

  const p = await Navigation.print({ request_id: "n-13", astra_tab_id: tabId });
  checkEnv("nav.print", p, "n-13");
  check("print dispatched + event",
    p.dispatched === true && seen.some((e) => e.type === "nav.print-requested"));

  const r = await Navigation.setReaderMode({ request_id: "n-14", astra_tab_id: tabId, enabled: true });
  checkEnv("nav.setReaderMode", r, "n-14");
  check("reader enabled", r.enabled === true && r.available === false);
  const ra = await Navigation.setReaderAvailable({ request_id: "n-15", astra_tab_id: tabId, available: true });
  check("reader availability merges", ra.enabled === true && ra.available === true);
  check("emitted nav.reader-changed", seen.filter((e) => e.type === "nav.reader-changed").length >= 2);

  // External ingress: new URL pushes history, same URL is a reload.
  const before = (await Tabs.list({ request_id: "n-16" })).tabs.find((t) => t.astra_tab_id === tabId);
  const ext1 = __commitExternal(tabId, "https://external.example/page");
  check("external commit returns url", ext1 === "https://external.example/page");
  const extBack = await Navigation.goBack({ request_id: "n-17", astra_tab_id: tabId });
  check("external load pushed history", extBack.went_back === true);
  const extFwd = await Navigation.goForward({ request_id: "n-18", astra_tab_id: tabId });
  check("forward to external url", extFwd.went_forward === true && extFwd.url === "https://external.example/page");
  const headCount = TabsMod.__historyFor(tabId).entries.length;
  __commitExternal(tabId, "https://external.example/page");
  check("same-url external is reload (no push)",
    TabsMod.__historyFor(tabId).entries.length === headCount);
  check("reload flagged external+reloaded",
    seen.some((e) => e.type === "nav.committed" && e.data.external === true && e.data.reloaded === true));
  check("external emits location-changed",
    seen.some((e) => e.type === "content.location-changed" && e.data.url === "https://external.example/page"));
  check("external on unknown tab null", __commitExternal("tab-nope", "https://x.example/") === null);
  check("external empty url null", __commitExternal(tabId, "") === null);
  void before;
}

// === Navigation history: the New Tab is not a Back entry ===
// Owner-reported: Back on the sidebar landed on the empty New Tab because
// `Tabs.create` seeds the stack with `about:blank` and the first real page was
// pushed on top of it. A fresh tab's first load must replace that head.
{
  const hist = (id) => TabsMod.__historyFor(id);
  const create = async (rid) =>
    (await Tabs.create({ request_id: rid, url: "about:blank", background: true })).astra_tab_id;

  const fresh = await create("nh-0");
  check("fresh tab starts on a blank head",
    hist(fresh).entries.length === 1 && hist(fresh).entries[0] === "about:blank");

  const first = await Navigation.loadURL({ request_id: "nh-1", astra_tab_id: fresh, url: "https://a.example/" });
  checkEnv("first load into a fresh tab", first, "nh-1");
  const afterFirst = await Tabs.get({ request_id: "nh-2", astra_tab_id: fresh });
  check("first real load replaces the New Tab (Back disabled)", afterFirst.tab.canGoBack === false);
  check("first real load keeps one entry at index 0",
    hist(fresh).entries.length === 1
    && hist(fresh).index === 0
    && hist(fresh).entries[0] === "https://a.example/");

  await Navigation.loadURL({ request_id: "nh-3", astra_tab_id: fresh, url: "https://b.example/" });
  const backA = await Navigation.goBack({ request_id: "nh-4", astra_tab_id: fresh });
  checkEnv("Back from B", backA, "nh-4");
  check("Back from B lands on A", backA.went_back === true && backA.url === "https://a.example/");
  const atA = await Tabs.get({ request_id: "nh-5", astra_tab_id: fresh });
  check("Back to A enables Forward (Back disabled)",
    atA.tab.canGoBack === false && atA.tab.canGoForward === true);

  const fwdB = await Navigation.goForward({ request_id: "nh-6", astra_tab_id: fresh });
  checkEnv("Forward from A", fwdB, "nh-6");
  check("Forward returns to B", fwdB.went_forward === true && fwdB.url === "https://b.example/");
  const atB = await Tabs.get({ request_id: "nh-7", astra_tab_id: fresh });
  check("Forward lands on the last entry",
    atB.tab.canGoBack === true && atB.tab.canGoForward === false);

  const entriesBefore = hist(fresh).entries.length;
  __commitExternal(fresh, "https://b.example/");
  check("same-url external commit adds no duplicate", hist(fresh).entries.length === entriesBefore);
  check("same-url external commit stays at the head", hist(fresh).entries[hist(fresh).index] === "https://b.example/");

  // Shell adoption: an external load into a fresh tab takes the same path.
  const adopted = await create("nh-8");
  __commitExternal(adopted, "https://adopted.example/");
  check("external first load replaces the New Tab (Back disabled)",
    hist(adopted).entries.length === 1
    && hist(adopted).index === 0
    && hist(adopted).entries[0] === "https://adopted.example/");
  const adoptedTab = await Tabs.get({ request_id: "nh-9", astra_tab_id: adopted });
  check("adopted tab has nothing behind it", adoptedTab.tab.canGoBack === false);
}

// === Panes v1 ===
{
  const s = await Panes.show({ request_id: "p-1", pane_id: "assistant" });
  checkEnv("panes.show", s, "p-1");
  const at = await Panes.attach({ request_id: "p-2", pane_id: "assistant", slot: "sidebar-right" });
  checkEnv("panes.attach", at, "p-2");
  check("attach slot + generation", at.slot === "sidebar-right" && at.generation === 1);
  check("emitted pane.attached", seen.some((e) => e.type === "pane.attached" && e.data.generation === 1));

  const rect = { x: 0, y: 0, width: 360, height: 800 };
  const sr = await Panes.setRect({ request_id: "p-3", pane_id: "assistant", rect });
  checkEnv("panes.setRect", sr, "p-3");
  check("rect kept", JSON.stringify(sr.rect) === JSON.stringify(rect));
  check("emitted pane.rect-changed", seen.some((e) => e.type === "pane.rect-changed"));

  const g = await Panes.get({ request_id: "p-4", pane_id: "assistant" });
  check("get returns full pane",
    g.pane.slot === "sidebar-right" && g.pane.visible === true && g.pane.generation === 1);

  const fresh = await Panes.check({ request_id: "p-5", pane_id: "assistant", generation: 1 });
  check("current generation not stale", fresh.stale === false);
  const dt = await Panes.detach({ request_id: "p-6", pane_id: "assistant" });
  checkEnv("panes.detach", dt, "p-6");
  check("detach bumps generation", dt.generation === 2);
  check("emitted pane.detached", seen.some((e) => e.type === "pane.detached"));
  const stale = await Panes.check({ request_id: "p-7", pane_id: "assistant", generation: 1 });
  check("old generation stale", stale.stale === true && stale.generation === 2);

  checkErr("panes.attach empty slot", await Panes.attach({ request_id: "p-8", pane_id: "x", slot: "" }), "p-8", "invalid_slot");
  checkErr("panes.detach unknown", await Panes.detach({ request_id: "p-9", pane_id: "nope" }), "p-9", "no_such_pane");
  checkErr("panes.setRect unknown", await Panes.setRect({ request_id: "p-10", pane_id: "nope", rect }), "p-10", "no_such_pane");
  checkErr("panes.setRect bad rect", await Panes.setRect({ request_id: "p-11", pane_id: "assistant", rect: { x: 0 } }), "p-11", "invalid_rect");
  checkErr("panes.get unknown", await Panes.get({ request_id: "p-12", pane_id: "nope" }), "p-12", "no_such_pane");
  checkErr("panes.check unknown", await Panes.check({ request_id: "p-13", pane_id: "nope", generation: 0 }), "p-13", "no_such_pane");
  const l = await Panes.list({ request_id: "p-14" });
  check("list carries pane records", l.panes.some((x) => x.pane_id === "assistant" && x.generation === 2));
}

// === Sidebar v1 (P3-T17: app boot calls resolve, no `no host route`) ===
{
  const g0 = await Sidebar.get({ request_id: "s-0" });
  checkEnv("sidebar.get", g0, "s-0");
  check("defaults hidden false + width null",
    g0.hidden === false && g0.width === null && g0.revision === null);

  const w = await Sidebar.setWidth({ request_id: "s-1", width: 240, animate: true, revision: 7 });
  checkEnv("sidebar.setWidth", w, "s-1");
  check("width/animate/revision kept",
    w.width === 240 && w.animate === true && w.revision === 7);

  const h = await Sidebar.setHidden({ request_id: "s-2", hidden: true });
  checkEnv("sidebar.setHidden", h, "s-2");
  check("hidden kept + width survives", h.hidden === true && h.width === 240);

  const g1 = await Sidebar.get({ request_id: "s-3" });
  check("get reflects last report", g1.hidden === true && g1.width === 240 && g1.revision === 7);

  const clr = await Sidebar.setWidth({ request_id: "s-4", width: null, animate: false, revision: null });
  check("null width clears override", clr.width === null && clr.animate === false);

  checkErr("sidebar.setWidth bad width",
    await Sidebar.setWidth({ request_id: "s-5", width: "wide" }), "s-5", "invalid_width");
  checkErr("sidebar.setWidth bad animate",
    await Sidebar.setWidth({ request_id: "s-6", width: 240, animate: "yes" }), "s-6", "invalid_animate");
  checkErr("sidebar.setWidth bad revision",
    await Sidebar.setWidth({ request_id: "s-7", width: 240, revision: NaN }), "s-7", "invalid_revision");
  checkErr("sidebar.setHidden bad type",
    await Sidebar.setHidden({ request_id: "s-8", hidden: 1 }), "s-8", "invalid_hidden");
}

// === WebExtensions v1 (P3-T17: `web_extension_list` stub) ===
{
  // Native payload shape (bare array — the generated UI binding consumes the
  // bridge payload as the list itself), so no request_id echo here by design.
  const list = await WebExtensions.list({ request_id: "x-1" });
  check("webext.list answers an empty array", Array.isArray(list) && list.length === 0);
}

// === Content progress-listener feedback (fakes, no Firefox needed) ===
{
  const tabId = (await Tabs.create({ request_id: "c-0", url: "https://start.example/", background: true })).astra_tab_id;
  const byBrowser = new Map();
  const fakeBrowser = { id: "b1" };
  byBrowser.set(fakeBrowser, tabId);
  const listener = makeProgressListener({ tabIdOf: (b) => byBrowser.get(b) ?? null });

  listener.onLocationChange(fakeBrowser, null, null, { spec: "https://clicked.example/" });
  const afterClick = await Tabs.get({ request_id: "c-1", astra_tab_id: tabId });
  check("progress location commits + history",
    afterClick.tab.url === "https://clicked.example/"
    && seen.some((e) => e.type === "nav.committed" && e.data.external === true));
  const back = await Navigation.goBack({ request_id: "c-2", astra_tab_id: tabId });
  check("progress load pushed history entry", back.went_back === true && back.url === "https://start.example/");

  listener.onTitleChange(fakeBrowser, "Clicked title");
  const titled = await Tabs.get({ request_id: "c-3", astra_tab_id: tabId });
  check("progress title updates model", titled.tab.title === "Clicked title");

  // Untracked browser + garbage inputs are swallowed, never throw.
  let threw = false;
  try {
    listener.onLocationChange({ id: "ghost" }, null, null, { spec: "https://x.example/" });
    listener.onLocationChange(fakeBrowser, null, null, null);
    listener.onTitleChange(fakeBrowser, "");
    listener.onTitleChange({ id: "ghost" }, "nope");
  } catch {
    threw = true;
  }
  check("progress listener never throws", threw === false);

  // attachTabBrowser with a fake tabbrowser wires add/remove.
  let added = null;
  let removed = null;
  const fakeBrowser2 = { id: "b2" };
  const fakeTabbrowser = {
    addTabsProgressListener(l) { added = l; },
    removeTabsProgressListener(l) { removed = l; },
  };
  const bound = Content.attachTabBrowser(fakeTabbrowser, { tabIdOf: () => tabId });
  check("attach registers listener", added === bound.listener && added !== null);
  bound.listener.onTitleChange(fakeBrowser2, "via attached");
  check("attached listener drives model",
    (await Tabs.get({ request_id: "c-4", astra_tab_id: tabId })).tab.title === "via attached");
  bound.detach();
  check("detach unregisters", removed === added);

  const inert = Content.attachTabBrowser(null);
  check("attach without tabbrowser no-ops", inert.listener === null);
  inert.detach();

  check("applyZoom without manager false", Content.applyZoom({}, 1.5) === false);
  check("printPage without utils false", Content.printPage({}) === false);
}

// === Events: envelope + gap resync ===
off();
{
  const seqs = seen.map((e) => e.event_seq);
  const monotonic = seqs.every((s, i) => s === i + 1);
  check(`event_seq monotonic 1..${seqs.length}`, monotonic && seqs.length > 0);

  let shapeOk = true;
  for (const e of seen) {
    if (typeof e.event_seq !== "number" || typeof e.type !== "string" || typeof e.data !== "object") {
      shapeOk = false;
    }
  }
  check("event envelope shape", shapeOk);

  const schemaText = await (await import("node:fs/promises")).readFile(
    path.join(HOST, "schemas", "events.json"), "utf8");
  const EVENT_ENUM = new Set(JSON.parse(schemaText).properties.type.enum);
  const unknown = seen.filter((e) => !EVENT_ENUM.has(e.type));
  check("all event types in schema enum", unknown.length === 0);

  for (const t of ["boot.ready", "window.created", "tab.created", "tab.moved",
    "nav.zoom-changed", "pane.attached", "content.location-changed"]) {
    check(`event ${t} observed`, seen.some((e) => e.type === t));
  }

  // Gap resync: replay from an early seq returns everything, no gap.
  const replay = eventsSince(2);
  check("eventsSince replays after seq", replay.events.length === seen.length - 2);
  check("no gap when buffered", replay.gap === false);
  check("eventsSince at head empty", eventsSince(eventSeq()).events.length === 0);
  check("future seq no gap", eventsSince(eventSeq() + 100).gap === false);

  // Eviction: overflow the 500-ring, then an old seq reports a gap.
  for (let i = 0; i < 520; i++) {
    emit("tab.updated", { probe: i });
  }
  const gapped = eventsSince(3);
  check("evicted history flags gap", gapped.gap === true);
  check("replay still ordered after eviction",
    gapped.events.every((e, i) => i === 0 || e.event_seq > gapped.events[i - 1].event_seq));
}

// === Facade ===
{
  check("HOST_API_VERSION stays 1", HostAPI.HOST_API_VERSION === 1);
  for (const k of ["Boot", "Windows", "Tabs", "Navigation", "Panes", "Sidebar", "WebExtensions", "eventsSince"]) {
    check(`facade exports ${k}`, HostAPI[k] !== undefined);
  }
  HostAPI.__resetForTests();
  check("reset clears tabs", (await Tabs.list({ request_id: "r-1" })).tabs.length === 0);
  check("reset clears sidebar", (await Sidebar.get({ request_id: "r-2" })).hidden === false
    && (await Sidebar.get({ request_id: "r-2" })).width === null);
  check("reset clears seq", eventSeq() === 0);
}

console.log(`hostapi v1 contract: ${failed ? "FAIL" : `PASS (${passed} checks)`}`);
if (failed) {
  process.exitCode = 1;
}

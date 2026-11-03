#!/usr/bin/env node
// P1-T10 contract test: Host API Tabs/Navigation/Panes stub protocol.
//
// Imports the chrome modules by file path (they are pure logic, no Firefox
// internals) and asserts the v1 shape from docs/astra/HOST_API_v1_T10.md:
//   - every call echoes `request_id` + `host_api_version`
//   - every event carries a monotonic `event_seq` (§5.4)
//   - tab create/select/close/list; navigation load/back/forward/reload over
//     a per-tab history stack; pane show/hide/list.
//
// Usage: node tests/contract/content_slot.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Tabs, Navigation, Panes, Boot, addEventListener, __resetForTests } = HostAPI;

let passed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
  }
}

__resetForTests();

// --- Event capture for seq monotonicity (before any calls) ---
const seen = [];
const off = addEventListener((e) => seen.push(e));

// --- Boot handshake keeps the P1-T05 shape ---
{
  const res = await Boot.handshake({ request_id: "boot-1", core_version: 7 });
  check("boot echoes request_id", res.request_id === "boot-1");
  check("boot carries host_api_version", res.host_api_version === 1);
}

// --- Tabs.create: one live tab ---
// Fixture URLs are https, not file:. Since f55bd14 the address field treats
// file:, javascript:, data: and chrome: as *words to search for*
// (`Search.sys.mjs` NAVIGABLE = http/https/about), so `Navigation.loadURL`
// would rewrite a file: URL into a DuckDuckGo query and the url echo below
// would never match. This stub never fetches the pages, so plain hostnames
// are enough; `new URL("https://fixture.test/a").href` is already canonical,
// which keeps the resolve round-trip byte-identical.
const A = "https://fixture.test/a";
const B = "https://fixture.test/b";
let tabId;
{
  const res = await Tabs.create({ request_id: "t-1", url: A });
  check("create echoes request_id", res.request_id === "t-1");
  check("create carries host_api_version", res.host_api_version === 1);
  check("create returns astra_tab_id", typeof res.astra_tab_id === "string");
  tabId = res.astra_tab_id;
}

// --- Navigation.load on the fixture pages ---
// (create already pushed A, so one load of B gives history [A, B].)
{
  const r2 = await Navigation.loadURL({ request_id: "n-2", astra_tab_id: tabId, url: B });
  check("load echoes request_id", r2.request_id === "n-2");
  check("load commits tab + url", r2.astra_tab_id === tabId && r2.url === B);
}

// --- Back / forward over the history stack ---
{
  const list = await Tabs.list({ request_id: "t-2" });
  const tab = list.tabs.find((t) => t.astra_tab_id === tabId);
  check("two entries -> canGoBack", tab && tab.canGoBack === true);
  check("at head -> !canGoForward", tab && tab.canGoForward === false);

  const back = await Navigation.goBack({ request_id: "n-3", astra_tab_id: tabId });
  check("goBack went_back + url A", back.went_back === true && back.url === A);

  const fwd = await Navigation.goForward({ request_id: "n-4", astra_tab_id: tabId });
  check("goForward went_forward + url B", fwd.went_forward === true && fwd.url === B);

  const back2 = await Navigation.goBack({ request_id: "n-5", astra_tab_id: tabId });
  check("goBack again to A", back2.went_back === true && back2.url === A);
  const stuck = await Navigation.goBack({ request_id: "n-6", astra_tab_id: tabId });
  check("goBack at bottom stays + went_back false",
    stuck.went_back === false && stuck.url === A);

  const rel = await Navigation.reload({ request_id: "n-7", astra_tab_id: tabId });
  check("reload echoes url A", rel.reloaded === true && rel.url === A);
}

// --- Select / second tab / close ---
{
  const c2 = await Tabs.create({ request_id: "t-3", url: B, background: true });
  const tab2 = c2.astra_tab_id;
  const list = await Tabs.list({ request_id: "t-4" });
  check("two tabs listed", list.tabs.length === 2);
  check("first tab still selected (background create)",
    list.selected_tab_id === tabId);

  const sel = await Tabs.select({ request_id: "t-5", astra_tab_id: tab2 });
  check("select returns tab2 url", sel.astra_tab_id === tab2 && sel.url === B);

  const bad = await Tabs.select({ request_id: "t-6", astra_tab_id: "tab-nope" });
  check("select unknown -> error", !!bad.error && bad.error.code === "no_such_tab");

  const closed = await Tabs.close({ request_id: "t-7", astra_tab_id: tab2 });
  check("close reports closed", closed.closed === true);
  const list2 = await Tabs.list({ request_id: "t-8" });
  check("one tab left + selection falls back",
    list2.tabs.length === 1 && list2.selected_tab_id === tabId);

  const badNav = await Navigation.loadURL({ request_id: "n-8", astra_tab_id: tab2, url: A });
  check("load on closed tab -> error", !!badNav.error && badNav.error.code === "no_such_tab");
}

// --- Panes stub ---
{
  const s = await Panes.show({ request_id: "p-1", pane_id: "assistant" });
  check("pane show visible", s.visible === true && s.pane_id === "assistant");
  const l = await Panes.list({ request_id: "p-2" });
  check("pane listed", l.panes.some((p) => p.pane_id === "assistant" && p.visible));
  const h = await Panes.hide({ request_id: "p-3", pane_id: "assistant" });
  check("pane hide", h.visible === false);
}

// --- Event envelope: monotonic event_seq, expected types ---
off();
{
  const seqs = seen.map((e) => e.event_seq);
  const monotonic = seqs.every((s, i) => s === i + 1);
  check(`event_seq monotonic 1..${seqs.length}`, monotonic && seqs.length > 0);
  const types = new Set(seen.map((e) => e.type));
  for (const t of ["tab.created", "tab.updated", "nav.committed", "tab.closed",
    "pane.shown", "pane.hidden", "boot.ready"]) {
    check(`event ${t} observed`, types.has(t));
  }
  check("nav.committed carries tab + url",
    seen.some((e) => e.type === "nav.committed" && e.data.astra_tab_id === tabId));
}

console.log(`content_slot stub contract: ${process.exitCode ? "FAIL" : `PASS (${passed} checks)`}`);

#!/usr/bin/env node
// Window-scoped tab model contract.
//
// A second chrome window must not share `win-1`: each window has its own id,
// its own tabs, its own selected row, and its own projection. This is the
// boundary a private window depends on (its tabs may never appear in the
// normal window), so a regression here is a privacy bug, not a layout bug.
//
// Usage: node tests/contract/window_scope.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const Tabs = await import(path.join(HOST, "Tabs.sys.mjs"));
const Windows = await import(path.join(HOST, "Windows.sys.mjs"));
const Events = await import(path.join(HOST, "Events.sys.mjs"));

const TabsApi = Tabs.Tabs;
const WindowsApi = Windows.Windows;

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name} ${detail}`);
  }
}

function fakeWindow() {
  return {
    closed: false,
    fullScreen: false,
    mozInnerScreenX: 0,
    mozInnerScreenY: 0,
    screenX: 0,
    screenY: 0,
    document: { documentElement: { getAttribute: () => null } },
    addEventListener() {},
  };
}

Tabs.__resetTabsForTests();
Events.__resetEventsForTests();
Windows.__resetWindowsForTests();

// === Identity ==============================================================
const first = fakeWindow();
const second = fakeWindow();
const firstId = Windows.__bindCurrentWindow(first);
const secondId = Windows.__bindCurrentWindow(second);
check("the first window gets win-1", firstId === "win-1", firstId);
check("the second window gets its own id", secondId !== firstId, secondId);
check("binding a window again keeps its id", Windows.__bindCurrentWindow(second) === secondId);
check("both windows are listed", (await WindowsApi.list({ request_id: "w" })).windows.length === 2);

// === Per-window tabs and projections ======================================
await TabsApi.create({ request_id: "a", url: "https://normal.test/", window_id: firstId });
await TabsApi.create({ request_id: "b", url: "https://normal.test/two", window_id: firstId });
const privateTab = await TabsApi.create({
  request_id: "c",
  url: "https://private.test/",
  window_id: secondId,
});

const firstSnapshot = Tabs.__itemsSnapshot(firstId);
const secondSnapshot = Tabs.__itemsSnapshot(secondId);
const firstUrls = firstSnapshot.tabs.map((tab) => tab.url);
const secondUrls = secondSnapshot.tabs.map((tab) => tab.url);
check(
  "the normal projection has only the normal tabs",
  firstUrls.every((url) => !String(url ?? "").includes("private.test")),
  JSON.stringify(firstUrls),
);
check(
  "the private projection has the private tab",
  secondUrls.some((url) => String(url ?? "").includes("private.test")),
  JSON.stringify(secondUrls),
);
check("the projection names its window", firstSnapshot.window_id === firstId);
check("the projection names its window (private)", secondSnapshot.window_id === secondId);
check("each projection selects its own tab", firstSnapshot.active !== secondSnapshot.active);

// === Selection is per window ==============================================
const firstSelected = firstSnapshot.active;
await TabsApi.select({ request_id: "s", astra_tab_id: privateTab.astra_tab_id });
check(
  "selecting in one window keeps the other window's selection",
  Tabs.__itemsSnapshot(firstId).active === firstSelected,
  `${Tabs.__itemsSnapshot(firstId).active} vs ${firstSelected}`,
);
check(
  "Tabs.list reports the window's own selection",
  (await TabsApi.list({ request_id: "l", window_id: secondId })).selected_tab_id ===
    privateTab.astra_tab_id,
);

// === Event scope ==========================================================
const seen = [];
const off = Events.addEventListener((event) => {
  if (event.type === "items-changed") seen.push(event.data.window_id);
});
Tabs.emitItemsChanged();
off();
check(
  "one items-changed per window, each naming its own window",
  seen.includes(firstId) && seen.includes(secondId) && new Set(seen).size === seen.length,
  JSON.stringify(seen),
);

// === Closing a window drops only its rows =================================
await TabsApi.close({ request_id: "cl", astra_tab_id: privateTab.astra_tab_id });
check(
  "the normal window keeps its tabs after the private tab closes",
  Tabs.__itemsSnapshot(firstId).tabs.length === 2,
);
check(
  "the private window no longer shows the private page",
  !Tabs.__itemsSnapshot(secondId).tabs.some((tab) =>
    String(tab.url ?? "").includes("private.test"),
  ),
  JSON.stringify(Tabs.__itemsSnapshot(secondId).tabs.map((tab) => tab.url)),
);

// === A closed native window's id is not handed out twice ==================
second.closed = true;
const third = fakeWindow();
const thirdId = Windows.__bindCurrentWindow(third);
check(
  "a new window never reuses a live or just-closed identity",
  thirdId !== firstId && thirdId !== secondId,
  thirdId,
);

console.log(`\nwindow_scope: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

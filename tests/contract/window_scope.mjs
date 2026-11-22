#!/usr/bin/env node
// Window-scoped tab model contract.
//
// A second chrome window must not share `win-1`: each window has its own id,
// its own tabs, its own selected row, and its own projection. This is the
// boundary a private window depends on (its tabs may never appear in the
// normal window), so a regression here is a privacy bug, not a layout bug.
//
// Usage: node tests/contract/window_scope.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const Tabs = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href);
const Windows = await import(pathToFileURL(path.join(HOST, "Windows.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

const TabsApi = Tabs.Tabs;
const { __syncHistory, __historyFor, __restoreSelection, __mruForTests } = Tabs;
const WindowsApi = Windows.Windows;

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

// === Restored history and selection restore ===============================
const historyTab = await TabsApi.create({
  request_id: "h",
  url: "https://one.test/",
  window_id: firstId,
  background: true,
});
const historyId = historyTab.astra_tab_id;
check(
  "a restored tab takes the engine's real history",
  __syncHistory(historyId, {
    entries: [
      { url: "https://one.test/" },
      { url: "https://two.test/" },
      { url: "https://three.test/" },
    ],
    index: 1,
  }) === true &&
    __historyFor(historyId)?.entries.length === 3 &&
    __historyFor(historyId)?.index === 1,
);
const beforeMru = __mruForTests(firstId);
const firstLive = Tabs.__itemsSnapshot(firstId).tabs.find(
  (tab) => tab.id !== historyId,
)?.id;
if (firstLive) {
  await TabsApi.select({ request_id: "m1", astra_tab_id: firstLive });
  const mruBefore = __mruForTests(firstId);
  __restoreSelection(firstLive);
  check(
    "restoring a selection does not rewrite the MRU stack",
    JSON.stringify(__mruForTests(firstId)) === JSON.stringify(mruBefore),
    JSON.stringify({ before: mruBefore, after: __mruForTests(firstId) }),
  );
}

// === A closed native window's id is not handed out twice ==================
second.closed = true;
const third = fakeWindow();
const thirdId = Windows.__bindCurrentWindow(third);
check(
  "a new window never reuses a live or just-closed identity",
  thirdId !== firstId && thirdId !== secondId,
  thirdId,
);

// === Process-wide binding across module instances (P2-1) ==================
// Every chrome window loads its own copy of this module, so a per-module map
// made the second window call itself `win-1` too. The record lives on
// `Services` (one object per process); two imports under one Services stand
// in for two chrome windows.
{
  const shared = {};
  globalThis.Services = shared;
  const url = pathToFileURL(path.join(HOST, "Windows.sys.mjs")).href;
  const windowsA = await import(`${url}?scope=window-a`);
  const windowsB = await import(`${url}?scope=window-b`);
  const nativeA = fakeWindow();
  const nativeB = fakeWindow();
  const idA = windowsA.__bindCurrentWindow(nativeA);
  const idB = windowsB.__bindCurrentWindow(nativeB);
  check(
    "two module instances share one window id space",
    idA === "win-1" && idB === "win-2",
    `${idA},${idB}`,
  );
  const listA = await windowsA.Windows.list({ request_id: "shared-a" });
  const listB = await windowsB.Windows.list({ request_id: "shared-b" });
  check(
    "each window lists both windows",
    listA.windows.map((w) => w.window_id).join() === "win-1,win-2" &&
      listB.windows.map((w) => w.window_id).join() === "win-1,win-2",
    JSON.stringify({
      a: listA.windows.map((w) => w.window_id),
      b: listB.windows.map((w) => w.window_id),
    }),
  );
  check(
    "the focus projection agrees between windows",
    listA.focused_window_id === listB.focused_window_id,
    `${listA.focused_window_id} vs ${listB.focused_window_id}`,
  );
  await windowsB.Windows.focus({ request_id: "shared-focus", window_id: idA });
  check(
    "focus from the second window moves the first window's projection",
    (await windowsA.Windows.list({ request_id: "shared-a2" })).focused_window_id === idA,
  );
  await windowsB.Windows.setFullscreen({
    request_id: "shared-fs",
    window_id: idA,
    fullscreen: true,
  });
  check(
    "fullscreen from the second window lands on the first window's record",
    (await windowsA.Windows.get({ request_id: "shared-get", window_id: idA })).window
      .fullscreen === true,
  );
  const closedFirst = await windowsB.Windows.close({
    request_id: "shared-close-a",
    window_id: idA,
  });
  check(
    "a window can close an id its own module never allocated",
    closedFirst.closed === true && closedFirst.window_id === idA,
    JSON.stringify(closedFirst),
  );
  const afterFirst = await windowsB.Windows.list({ request_id: "shared-after-a" });
  check(
    "the default window is not resurrected for the survivor",
    afterFirst.windows.map((w) => w.window_id).join() === idB &&
      afterFirst.focused_window_id === idB,
    JSON.stringify({
      ids: afterFirst.windows.map((w) => w.window_id),
      focused: afterFirst.focused_window_id,
    }),
  );
  windowsA.__resetWindowsForTests();
  windowsB.__resetWindowsForTests();
  delete globalThis.Services;
}

console.log(`\nwindow_scope: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

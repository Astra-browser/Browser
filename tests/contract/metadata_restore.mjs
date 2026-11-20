#!/usr/bin/env node
// P5b contract test: what the organisation store may capture, and how a
// restored snapshot is re-applied.
//
// The privacy rules are the point:
//   - private tabs (and tabs in private windows) never reach the snapshot
//   - only http(s) URLs are persisted
//   - restore consumes snapshot tabs by URL, one live tab per entry
//   - a snapshot without usable spaces falls back to the default space
//
// Usage: node tests/contract/metadata_restore.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Metadata, buildSnapshot, planRestore, isPersistableUrl, ownerAllows, organisationDiffers } = await import(pathToFileURL(path.join(HOST, "Metadata.sys.mjs")).href);
const { Tabs, __applyExternalUpdate, __resetTabsForTests: __resetTabs } = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href);

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

const spaceA = { id: "space-1", name: "Space", icon: null, color: 0, theme: null };
const spaceB = { id: "space-2", name: "Work", icon: null, color: 0, theme: null };

function tab(overrides) {
  return {
    astra_tab_id: "tab-1",
    url: "https://a.example/",
    title: "A",
    space_id: "space-1",
    pinned: false,
    window_id: "win-1",
    private: false,
    selected: false,
    muted: false,
    discarded: false,
    ...overrides,
  };
}

// --- URL gate ----------------------------------------------------------------
{
  for (const url of ["https://a.example/", "http://a.example/x?y=1"]) {
    check(`persists ${url}`, isPersistableUrl(url) === true);
  }
  for (const url of [
    "about:blank",
    "about:preferences",
    "data:text/html,x",
    "file:///etc/hostname",
    "blob:https://a.example/0b1c",
    "javascript:alert(1)",
    "",
    null,
    42,
  ]) {
    check(`refuses ${String(url)}`, isPersistableUrl(url) === false);
  }
}

// --- Capture -----------------------------------------------------------------
{
  const tabs = [
    tab({ astra_tab_id: "tab-1", url: "https://a.example/" }),
    tab({ astra_tab_id: "tab-2", url: "https://b.example/", space_id: "space-2", pinned: true }),
    tab({ astra_tab_id: "tab-3", url: "https://private.example/", private: true }),
    tab({ astra_tab_id: "tab-4", url: "https://other-window.example/", window_id: "win-2" }),
    tab({ astra_tab_id: "tab-5", url: "about:blank", space_id: "space-2" }),
    tab({ astra_tab_id: "tab-6", url: "data:text/html,secret" }),
  ];
  const windows = [
    { window_id: "win-1", private: false, focused: true, title: "Astra" },
    { window_id: "win-2", private: true, focused: false, title: "Private" },
  ];
  const snapshot = buildSnapshot({
    spaces: [spaceA, spaceB],
    active_space_id: "space-1",
    tabs,
    windows,
    selected_tab_id: "tab-3",
    now: 1_700_000_000_000,
  });

  check("snapshot is version 1", snapshot.version === 1);
  check("snapshot is named organisation", snapshot.name === "organisation");
  check("created_at is UTC seconds", snapshot.created_at === 1_700_000_000);
  check("only public http(s) tabs are kept", snapshot.tabs.length === 2);
  check(
    "private tabs never reach the snapshot",
    snapshot.tabs.every((entry) => !entry.url.includes("private.example")),
  );
  check(
    "tabs in a private window never reach the snapshot",
    snapshot.tabs.every((entry) => !entry.url.includes("other-window.example")),
  );
  check(
    "about/data URLs never reach the snapshot",
    snapshot.tabs.every((entry) => isPersistableUrl(entry.url)),
  );
  check("kept tabs keep their space", snapshot.tabs.find((t) => t.url === "https://b.example/").space_uuid === "space-2");
  check("kept tabs keep their pin", snapshot.tabs.find((t) => t.url === "https://b.example/").pinned === true);
  check("positions are contiguous", snapshot.tabs.map((t) => t.position).join(",") === "0,1");
  check("escalating order is preserved", snapshot.tabs[0].url === "https://a.example/");

  check("spaces are ordered", snapshot.spaces.map((s) => s.uuid).join(",") === "space-1,space-2");
  check("spaces carry no container ref", snapshot.spaces.every((s) => s.container_ref === null));

  check("private windows are not listed", snapshot.windows.length === 1);
  check("only the public window is listed", snapshot.windows[0].window_id === "win-1");
  check("the focused flag survives", snapshot.windows[0].focused === true);

  check("a private selected tab is not active in the snapshot", snapshot.active_tab_id === null);
  check("folders are optional and empty", Array.isArray(snapshot.folders) && snapshot.folders.length === 0);
  check("no layout is written", snapshot.layout === null);

  // A public selected tab is kept.
  const withPublicActive = buildSnapshot({
    spaces: [spaceA],
    tabs,
    windows,
    selected_tab_id: "tab-1",
  });
  check("a public selected tab is active", withPublicActive.active_tab_id === "tab-1");
}

// --- Restore plan ------------------------------------------------------------
{
  const snapshot = buildSnapshot({
    spaces: [spaceB, spaceA],
    tabs: [
      tab({ astra_tab_id: "old-1", url: "https://a.example/", space_id: "space-1" }),
      tab({ astra_tab_id: "old-2", url: "https://b.example/", space_id: "space-2", pinned: true }),
      tab({ astra_tab_id: "old-3", url: "https://c.example/", space_id: "space-2" }),
    ],
    windows: [{ window_id: "win-1", private: false, focused: true, title: "" }],
    selected_tab_id: "old-2",
  });
  // Restored tabs get fresh ids and may arrive in any order.
  const live = [
    tab({ astra_tab_id: "tab-9", url: "https://c.example/" }),
    tab({ astra_tab_id: "tab-8", url: "https://unknown.example/" }),
    tab({ astra_tab_id: "tab-7", url: "https://b.example/" }),
    tab({ astra_tab_id: "tab-6", url: "https://a.example/" }),
    tab({ astra_tab_id: "tab-5", url: "https://b.example/", private: true }),
  ];
  const plan = planRestore(snapshot, live);
  check("restore rebuilds the saved spaces in position order", plan.spaces.map((s) => s.id).join(",") === "space-2,space-1");
  check("restore keeps space names", plan.spaces.find((s) => s.id === "space-2").name === "Work");
  check("restore assigns by URL, not by id", plan.assignments.length === 3);
  const byUrl = new Map(plan.assignments.map((entry) => [entry.astra_tab_id, entry]));
  check("the B tab is restored into Work and pinned", byUrl.get("tab-7")?.space_id === "space-2" && byUrl.get("tab-7")?.pinned === true);
  check("the C tab is restored into Work", byUrl.get("tab-9")?.space_id === "space-2");
  check("the A tab is restored into Space", byUrl.get("tab-6")?.space_id === "space-1");
  check("an unknown live tab is left alone", !byUrl.has("tab-8"));
  check("a private live tab is never assigned", !byUrl.has("tab-5"));
  check("the active space follows the saved active tab", plan.activeSpaceId === "space-2");
  check("the active live tab is identified", plan.active === "tab-7");
}

// --- Duplicate URLs and fallbacks -------------------------------------------
{
  const snapshot = {
    version: 1,
    spaces: [{ uuid: "space-1", name: "Space", position: 0 }],
    tabs: [
      { astra_tab_id: "o1", url: "https://same.example/", space_uuid: "space-1", pinned: false, position: 0 },
      { astra_tab_id: "o2", url: "https://same.example/", space_uuid: "space-1", pinned: true, position: 1 },
    ],
    active_tab_id: "o2",
  };
  const live = [
    tab({ astra_tab_id: "n1", url: "https://same.example/" }),
    tab({ astra_tab_id: "n2", url: "https://same.example/" }),
    tab({ astra_tab_id: "n3", url: "https://same.example/" }),
  ];
  const plan = planRestore(snapshot, live);
  check("duplicate URLs consume one snapshot entry each", plan.assignments.length === 2);
  check("the pin follows position order", plan.assignments[1].pinned === true && plan.assignments[1].astra_tab_id === "n2");
  check("the extra live duplicate stays unassigned", !plan.assignments.some((a) => a.astra_tab_id === "n3"));
}

{
  const plan = planRestore({ version: 1, spaces: [], tabs: [] }, []);
  check("an empty snapshot falls back to the default space", plan.spaces.length === 1 && plan.spaces[0].id === "space-1");
  check("an empty snapshot assigns nothing", plan.assignments.length === 0);
  const bad = planRestore({ version: 1, spaces: [{ uuid: "", name: "x", position: 0 }], tabs: [] }, []);
  check("a nameless space is refused", bad.spaces.length === 1 && bad.spaces[0].id === "space-1");
}

// --- Round trip --------------------------------------------------------------
{
  const originalTabs = [
    tab({ astra_tab_id: "a1", url: "https://one.example/", space_id: "space-1" }),
    tab({ astra_tab_id: "a2", url: "https://two.example/", space_id: "space-2", pinned: true }),
  ];
  const snapshot = buildSnapshot({
    spaces: [spaceA, spaceB],
    tabs: originalTabs,
    windows: [{ window_id: "win-1", private: false, focused: true, title: "" }],
    selected_tab_id: "a2",
  });
  const live = originalTabs.map((entry, index) =>
    tab({ astra_tab_id: `live-${index}`, url: entry.url }),
  );
  const plan = planRestore(snapshot, live);
  check("round trip keeps two assignments", plan.assignments.length === 2);
  check("round trip keeps the Work space", plan.spaces.some((s) => s.name === "Work"));
  check("round trip keeps the pin", plan.assignments.some((a) => a.pinned === true));
}

// --- One writer per process -------------------------------------------------
{
  const a = { id: "a" };
  const b = { id: "b" };
  check("the unclaimed slot admits the first window", ownerAllows({ owner: null, token: a }) === true);
  check("the owner may write", ownerAllows({ owner: a, token: a }) === true);
  check("a non-owner may not write", ownerAllows({ owner: a, token: b }) === false);
  check("a private window never writes", ownerAllows({ private: true, owner: a, token: a }) === false);
  check("a private window never writes even unclaimed", ownerAllows({ private: true, owner: null, token: a }) === false);
}

// --- Deferred (lazy) restore ------------------------------------------------
{
  Metadata.__resetForTests();
  __resetTabs();
  await Tabs.bootstrap({ request_id: "lazy-boot" });
  const made = await Tabs.create({ request_id: "lazy-create", url: "about:blank" });
  const snapshot = buildSnapshot({
    spaces: [spaceA, spaceB],
    tabs: [
      tab({ astra_tab_id: "old", url: "https://lazy.example/", space_id: "space-2", pinned: true }),
    ],
    windows: [{ window_id: "win-1", private: false, focused: true, title: "" }],
  });
  check("the test snapshot installs", Metadata.__setSnapshotForTests(snapshot) === true);
  const first = await Metadata.restore();
  check("a lazy tab is not assigned yet", first.moved === 0 && first.pinned === 0);
  // SessionStore commits the real URL later.
  __applyExternalUpdate(made.astra_tab_id, { url: "https://lazy.example/" });
  const second = await Metadata.restore();
  check("the committed tab is placed", second.moved === 1 && second.pinned === 1);
  const stored = (await Tabs.list({ request_id: "lazy-list" })).tabs.find(
    (entry) => entry.astra_tab_id === made.astra_tab_id,
  );
  check("the deferred tab lands in Work", stored?.space_id === "space-2");
  check("the deferred tab is pinned", stored?.pinned === true);
  const third = await Metadata.restore();
  check("restore is idempotent", third.moved === 0 && third.pinned === 0);
  check("a completed restore has nothing pending", (await Metadata.plan(snapshot, [])).remaining === 1);
  Metadata.__resetForTests();
  __resetTabs();
}

// --- Private windows write nothing ------------------------------------------
{
  Metadata.__resetForTests();
  const prepared = await Metadata.prepare({ private: true });
  check("a private window does not load the store", prepared.state === "private");
  check(
    "a private prepare leaves the normal store state alone",
    Metadata.status().private === false && Metadata.status().available === false,
  );
  const saved = await Metadata.save();
  check("a private prepare loaded no store to save", saved.saved === false);
  const restored = await Metadata.restore({ private: true });
  check("a private window does not restore", restored.restored === false && restored.reason === "private");
  check("status never reports the process as private", Metadata.status().private === false);
  check("private init does not claim the writer", Metadata.init({ private: true }) === undefined);
  Metadata.__resetForTests();
  check("reset clears the private flag", Metadata.status().private === false);
}

// --- A second window never tears the owner's store down ---------------------
{
  Metadata.__resetForTests();
  await Metadata.prepare({ window_id: "win-a" });
  check(
    "a non-owner window cannot dispose the store",
    Metadata.dispose({ window_id: "win-b" }) === false,
  );
  check(
    "a non-owner window cannot release the owner's slot",
    Metadata.releaseOwner({ window_id: "win-b" }) === false,
  );
  Metadata.__resetForTests();
}

// --- Exposed test seams ------------------------------------------------------
{
  check("Metadata exposes the capture function", Metadata.capture === buildSnapshot);
  check("Metadata exposes the plan function", Metadata.plan === planRestore);
  check("a fresh module has not restored anything", Metadata.status().restored === false);
  Metadata.__resetForTests();
}

// --- Organisation changes persist with no page open (2026-11-20) -------------
// A space deleted while it held the only page left a capture with zero tabs.
// `save()` refused it and the quit flush rewrote the older snapshot, so the
// space came back. Only a space change may persist an empty capture; a tab or
// selection change may not, or a restore that has not finished would erase the
// organisation it is about to restore.
{
  const withPage = buildSnapshot({
    spaces: [{ id: "space-1", name: "Space" }, { id: "space-2", name: "Doomed" }],
    active_space_id: "space-1",
    tabs: [{ astra_tab_id: "tab-1", url: "https://example.com/", title: "x", window_id: "win-1", private: false }],
    windows: [{ window_id: "win-1", private: false }],
    selected_tab_id: "tab-1",
  });
  const afterDelete = buildSnapshot({
    spaces: [{ id: "space-1", name: "Space" }],
    active_space_id: "space-1",
    tabs: [],
    windows: [{ window_id: "win-1", private: false }],
  });
  const renamedOnly = buildSnapshot({
    spaces: [{ id: "space-1", name: "Renamed" }, { id: "space-2", name: "Doomed" }],
    active_space_id: "space-1",
    tabs: [],
    windows: [{ window_id: "win-1", private: false }],
  });
  check("deleting a space differs from the saved organisation",
    organisationDiffers(afterDelete, withPage) === true);
  check("renaming a space differs from the saved organisation",
    organisationDiffers(renamedOnly, withPage) === true);
  check("an unchanged organisation does not differ",
    organisationDiffers(afterDelete, afterDelete) === false);
  check("a tab-only change is not an organisation change",
    organisationDiffers(
      { spaces: afterDelete.spaces, tabs: [{ astra_tab_id: "tab-2" }] },
      afterDelete,
    ) === false);
}

// --- A merged capture covers every window (P1-2, 2026-11-20) ----------------
// One Host API instance — and therefore one tab/space model — exists per chrome
// window, so a capture built from the owner's model alone wrote only the
// owner's rows; the second window was refused as `not_owner`. The capture now
// merges every host in `Services.astraHosts`. Each model numbers its tabs from
// `tab-1`, so the merge must key a tab by its window as well as its id, and a
// private window must never be read into the capture.
{
  Metadata.__resetForTests();
  const url = pathToFileURL(path.join(HOST, "Windows.sys.mjs")).href;
  const windows = await import(url);
  const spaceC = { id: "space-3", name: "B Only", icon: null, color: 0, theme: null };
  const fakeWindow = (privateMarker = false) => ({
    closed: false,
    fullScreen: false,
    document: {
      documentElement: { getAttribute: (name) => (privateMarker && name === "privatebrowsingmode" ? "temporary" : null) },
    },
    addEventListener() {},
  });
  globalThis.Services = {};
  windows.__resetWindowsForTests();
  const nativeA = fakeWindow();
  const nativeB = fakeWindow();
  const nativePrivate = fakeWindow(true);
  const idA = windows.__bindCurrentWindow(nativeA);
  const idB = windows.__bindCurrentWindow(nativeB);
  const idPrivate = windows.__bindCurrentWindow(nativePrivate);

  // Window A: the saved spaces, one page.
  const rowsA = [
    tab({ astra_tab_id: "tab-1", url: "", window_id: idA }),
    tab({ astra_tab_id: "tab-2", url: "https://a.example/", window_id: idA }),
  ];
  // Window B: its own page ids collide with A's, plus a third space.
  const rowsB = [
    tab({ astra_tab_id: "tab-1", url: "", window_id: idB }),
    tab({ astra_tab_id: "tab-2", url: "https://b-one.example/", window_id: idB }),
    tab({ astra_tab_id: "tab-3", url: "https://b-two.example/", window_id: idB }),
  ];
  const rowsPrivate = [
    tab({ astra_tab_id: "tab-1", url: "https://private.example/", window_id: idPrivate }),
  ];
  const hosts = new WeakMap();
  hosts.set(nativeA, {
    Tabs: { list: async () => ({ tabs: rowsA, selected_tab_id: "tab-2" }) },
    __spacesState: () => ({ spaces: [spaceA, spaceB] }),
  });
  hosts.set(nativeB, {
    Tabs: { list: async () => ({ tabs: rowsB, selected_tab_id: "tab-3" }) },
    __spacesState: () => ({
      spaces: [spaceA, { ...spaceB, name: "B Work" }, { ...spaceC, name: "B Only Space" }],
    }),
  });
  hosts.set(nativePrivate, {
    Tabs: { list: async () => ({ tabs: rowsPrivate, selected_tab_id: "tab-1" }) },
    __spacesState: () => ({ spaces: [spaceA] }),
  });
  globalThis.Services.astraHosts = hosts;
  // The focused window's selection is the one a restart brings forward.
  await windows.Windows.focus({ request_id: "merged-focus", window_id: idB });

  const merged = await Metadata.__captureForTests({ prefer_window_id: idB });
  check(
    "the merged capture keeps both windows' pages",
    ["https://a.example/", "https://b-one.example/", "https://b-two.example/"].every(
      (entry) => merged.tabs.some((saved) => saved.url === entry),
    ),
    JSON.stringify(merged.tabs.map((saved) => saved.url)),
  );
  check(
    "two windows' identical tab ids are both kept",
    merged.tabs.filter((saved) => saved.astra_tab_id === "tab-2").length === 2,
    JSON.stringify(merged.tabs.map((saved) => saved.astra_tab_id)),
  );
  check(
    "positions do not collapse on a duplicate id",
    merged.tabs.map((saved) => saved.position).join() ===
      merged.tabs.map((_, index) => index).join(),
    JSON.stringify(merged.tabs.map((saved) => saved.position)),
  );
  check(
    "spaces are de-duplicated by id",
    merged.spaces.map((space) => space.uuid).join() === "space-1,space-2,space-3",
    JSON.stringify(merged.spaces.map((space) => space.uuid)),
  );
  check(
    "the triggering window's copy of a shared space wins",
    merged.spaces.find((space) => space.uuid === "space-2")?.name === "B Work",
  );
  check(
    "the second window's own space reaches the snapshot",
    merged.spaces.find((space) => space.uuid === "space-3")?.name === "B Only Space",
  );
  check(
    "both public windows are listed",
    merged.windows.length === 2 &&
      merged.windows.some((win) => win.window_id === idA) &&
      merged.windows.some((win) => win.window_id === idB),
    JSON.stringify(merged.windows.map((win) => win.window_id)),
  );
  check("the private window is not listed", !merged.windows.some((win) => win.window_id === idPrivate));
  check(
    "a private window's page never reaches the merged capture",
    merged.tabs.every((saved) => !saved.url.includes("private.example")),
    JSON.stringify(merged.tabs.map((saved) => saved.url)),
  );
  check(
    "the focused window's selection is the saved active tab",
    merged.active_tab_id === "tab-3",
    String(merged.active_tab_id),
  );

  // The merged shape is what restore consumes: every saved page is matched by
  // URL, in position order, into a live tab.
  const live = [
    tab({ astra_tab_id: "live-1", url: "https://b-two.example/" }),
    tab({ astra_tab_id: "live-2", url: "https://a.example/" }),
    tab({ astra_tab_id: "live-3", url: "https://b-one.example/" }),
  ];
  const plan = planRestore(merged, live);
  check("a merged snapshot restores by URL", plan.assignments.length === 3);
  check(
    "restored tabs land in their saved spaces",
    plan.assignments.find((entry) => entry.astra_tab_id === "live-1")?.space_id === "space-1" &&
      plan.assignments.find((entry) => entry.astra_tab_id === "live-2")?.space_id === "space-1",
  );
  check(
    "the space added in the second window restores",
    plan.spaces.some((space) => space.id === "space-3" && space.name === "B Only Space"),
  );

  // A capture read twice (or two identical rows in one model) is one entry;
  // two real pages of the same URL are still two.
  const twice = buildSnapshot({
    spaces: [spaceA, spaceA],
    tabs: [
      tab({ astra_tab_id: "tab-1", url: "https://same.example/" }),
      tab({ astra_tab_id: "tab-1", url: "https://same.example/" }),
      tab({ astra_tab_id: "tab-2", url: "https://same.example/" }),
    ],
    windows: [{ window_id: "win-1", private: false }],
  });
  check("a repeated row is captured once", twice.tabs.length === 2);
  check("a repeated space is captured once", twice.spaces.length === 1);

  windows.__resetWindowsForTests();
  delete globalThis.Services;
  Metadata.__resetForTests();

  // Without a registry (Node, preview DOM) the capture is this module's own
  // model: the single-window path is unchanged.
  const local = await Metadata.__captureForTests();
  check(
    "no registry keeps the single-window capture",
    Array.isArray(local?.tabs) && local.spaces.length >= 1,
    JSON.stringify(local?.spaces),
  );

  // A window that does not own the store still makes its own change land: its
  // debounce calls the owner's published writer instead of writing itself.
  const shared = { astraOrgOwner: { id: "other-window" } };
  let calls = 0;
  let origin = null;
  shared.astraOrgSave = (from) => {
    calls += 1;
    origin = from;
    return { saved: true };
  };
  globalThis.Services = shared;
  Metadata.__setSnapshotForTests(buildSnapshot({ spaces: [spaceA], tabs: [], windows: [] }));
  Metadata.init({ window_id: "win-2" });
  await new Promise((resolve) => setTimeout(resolve, 900));
  check("a non-owner window's change reaches the owner's writer", calls >= 1, String(calls));
  check("the owner is told which window changed", origin === "win-2", String(origin));
  Metadata.__resetForTests();
  delete globalThis.Services;
}

// --- The store write carries every window (P1-2) ----------------------------
// The whole path, not just the capture: the owner's save must put the second
// window's page and space into the snapshot it hands the sidecar.
{
  Metadata.__resetForTests();
  const windows = await import(pathToFileURL(path.join(HOST, "Windows.sys.mjs")).href);
  const { Boot } = await import(pathToFileURL(path.join(HOST, "Boot.sys.mjs")).href);
  const originalCoreCall = Boot.coreCall;
  const spaceThird = { id: "space-3", name: "Second Only", icon: null, color: 0, theme: null };
  const fakeWindow = () => ({
    closed: false,
    fullScreen: false,
    document: { documentElement: { getAttribute: () => null } },
    addEventListener() {},
  });
  globalThis.Services = {};
  windows.__resetWindowsForTests();
  const winA = fakeWindow();
  const winB = fakeWindow();
  const idA = windows.__bindCurrentWindow(winA);
  const idB = windows.__bindCurrentWindow(winB);
  const rowsFor = (window_id, url) => [
    tab({ astra_tab_id: "tab-1", url: "", window_id }),
    tab({ astra_tab_id: "tab-2", url, window_id }),
  ];
  const hosts = new WeakMap();
  hosts.set(winA, {
    Tabs: { list: async () => ({ tabs: rowsFor(idA, "https://owner.example/"), selected_tab_id: "tab-2" }) },
    __spacesState: () => ({ spaces: [spaceA] }),
  });
  hosts.set(winB, {
    Tabs: { list: async () => ({ tabs: rowsFor(idB, "https://second.example/"), selected_tab_id: "tab-2" }) },
    __spacesState: () => ({ spaces: [spaceA, spaceThird] }),
  });
  globalThis.Services.astraHosts = hosts;
  let written = null;
  Boot.coreCall = async ({ name = "", payload = {} } = {}) => {
    if (name === "session.load") return { payload: { snapshot: null } };
    written = JSON.parse(payload.snapshot ?? "null");
    return { payload: { updated_at: 1 } };
  };
  const prepared = await Metadata.prepare({ window_id: idA });
  check("the owner prepares against the sidecar", prepared.state === "empty", JSON.stringify(prepared));
  const saved = await Metadata.save({ prefer_window_id: idB });
  check("the owner saves a merged organisation", saved.saved === true && saved.tabs === 2, JSON.stringify(saved));
  check(
    "the second window's page is in the written snapshot",
    written?.tabs.some((entry) => entry.url === "https://second.example/"),
    JSON.stringify(written?.tabs.map((entry) => entry.url)),
  );
  check(
    "the second window's space is in the written snapshot",
    written?.spaces.some((entry) => entry.uuid === "space-3"),
    JSON.stringify(written?.spaces.map((entry) => entry.uuid)),
  );
  check("both windows are in the written snapshot", written?.windows.length === 2, JSON.stringify(written?.windows));
  const flushed = await Metadata.flush();
  check("quit still writes the merged organisation", flushed.saved === true && flushed.tabs === 2, JSON.stringify(flushed));
  Boot.coreCall = originalCoreCall;
  windows.__resetWindowsForTests();
  delete globalThis.Services;
  Metadata.__resetForTests();
}

console.log(
  `\nmetadata restore contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);

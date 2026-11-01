#!/usr/bin/env node
// P2-T09 contract test: Host API Session module — snapshot/restore
// round-trip (tabs, spaces, folders, scroll, per-tab state).
//
// Imports the chrome modules by file path (pure logic, no Firefox
// internals) and asserts:
//   - every call echoes `request_id` + `host_api_version: 1`
//   - failures return `{ request_id, host_api_version, error }`
//   - round-trip: describe → reset (kill -9) → restore → identical
//     organisation (URLs, order, pins, titles, spaces, scroll)
//   - conflict: live-existence wins (live-only tabs kept), core wins
//     organisation (order/pins/selection from the snapshot)
//   - validation rejects broken snapshots with `invalid_snapshot`
//   - private windows and their tabs are never snapshotted
//
// Usage: node tests/contract/session_restore.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Windows, Tabs } = HostAPI;
const { Session, validateSnapshot, __resetSessionForTests } = await import(
  path.join(HOST, "Session.sys.mjs")
);

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

function checkEnv(name, res, rid) {
  check(`${name} echoes request_id`, res.request_id === rid);
  check(`${name} carries host_api_version 1`, res.host_api_version === 1);
}

function checkErr(name, res, rid, code) {
  checkEnv(name, res, rid);
  check(`${name} errors ${code}`, !!res.error && res.error.code === code);
}

function reset() {
  HostAPI.__resetForTests();
  __resetSessionForTests();
}

reset();

// === Envelope + validate ===
{
  const bad = await Session.restore({ request_id: "s-0", snapshot: null });
  checkErr("restore null snapshot", bad, "s-0", "invalid_snapshot");

  const v = await Session.validate({ request_id: "s-1", snapshot: null });
  checkErr("validate null snapshot", v, "s-1", "invalid_snapshot");

  const wrong = await Session.validate({
    request_id: "s-2",
    snapshot: { version: 999, name: "last", created_at: 0, tabs: [] },
  });
  checkErr("validate wrong version", wrong, "s-2", "invalid_snapshot");
  check(
    "validateSnapshot reports version reason",
    (validateSnapshot({ version: 999, name: "x", created_at: 0, tabs: [] }) ?? "").includes("version"),
  );

  const noUrl = await Session.validate({
    request_id: "s-3",
    snapshot: {
      version: 1,
      name: "last",
      created_at: 0,
      tabs: [{ astra_tab_id: "t1", url: "", position: 0 }],
    },
  });
  checkErr("validate empty url", noUrl, "s-3", "invalid_snapshot");
}

// === Split layout carry-through (P3-T06) ===
{
  const layout = {
    version: 1,
    slots: [
      { slot_id: "a", astra_tab_id: null, ratio: 0.6, position: 0 },
      { slot_id: "b", astra_tab_id: null, ratio: 0.4, position: 1 },
    ],
    active_slot_id: "a",
  };
  const base = { version: 1, name: "last", created_at: 0, tabs: [] };
  const good = await Session.validate({ request_id: "s-4", snapshot: { ...base, layout } });
  check("validate accepts layout", good.valid === true);
  check(
    "validateSnapshot accepts layout",
    validateSnapshot({ ...base, layout }) === null,
  );
  for (const [name, bad] of [
    ["layout wrong version", { ...layout, version: 2 }, "version"],
    ["layout ratio sum", { ...layout, slots: layout.slots.map((s) => ({ ...s, ratio: 0.9 })) }, "sum to 1.0"],
    ["layout duplicate slot", { ...layout, slots: [layout.slots[0], layout.slots[0]] }, "duplicate"],
    ["layout unknown active", { ...layout, active_slot_id: "zzz" }, "not in layout"],
    ["layout not object", "wide", "object"],
  ]) {
    const v = await Session.validate({ request_id: "s-5", snapshot: { ...base, layout: bad } });
    checkErr(`validate ${name}`, v, "s-5", "invalid_snapshot");
    check(
      `validateSnapshot reports ${name}`,
      (validateSnapshot({ ...base, layout: bad }) ?? "").length > 0,
    );
  }
  check(
    "validateSnapshot reports reason text",
    (validateSnapshot({ ...base, layout: { ...layout, version: 2 } }) ?? "").includes("version"),
  );

  // describe contributes no layout (core owns it); restore echoes it back.
  const d = await Session.describe({ request_id: "s-6" });
  check("describe layout null", d.snapshot && d.snapshot.layout === null);
  const r = await Session.restore({ request_id: "s-7", snapshot: { ...base, layout } });
  check("restore echoes layout", JSON.stringify(r.layout) === JSON.stringify(layout));
  const r2 = await Session.restore({ request_id: "s-8", snapshot: base });
  check("restore layout null when absent", r2.layout === null);
}

// === describe on empty + scroll sidecar ===
{
  const d = await Session.describe({ request_id: "s-10" });
  checkEnv("describe empty", d, "s-10");
  check("describe snapshot version 1", d.snapshot.version === 1);
  check("describe empty tabs", d.snapshot.tabs.length === 0);
  check("describe default window present", d.snapshot.windows.some((w) => w.window_id === "win-1"));

  const gs = await Session.getScroll({ request_id: "s-11", astra_tab_id: "tab-nope" });
  checkEnv("getScroll unknown", gs, "s-11");
  check("getScroll null when unset", gs.scroll === null);

  const t = await Tabs.create({ request_id: "s-12", url: "https://a.example/" });
  const ss = await Session.setScroll({ request_id: "s-13", astra_tab_id: t.astra_tab_id, x: 0, y: 240 });
  checkEnv("setScroll", ss, "s-13");
  check("scroll kept", ss.scroll.x === 0 && ss.scroll.y === 240);
  const gs2 = await Session.getScroll({ request_id: "s-14", astra_tab_id: t.astra_tab_id });
  check("getScroll returns stored", gs2.scroll.x === 0 && gs2.scroll.y === 240);
  checkErr(
    "setScroll unknown tab",
    await Session.setScroll({ request_id: "s-15", astra_tab_id: "tab-nope", x: 0, y: 0 }),
    "s-15",
    "no_such_tab",
  );
  checkErr(
    "setScroll bad coords",
    await Session.setScroll({ request_id: "s-16", astra_tab_id: t.astra_tab_id, x: 1.5, y: 0 }),
    "s-16",
    "invalid_scroll",
  );

  const d2 = await Session.describe({ request_id: "s-17" });
  check("describe carries scroll", d2.snapshot.tabs[0].scroll?.y === 240);
}

// === Round-trip: snapshot → kill -9 (reset) → restore → identical ===
let savedSnapshot;
{
  reset();
  const a = await Tabs.create({ request_id: "r-1", url: "https://a.example/" });
  const b = await Tabs.create({ request_id: "r-2", url: "https://b.example/", background: true });
  const c = await Tabs.create({ request_id: "r-3", url: "https://c.example/", background: true });
  await Tabs.setTitle({ request_id: "r-4", astra_tab_id: a.astra_tab_id, title: "A page" });
  await Tabs.pin({ request_id: "r-5", astra_tab_id: a.astra_tab_id });
  await Tabs.setMuted({ request_id: "r-6", astra_tab_id: b.astra_tab_id, muted: true });
  await Session.setScroll({ request_id: "r-7", astra_tab_id: a.astra_tab_id, x: 0, y: 500 });
  await Session.setScroll({ request_id: "r-8", astra_tab_id: c.astra_tab_id, x: 10, y: 20 });
  await Tabs.select({ request_id: "r-9", astra_tab_id: b.astra_tab_id });

  const d = await Session.describe({ request_id: "r-10" });
  checkEnv("describe pre-kill", d, "r-10");
  // Enrich with core-owned organisation (spaces/folders live in core).
  savedSnapshot = {
    ...d.snapshot,
    spaces: [{ uuid: "space-work", name: "Work", position: 0 }],
    folders: [{ uuid: "folder-inbox", space_uuid: "space-work", name: "Inbox", position: 0 }],
    tabs: d.snapshot.tabs.map((t, i) =>
      i === 0
        ? { ...t, space_uuid: "space-work", folder_uuid: "folder-inbox" }
        : { ...t, space_uuid: "space-work" },
    ),
  };
  const vv = await Session.validate({ request_id: "r-11", snapshot: savedSnapshot });
  checkEnv("validate enriched snapshot", vv, "r-11");
  check("enriched snapshot valid", vv.valid === true);
  check("three tabs captured", savedSnapshot.tabs.length === 3);

  // Kill -9: drop all host state (tabs, windows, events, scroll sidecar).
  reset();
  const empty = await Tabs.list({ request_id: "r-12" });
  check("kill leaves no tabs", empty.tabs.length === 0);

  const res = await Session.restore({ request_id: "r-13", snapshot: savedSnapshot });
  checkEnv("restore after kill", res, "r-13");
  check("restore reports restored", res.restored === true);
  check("restore recreated 3 tabs", res.created.length === 3);
  check("restore order length 3", res.order.length === 3);
  check("restore scroll intents for scrolled tabs", res.scroll_intents.length === 2);

  const after = await Session.describe({ request_id: "r-14" });
  // Organisation equality by content + placement (host mints fresh tab ids
  // on restore, so ids are excluded — see Session.sys.mjs header). Spaces
  // live in core and are asserted on the Rust side; here the host-owned
  // fields (url, pin, title, scroll) must match in order.
  const contentView = (tabs) =>
    [...tabs]
      .sort((a, b) => a.position - b.position)
      .map((t) => [t.url, t.pinned, t.title, t.scroll ? `${t.scroll.x},${t.scroll.y}` : null]);
  check(
    "organisation identical after kill (urls/pins/titles/scroll/order)",
    JSON.stringify(contentView(after.snapshot.tabs)) ===
      JSON.stringify(contentView(savedSnapshot.tabs)),
  );
  check(
    "urls restored in order",
    after.snapshot.tabs.map((t) => t.url).join() ===
      savedSnapshot.tabs.map((t) => t.url).join(),
  );
  check(
    "pins restored",
    after.snapshot.tabs.map((t) => t.pinned).join() ===
      savedSnapshot.tabs.map((t) => t.pinned).join(),
  );
  check(
    "titles restored",
    after.snapshot.tabs.map((t) => t.title).join() ===
      savedSnapshot.tabs.map((t) => t.title).join(),
  );
  check(
    "scroll restored",
    JSON.stringify(after.snapshot.tabs.map((t) => t.scroll)) ===
      JSON.stringify(savedSnapshot.tabs.map((t) => t.scroll)),
  );
  // Active tab: snapshot active was tab B (by old id); mapped restore must
  // select the tab with B's URL.
  const activeUrl = after.snapshot.tabs.find(
    (t) => t.astra_tab_id === after.snapshot.active_tab_id,
  )?.url;
  check("active tab restored (B)", activeUrl === "https://b.example/");
}

// === Conflict: live-existence wins, core organisation wins ===
{
  reset();
  // Live world: B survived, C is new (never in the snapshot).
  const bLive = await Tabs.create({ request_id: "c-1", url: "https://b.example/" });
  const cLive = await Tabs.create({ request_id: "c-2", url: "https://c-new.example/", background: true });

  // Snapshot knows A + B (A was closed live; B needs re-pinning per core).
  const snapshot = {
    version: 1,
    name: "last",
    created_at: 0,
    spaces: [],
    folders: [],
    windows: [{ window_id: "win-1", focused: true, title: "" }],
    tabs: [
      {
        astra_tab_id: "snap-a",
        url: "https://a.example/",
        title: "A core",
        pinned: true,
        position: 0,
        window_id: "win-1",
      },
      {
        astra_tab_id: bLive.astra_tab_id, // same id: B exists live
        url: "https://b.example/",
        title: "B core title",
        pinned: true,
        position: 1,
        window_id: "win-1",
      },
    ],
    active_tab_id: bLive.astra_tab_id,
  };
  void cLive;
  const res = await Session.restore({ request_id: "c-3", snapshot });
  checkEnv("conflict restore", res, "c-3");
  check("missing snapshot tab recreated", res.created.length === 1);
  check(
    "recreated tab carries snapshot URL",
    (await Tabs.get({ request_id: "c-4", astra_tab_id: res.created[0].astra_tab_id })).tab.url ===
      "https://a.example/",
  );

  const list = await Tabs.list({ request_id: "c-5" });
  const urls = list.tabs.map((t) => t.url);
  check("live-only tab survives (live-existence wins)", urls.includes("https://c-new.example/"));
  check("no live tab closed", list.tabs.length === 3);
  check(
    "core order first, live-only appended (core organisation wins)",
    urls[0] === "https://a.example/" && urls[1] === "https://b.example/" && urls[2] === "https://c-new.example/",
  );
  const bAfter = list.tabs.find((t) => t.url === "https://b.example/");
  check("core pin applied to live tab", bAfter.pinned === true);
  check("core title applied to live tab", bAfter.title === "B core title");
  check("snapshot selection applied", list.selected_tab_id === bAfter.astra_tab_id);
}

// === Private windows never snapshotted ===
{
  reset();
  const priv = await Windows.create({ request_id: "p-1", private: true });
  await Tabs.create({ request_id: "p-2", url: "https://secret.example/", window_id: priv.window_id });
  await Tabs.create({ request_id: "p-3", url: "https://public.example/" });
  const d = await Session.describe({ request_id: "p-4" });
  checkEnv("describe with private window", d, "p-4");
  check("private window excluded", !d.snapshot.windows.some((w) => w.window_id === priv.window_id));
  check(
    "private tab excluded",
    !d.snapshot.tabs.some((t) => t.url === "https://secret.example/"),
  );
  check("public tab kept", d.snapshot.tabs.some((t) => t.url === "https://public.example/"));
}

// === Schema file parses and matches the module surface ===
{
  const schemaText = await (await import("node:fs/promises")).readFile(
    path.join(HOST, "schemas", "session.json"),
    "utf8",
  );
  const schema = JSON.parse(schemaText);
  check("schema snapshot version const 1", schema.properties.snapshot_version.const === 1);
  for (const fn of ["describe", "validate", "setScroll", "getScroll", "restore"]) {
    check(`schema documents Session.${fn}`, !!schema.properties[fn]);
  }
  check("schema requires tab url", schema.properties.Tab.required.includes("url"));
}

console.log(`session contract: ${failed ? "FAIL" : `PASS (${passed} checks)`}`);
if (failed) {
  process.exitCode = 1;
}

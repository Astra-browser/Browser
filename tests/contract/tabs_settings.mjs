#!/usr/bin/env node
// Lane 1 — Tabs settings on their real consumers.
//
//   tabs.new-position      Tabs.create inserts after the current tab and
//                          announces the index Content passes to gb.addTab.
//   tabs.external-position  an adopted native tab splices at its native
//                          position; `new-tab` resolves through
//                          tabs.new-position on every open.
//   tabs.after-close       next / previous / recent (bounded per-window MRU),
//                          with per-window teardown.
//   tabs.close-button      the packed UI binds data-close-buttons to the
//                          setting; pinned/essential rows have no close.
//   tabs.archive           a per-window timer closes idle Today tabs after the
//                          chosen age, with an injectable clock; the tab goes,
//                          the Places visit stays.
//
// Usage: node tests/contract/tabs_settings.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const {
  Tabs,
  __adoptNative,
  __announceAdopted,
  __archiveSchedulerActiveForTests,
  __archiveSweep,
  __closeTabsInWindow,
  __itemsSnapshot,
  __mruForTests,
  __resetTabsForTests,
  __setArchiveClockForTests,
  __setTabLastActiveForTests,
  __startArchiveScheduler,
  __stopArchiveScheduler,
  resolveExternalPosition,
} = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href);
const { Settings, __resetSettingsForTests } = await import(pathToFileURL(path.join(HOST, "Settings.sys.mjs")).href);
const { addEventListener, __resetEventsForTests } = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function reset() {
  __resetTabsForTests();
  __resetSettingsForTests();
  __resetEventsForTests();
}

async function list() {
  return (await Tabs.list({ request_id: "tabs-settings" })).tabs;
}

async function order() {
  return (await list()).map((tab) => tab.astra_tab_id);
}

async function selected() {
  return (await Tabs.list({ request_id: "tabs-settings-selected" })).selected_tab_id;
}

async function makeTab(url, background = true) {
  const result = await Tabs.create({
    request_id: `tabs-settings-${url}`,
    url,
    background,
  });
  assert.equal(result.accepted, true);
  return result.astra_tab_id;
}

async function threeTabs() {
  const a = (await Tabs.bootstrap({ request_id: "boot" })).selected_tab_id;
  const b = await makeTab("https://b.example/");
  const c = await makeTab("https://c.example/");
  return { a, b, c };
}

// === tabs.new-position ===================================================
{
  reset();
  const { a, b, c } = await threeTabs();
  await Settings.set({ key: "tabs.new-position", value: "after-current" });
  await Tabs.select({ request_id: "select-b", astra_tab_id: b });

  const created = [];
  const off = addEventListener((event) => {
    if (event.type === "tab.created") created.push(event);
  });
  const n = await makeTab("https://new.example/", false);
  off();

  check(
    "after-current opens immediately after the selected tab",
    (await order()).join() === [a, b, n, c].join(),
    (await order()).join(),
  );
  check(
    "the sidebar projection uses the same order",
    __itemsSnapshot().tabs.map((tab) => tab.id).join() === [a, b, n, c].join(),
  );
  const event = created.find((entry) => entry.data.astra_tab_id === n);
  check("tab.created announces the native tab index", event?.data.index === 2, String(event?.data.index));
  check("create reports the model position", (await Tabs.get({ request_id: "get", astra_tab_id: n })).tab.index === 2);

  // An explicit index (duplicate, history stack) still wins over the setting.
  const pinned = await Tabs.create({
    request_id: "explicit",
    url: "https://explicit.example/",
    background: true,
    index: 1,
  });
  check(
    "an explicit index still positions the tab",
    (await order())[1] === pinned.astra_tab_id,
    (await order()).join(),
  );

  reset();
  await Settings.set({ key: "tabs.new-position", value: "end" });
  const defaults = await threeTabs();
  await Tabs.select({ request_id: "select-default-b", astra_tab_id: defaults.b });
  const end = await makeTab("https://end.example/", false);
  check(
    "end appends to the strip",
    (await order()).join() === [defaults.a, defaults.b, defaults.c, end].join(),
    (await order()).join(),
  );
}

// === tabs.external-position =============================================
{
  reset();
  await Settings.set({ key: "tabs.external-position", value: "new-tab" });
  await Settings.set({ key: "tabs.new-position", value: "end" });
  const { a, b, c } = await threeTabs();
  await Tabs.select({ request_id: "select-b", astra_tab_id: b });

  // An engine tab opened between B and C must adopt there, not at the end.
  const between = __adoptNative({
    url: "https://between.example/",
    window_id: "win-1",
    after: b,
    before: c,
  });
  __announceAdopted(between);
  check(
    "an adopted native tab splices at its native position",
    (await order()).join() === [a, b, between, c].join(),
    (await order()).join(),
  );

  const afterB = __adoptNative({
    url: "https://after-b.example/",
    window_id: "win-1",
    after: b,
  });
  __announceAdopted(afterB);
  check(
    "an after anchor inserts directly behind it",
    (await order()).indexOf(afterB) === (await order()).indexOf(b) + 1,
  );

  const beforeA = __adoptNative({
    url: "https://before-a.example/",
    window_id: "win-1",
    before: a,
  });
  __announceAdopted(beforeA);
  check("a before anchor inserts directly in front", (await order())[0] === beforeA);

  // `new-tab` is not a placement: it resolves through tabs.new-position, and
  // the resolver is live, so a settings change applies to the next open.
  check("new-tab resolves to end when new-position is end", resolveExternalPosition() === "end");
  await Settings.set({ key: "tabs.new-position", value: "after-current" });
  check(
    "new-tab re-resolves when new-position changes",
    resolveExternalPosition() === "after-current",
  );
  const fallback = __adoptNative({
    url: "https://fallback.example/",
    window_id: "win-1",
  });
  __announceAdopted(fallback);
  check(
    "an adoption without native neighbours obeys the resolved placement",
    (await order()).indexOf(fallback) === (await order()).indexOf(b) + 1,
    (await order()).join(),
  );

  await Settings.set({ key: "tabs.external-position", value: "after-current" });
  await Settings.set({ key: "tabs.new-position", value: "end" });
  check(
    "an explicit external placement is not overridden by new-position",
    resolveExternalPosition() === "after-current",
  );
  await Settings.set({ key: "tabs.external-position", value: "end" });
  check("an explicit end stays end", resolveExternalPosition() === "end");
}

// === tabs.after-close ====================================================
{
  reset();
  let { a, b, c } = await threeTabs();
  await Tabs.select({ request_id: "select-b", astra_tab_id: b });
  await Settings.set({ key: "tabs.after-close", value: "next" });
  await Tabs.close({ request_id: "close-b", astra_tab_id: b });
  check("next selects the tab that took its place", (await selected()) === c, await selected());

  reset();
  ({ a, b, c } = await threeTabs());
  await Tabs.select({ request_id: "select-b", astra_tab_id: b });
  await Settings.set({ key: "tabs.after-close", value: "previous" });
  await Tabs.close({ request_id: "close-b", astra_tab_id: b });
  check("previous selects the tab before it", (await selected()) === a, await selected());

  reset();
  ({ a, b, c } = await threeTabs());
  await Tabs.select({ request_id: "select-a", astra_tab_id: a });
  await Settings.set({ key: "tabs.after-close", value: "previous" });
  await Tabs.close({ request_id: "close-a", astra_tab_id: a });
  check("previous at the first row falls forward to the new first", (await selected()) === b, await selected());

  reset();
  ({ a, b, c } = await threeTabs());
  await Tabs.select({ request_id: "select-c", astra_tab_id: c });
  await Settings.set({ key: "tabs.after-close", value: "next" });
  await Tabs.close({ request_id: "close-c", astra_tab_id: c });
  check("next at the last row falls back to the previous tab", (await selected()) === b, await selected());

  reset();
  ({ a, b, c } = await threeTabs());
  await Tabs.select({ request_id: "select-b-1", astra_tab_id: b });
  await Tabs.select({ request_id: "select-c", astra_tab_id: c });
  await Tabs.select({ request_id: "select-b-2", astra_tab_id: b });
  await Settings.set({ key: "tabs.after-close", value: "recent" });
  await Tabs.close({ request_id: "close-b", astra_tab_id: b });
  check("recent selects the last used other tab", (await selected()) === c, await selected());

  // A tab from another space is not a valid recent target.
  reset();
  ({ a, b, c } = await threeTabs());
  await Tabs.select({ request_id: "select-b", astra_tab_id: b });
  const other = await Tabs.createSpace({ request_id: "space", name: "Other" });
  check("a second space is admitted", other.accepted === true);
  const otherTab = (await selected());
  await Tabs.switchSpace({ request_id: "back", space: "space-1" });
  await Tabs.select({ request_id: "select-b-again", astra_tab_id: b });
  await Settings.set({ key: "tabs.after-close", value: "recent" });
  await Tabs.close({ request_id: "close-b", astra_tab_id: b });
  check(
    "recent never jumps into another space",
    (await selected()) === a,
    `${await selected()} (other space tab ${otherTab})`,
  );

  // Bounded stack, and teardown with the window.
  reset();
  const base = (await Tabs.bootstrap({ request_id: "boot" })).selected_tab_id;
  const ids = [base];
  for (let i = 0; i < 30; i += 1) {
    ids.push(await makeTab(`https://mru-${i}.example/`));
  }
  for (const id of ids) {
    await Tabs.select({ request_id: `mru-${id}`, astra_tab_id: id });
  }
  check("the recent stack is bounded", __mruForTests("win-1").length <= 25, String(__mruForTests("win-1").length));
  __closeTabsInWindow("win-1");
  check("closing a window tears its recent stack down", __mruForTests("win-1").length === 0);
}

// === tabs.close-button ===================================================
{
  reset();
  const written = await Settings.set({ key: "tabs.close-button", value: "always" });
  check("close-button is admitted", written.accepted === true);
  check("close-button reads back", (await Settings.get({ key: "tabs.close-button" })) === "always");
  await Settings.set({ key: "tabs.close-button", value: "hover" });
  check("close-button returns to hover", (await Settings.get({ key: "tabs.close-button" })) === "hover");

  const listSource = fs.readFileSync(
    path.join(ROOT, "ui", "app", "src", "features", "tabs", "components", "TabList.svelte"),
    "utf8",
  );
  check(
    "the list binds data-close-buttons to the setting",
    listSource.includes("data-close-buttons={closeButtons}") &&
      listSource.includes('preferences.value("tabs.close-button")'),
  );
  check(
    "only Today rows are closable; essentials/pinned rows have no close control",
    listSource.includes('closable={section === "today"'),
  );

  // The packaged bundle is the UI that actually runs in the dev build. Its
  // binding is compiled differently, but both the attribute and its reactive
  // source have to be present.
  const assets = path.join(ROOT, "overlay", "astra", "chrome", "app", "assets");
  if (fs.existsSync(assets)) {
    const bundle = fs
      .readdirSync(assets)
      // The app is code-split: the tabs list is a lazy chunk, not part of the
      // eager browser-chrome entry. The packed UI is every emitted script.
      .filter((name) => name.endsWith(".js"))
      .map((name) => fs.readFileSync(path.join(assets, name), "utf8"))
      .join("\n");
    if (bundle !== "") {
      check("the packed UI carries data-close-buttons", bundle.includes("data-close-buttons"));
      check("the packed UI keeps the close-button binding reactive", bundle.includes("tabs.close-button"));
    }
  }
}

// === tabs.switch-to-open ==================================================
{
  reset();
  await Tabs.bootstrap({ request_id: "boot" });
  const url = "https://dup.example/";
  const first = await Tabs.create({ request_id: "d-1", url, background: true });
  const count = (await list()).length;
  const again = await Tabs.create({ request_id: "d-2", url, background: true });
  check(
    "a URL already open in this space reuses its tab",
    again.astra_tab_id === first.astra_tab_id && again.existing === true,
    JSON.stringify(again),
  );
  check("no second tab is created", (await list()).length === count);

  await Settings.set({ key: "tabs.switch-to-open", value: "false" });
  const fresh = await Tabs.create({ request_id: "d-3", url, background: true });
  check("off opens a second copy", fresh.astra_tab_id !== first.astra_tab_id);
}

// === tabs.archive ========================================================
{
  const HOUR = 60 * 60 * 1000;
  reset();
  const a = (await Tabs.bootstrap({ request_id: "boot" })).selected_tab_id;
  const b = await makeTab("https://idle-b.example/");
  const c = await makeTab("https://idle-c.example/");
  const now = 1_800_000_000_000;

  await Settings.set({ key: "tabs.archive", value: "12h" });
  __setTabLastActiveForTests(a, now - 13 * HOUR);
  __setTabLastActiveForTests(b, now - 13 * HOUR);
  __setTabLastActiveForTests(c, now - 13 * HOUR);

  let swept = await __archiveSweep({ window_id: "win-1", now });
  check(
    "an idle open tab is archived after 12h",
    swept.archived.includes(b) && swept.archived.includes(c),
    JSON.stringify(swept),
  );
  check("the selected tab is never archived", !swept.archived.includes(a));
  check("the selected tab keeps the stage", (await order()).join() === a);

  // Pinned/essential tabs are not Today tabs and are never closed.
  reset();
  await Tabs.bootstrap({ request_id: "boot-pinned" });
  const pinned = await makeTab("https://kept.example/");
  await Tabs.pin({ request_id: "pin", astra_tab_id: pinned });
  await Settings.set({ key: "tabs.archive", value: "12h" });
  __setTabLastActiveForTests(pinned, now - 13 * HOUR);
  swept = await __archiveSweep({ window_id: "win-1", now });
  check("a kept tab is exempt from archive", !swept.archived.includes(pinned));
  check("the kept tab is still open", (await order()).includes(pinned));

  // Fresh tabs and "never" survive a sweep.
  reset();
  const fresh = (await Tabs.bootstrap({ request_id: "boot-fresh" })).selected_tab_id;
  const idle = await makeTab("https://not-old-enough.example/");
  await Settings.set({ key: "tabs.archive", value: "12h" });
  __setTabLastActiveForTests(idle, now - 11 * HOUR);
  swept = await __archiveSweep({ window_id: "win-1", now });
  check("a tab younger than the age is untouched", swept.archived.length === 0 && (await order()).includes(idle));

  await Settings.set({ key: "tabs.archive", value: "never" });
  __setTabLastActiveForTests(idle, now - 100 * 24 * HOUR);
  swept = await __archiveSweep({ window_id: "win-1", now });
  check("never disables the sweep", swept.age_ms === 0 && swept.archived.length === 0);
  check("never leaves the tab open", (await order()).includes(idle) && (await order()).includes(fresh));

  // The timer is real, injectable and torn down per window.
  reset();
  await Tabs.bootstrap({ request_id: "boot-timer" });
  const timed = await makeTab("https://timed.example/");
  await Settings.set({ key: "tabs.archive", value: "12h" });
  __setTabLastActiveForTests(timed, now - 13 * HOUR);
  let tick = null;
  let interval = 0;
  let cleared = 0;
  __startArchiveScheduler({
    window_id: "win-1",
    now: () => now,
    intervalMs: 1234,
    setIntervalFn: (fn, ms) => {
      tick = fn;
      interval = ms;
      return "timer-1";
    },
    clearIntervalFn: () => {
      cleared += 1;
    },
  });
  check("the archive timer starts", __archiveSchedulerActiveForTests("win-1"));
  check("the sweep interval is the host's, not performance.after", interval === 1234);
  check("the timer was scheduled", typeof tick === "function");
  tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("a timer tick archives the idle tab", !(await order()).includes(timed));
  check("stopping the timer clears it", __stopArchiveScheduler("win-1") && cleared === 1);
  check("the stopped window has no timer", !__archiveSchedulerActiveForTests("win-1"));

  __startArchiveScheduler({
    window_id: "win-1",
    setIntervalFn: () => "timer-2",
    clearIntervalFn: () => {
      cleared += 1;
    },
  });
  __closeTabsInWindow("win-1");
  check("closing the window stops its archive timer", !__archiveSchedulerActiveForTests("win-1"));
  check("window teardown cleared the second timer", cleared === 2, String(cleared));
  check("closing a window closes its tabs", (await order()).length === 0);

  // The clock seam is restored for later suites.
  __setArchiveClockForTests(null);
}

console.log(
  `\ntabs settings contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exitCode = failed === 0 ? 0 : 1;

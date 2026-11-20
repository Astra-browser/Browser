#!/usr/bin/env node
// Commands module contract (wiring slice 1): `run_command` executes product
// commands natively instead of failing with `unknown_command`.
//
//   - every browser-surface command is announced on `ui-command` before the
//     admission returns, so the UI only moves once native agreed
//   - leaving a surface (`browser.return`) is announced the same way
//   - an id that is not ported yet is refused (`accepted: false`), never
//     silently accepted
//   - the admission shape is what the UI's `settle()` expects
//     (`{ accepted, operation_id }`, no operation to observe)
//
// Usage: node tests/contract/commands_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href);
const { Commands, addEventListener, __resetForTests } = HostAPI;
// The same module instance HostAPI re-exports (one URL, one cache entry), so
// the reopen seam drives the Commands the product calls.
const { __setReopenForTests, __resetCommandsForTests } = await import(
  pathToFileURL(path.join(HOST, "Commands.sys.mjs")).href
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

__resetForTests();

/** Collect the `ui-command` payloads a call emits. */
async function capture(fn) {
  const seen = [];
  const off = addEventListener((event) => {
    if (event.type === "ui-command") seen.push(event.data);
  });
  const result = await fn();
  off();
  return { seen, result };
}

const PAGES = [
  "settings",
  "work",
  "extensions",
  "history",
  "downloads",
  "tasks",
  "notes",
  "time",
  "source",
];

for (const page of PAGES) {
  const id = `browser.${page}`;
  const { seen, result } = await capture(() => Commands.run({ id }));
  check(`${id} is admitted`, result.accepted === true);
  check(`${id} has no operation to observe`, result.operation_id === null);
  check(`${id} announces the surface`, seen.length === 1 && seen[0] === id);
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "browser.return" }));
  check("browser.return is admitted", result.accepted === true);
  check("browser.return announces the return", seen.length === 1 && seen[0] === "browser.return");
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "page.autofillPassword" }));
  check("an unported command is refused", result.accepted === false);
  check("an unported command announces nothing", seen.length === 0);
}

// The dock's private-window control and the private bar's close control run
// these ids. They were absent from the allowlist, so the click was silently
// refused (the incognito icon did nothing).
for (const id of [
  "window.new",
  "window.newPrivate",
  "window.togglePrivate",
  "window.closePrivate",
]) {
  const { seen, result } = await capture(() => Commands.run({ id }));
  check(`${id} is admitted`, result.accepted === true);
  check(`${id} is announced to the chrome`, seen.length === 1 && seen[0] === id);
}

{
  const { result } = await capture(() => Commands.run({ id: "" }));
  check("an empty id is refused", result.accepted === false);
}

{
  const { result } = await capture(() => Commands.run({}));
  check("a missing id is refused", result.accepted === false);
}

{
  const { result } = await capture(() => Commands.run({ id: "browser.unknown" }));
  check("an unknown surface is refused", result.accepted === false);
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "tool.notes" }));
  check("a tool command is admitted", result.accepted === true);
  check("a tool command announces the tool", seen.length === 1 && seen[0] === "tool.notes");
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "tool.nope" }));
  check("an unknown tool is refused", result.accepted === false);
  check("an unknown tool announces nothing", seen.length === 0);
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "note.new" }));
  check("note.new is admitted", result.accepted === true);
  check("note.new announces itself", seen.length === 1 && seen[0] === "note.new");
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "settings.ai" }));
  check("a settings section is admitted", result.accepted === true);
  check(
    "a settings section names the section, then the page",
    seen.length === 2 && seen[0] === "settings.section.ai" && seen[1] === "browser.settings",
  );
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "settings.section.profiles" }));
  check("an explicit settings.section id is admitted", result.accepted === true);
  check(
    "an explicit settings.section id names the page too",
    seen.length === 2 && seen[0] === "settings.section.profiles" && seen[1] === "browser.settings",
  );
}

{
  const { seen, result } = await capture(() => Commands.run({ id: "settings.nope" }));
  check("an unknown settings section is refused", result.accepted === false);
  check("an unknown settings section announces nothing", seen.length === 0);
}

{
  const supported = await Commands.supported();
  check("supported() lists every page command", PAGES.every((p) => supported.includes(`browser.${p}`)));
  check("supported() includes browser.return", supported.includes("browser.return"));
  check("supported() lists the tools", supported.includes("tool.notes") && supported.includes("tool.ai"));
  check("supported() lists the settings sections", supported.includes("settings.ai"));
  assert.ok(supported.includes("browser.work"));
}

// === Commands act on the calling window's tab, not the process-wide last ===
{
  const { Tabs } = HostAPI;
  const a1 = (await Tabs.create({ request_id: "c-a1", url: "https://a.test/1", window_id: "win-a" })).astra_tab_id;
  const a2 = (await Tabs.create({ request_id: "c-a2", url: "https://a.test/2", window_id: "win-a", background: true })).astra_tab_id;
  const b1 = (await Tabs.create({ request_id: "c-b1", url: "https://b.test/", window_id: "win-b" })).astra_tab_id;
  await Tabs.select({ request_id: "c-s1", astra_tab_id: a1 });
  await Tabs.select({ request_id: "c-s2", astra_tab_id: b1 });
  const moved = await Commands.run({ id: "tab.next", window_id: "win-a" });
  const inA = await Tabs.list({ request_id: "c-la", window_id: "win-a" });
  const inB = await Tabs.list({ request_id: "c-lb", window_id: "win-b" });
  check("tab.next is admitted for its own window", moved.accepted === true);
  check(
    "tab.next moves the calling window's selection",
    inA.selected_tab_id === a2,
    JSON.stringify({ selected: inA.selected_tab_id, a2 }),
  );
  check(
    "tab.next leaves the other window's selection alone",
    inB.selected_tab_id === b1,
    JSON.stringify({ selected: inB.selected_tab_id, b1 }),
  );
}

// === Reopen a closed tab ==================================================
// The engine owns the closed-tab stack (SessionStore), per window. The command
// must reopen in the window that pressed the key and must never claim a reopen
// the engine did not perform.
{
  const { seen, result } = await capture(() => Commands.run({ id: "tab.reopen" }));
  check("tab.reopen without the engine is refused", result.accepted === false);
  check("tab.reopen names the missing engine", result.reason === "unavailable");
  check("tab.reopen announces nothing", seen.length === 0);

  const win = { closed: false };
  const calls = [];
  const store = (count, undo = () => ({ id: "native" })) => ({
    getClosedTabCountForWindow(target) {
      calls.push(["count", target]);
      return count;
    },
    undoCloseTab(...args) {
      calls.push(["undo", ...args]);
      return undo();
    },
  });

  __setReopenForTests({ window: win, store: store(0) });
  const empty = await capture(() => Commands.run({ id: "tab.reopen" }));
  check("an empty closed-tab stack is refused", empty.result.accepted === false);
  check("an empty stack is not asked to undo", empty.result.reason === "empty");
  check(
    "an empty stack calls no undo",
    !calls.some(([kind]) => kind === "undo"),
  );

  calls.length = 0;
  __setReopenForTests({ window: win, store: store(1) });
  const opened = await Commands.run({ id: "tab.reopen", window_id: "win-a" });
  check("tab.reopen is admitted when the engine has one", opened.accepted === true);
  check("tab.reopen has no operation to observe", opened.operation_id === null);
  const undo = calls.find(([kind]) => kind === "undo");
  check(
    "tab.reopen undoes in the calling window",
    undo?.[1] === win && undo?.[2] === 0 && undo?.[3] === win,
    JSON.stringify(calls),
  );

  __setReopenForTests({
    window: win,
    store: store(2, () => {
      throw new Error("gone");
    }),
  });
  const thrown = await Commands.run({ id: "tab.reopen" });
  check("a refused undo is not a reopened tab", thrown.accepted === false);
  check("a refused undo names the refusal", thrown.reason === "refused");

  __setReopenForTests(null);
}

// === Duplicate the tab in front ===========================================
{
  const { Tabs } = HostAPI;
  const src = await Tabs.create({ request_id: "dup-src", url: "https://dup.test/page" });
  await Tabs.select({ request_id: "dup-sel", astra_tab_id: src.astra_tab_id });
  const before = (await Tabs.list({ request_id: "dup-0" })).tabs;
  const { result } = await capture(() => Commands.run({ id: "tab.duplicate" }));
  const after = (await Tabs.list({ request_id: "dup-1" })).tabs;
  check("tab.duplicate is admitted", result.accepted === true);
  check(
    "tab.duplicate adds one tab with the same URL",
    after.length === before.length + 1 &&
      after.some(
        (tab) => tab.astra_tab_id !== src.astra_tab_id && tab.url === "https://dup.test/page",
      ),
    String(after.length),
  );
}

// === Print has no Astra surface yet =======================================
{
  const { seen, result } = await capture(() => Commands.run({ id: "page.print" }));
  check("page.print is refused", result.accepted === false);
  check("page.print names the refusal", result.reason === "unavailable");
  check(
    "page.print asks the app for a notice",
    seen.length === 1 && seen[0] === "notice.print-unavailable",
  );
  check("page.print never reaches the native print path", !seen.includes("page.print"));
}

// === The launcher's key toggles once per press ============================
{
  __resetCommandsForTests();
  const first = await capture(() => Commands.run({ id: "launcher.toggle" }));
  const second = await capture(() => Commands.run({ id: "launcher.toggle" }));
  check(
    "launcher.toggle asks the app to open the launcher",
    first.seen.length === 1 && first.seen[0] === "launcher.toggle",
  );
  check("the first delivery is admitted", first.result.accepted === true);
  check(
    "a second delivery of one press does not toggle back",
    second.seen.length === 0,
  );
  check("the coalesced press still reports handled", second.result.accepted === true);
  __resetCommandsForTests();
  const later = await capture(() => Commands.run({ id: "launcher.toggle" }));
  check("a press after the coalescing window toggles again", later.seen.length === 1);
}

// === The launcher's key reaches the window's keymap ======================
// The chrome key handler builds its map from `Keymap.entries()`. The launcher
// stores its key elsewhere, so without this the window kept matching the
// registry default after a rebind and ate the chord while recording.
{
  const { Keymap, Launcher } = HostAPI;
  const row = async () =>
    (await Keymap.entries({ platform: "other" })).find((entry) => entry.id === "launcher.toggle");
  await Launcher.trigger();
  check(
    "the launcher publishes its shortcut to the keymap",
    (await row()).accelerator === "Ctrl+Shift+Space",
    JSON.stringify(await row()),
  );
  await Launcher.recordShortcut({ active: true });
  check(
    "the recorder silences the launcher key in the window",
    (await row()).accelerator === null,
  );
  await Launcher.recordShortcut({ active: false });
  check(
    "stopping the recorder restores the launcher key",
    (await row()).accelerator === "Ctrl+Shift+Space",
  );
}

// === The sidebar's compact toggle was advertised and unrouted ============
{
  const { seen, result } = await capture(() => Commands.run({ id: "sidebar.toggleCompact" }));
  check("sidebar.toggleCompact is admitted", result.accepted === true);
  check(
    "sidebar.toggleCompact reaches the app",
    seen.length === 1 && seen[0] === "sidebar.toggleCompact",
  );
}

// === Advertised commands without a surface are refused by name ===========
{
  const unavailable = await Commands.unavailable();
  check("some advertised commands are explicitly unavailable", unavailable.length > 0);
  for (const id of unavailable) {
    const { seen, result } = await capture(() => Commands.run({ id }));
    check(`${id} is refused by name`, result.accepted === false && result.reason === "unavailable");
    check(`${id} announces nothing`, seen.length === 0);
  }
}

// === Every keymap id is handled or refused ===============================
{
  const supported = new Set(await Commands.supported());
  const refused = new Set(await Commands.unavailable());
  const entries = await HostAPI.Keymap.entries();
  const base = (id) => id.replace(/\.alt\d*$/u, "");
  const missing = entries
    .map((entry) => base(entry.id))
    .filter((id) => !supported.has(id) && !refused.has(id));
  check(
    "every keymap id is executed or refused by name",
    missing.length === 0,
    missing.join(", "),
  );
  const both = [...supported].filter((id) => refused.has(id));
  check("no id is both executed and refused", both.length === 0, both.join(", "));
  check("supported() lists tab.reopen", supported.has("tab.reopen"));
  check("supported() lists tab.duplicate", supported.has("tab.duplicate"));
  check("supported() lists page.print", supported.has("page.print"));
}

console.log(`\ncommands_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

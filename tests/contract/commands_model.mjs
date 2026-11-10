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
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");

const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Commands, addEventListener, __resetForTests } = HostAPI;

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

console.log(`\ncommands_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

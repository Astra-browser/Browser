#!/usr/bin/env node
// Contract test: the Host API keymap model. Ports the checks the native
// `commands.rs` and `keymap.rs` suites make — one registry, unique ids,
// platform defaults, rebinding, unbinding, conflicts and reset — and adds the
// wire checks Keyboard settings relies on: every entry carries
// `default_accelerator`, and every successful change emits `keymap-changed`.
//
// Usage: node tests/contract/keymap_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Keymap, __resetKeymapForTests, __keymapRecording, featureOf } =
  await import(pathToFileURL(path.join(HOST, "Keymap.sys.mjs")).href);
const { addEventListener, __resetEventsForTests } = await import(
  pathToFileURL(path.join(HOST, "Events.sys.mjs")).href
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

const byId = (entries, id) => entries.find((entry) => entry.id === id);

// Collect `keymap-changed` while the model changes.
__resetEventsForTests();
__resetKeymapForTests();
const changed = [];
const off = addEventListener((event) => {
  if (event.type === "keymap-changed") {
    changed.push(event);
  }
});

// === Registry ===
{
  const other = await Keymap.entries({ platform: "other" });
  const mac = await Keymap.entries({ platform: "mac" });

  check("entries returns an array", Array.isArray(other) && Array.isArray(mac));
  check("the registry is complete (88 commands)", other.length === 88);
  check("both platforms list the same commands", mac.length === other.length);

  const ids = other.map((entry) => entry.id);
  check("every registry id is unique", new Set(ids).size === ids.length);
  check(
    "mac ids are unique",
    new Set(mac.map((entry) => entry.id)).size === mac.length,
  );
  check(
    "mac and other list the same ids",
    mac.every((entry, index) => entry.id === other[index].id),
  );

  const sorted = [...ids].sort();
  check(
    "entries are sorted by id",
    ids.every((id, index) => id === sorted[index]),
  );

  check(
    "every entry carries default_accelerator",
    other.every((entry) => Object.hasOwn(entry, "default_accelerator")),
  );
  check(
    "every entry carries the wire fields",
    other.every(
      (entry) =>
        typeof entry.id === "string" &&
        typeof entry.title === "string" &&
        typeof entry.group === "string" &&
        Object.hasOwn(entry, "accelerator") &&
        typeof entry.customizable === "boolean" &&
        typeof entry.customized === "boolean",
    ),
  );

  // Defaults follow the platform, not one shared string.
  check(
    "tab.new default is Ctrl+T elsewhere",
    byId(other, "tab.new").default_accelerator === "Ctrl+T",
  );
  check(
    "tab.new default is Cmd+T on macOS",
    byId(mac, "tab.new").default_accelerator === "Cmd+T",
  );
  check(
    "browser.settings default is Ctrl+,",
    byId(other, "browser.settings").default_accelerator === "Ctrl+,",
  );
  check(
    "a macOS-only default is null elsewhere",
    byId(other, "note.new").default_accelerator === null,
  );
  check(
    "a macOS-only default is set on macOS",
    byId(mac, "note.new").default_accelerator === "Cmd+Option+N",
  );
  check(
    "an alternate without a macOS default is null there",
    byId(mac, "nav.reload.alt").default_accelerator === null,
  );
  check(
    "the same alternate has F5 elsewhere",
    byId(other, "nav.reload.alt").default_accelerator === "F5",
  );
  check(
    "Option is spelled for macOS",
    byId(mac, "space.next").default_accelerator === "Cmd+Option+Right",
  );

  // Groups and alternates survive the port.
  check(
    "browser.settings is an app command",
    byId(other, "browser.settings").group === "app",
  );
  check(
    "nav.reload.alt is a keys alternate",
    byId(other, "nav.reload.alt").group === "keys",
  );
  check(
    "launcher.toggle is global",
    byId(other, "launcher.toggle").group === "global",
  );
  check(
    "work.pane.close is a work binding",
    byId(other, "work.pane.close").group === "work",
  );
  check(
    "the launcher is not customizable",
    byId(other, "launcher.toggle").customizable === false,
  );
  check(
    "Work bindings are not customizable",
    byId(other, "work.pane.close").customizable === false,
  );
  check(
    "ordinary commands are customizable",
    byId(other, "tab.new").customizable === true,
  );
  check("feature_of maps dictate to ai", featureOf("work.dictate") === "ai");
  check(
    "feature_of maps a work id to work",
    featureOf("work.pane.close") === "work",
  );
  check("feature_of leaves tab.new alone", featureOf("tab.new") === null);
}

// === Bind and unbind ===
{
  check("no change has been emitted yet", changed.length === 0);

  const applied = await Keymap.bind({
    id: "tab.new",
    accelerator: "CmdOrCtrl+Shift+F9",
  });
  check("bind applies", applied.kind === "applied");
  let entries = await Keymap.entries();
  check(
    "bind stores canonical text",
    byId(entries, "tab.new").accelerator === "Ctrl+Shift+F9",
  );
  check(
    "bind marks the command customized",
    byId(entries, "tab.new").customized === true,
  );
  check(
    "bind leaves the default intact",
    byId(entries, "tab.new").default_accelerator === "Ctrl+T",
  );
  check("bind emitted keymap-changed", changed.length === 1);
  check("keymap-changed carries a version", changed[0]?.data?.version === 1);

  const unbound = await Keymap.bind({ id: "tab.new", accelerator: null });
  check("bind(null) applies", unbound.kind === "applied");
  entries = await Keymap.entries();
  check("bind(null) unbinds", byId(entries, "tab.new").accelerator === null);
  check(
    "unbinding still counts as customized",
    byId(entries, "tab.new").customized === true,
  );
  check("unbinding emitted keymap-changed", changed.length === 2);

  const resetOne = await Keymap.reset({ id: "tab.new" });
  entries = await Keymap.entries();
  check(
    "reset(id) restores one default",
    resetOne === true &&
      byId(entries, "tab.new").accelerator === "Ctrl+T" &&
      byId(entries, "tab.new").customized === false,
  );
  check("reset(id) emitted keymap-changed", changed.length === 3);
}

// === Conflicts ===
{
  const refused = await Keymap.bind({ id: "tab.new", accelerator: "Ctrl+W" });
  check("a conflicting bind is refused", refused.kind === "conflict");
  check(
    "the conflict names the other command",
    refused.command === "tab.close",
  );
  let entries = await Keymap.entries();
  check(
    "a refused bind leaves the target alone",
    byId(entries, "tab.new").accelerator === "Ctrl+T",
  );
  check(
    "a refused bind leaves the holder alone",
    byId(entries, "tab.close").accelerator === "Ctrl+W",
  );
  check("a refused bind emits nothing", changed.length === 3);

  const replaced = await Keymap.bind({
    id: "tab.new",
    accelerator: "Ctrl+W",
    replace: true,
  });
  check("replace applies", replaced.kind === "applied");
  entries = await Keymap.entries();
  check(
    "replace moves the key",
    byId(entries, "tab.new").accelerator === "Ctrl+W",
  );
  check(
    "replace unbinds the other command",
    byId(entries, "tab.close").accelerator === null,
  );
  check(
    "the displaced command is customized",
    byId(entries, "tab.close").customized === true,
  );
  check("replace emitted keymap-changed", changed.length === 4);

  // A fixed command cannot give its key away.
  const fixedConflict = await Keymap.bind({
    id: "tab.new",
    accelerator: "Escape",
    replace: true,
  });
  check(
    "a fixed holder keeps its key",
    fixedConflict.kind === "conflict" &&
      fixedConflict.command === "work.pane.close",
  );

  const resetAll = await Keymap.reset({ id: null });
  entries = await Keymap.entries();
  check(
    "reset(null) restores every default",
    resetAll === true &&
      byId(entries, "tab.new").accelerator === "Ctrl+T" &&
      byId(entries, "tab.close").accelerator === "Ctrl+W" &&
      entries.every((entry) => entry.customized === false),
  );
  check("reset(null) emitted keymap-changed", changed.length === 5);
}

// === Validation ===
{
  for (const bad of ["", "a b", "x".repeat(65)]) {
    const refused = await Keymap.bind({ id: "tab.new", accelerator: bad });
    check(
      `invalid accelerator ${JSON.stringify(bad)} is refused`,
      refused.kind === "invalid",
    );
  }
  const malformed = await Keymap.bind({
    id: "tab.new",
    accelerator: "Hyper+R",
  });
  check("an unknown modifier is refused", malformed.kind === "invalid");
  const unknown = await Keymap.bind({ id: "nope", accelerator: "Ctrl+K" });
  check("an unknown command id is refused", unknown.kind === "invalid");
  const fixed = await Keymap.bind({
    id: "launcher.toggle",
    accelerator: "Ctrl+K",
  });
  check("a fixed command refuses a bind", fixed.kind === "fixed");
  const fixedReset = await Keymap.reset({ id: "nope" });
  check("reset on an unknown id is false", fixedReset === false);
  check("no refused change emitted keymap-changed", changed.length === 5);
}

// === Recording ===
{
  check(
    "record starts recording",
    (await Keymap.record({ active: true })) === true,
  );
  check("recording is honest", __keymapRecording() === true);
  check(
    "record ends recording",
    (await Keymap.record({ active: false })) === true,
  );
  check("recording ended", __keymapRecording() === false);
}

// === Platform and auxiliary mouse buttons ===
{
  const mac = await Keymap.bind({
    id: "tab.new",
    accelerator: "Cmd+K",
    platform: "mac",
  });
  check("an explicit mac platform accepts Cmd", mac.kind === "applied");
  let entries = await Keymap.entries({ platform: "mac" });
  check(
    "the mac binding is stored",
    byId(entries, "tab.new").accelerator === "Cmd+K",
  );

  const mouse = await Keymap.bind({ id: "tab.new", accelerator: "Mouse3" });
  check("an auxiliary mouse button binds", mouse.kind === "applied");
  entries = await Keymap.entries();
  check(
    "the mouse binding is stored",
    byId(entries, "tab.new").accelerator === "Mouse3",
  );
  await Keymap.bind({ id: "tab.new", accelerator: null });
}

off();
__resetKeymapForTests();
__resetEventsForTests();

console.log(`keymap_model: ${passed} passed, ${failed} failed`);
if (failed) {
  process.exitCode = 1;
}

#!/usr/bin/env node
// Spaces contract: creating, switching, renaming, reordering and deleting a
// space is a native model change, and the projection that follows is the
// only thing the UI reads.
//
// Usage: node tests/contract/spaces_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const HostAPI = await import(pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href);
const { Tabs, __resetForTests } = HostAPI;

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
await Tabs.bootstrap({});

const items = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());

check("a fresh window has one space", items.spaces.length === 1);
check("that space is active", items.active_space_id === items.spaces[0].id);

const first = items.spaces[0].id;
const made = await Tabs.createSpace({ name: "", look: { icon: null, color: 3, theme: null } });
check("create is admitted", made.accepted === true && made.operation_id === null);

let next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("create adds a space", next.spaces.length === 2);
check("create names it in order", next.spaces[1].name === "Space 2");
check("create makes it active", next.active_space_id === next.spaces[1].id);
check("create keeps its look", next.spaces[1].color === 3);
// The space in front always has somewhere to go: a new space opens with its
// own New Tab instead of an empty stage (Tabs.ensureTabInActiveSpace), and
// that tab is the one selected. `url: null` is the model's New Tab marker.
check("a new space opens with its own New Tab",
  next.tabs.length === 1 && next.tabs[0].url === null && next.tabs[0].title === "New Tab");
check("that New Tab is selected", next.active === next.tabs[0].id);

const second = next.spaces[1].id;
const switched = await Tabs.switchSpace({ space: first });
next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("switch is admitted", switched.accepted === true);
check("switch moves the active space", next.active_space_id === first);
check("switch shows that space's tabs", next.tabs.length >= 1);

const stepped = await Tabs.stepSpace({ step: 1 });
next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("step is admitted", stepped.accepted === true);
check("step wraps to the next space", next.active_space_id === second);

await Tabs.updateSpace({ space: second, name: "Work", look: { icon: null, color: 1, theme: null } });
next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("update renames the space", next.spaces.find((s) => s.id === second).name === "Work");

await Tabs.reorderSpace({ space: second, before: first });
next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("reorder moves it to the front", next.spaces[0].id === second);

const removed = await Tabs.deleteSpace({ space: second });
next = await import(pathToFileURL(path.join(HOST, "Tabs.sys.mjs")).href).then((m) => m.__itemsSnapshot());
check("delete is admitted", removed.accepted === true);
check("delete removes the space", next.spaces.length === 1);
check("delete falls back to the remaining space", next.active_space_id === first);

const refused = await Tabs.deleteSpace({ space: first });
check("the last space cannot be deleted", refused.accepted === false);

const unknown = await Tabs.switchSpace({ space: "nope" });
check("switching to an unknown space is refused", unknown.accepted === false);

console.log(`\nspaces_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

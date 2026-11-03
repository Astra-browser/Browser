#!/usr/bin/env node
// Native navigation wiring (P2): the model emits the intents the content
// binding performs on the live browser.
//
//   - stop emits nav.stopped for the tab
//   - zoom emits nav.zoom-changed with the clamped level
//   - print emits nav.print-requested
//   - hard reload emits nav.hard-reload and keeps the URL/history
//   - Commands routes nav.hardReload to that path
//
// Usage: node tests/contract/native_nav_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.

import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const HostAPI = await import(path.join(HOST, "HostAPI.sys.mjs"));
const { Tabs, Navigation, Commands, addEventListener, __resetForTests } = HostAPI;

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

const made = await Tabs.create({ request_id: "nav-new", url: "https://example.com/" });
const id = made.astra_tab_id;

function capture(fn) {
  const seen = [];
  const off = addEventListener((event) => {
    if (String(event.type).startsWith("nav.")) seen.push(event);
  });
  return Promise.resolve(fn()).then((result) => {
    off();
    return { seen, result };
  });
}

const stop = await capture(() => Navigation.stop({ request_id: "nav-stop", astra_tab_id: id }));
check("stop is accepted", !stop.result.error);
check("stop emits nav.stopped", stop.seen.some((e) => e.type === "nav.stopped"));
check("stop names the tab", stop.seen.find((e) => e.type === "nav.stopped")?.data.astra_tab_id === id);

const zoom = await capture(() =>
  Navigation.setZoom({ request_id: "nav-zoom", astra_tab_id: id, zoom: 9 }),
);
const zoomEvent = zoom.seen.find((e) => e.type === "nav.zoom-changed");
check("zoom is clamped to 3.0", zoom.result.zoom === 3);
check("zoom emits nav.zoom-changed", zoomEvent?.data.zoom === 3);

const before = (await Tabs.get({ request_id: "nav-get", astra_tab_id: id })).tab;
const print = await capture(() => Navigation.print({ request_id: "nav-print", astra_tab_id: id }));
check("print emits nav.print-requested", print.seen.some((e) => e.type === "nav.print-requested"));

const hard = await capture(() =>
  Navigation.hardReload({ request_id: "nav-hard", astra_tab_id: id }),
);
const hardEvent = hard.seen.find((e) => e.type === "nav.hard-reload");
check("hard reload is accepted", !hard.result.error && hard.result.hard === true);
check("hard reload emits nav.hard-reload", hardEvent?.data.astra_tab_id === id);
const after = (await Tabs.get({ request_id: "nav-get", astra_tab_id: id })).tab;
check("hard reload keeps the URL", after.url === before.url);
check("hard reload marks loading", after.loading === true);

const cmd = await capture(() => Commands.run({ id: "nav.hardReload" }));
check("Commands routes nav.hardReload", cmd.result.accepted === true);
check("Commands hard reload emits the native intent", cmd.seen.some((e) => e.type === "nav.hard-reload"));

assert.equal(failed, 0, `${failed} native navigation checks failed`);
console.log(`\nnative_nav_model: ${passed} passed, ${failed} failed`);

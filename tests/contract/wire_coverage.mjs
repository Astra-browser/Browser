#!/usr/bin/env node
// Native-merge guard: every route target exists, and the channels this merge
// owns are re-dispatched from the bridge onto the DOM.
//
// This is deliberately text-based (host-transport.ts is TypeScript) and narrow:
// it catches a route pointing at a missing method, and a channel the app
// listens for that chrome-entry forgot to forward.
//
// Usage: node tests/contract/wire_coverage.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const UI = path.join(ROOT, "ui");

const host = await import(path.join(HOST, "HostAPI.sys.mjs"));
const transport = await readFile(
  path.join(UI, "packages", "bridge", "src", "host-transport.ts"),
  "utf8",
);
const nativeEvents = await readFile(
  path.join(UI, "app", "src", "shared", "ipc", "native-events.ts"),
  "utf8",
);
const chromeEntry = await readFile(
  path.join(UI, "app", "chrome-entry", "browser-chrome.ts"),
  "utf8",
);
const proto = await readFile(
  path.join(UI, "packages", "bridge", "src", "proto.ts"),
  "utf8",
);
const baseline = JSON.parse(
  await readFile(path.join(ROOT, "tests", "contract", "wire_baseline.json"), "utf8"),
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

const routes = [];
for (const match of transport.matchAll(
  /^\s*([a-z0-9_]+): \["([A-Za-z0-9_]+)", "([A-Za-z0-9_]+)"([^\]]*)\]/gmu,
)) {
  routes.push({
    name: match[1],
    module: match[2],
    method: match[3],
    mapsTab: /astra_tab_id|TAB_ARG/u.test(match[4] ?? ""),
  });
}
check("the route table was parsed", routes.length > 50);
const missing = routes.filter(
  (route) => typeof host[route.module]?.[route.method] !== "function",
);
check(
  `every route target exists (${routes.length} routes)`,
  missing.length === 0,
);
if (missing.length > 0) {
  for (const route of missing) {
    console.error(`  ${route.name} -> ${route.module}.${route.method} (missing)`);
  }
}

// Channels this merge owns must reach the DOM. The rest are documented gaps
// (P10) and are not asserted here.
const REQUIRED = [
  "astra:items",
  "astra:ui-command",
  "astra:operation-processed",
  "astra:page-permission-prompt",
  "astra:media-player",
  "astra:find",
  "astra:keymap-changed",
  "astra:notes-changed",
  "astra:focus",
  "astra:search",
  "astra:favicons",
];
const declared = new Set(
  [...nativeEvents.matchAll(/"(astra:[a-z-]+)"/gu)].map((match) => match[1]),
);
const forwarded = new Set(
  [...chromeEntry.matchAll(/"(astra:[a-z-]+)"/gu)].map((match) => match[1]),
);
for (const channel of REQUIRED) {
  check(`${channel} is declared`, declared.has(channel));
  check(`${channel} is forwarded by chrome-entry`, forwarded.has(channel));
}

// A route whose host method reads `astra_tab_id` must map the wire's `id`,
// or the call arrives with an empty tab (the failure this merge fixed twice).
for (const route of routes) {
  let moduleSource = "";
  try {
    moduleSource = await readFile(path.join(HOST, `${route.module}.sys.mjs`), "utf8");
  } catch {
    continue;
  }
  const signature = new RegExp(
    `async\\s+${route.method}\\s*\\(\\s*\\{([^}]*)\\}`,
  ).exec(moduleSource);
  if (!signature || !/\bastra_tab_id\b/u.test(signature[1])) continue;
  check(`${route.name} maps id to astra_tab_id`, route.mapsTab === true);
}

// The prompt routes the app calls must be routed.
for (const name of [
  "page_permission_respond",
  "page_permission_card_host",
  "tabs_answer_sign_in",
  "tabs_continue_past_certificate",
  "page_source",
  "page_find",
  "web_extension_confirm",
  "web_extension_cancel",
  "operation_status",
  "operations_reconcile",
  "operation_acknowledge",
]) {
  check(`${name} is routed`, routes.some((route) => route.name === name));
}

// No new gap: every command without a route, and every declared channel
// without a forwarder, must already be in the recorded baseline. Adding a
// control that calls an unrouted command now fails this guard.
const commands = [
  ...proto
    .split("export const COMMANDS: readonly CommandName[] = [")[1]
    .split("];")[0]
    .matchAll(/"([a-z0-9_]+)"/gu),
].map((match) => match[1]);
const routed = new Set(routes.map((route) => route.name));
const knownUnrouted = new Set(baseline.unrouted ?? []);
const newGaps = commands.filter(
  (name) => !routed.has(name) && !knownUnrouted.has(name),
);
check(
  `no new unrouted command (${newGaps.length} new, ${knownUnrouted.size} known)`,
  newGaps.length === 0,
);
for (const name of newGaps) console.error(`  ${name} has no route`);

const channels = [
  ...nativeEvents.matchAll(/"(astra:[a-z-]+)"/gu),
].map((match) => match[1]);
const forwardedChannels = new Set(
  [...chromeEntry.matchAll(/"(astra:[a-z-]+)"/gu)].map((match) => match[1]),
);
const knownUnforwarded = new Set(baseline.unforwarded ?? []);
const newChannels = [...new Set(channels)].filter(
  (name) => !forwardedChannels.has(name) && !knownUnforwarded.has(name),
);
check(
  `no new unforwarded channel (${newChannels.length} new, ${knownUnforwarded.size} known)`,
  newChannels.length === 0,
);
for (const name of newChannels) console.error(`  ${name} is never forwarded`);

console.log(
  `\nwire coverage: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);

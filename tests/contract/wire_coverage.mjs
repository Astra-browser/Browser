#!/usr/bin/env node
// Native-merge guard: every route target exists, and the channels this merge
// owns are re-dispatched from the bridge onto the DOM.
//
// The command list and the route destinations come from the command manifest
// (`ui/packages/bridge/src/manifest.ts`, D-55), imported as a module. Node
// strips the type-only import, so no TypeScript parser is involved. Three
// suites split the work:
//   - `manifest.test.ts` (bun): manifest <-> route-table equality;
//   - `wire_manifest.mjs` (node): manifest invariants and the registry ->
//     manifest gate (a command in proto.ts with no row there fails);
//   - this guard: every route target exists, and the prompt routes and channel
//     forwarders the product depends on are present.
//
// Usage: node tests/contract/wire_coverage.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { loadManifest } from "./lib/manifest.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const HOST = path.join(ROOT, "overlay", "astra", "host");
const UI = path.join(ROOT, "ui");

const host = await import(
  pathToFileURL(path.join(HOST, "HostAPI.sys.mjs")).href
);
const { ARG_MAPS, COMMAND_MANIFEST } = await loadManifest();
const nativeEvents = await readFile(
  path.join(UI, "app", "src", "shared", "ipc", "native-events.ts"),
  "utf8",
);
const chromeEntry = await readFile(
  path.join(UI, "app", "chrome-entry", "browser-chrome.ts"),
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

const routes = COMMAND_MANIFEST.filter((entry) => entry.state === "routed").map(
  (entry) => ({
    name: entry.name,
    module: entry.module,
    method: entry.method,
    mapsTab:
      entry.args !== "none" &&
      Object.values(ARG_MAPS[entry.args]).includes("astra_tab_id"),
  }),
);
check("the manifest declares its routes", routes.length > 50);
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
  // Settings surfaces that must reach their host module rather than fail in
  // the card: the Windows privacy rows and the login item.
  "windows_reputation_managed",
  "windows_diagnostics_settings",
  "login_item_set",
  "login_item_open_settings",
  "open_software_update",
  "favicon_probe",
  // The launcher surface: its shortcut card and the entry points that ask for
  // it (the address field, the sidebar button, its own accelerator).
  "launcher_trigger",
  "launcher_set_shortcut",
  "launcher_record_shortcut",
  "launcher_set_double_tap",
  "launcher_open_accessibility",
]) {
  check(`${name} is routed`, routes.some((route) => route.name === name));
}

// A command's state is declared in the manifest, not in a second list. The
// registry -> manifest gate lives in `wire_manifest.mjs`: a command added to
// proto.ts without a row there fails that suite. This guard keeps the host side
// (a route points at a real method) and the one channel inventory that has no
// manifest equivalent yet.
const commands = COMMAND_MANIFEST.map((entry) => entry.name);
check(`the command manifest has entries (${commands.length} names)`, commands.length > 200);
const routed = new Set(routes.map((route) => route.name));
const channels = [
  ...new Set(
    [...nativeEvents.matchAll(/"(astra:[a-z-]+)"/gu)].map((match) => match[1]),
  ),
];
const forwardedChannels = new Set(
  [...chromeEntry.matchAll(/"(astra:[a-z-]+)"/gu)].map((match) => match[1]),
);
const unforwardedChannels = channels.filter(
  (name) => !forwardedChannels.has(name),
);

if (process.argv.includes("--write-baseline")) {
  const next = { unforwarded: [...unforwardedChannels].sort() };
  await writeFile(
    path.join(ROOT, "tests", "contract", "wire_baseline.json"),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  console.log(
    `wire baseline: wrote ${next.unforwarded.length} unforwarded channels`,
  );
  process.exit(0);
}

const baselineUnforwarded = baseline.unforwarded ?? [];
const unknownChannels = baselineUnforwarded.filter(
  (name) => !channels.includes(name),
);
check(
  `every baseline channel is declared (${unknownChannels.length} invalid)`,
  unknownChannels.length === 0,
);
for (const name of unknownChannels) console.error(`  ${name} is not declared`);
const staleForwarded = baselineUnforwarded.filter((name) =>
  forwardedChannels.has(name),
);
check(
  `no baseline channel is forwarded (${staleForwarded.length} stale)`,
  staleForwarded.length === 0,
);
for (const name of staleForwarded) {
  console.error(`  ${name} is forwarded but is still in the baseline`);
}

const knownUnforwarded = new Set(baselineUnforwarded);
const newChannels = channels.filter(
  (name) => !forwardedChannels.has(name) && !knownUnforwarded.has(name),
);
check(
  `no new unforwarded channel (${newChannels.length} new, ${knownUnforwarded.size} known of ${channels.length})`,
  newChannels.length === 0,
);
for (const name of newChannels) console.error(`  ${name} is never forwarded`);

console.log(
  `\nwire coverage: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One registry owns the browser surfaces (pages and side-panel tools).
//
// Before this gate, a page id lived in five places: the `BrowserPage` union,
// the `ui-command` guard, the host's `Commands.PAGES`, the Shell stage chain
// and the command contract's own list; the tool ids lived in `ToolKind`, two
// literal arrays in `session/tools.svelte.ts` and the host's `Commands.TOOLS`.
// They drifted: `browser.gallery` was in every list except the command
// contract, so the page was never exercised.
//
// The host modules are staged into astra.jar and served from resource://, so
// they cannot import the UI's TypeScript. `Commands.PAGES` and `Commands.TOOLS`
// therefore stay literal and are asserted equal here instead of derived.
//
// Usage: node tests/contract/surfaces_registry.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSurfaces } from "./lib/surfaces.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const COMMANDS = path.join(ROOT, "overlay", "astra", "host", "Commands.sys.mjs");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
    if (detail) console.error(`  ${detail}`);
  }
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const describe = (values) => [...values].sort().join(", ");

let surfaces;
try {
  surfaces = await loadSurfaces();
} catch (error) {
  console.error("FAIL the surface registry loads from Node");
  console.error(`  ${error?.stack ?? error}`);
  console.log(`\nsurface registry: FAIL (1 failed)`);
  process.exit(1);
}

const { SURFACES, PAGE_SURFACES, TOOL_SURFACES, BROWSER_PAGES, TOOL_KINDS } = surfaces;
const { PAGES, TOOLS } = await import(pathToFileURL(COMMANDS).href);

check(
  "the registry exposes page rows, tool rows and their id lists",
  Array.isArray(SURFACES) &&
    Array.isArray(PAGE_SURFACES) &&
    Array.isArray(TOOL_SURFACES) &&
    Array.isArray(BROWSER_PAGES) &&
    Array.isArray(TOOL_KINDS),
);

check(
  "every row has an id, a known kind, a callable loader and a label key",
  SURFACES.every(
    (row) =>
      typeof row?.id === "string" &&
      row.id.length > 0 &&
      (row.kind === "page" || row.kind === "tool") &&
      typeof row.loader === "function" &&
      typeof row.labelKey === "string" &&
      row.labelKey.length > 0,
  ),
  SURFACES.filter(
    (row) =>
      typeof row?.id !== "string" ||
      (row.kind !== "page" && row.kind !== "tool") ||
      typeof row.loader !== "function" ||
      typeof row.labelKey !== "string" ||
      row.labelKey.length === 0,
  )
    .map((row) => row?.id ?? "<missing id>")
    .join(", "),
);

const ids = SURFACES.map((row) => row.id);
check(
  "surface ids are unique",
  new Set(ids).size === ids.length,
  ids.filter((id, index) => ids.indexOf(id) !== index).join(", "),
);

check(
  "BROWSER_PAGES is exactly the page rows",
  sameSet(BROWSER_PAGES, PAGE_SURFACES.map((row) => row.id)),
  `pages: ${describe(BROWSER_PAGES)}`,
);
check(
  "TOOL_KINDS is exactly the tool rows",
  sameSet(TOOL_KINDS, TOOL_SURFACES.map((row) => row.id)),
  `tools: ${describe(TOOL_KINDS)}`,
);

check(
  `the host's PAGES set equals the page ids (${BROWSER_PAGES.length})`,
  PAGES instanceof Set && sameSet([...PAGES], BROWSER_PAGES),
  `host: ${describe([...(PAGES ?? [])])}\n  ui:   ${describe(BROWSER_PAGES)}`,
);
check(
  `the host's TOOLS set equals the tool kinds (${TOOL_KINDS.length})`,
  TOOLS instanceof Set && sameSet([...TOOLS], TOOL_KINDS),
  `host: ${describe([...(TOOLS ?? [])])}\n  ui:   ${describe(TOOL_KINDS)}`,
);

check(
  "every page id has its own loader",
  PAGE_SURFACES.every((row) => typeof row.loader === "function"),
  PAGE_SURFACES.filter((row) => typeof row.loader !== "function")
    .map((row) => row.id)
    .join(", "),
);

for (const row of PAGE_SURFACES) {
  check(
    `page "${row.id}" is in the host PAGES set and the browser page list`,
    PAGES.has(row.id) && BROWSER_PAGES.includes(row.id),
  );
}
for (const row of TOOL_SURFACES) {
  check(
    `tool "${row.id}" is in the host TOOLS set and the tool kind list`,
    TOOLS.has(row.id) && TOOL_KINDS.includes(row.id),
  );
}

// The registry is the only owner: a page id must not appear in a second
// hand-written page list. `gallery` is called out because that is the id this
// gate found missing from `commands_model.mjs`.
check(
  "gallery is a page row (the drift this gate was written for)",
  BROWSER_PAGES.includes("gallery") && PAGES.has("gallery"),
);

console.log(
  `\nsurface registry: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);

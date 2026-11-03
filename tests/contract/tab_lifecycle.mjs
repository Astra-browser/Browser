#!/usr/bin/env node
// Docshell contract: the tab in front renders and keeps its layer; a parked
// tab gives both back, and stays otherwise untouched (no unload, no discard).
//
// The live behaviour (visibilityState, rAF, media) is in tab_lifecycle.py,
// which needs the engine build. This pins the policy the host applies, in
// particular that parked tabs do NOT keep `preserveLayers` warm the way
// Firefox's tabbrowser layer cache does.
//
// Usage: node tests/contract/tab_lifecycle.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { docshellState } = await import(
  path.join(ROOT, "overlay", "astra", "host", "Content.sys.mjs")
);

let passed = 0;
function check(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(`  expected ${JSON.stringify(expected)}`);
    console.error(`  actual   ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

check("the tab in front is active and keeps its layer", docshellState(true), {
  docShellIsActive: true,
  preserveLayers: true,
});

check("a parked tab is inactive and releases its layer", docshellState(false), {
  docShellIsActive: false,
  preserveLayers: false,
});

// `park()` / an unknown tab id must park, never fall through to "active":
// a docshell that stays active keeps painting, running rAF and reporting
// visibilityState "visible", which is the bug this contract exists for.
check("an unresolved tab parks", docshellState(undefined), {
  docShellIsActive: false,
  preserveLayers: false,
});
check("only a literal true activates", docshellState("tab-1"), {
  docShellIsActive: false,
  preserveLayers: false,
});

if (!process.exitCode) {
  console.log(`tab_lifecycle: PASS (${passed} checks)`);
}

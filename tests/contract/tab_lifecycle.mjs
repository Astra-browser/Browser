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
const { docshellState, applyBrowserActivation, applyTabActivation } = await import(
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

check("the tab in front is active and does not hold a layer cache", docshellState(true), {
  docShellIsActive: true,
  preserveLayers: false,
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

// The switch path has to write that state into the real browser. Hiding the
// tabbox is not enough: both documents stay visible and automatic PiP never
// sees VideoTabHidden.
function fakeBrowser() {
  return {
    docShellIsActive: true,
    layers: [],
    preserveLayers(value) {
      this.layers.push(value);
    },
  };
}

const incoming = fakeBrowser();
const outgoing = fakeBrowser();
check("activation writes the docshell state", applyBrowserActivation(incoming, true), true);
check("the incoming browser is active", incoming.docShellIsActive, true);
check("the incoming browser does not keep a layer cache", incoming.layers, [false]);
check("parking writes the docshell state", applyBrowserActivation(outgoing, false), true);
check("the outgoing browser is inactive", outgoing.docShellIsActive, false);
check("the outgoing browser releases its layer", outgoing.layers, [false]);

const browsers = new Map([
  ["tab-a", { browser: fakeBrowser() }],
  ["tab-b", { browser: fakeBrowser() }],
]);
check("a tab switch activates one browser and parks the rest", applyTabActivation(browsers, "tab-b"), 2);
check(
  "only the selected browser stays active",
  [...browsers.entries()].map(([id, entry]) => [id, entry.browser.docShellIsActive]),
  [
    ["tab-a", false],
    ["tab-b", true],
  ],
);

if (!process.exitCode) {
  console.log(`tab_lifecycle: PASS (${passed} checks)`);
}

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
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { docshellState, applyBrowserActivation, applyTabActivation, isPictureInPictureSource, needsDeckRepair } =
  await import(pathToFileURL(path.join(ROOT, "overlay", "astra", "host", "Content.sys.mjs")).href);

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

// A media Picture-in-Picture source must keep its docshell active. The engine
// writes that to feed the player's clone; parking it freezes the clone and
// makes the page fire VideoTabHidden again, which auto-PiP reads as a second
// toggle and closes the window the person just opened.
function fakeTab({ pip = false } = {}) {
  return {
    pictureinpicture: pip,
    hasAttribute(name) {
      return name === "pictureinpicture" ? this.pictureinpicture : false;
    },
  };
}

check("a PiP source is recognised", isPictureInPictureSource({ tab: fakeTab({ pip: true }) }), true);
check("an ordinary tab is not a PiP source", isPictureInPictureSource({ tab: fakeTab() }), false);
check("an entry without a native tab is not a PiP source", isPictureInPictureSource({ browser: fakeBrowser() }), false);

const pipBrowsers = new Map([
  ["tab-pip", { browser: fakeBrowser(), tab: fakeTab({ pip: true }) }],
  ["tab-front", { browser: fakeBrowser(), tab: fakeTab() }],
]);
check("a PiP source is not parked by a tab switch", applyTabActivation(pipBrowsers, "tab-front"), 2);
check(
  "the PiP source and the tab in front are both active",
  [...pipBrowsers.entries()].map(([id, entry]) => [id, entry.browser.docShellIsActive]),
  [
    ["tab-pip", true],
    ["tab-front", true],
  ],
);

// A redundant selection is a no-op in the tabbrowser. The deck repair is the
// only thing that can bring a page back when the deck drifted from the tab the
// engine already has selected, so it must fire exactly in that case.
check(
  "a drifted deck on the already-selected tab is repaired",
  needsDeckRepair({ alreadySelected: true, presented: true, panelMatches: false }),
  true,
);
check(
  "a deck already showing the selected tab is left alone",
  needsDeckRepair({ alreadySelected: true, presented: true, panelMatches: true }),
  false,
);
check(
  "a real switch is not repaired behind the engine's own switch",
  needsDeckRepair({ alreadySelected: false, presented: true, panelMatches: false }),
  false,
);
check(
  "a tab that never presented waits for its own load",
  needsDeckRepair({ alreadySelected: true, presented: false, panelMatches: false }),
  false,
);

if (!process.exitCode) {
  console.log(`tab_lifecycle: PASS (${passed} checks)`);
}

#!/usr/bin/env node
// Which tab the one "Now playing" card names when several tabs have media.
// Pure policy: Content supplies live flags and play/active generations.
//
// Usage: node tests/contract/media_selection.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { chooseMedia } = await import(pathToFileURL(path.join(ROOT, "overlay", "astra", "host", "MediaSelection.sys.mjs")).href);

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

const tab = (id, extra = {}) => ({
  id,
  live: true,
  playing: false,
  playSince: 0,
  activeSince: 1,
  ...extra,
});

check("nothing live is no player", chooseMedia({ candidates: [] }) === null);

check(
  "a live tab with no playback keeps the card",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [tab("a")],
  }) === "a",
);

check(
  "a silent tab cannot clear a live player",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [tab("a"), { ...tab("b"), live: false }],
  }) === "a",
);

check(
  "a live tab whose controller went away is not chosen",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [{ ...tab("a"), live: false }],
  }) === null,
);

check(
  "a newly playing tab takes the card from a paused one",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [tab("a"), tab("b", { playing: true, playSince: 2 })],
  }) === "b",
);

check(
  "the most recently started playback wins",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [
      tab("a", { playing: true, playSince: 2 }),
      tab("b", { playing: true, playSince: 5 }),
    ],
  }) === "b",
);

check(
  "a current, live, playing tab is kept over a silent live tab",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [tab("a", { playing: true, playSince: 3 }), tab("b", { activeSince: 9 })],
  }) === "a",
);

check(
  "without playback the most recently active live tab is chosen",
  chooseMedia({
    currentId: "gone",
    currentLive: false,
    candidates: [tab("a", { activeSince: 4 }), tab("b", { activeSince: 7 })],
  }) === "b",
);

check(
  "a suppressed (non-live) tab is never chosen",
  chooseMedia({
    currentId: "a",
    currentLive: true,
    candidates: [tab("a"), tab("b", { playing: true, playSince: 9, live: false })],
  }) === "a",
);

check(
  "a missing id on a candidate is ignored",
  chooseMedia({
    candidates: [{ id: "", live: true }, tab("a")],
  }) === "a",
);

console.log(`\nmedia selection: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

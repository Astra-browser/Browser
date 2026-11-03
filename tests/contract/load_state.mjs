#!/usr/bin/env node
// Fast-load contract: a page that finishes before the first 200 ms poll must
// clear loading immediately instead of waiting out the 15 s start deadline.
//
// Usage: node tests/contract/load_state.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { loadWatchStep } = await import(
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

const base = {
  loading: false,
  seenLoading: false,
  currentUrl: "about:blank",
  requestedUrl: "http://127.0.0.1:8111/blank.html",
  previousUrl: "about:blank",
  elapsedMs: 200,
  startDeadlineMs: 15_000,
};

// The bug: a local page finishes between polls. The first poll sees the final
// URL and no loading flag; that is a completed load, not "not started yet".
check("fast local load is done on the first poll", loadWatchStep({
  ...base,
  currentUrl: base.requestedUrl,
}), {
  live: false,
  seenLoading: true,
  fastDone: true,
});

// A server that has not sent a byte yet must still show the skeleton.
check(
  "slow request before first byte stays live",
  loadWatchStep({ ...base, elapsedMs: 500 }),
  { live: true, seenLoading: false, fastDone: false },
);

// Requesting a new URL while the old page is still in the browser is also a
// pre-commit state: do not hide the skeleton just because a document exists.
check(
  "previous page is not the requested page",
  loadWatchStep({
    ...base,
    currentUrl: "https://old.example/",
    previousUrl: "https://old.example/",
  }),
  { live: true, seenLoading: false, fastDone: false },
);

// A load that was actually observed keeps the normal two-quiet-polls grace.
check(
  "observed load is live",
  loadWatchStep({
    ...base,
    loading: true,
    seenLoading: true,
    currentUrl: "https://old.example/",
    previousUrl: "https://old.example/",
  }),
  { live: true, seenLoading: true, fastDone: false },
);
check(
  "observed load clears after it reaches the target",
  loadWatchStep({
    ...base,
    seenLoading: true,
    currentUrl: base.requestedUrl,
    previousUrl: "https://old.example/",
    elapsedMs: 5_000,
  }),
  { live: false, seenLoading: true, fastDone: true },
);

// Redirects land on a different URL: that is still a committed document.
check(
  "redirect is a committed load",
  loadWatchStep({
    ...base,
    currentUrl: "https://final.example/",
    previousUrl: "https://old.example/",
    elapsedMs: 800,
  }),
  { live: false, seenLoading: true, fastDone: true },
);

// A request that never starts still has the bounded 15 s fallback.
check(
  "never-started request hits the bounded fallback",
  loadWatchStep({
    ...base,
    currentUrl: "https://old.example/",
    previousUrl: "https://old.example/",
    elapsedMs: 16_000,
  }),
  { live: false, seenLoading: false, fastDone: false },
);

// Reloading the same URL: the document is already there; show it.
check(
  "same-URL reload can clear immediately",
  loadWatchStep({
    ...base,
    currentUrl: base.requestedUrl,
    previousUrl: base.requestedUrl,
  }),
  { live: false, seenLoading: true, fastDone: true },
);

if (!process.exitCode) {
  console.log(`load_state: PASS (${passed} checks)`);
}

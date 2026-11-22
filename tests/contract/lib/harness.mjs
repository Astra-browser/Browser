/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One harness for the contract suites: the check semantics, the counters, the
// summary/exit-code helpers and the repository paths live here instead of in
// 72 copies.
//
// A suite imports what it uses:
//
//   import { check, passed, failed } from "./lib/harness.mjs";
//
// `check` is the truthy form every suite used. `checkEqual` is the deep-equal
// form (it replaces a suite's `check(name, actual, expected)`); the two stay
// separate because a third argument is an expected value in one and a failure
// detail string in the other. `passed`/`failed` are live ESM bindings: a
// suite's own summary line can keep reading them after a check.
//
// Exit code is owned here too: a failed check sets process.exitCode, so a
// suite that used to rely on that keeps exiting 1, and a suite that called
// process.exit(failed === 0 ? 0 : 1) keeps the same result.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tests/contract/lib/harness.mjs -> repository root
export const ROOT = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);
export const HOST = path.join(ROOT, "overlay", "astra", "host");
export const UI = path.join(ROOT, "ui");

export let passed = 0;
export let failed = 0;

/** Names of the checks that failed, in order. */
export const failedNames = [];

export function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    failedNames.push(name);
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

export function checkEqual(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    failedNames.push(name);
    console.error(`FAIL ${name}`);
    console.error(`  expected ${JSON.stringify(expected)}`);
    console.error(`  actual   ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  }
}

/** The standard trailing line: `<label>: PASS|FAIL (N checks, M failed)`. */
export function summary(label) {
  console.log(
    `\n${label}: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
  );
}

/** The process exit code the counters imply. */
export function exitCode() {
  return failed === 0 ? 0 : 1;
}

/** summary(label) followed by process.exit() with the counter's code. */
export function finish(label) {
  if (label) summary(label);
  process.exit(exitCode());
}

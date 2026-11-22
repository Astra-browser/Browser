#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Run every contract suite in this directory, discovered from the filesystem.
//
//   node tests/contract/run-all.mjs            run all suites
//   node tests/contract/run-all.mjs --list     print the suite names, one per line
//   node tests/contract/run-all.mjs --verbose  stream each suite's output live
//   node tests/contract/run-all.mjs --filter=wire            only matching names
//   node tests/contract/run-all.mjs --timeout=300            per-suite seconds
//
// Exit codes: 0 every suite passed or skipped, 1 at least one suite failed.
// A suite that exits 2 is a SKIP: it means the environment cannot run it
// (no built binary, no audio device), and is reported as such, not as a pass
// and not as a failure. Any other non-zero exit is a failure, including a
// timeout or a signal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(path.dirname(DIR));
const SELF = path.basename(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const option = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const verbose = hasFlag("--verbose");
const timeout = Number(option("timeout", "180")) * 1000;
const filter = option("filter", "");

function discover(dir = DIR) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".mjs") && name !== SELF)
    .sort();
}

function countPasses(output) {
  return (output.match(/^PASS /gm) || []).length;
}

function firstLine(text) {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ""
  );
}

const suites = discover().filter((name) => name.includes(filter));

if (hasFlag("--list")) {
  for (const name of suites) console.log(name.replace(/\.mjs$/, ""));
  process.exit(0);
}

if (suites.length === 0) {
  console.error("run-all: no contract suites found");
  process.exit(1);
}

const results = [];
const started = Date.now();

for (const file of suites) {
  const name = file.replace(/\.mjs$/, "");
  const suiteStarted = Date.now();
  const run = spawnSync(process.execPath, [path.join(DIR, file)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  const seconds = (Date.now() - suiteStarted) / 1000;
  const output = `${run.stdout || ""}${run.stderr || ""}`;
  const passes = countPasses(run.stdout || "");
  let status;
  let reason = "";
  if (run.status === 0) {
    status = "PASS";
  } else if (run.status === 2) {
    status = "SKIP";
    reason = firstLine(output) || "environment";
  } else if (run.error?.code === "ETIMEDOUT" || run.signal) {
    status = "FAIL";
    reason = `timeout after ${timeout / 1000}s`;
  } else {
    status = "FAIL";
    reason = firstLine(run.stderr || "") || firstLine(run.stdout || "");
  }
  results.push({ name, status, passes, seconds, reason, output });
  const detail =
    status === "PASS"
      ? `(${passes} checks, ${seconds.toFixed(1)}s)`
      : `${reason ? `: ${reason}` : ""} (${seconds.toFixed(1)}s)`;
  console.log(`${status} ${name} ${detail}`.trim());
  if (verbose) console.log(output.trimEnd());
  if (status === "FAIL" && !verbose) {
    const tail = output.trimEnd().split(/\r?\n/).slice(-25).join("\n");
    if (tail) console.log(tail);
  }
}

const passed = results.filter((r) => r.status === "PASS").length;
const skipped = results.filter((r) => r.status === "SKIP").length;
const failed = results.filter((r) => r.status === "FAIL").length;
const checks = results.reduce((sum, r) => sum + r.passes, 0);

console.log(
  `\n${results.length} suites: ${passed} passed, ${skipped} skipped, ${failed} failed` +
    ` (${checks} checks, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
);
if (skipped) {
  console.log(
    `skipped: ${results
      .filter((r) => r.status === "SKIP")
      .map((r) => r.name)
      .join(", ")}`,
  );
}
if (failed) {
  console.log(
    `failed: ${results
      .filter((r) => r.status === "FAIL")
      .map((r) => r.name)
      .join(", ")}`,
  );
}
process.exit(failed === 0 ? 0 : 1);

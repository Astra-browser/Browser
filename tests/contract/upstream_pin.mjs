#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
// D-58 upstream-pin contract: the pin, the engine it fetched, the version the
// extensions crate reports and the version the packager stamps must all name
// the same base. Three places carry it and nothing else ties them together.
//
// Exit codes follow the contract convention: 0 pass, 1 fail, 2 SKIP when the
// engine source is absent (a fresh clone has not fetched yet) — the pin and the
// packager claims are still checked in that case.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { ROOT, check, passed, failed } from "./lib/harness.mjs";

/** A channel suffix that a version string may legitimately carry. */
const SUFFIXES = ["esr"];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// --- the pin ----------------------------------------------------------------
const toml = read("upstream.toml");
const pin = (() => {
  const out = {};
  for (const line of toml.split(/\r?\n/)) {
    const m = /^([a-z_]+)\s*=\s*"([^"]*)"/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
})();

check("upstream.toml names a version", typeof pin.version === "string" && pin.version.length > 0
  && pin.version !== "UNVERIFIED", `got ${JSON.stringify(pin.version)}`);
check("upstream.toml names a channel", typeof pin.channel === "string" && pin.channel.length > 0,
  `got ${JSON.stringify(pin.channel)}`);

// The channel and the version must agree. A 160.0.1 pin cannot call itself esr:
// no ESR ever shipped that number, so the pin would describe a release that
// does not exist (D-58).
const versionSuffix = SUFFIXES.find((s) => String(pin.version || "").endsWith(s));
const channelIsEsr = pin.channel === "esr";
check("channel agrees with the version suffix",
  (versionSuffix === "esr") === channelIsEsr,
  `version=${pin.version} channel=${pin.channel}`);

const tarball = path.basename(String(pin.url || ""));
check("tarball url matches the pin", tarball === `firefox-${pin.version}.source.tar.xz`, tarball);
if (pin.signature_url) {
  check("signature url matches the tarball",
    path.basename(pin.signature_url) === `${tarball}.asc`, pin.signature_url);
}

/** The base version with any channel suffix removed: 160.0.1esr -> 160.0.1. */
const baseOf = (v) => SUFFIXES.reduce((acc, s) => (acc.endsWith(s) ? acc.slice(0, -s.length) : acc), String(v || ""));
const pinBase = baseOf(pin.version);

// --- the engine that was fetched -------------------------------------------
const engineVersionFile = path.join(ROOT, "engine", "browser", "config", "version.txt");
let engineSkipped = true;
if (fs.existsSync(engineVersionFile)) {
  const fetched = fs.readFileSync(engineVersionFile, "utf8").trim();
  check("engine source matches the pin", fetched === pin.version, `engine=${fetched} pin=${pin.version}`);
  engineSkipped = false;
}

// --- the version the extensions crate reports -------------------------------
const manifestRs = read("crates/astra-extensions/src/manifest.rs");
const engineConst = /pub const ENGINE_VERSION: &str = "([^"]+)";/.exec(manifestRs);
check("ENGINE_VERSION is declared once", engineConst !== null, "no pub const ENGINE_VERSION");
if (engineConst) {
  check("ENGINE_VERSION carries the pinned base", baseOf(engineConst[1]) === pinBase,
    `const=${engineConst[1]} pin=${pin.version}`);
}

// --- what the packager stamps ----------------------------------------------
// platform.ini's Milestone already carries the channel ("160.0.1"), so anything
// appended to it invents a version. A hardcoded fallback drifts on its own.
for (const rel of ["tools/package-windows.ps1", "tools/package-release.sh"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) continue;
  const text = read(rel);
  check(`${rel} does not append a channel suffix`, !/\+\s*['"]esr['"]/.test(text),
    "appends 'esr' to the milestone");
  for (const m of text.matchAll(/\$?engineVersion\s*=\s*['"]([0-9][^'"]*)['"]/gi)) {
    check(`${rel} fallback matches the pin`, baseOf(m[1]) === pinBase, `fallback=${m[1]} pin=${pin.version}`);
  }
  for (const m of text.matchAll(/^\s*VERSION=['"]?([0-9][^'"\s]*)/gm)) {
    check(`${rel} version literal matches the pin`, baseOf(m[1]) === pinBase, `literal=${m[1]} pin=${pin.version}`);
  }
}

assert.equal(failed, 0, `${failed} upstream-pin checks failed`);
console.log(`\nupstream_pin: ${passed} passed, ${failed} failed`);
if (engineSkipped) {
  console.log("SKIP: engine source absent (run `forge fetch`); pin and packager checks only");
  process.exit(2);
}

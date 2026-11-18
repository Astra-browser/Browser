#!/usr/bin/env node
// Blocking-coverage contract for the public Super Adblock Test inventory.
//
// The site fetches every host in `blocker/lists/superadblock-hosts.json` with
// `fetch(no-cors)`. Community lists often match a host only for one resource
// type, so a fetch can slip through even though a script/image is blocked.
// This contract proves the bundled Astra list carries a host-anchored,
// type-agnostic `$important` rule for every scored host, that the generated
// section is current, that the packaged gzip matches the text, and that the
// browser-wide privacy posture is still the documented one.
//
// Usage: node tests/contract/blocker_coverage.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const INVENTORY = path.join(ROOT, "blocker/lists/superadblock-hosts.json");
const TESTER_INVENTORY = path.join(
  ROOT,
  "blocker/lists/adblocktester-hosts.json",
);
const LIST = path.join(ROOT, "blocker/lists/astra-telemetry.txt");
const SEED = path.join(ROOT, "blocker/seed/astra-telemetry.txt.gz");
const CFG = path.join(ROOT, "overlay/astra/mozilla.cfg");
const GENERATOR = path.join(ROOT, "blocker/tools/superadblock.py");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

const inventory = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
const source = fs.readFileSync(LIST, "utf8");
const rules = new Set(
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("!")),
);

function hostsCovered(host, set) {
  if (set.has(`||${host}^$important`)) return true;
  let parent = host;
  while (parent.includes(".")) {
    parent = parent.slice(parent.indexOf(".") + 1);
    if (set.has(`||${parent}^$important`)) return true;
  }
  return false;
}

// 1. Every scored host is blocked for every request type.
const scored = inventory.hosts.filter(
  (entry) => entry.scored && !entry.scoped_only,
);
const missing = scored.filter((entry) => !hostsCovered(entry.host, rules));
check(
  `${scored.length} scored hosts have a host-wide rule`,
  missing.length === 0,
  missing
    .slice(0, 12)
    .map((entry) => entry.host)
    .join(", "),
);

// 2. Raw block rate too: the non-scored error/telemetry hosts count in the
//    page's blocked/total figure even though they carry no module weight.
const all = inventory.hosts.filter(
  (entry) => !entry.scoped_only && entry.host !== "vk.com",
);
const missingAll = all.filter((entry) => !hostsCovered(entry.host, rules));
check(
  `${all.length} probed hosts have a host-wide rule`,
  missingAll.length === 0,
  missingAll
    .slice(0, 12)
    .map((entry) => entry.host)
    .join(", "),
);

// 3. The Adblock Tester inventory: every fetch-probed host and every bait it
//    left open in the captured run is covered now.
const tester = JSON.parse(fs.readFileSync(TESTER_INVENTORY, "utf8"));
const testerHosts = tester.hosts.filter((entry) => entry.method !== "cosmetic");
const testerMissing = testerHosts.filter(
  (entry) => !hostsCovered(entry.host, rules),
);
check(
  `${testerHosts.length} Adblock Tester hosts have a host-wide rule`,
  testerMissing.length === 0,
  testerMissing
    .slice(0, 12)
    .map((entry) => entry.host)
    .join(", "),
);
const testerOpen = testerHosts.filter((entry) => entry.open);
check(
  `the ${testerOpen.length} Adblock Tester hosts the capture left open are blocked`,
  testerOpen.every((entry) => hostsCovered(entry.host, rules)),
  testerOpen
    .filter((entry) => !hostsCovered(entry.host, rules))
    .map((entry) => entry.host)
    .join(", "),
);
// The site's script baits are local files whose global must never be defined,
// and its cosmetic baits are nodes inserted after load. Both are covered by
// the hand-maintained heuristics rather than by a host rule.
const BAIT_RULES = [
  ...tester.baits.scripts.map((bait) => bait.rule),
  ...tester.baits.cosmetic.flatMap((bait) => bait.rules),
];
const missingBaits = BAIT_RULES.filter((rule) => !rules.has(rule));
check(
  "every script and cosmetic bait has a rule",
  missingBaits.length === 0,
  missingBaits.join(", "),
);
check(
  "the bait rules the capture left open are the baits now covered",
  tester.baits.scripts.filter((bait) => bait.open).length === 2 &&
    tester.baits.cosmetic.every((bait) => bait.open && bait.rules.length > 0),
);

// 4. The shared-domain exception stays path-scoped and the bundled seed
//    carries the covering path rule.
const bundled = [
  "easylist.txt.gz",
  "easyprivacy.txt.gz",
]
  .map((name) =>
    zlib.gunzipSync(fs.readFileSync(path.join(ROOT, "blocker/seed", name))).toString("utf8"),
  )
  .join("\n");
check(
  "vk.com is not host-wide blocked and its /rtrg path stays covered",
  !rules.has("||vk.com^$important") && bundled.includes("||vk.com/rtrg"),
);

// 5. No host rule appears twice in the generated sections.
const markerIndex = source.indexOf("! >>> superadblock-strict");
check("strict section marker exists", markerIndex !== -1);
check(
  "Adblock Tester strict section exists",
  source.includes("! >>> adblocktester-strict") &&
    source.includes("! <<< adblocktester-strict"),
);
const section = markerIndex === -1 ? "" : source.slice(markerIndex);
const dups = [];
const seen = new Set();
for (const line of section.split("\n")) {
  const rule = line.trim();
  if (!rule.startsWith("||")) continue;
  if (seen.has(rule)) dups.push(rule);
  seen.add(rule);
}
check("generated sections have no duplicate rules", dups.length === 0, dups.slice(0, 5).join(", "));

// 6. The generator's `--check` is green (source inventories and list agree).
let generatorOk = false;
let generatorDetail = "";
try {
  execFileSync("python3", [GENERATOR, "--check"], { stdio: "pipe" });
  generatorOk = true;
} catch (error) {
  generatorDetail = String(error.stderr || error.message).trim();
}
check("strict section is current (superadblock.py --check)", generatorOk, generatorDetail);

// 7. The packaged gzip is the same text (a stale jar ships stale rules).
const packed = zlib.gunzipSync(fs.readFileSync(SEED)).toString("utf8");
check("packaged seed matches the list text", packed === source);
check(
  "packaged seed carries the generated sections",
  packed.includes("! >>> superadblock-strict") &&
    packed.includes("! >>> adblocktester-strict") &&
    packed.includes("||pagead2.googlesyndication.com^$important"),
);

// 8. Cosmetic delivery must survive a page's own CSP, and a batch that brings
//    a new class/id must be answered without waiting for the floor: both are
//    required for the baits this benchmark inserts after load.
const ACTOR = path.join(ROOT, "overlay/astra/actors/AstraBlockerChild.sys.mjs");
const actor = fs.readFileSync(ACTOR, "utf8");
check(
  "cosmetic CSS loads as a chrome sheet, not a page style node",
  actor.includes("loadSheetUsingURIString") &&
    actor.includes("AGENT_SHEET") &&
    // The style node survives only as the fallback of the sheet path.
    actor.includes("if (!this.#applySheet(css))"),
);
check(
  "an unseen class/id batch is looked up immediately",
  actor.includes("IMMEDIATE_BATCHES") && actor.includes("collectMutated"),
);

// 9. Browser-wide privacy posture stays strengthened. Each target closes a
//    cheap high-entropy surface; the list is asserted so a later edit cannot
//    silently weaken it.
const cfg = fs.readFileSync(CFG, "utf8");
const PRIVACY = path.join(ROOT, "overlay/astra/host/Privacy.sys.mjs");
const privacy = fs.readFileSync(PRIVACY, "utf8");
const overrides = cfg.match(
  /defaultPref\("privacy\.fingerprintingProtection\.overrides",\s*"([^"]+)"\)/,
);
const targets = new Set(
  (overrides ? overrides[1] : "").split(",").map((value) => value.replace(/^\+/, "")),
);
const REQUIRED_TARGETS = [
  "CanvasRandomization",
  "WebGLRenderInfo",
  "WebGLRenderCapability",
  "WebGLVendorSanitize",
  "WebGLRendererConstant",
  "WebGLRandomization",
  "AudioContext",
  "AudioSampleRate",
  "MediaCapabilities",
  "MediaDevices",
  "MediaError",
  "NetworkConnection",
  "FontVisibilityBaseSystem",
  "CSSResolution",
  "CSSDeviceSize",
  "CSSColorInfo",
  "FrameRate",
  "WebCodecs",
  "WebGPULimits",
  "WebGPUIsFallbackAdapter",
  "WebGPUSubgroupSizes",
  "VideoElementMozFrames",
  "VideoElementMozFrameDelay",
  "VideoElementPlaybackQuality",
];
const missingTargets = REQUIRED_TARGETS.filter(
  (target) => !targets.has(target) && !isDefaultTarget(cfg, target),
);
check(
  "FPP carries every strengthened target",
  missingTargets.length === 0,
  missingTargets.join(", "),
);

// The runtime writer must agree with the shipped default, otherwise the host
// overwrites the config at startup (this happened with the old target set).
const runtimeSets = [
  ["FP_STANDARD", /const FP_STANDARD =([\s\S]*?)const FP_AGGRESSIVE/],
  ["FP_AGGRESSIVE", /const FP_AGGRESSIVE =([\s\S]*?)const FP_SCREEN/],
];
const runtimeMissing = [];
const runtimeTargets = new Set();
for (const [name, pattern] of runtimeSets) {
  const block = privacy.match(pattern);
  const runtime = new Set(
    (block ? block[1] : "")
      .match(/\+[A-Za-z]+/g)
      ?.map((value) => value.slice(1)) || [],
  );
  for (const target of runtime) runtimeTargets.add(target);
  for (const target of REQUIRED_TARGETS) {
    if (!runtime.has(target) && !isDefaultTarget(cfg, target)) {
      runtimeMissing.push(`${name}:${target}`);
    }
  }
}
check(
  "runtime FPP sets match the shipped targets",
  runtimeMissing.length === 0,
  runtimeMissing.slice(0, 8).join(", "),
);

// performance.now() must keep sub-frame precision: FPP's
// ReduceTimerPrecision clamps it to 16.667 ms, which makes Speedometer's
// 0-time suite check fail and breaks real animation code.
check(
  "timer precision is not reduced to the 16.667 ms frame atom",
  !targets.has("ReduceTimerPrecision") &&
    !runtimeTargets.has("ReduceTimerPrecision"),
);
check(
  "per-site aggressive also excludes ReduceTimerPrecision",
  !/"\+AllTargets"/.test(privacy) &&
    /\+AllTargets,-ReduceTimerPrecision/.test(privacy),
);

// The site shield must pause the engine's own ETP lists too, or "off" still
// leaves Disconnect-listed hosts blocked.
const BLOCKER = path.join(ROOT, "overlay/astra/host/Blocker.sys.mjs");
const blockerSource = fs.readFileSync(BLOCKER, "utf8");
check(
  "site shield pauses native ETP per site",
  /trackingprotection/.test(blockerSource) &&
    /addFromPrincipal/.test(blockerSource) &&
    /setNativeSiteException/.test(blockerSource),
);
// CNAME uncloaking must read the async record's canonical name. Calling the
// native `cname()` seam from `onLookupComplete` performs a synchronous system
// DNS query on the chrome main thread, which freezes the window on the first
// page load when the resolver does not answer CNAME queries.
check(
  "CNAME uncloaking never runs a synchronous resolver query",
  !/native\.cname\s*\??\.\(/.test(blockerSource) &&
    /record\?\.canonicalName/.test(blockerSource),
  "Blocker.sys.mjs must read record.canonicalName, never call native.cname()",
);

const REQUIRED_PREFS = [
  ["privacy.fingerprintingProtection", "true"],
  ["privacy.fingerprintingProtection.pbmode", "true"],
  ["privacy.trackingprotection.enabled", "true"],
  ["privacy.trackingprotection.cryptomining.enabled", "true"],
  ["privacy.trackingprotection.fingerprinting.enabled", "true"],
  ["privacy.trackingprotection.emailtracking.enabled", "true"],
  ["privacy.query_stripping.enabled", "true"],
  ["privacy.query_stripping.strip_on_share.enabled", "true"],
  ["network.http.referer.trimmingPolicy", "2"],
  ["network.http.referer.XOriginTrimmingPolicy", "2"],
  ["astra.blocker.enabled", "true"],
  ["astra.blocker.cosmetic", "true"],
  ["astra.blocker.scriptlets", "true"],
  ["astra.blocker.removeparam", "true"],
  ["astra.blocker.bounce", "true"],
  ["astra.blocker.redirects", "true"],
  ["astra.blocker.cname-uncloaking", "true"],
  // Global script blocking stays off: hedging all scripts breaks the web.
  // Per-site script blocking remains a shield control.
  ["astra.blocker.block-scripts", "false"],
];
const missingPrefs = REQUIRED_PREFS.filter(
  ([pref, value]) => !new RegExp(`defaultPref\\("${escapeRe(pref)}",\\s*${value}\\)`).test(cfg),
);
check(
  "privacy and blocker defaults are intact",
  missingPrefs.length === 0,
  missingPrefs.map(([pref]) => pref).join(", "),
);

// 8. The inventory is complete enough to be meaningful and pins its source.
check(
  "inventory pins the public probe source",
  inventory.source === "https://superadblocktest.com/adblock.js" &&
    /^\d{4}-\d{2}-\d{2}$/.test(inventory.captured),
);
check(
  "inventory covers every scored category",
  inventory.scored_categories.every((category) =>
    inventory.hosts.some((entry) => entry.categories.includes(category)),
  ),
);
check(
  "the Adblock Tester inventory pins its source and every category",
  tester.source === "https://adblocktester.pages.dev/" &&
    /^\d{4}-\d{2}-\d{2}$/.test(tester.captured) &&
    tester.categories.every((category) =>
      tester.hosts.some((entry) => entry.category === category),
    ),
);

function isDefaultTarget(cfgText, target) {
  // Firefox enables these with FPP itself; overrides do not have to repeat
  // them. CanvasRandomization/FontVisibilityLangPack are the baseline set.
  return ["CanvasRandomization", "FontVisibilityLangPack"].includes(target);
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

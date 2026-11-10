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

// 3. The shared-domain exception stays path-scoped and the bundled seed
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

// 4. No host rule appears twice in the generated section.
const markerIndex = source.indexOf("! >>> superadblock-strict");
check("strict section marker exists", markerIndex !== -1);
const section = markerIndex === -1 ? "" : source.slice(markerIndex);
const dups = [];
const seen = new Set();
for (const line of section.split("\n")) {
  const rule = line.trim();
  if (!rule.startsWith("||")) continue;
  if (seen.has(rule)) dups.push(rule);
  seen.add(rule);
}
check("generated section has no duplicate rules", dups.length === 0, dups.slice(0, 5).join(", "));

// 5. The generator's `--check` is green (source inventory and list agree).
let generatorOk = false;
let generatorDetail = "";
try {
  execFileSync("python3", [GENERATOR, "--check"], { stdio: "pipe" });
  generatorOk = true;
} catch (error) {
  generatorDetail = String(error.stderr || error.message).trim();
}
check("strict section is current (superadblock.py --check)", generatorOk, generatorDetail);

// 6. The packaged gzip is the same text (a stale jar ships stale rules).
const packed = zlib.gunzipSync(fs.readFileSync(SEED)).toString("utf8");
check("packaged seed matches the list text", packed === source);
check(
  "packaged seed carries the generated section",
  packed.includes("! >>> superadblock-strict") &&
    packed.includes("||pagead2.googlesyndication.com^$important"),
);

// 7. Browser-wide privacy posture stays strengthened. Each target closes a
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

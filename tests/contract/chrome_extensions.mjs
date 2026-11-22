#!/usr/bin/env node
// Chrome extension intake contract: the pure review mapping and the store URL
// rule, with the Rust sidecar stubbed. The live probe
// (`tools/perf/stress/chrome_ext_probe.py`) covers the real CRX3 install.
//
// Usage: node tests/contract/chrome_extensions.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const mod = await import(pathToFileURL(path.join(HOST, "ChromeExtensions.sys.mjs")).href);
const { WebExtensions } = await import(pathToFileURL(path.join(HOST, "WebExtensions.sys.mjs")).href);

// --- store URL rule -------------------------------------------------------
const ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
check("a Chrome Web Store detail URL yields its id", mod.storeIdFromUrl(`https://chromewebstore.google.com/detail/ublock-origin-lite/${ID}`) === ID);
check("the legacy Web Store path yields its id", mod.storeIdFromUrl(`https://chrome.google.com/webstore/detail/ublock-origin-lite/${ID}`) === ID);
check("a query id yields the id", mod.storeIdFromUrl(`https://chromewebstore.google.com/detail/x?hl=en&id=${ID}`) === ID);
check("a non-listing URL is refused", mod.storeIdFromUrl("https://example.com/detail/x") === null);
check("an invalid id is refused", mod.storeIdFromUrl("https://chromewebstore.google.com/detail/x/not-an-id") === null);
check("a javascript URL is refused", mod.storeIdFromUrl("javascript:alert(1)") === null);

// --- review mapping -------------------------------------------------------
const report = {
  source: "chrome",
  format: "crx3",
  identity: { install_id: `${ID}@chrome.astra`, chrome_id: ID, kind: "chrome_key" },
  signature: { verified: "sha256_with_rsa" },
  package_sha256: "a".repeat(64),
  manifest: {
    manifest_version: 3,
    name: "Probe",
    version: "1.2.3",
    description: "A probe",
    permissions: ["tabs", "storage", "sidePanel"],
    host_permissions: ["<all_urls>"],
    optional_permissions: [],
    optional_host_permissions: [],
  },
  compatibility: {
    verdict: "limited",
    manifest_version: 3,
    adaptations: ["background: service worker runs as an event page"],
    limitations: ["side_panel mapped to the engine sidebar"],
    unsupported: ["debugger: no chrome.debugger implementation"],
    apis: [],
    compat_prelude: true,
  },
  security: {
    level: "medium",
    blocked: false,
    summary: "2 signal(s): cryptomining×1, combination×1. Signals can be legitimate.",
    findings: [
      {
        id: "crypto-mining-host",
        category: "cryptomining",
        level: "medium",
        file: "sw.js",
        line: 3,
        evidence: "coinhive … const host = 'coinhive.com'",
        explanation: "names a known browser-mining service",
      },
    ],
  },
  package: { entries: 4, files: 3, compressed_bytes: 100, uncompressed_bytes: 200, largest_entry: 120 },
  warnings: ["Some browser APIs this extension calls are not implemented by this engine."],
  adapted_manifest: {
    manifest_version: 3,
    name: "Probe",
    version: "1.2.3",
    permissions: ["tabs", "storage"],
    host_permissions: ["<all_urls>"],
  },
  store_name: null,
  store_url: null,
};

const review = mod.reviewFromReport(report, { reviewId: "chrome-review-1", persistence: "session", fromFile: false });
check("the review keeps the engine id", review.id === `${ID}@chrome.astra`);
check("the review keeps name and version", review.name === "Probe" && review.version === "1.2.3");
check("the CRX signature is reported as verified", review.signature === "verified");
check("the compatibility verdict survives", review.compatibility === "limited");
check("the security level survives", review.security.level === "medium");
check("security findings are bounded into the review", review.security.findings.length === 1);
check("the install persistence is stated", review.persistence === "session");
check("the review says it is not a file import", review.from_file === false);
check("the manifest version survives", review.manifest_version === 3);
check("permissions are listed", review.permissions.includes("tabs"));
check("host permissions are listed", review.host_permissions.includes("<all_urls>"));
check(
  "the broadest permission leads the warnings",
  review.warnings[0].includes("all your data on all websites"),
  review.warnings[0],
);
check(
  "the engine limitation is shown",
  review.limitations.some((item) => item.includes("side_panel")),
);
check(
  "the security summary is shown",
  review.warnings.some((item) => item.includes("Signals can be legitimate")),
);

const unsigned = mod.reviewFromReport(
  { ...report, signature: "not_present", security: { level: "none", blocked: false, summary: "", findings: [] }, warnings: [] },
  { reviewId: "chrome-review-2", persistence: "profile" },
);
check("an unsigned package is labelled", unsigned.signature === "not_present");
check("a clean report is not called safe", unsigned.security.level === "none");

// --- blocked package is refused before staging ----------------------------
mod.__setCoreCallForTests((name) => {
  if (name === "extensions.inspect") {
    return { report: { ...report, security: { ...report.security, level: "blocked", blocked: true } } };
  }
  throw new Error(`unexpected core call ${name}`);
});
const blockedReview = await mod.ChromeExtensions.prepareFile({ path: "/tmp/probe.crx", source: "chrome" });
check("a blocked package still gets a review", blockedReview.security.blocked === true);
let refused = null;
try {
  await mod.ChromeExtensions.confirm({ review_id: blockedReview.review_id });
} catch (error) {
  refused = error;
}
check("confirm refuses a blocked package", refused !== null && String(refused.message).includes("refused"));
check("the refusal is before any staging", String(refused?.code) === "blocked");

// --- path rule ------------------------------------------------------------
check("a .crx path is a Chrome package", mod.isChromePackagePath("/tmp/a.crx") === true);
check("a .zip path is a Chrome package", mod.isChromePackagePath("/tmp/a.zip") === true);
check("a .xpi path is not handled here", mod.isChromePackagePath("/tmp/a.xpi") === false);
check("a directory is not handled here", mod.isChromePackagePath("/tmp/a") === false);

// --- the Host module exposes the routed methods ---------------------------
for (const name of ["list", "prepare", "prepareFile", "confirm", "cancel", "uninstall", "setEnabled", "retry"]) {
  check(`WebExtensions.${name} exists`, typeof WebExtensions[name] === "function");
}
check("the Chrome module is reachable from the Host API", typeof mod.ChromeExtensions.restore === "function");

// The app opens its Extensions page from this command; it must be admitted by
// the host command table, not only handled by the app after the fact.
const { Commands } = await import(pathToFileURL(path.join(HOST, "Commands.sys.mjs")).href);
const manage = await Commands.run({ id: "extensions.manage" });
check("extensions.manage is admitted", manage?.accepted === true, manage);

mod.__resetChromeExtensionsForTests();
mod.__setCoreCallForTests(null);

console.log(`\nchrome extensions contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);

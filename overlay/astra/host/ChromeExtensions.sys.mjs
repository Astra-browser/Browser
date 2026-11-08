/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Chrome-package intake for the Host API.
//
// The engine (Gecko 153) installs and runs extensions; this module is the
// bridge between a Chrome package and that engine, and it never pretends an
// extension is running when it is not:
//
//   inspect  -> astra-core (`extensions.inspect`) verifies the CRX3
//               signature, unpacks safely, adapts the manifest and returns
//               the compatibility and security report. Read-only.
//   stage    -> astra-core writes an adapted XPI + the report it is bound to.
//   install  -> AddonManager installs that exact XPI. A build that requires
//               Mozilla signatures installs it as a temporary add-on and
//               restores it from Astra's own package store at startup; a
//               build that allows unsigned add-ons installs it persistently.
//               The review says which one applies.
//
// Provenance is recorded in `<ProfD>/astra/extensions/chrome/records.json`
// with the package hash, the CRX signature result, the verdict and the
// security level. The store is never trusted over the engine: the XPI is
// verified again by AddonManager and every install is transactional (stage,
// install, then move the staged package into its final directory; a failure
// removes the staging directory and leaves no record).

import { Boot } from "./Boot.sys.mjs";

let _coreCall = null;
/** Test seam: replace the sidecar call with a stub. */
export function __setCoreCallForTests(fn) {
  _coreCall = typeof fn === "function" ? fn : null;
}

const RECORD_VERSION = 1;
const MAX_PACKAGE_BYTES = 96 * 1024 * 1024;
const STORE_UPDATE_URL =
  "https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3";
const CHROME_ID = /^[a-p]{32}$/u;
const REVIEW_TTL_MS = 10 * 60 * 1000;

const REVIEWS = new Map();
let _nextReview = 0;
let _restorePromise = null;
let _recordsCache = null;

function hasChrome() {
  try {
    return typeof Services !== "undefined" && typeof Cc !== "undefined" && typeof Ci !== "undefined";
  } catch {
    return false;
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pure: the Chrome id from a store listing URL, or null. */
export function storeIdFromUrl(raw) {
  let url = null;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "chromewebstore.google.com" && host !== "chrome.google.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const detail = parts.lastIndexOf("detail");
  const candidate = detail >= 0 ? parts[detail + 2] : parts[parts.length - 1];
  if (candidate && CHROME_ID.test(candidate)) return candidate;
  const query = url.searchParams.get("id");
  return query && CHROME_ID.test(query) ? query : null;
}

/** Pure: a package path this module owns (CRX or ZIP chosen by the person). */
export function isChromePackagePath(path) {
  return typeof path === "string" && /\.(crx|zip)$/iu.test(path);
}

function signatureKind(signature) {
  if (typeof signature === "string") return signature;
  if (signature && typeof signature === "object") {
    if (typeof signature.verified === "string") return "verified";
    if (typeof signature.not_present === "string") return "not_present";
    if (signature.invalid !== undefined) return "invalid";
    if (signature.unsupported !== undefined) return "unsupported";
  }
  return "not_present";
}

const PERMISSION_TEXT = {
  tabs: "Read your browsing history and the tabs you have open",
  cookies: "Read and change your cookies on the sites you visit",
  history: "Read and change your browsing history",
  bookmarks: "Read and change your bookmarks",
  downloads: "Manage your downloads",
  management: "Manage your other extensions",
  webRequest: "Observe and change network requests",
  declarativeNetRequest: "Block or rewrite network requests",
  proxy: "Control your proxy settings",
  nativeMessaging: "Communicate with programs on your computer",
  debugger: "Attach to pages and inspect everything they do",
  clipboardRead: "Read the clipboard",
  clipboardWrite: "Write to the clipboard",
  notifications: "Show notifications",
  identity: "Know your identity on sites that support it",
  "identity.email": "Know your email address",
  privacy: "Change privacy-related settings",
  sessions: "Read and change your recently closed tabs",
  topSites: "Read your most visited sites",
  userScripts: "Run scripts in your browser",
  scripting: "Run scripts on the sites you visit",
  storage: "Store data in your browser",
  alarms: "Schedule background work",
  contextMenus: "Add items to the page context menu",
  commands: "Use keyboard shortcuts",
  omnibox: "Add a keyword to the address bar",
  theme: "Change the browser theme",
  sidePanel: "Show a panel in the browser sidebar",
  declarativeNetRequestFeedback: "See which network requests were blocked",
  "declarativeNetRequestWithHostAccess": "Block requests with the sites you granted",
  unlimitedStorage: "Store unlimited data",
  webNavigation: "Read the address of pages as you browse",
};

function permissionWarnings(manifest) {
  const warnings = [];
  const seen = new Set();
  const permissions = [
    ...(Array.isArray(manifest?.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest?.optional_permissions) ? manifest.optional_permissions : []),
  ];
  const hosts = [
    ...(Array.isArray(manifest?.host_permissions) ? manifest.host_permissions : []),
    ...(Array.isArray(manifest?.permissions)
      ? manifest.permissions.filter((value) => typeof value === "string" && /^[a-z*]+:\/\//u.test(value))
      : []),
  ];
  if (hosts.some((host) => host === "<all_urls>" || host === "*://*/*")) {
    warnings.push("Read and change all your data on all websites");
  } else if (hosts.length > 0) {
    warnings.push(
      hosts.length === 1
        ? `Read and change your data on ${hosts[0]}`
        : `Read and change your data on ${hosts.length} sites`,
    );
  }
  for (const permission of permissions) {
    if (typeof permission !== "string" || seen.has(permission)) continue;
    seen.add(permission);
    const text = PERMISSION_TEXT[permission];
    if (text) warnings.push(text);
    else if (permission !== "<all_urls>" && !/^[a-z*]+:\/\//u.test(permission)) {
      warnings.push(`Ask the browser for the \`${permission}\` permission`);
    }
  }
  return warnings;
}

/** Pure: the review the app renders from a core report. */
export function reviewFromReport(report, { reviewId, persistence, fromFile = true } = {}) {
  const compatibility = report?.compatibility ?? {};
  const security = report?.security ?? {};
  const securityLevel = String(security.level ?? "none");
  const warnings = [
    ...permissionWarnings(report?.adapted_manifest),
    ...(securityLevel === "medium" ||
    securityLevel === "high" ||
    securityLevel === "critical" ||
    security.blocked === true
      ? [String(security.summary ?? "")]
      : []),
    ...(Array.isArray(report?.warnings) ? report.warnings : []),
  ].filter((value, index, list) => typeof value === "string" && value !== "" && list.indexOf(value) === index);
  return {
    review_id: String(reviewId ?? ""),
    id: String(report?.identity?.install_id ?? ""),
    name: String(report?.manifest?.name ?? ""),
    version: String(report?.manifest?.version ?? ""),
    description: String(report?.manifest?.description ?? ""),
    warnings,
    limitations: Array.isArray(compatibility.limitations) ? compatibility.limitations : [],
    icon: null,
    update: false,
    from_file: fromFile === true,
    source: String(report?.source ?? "chrome"),
    signature: signatureKind(report?.signature),
    compatibility: String(compatibility.verdict ?? "unsupported"),
    security: {
      level: String(security.level ?? "none"),
      summary: String(security.summary ?? ""),
      blocked: security.blocked === true,
      findings: Array.isArray(security.findings) ? security.findings.slice(0, 20) : [],
    },
    persistence,
    manifest_version: Number(report?.manifest?.manifest_version ?? 0),
    permissions: Array.isArray(report?.manifest?.permissions) ? report.manifest.permissions : [],
    host_permissions: Array.isArray(report?.manifest?.host_permissions)
      ? report.manifest.host_permissions
      : [],
  };
}

async function coreCall(name, payload) {
  if (_coreCall) return _coreCall(name, payload);
  if (!hasChrome()) throw fail("unavailable", "the extension analyzer needs a browser process");
  const reply = await Boot.coreCall({
    request_id: `ext-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    name,
    payload,
    // A legitimate blocker can carry ~300 MiB of rules across hundreds of
    // files; inspect and stage are disk-bound, not request-bound.
    timeout: 180000,
  });
  if (reply?.error) {
    throw fail("core_error", String(reply.error.message ?? "the extension analyzer refused the package"));
  }
  return reply?.payload ?? null;
}

async function addonManager() {
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    return AddonManager;
  } catch {
    return null;
  }
}

function io() {
  try {
    const scope = hasChrome() ? globalThis : null;
    const value = scope?.IOUtils;
    if (value && typeof value.write === "function") return value;
  } catch {
    // Fall through.
  }
  try {
    return ChromeUtils.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils;
  } catch {
    return null;
  }
}

function profD() {
  return Services.dirsvc.get("ProfD", Ci.nsIFile).path;
}

function root() {
  return `${profD()}/astra/extensions/chrome`;
}

async function readRecords() {
  if (_recordsCache) return _recordsCache;
  const ioUtils = io();
  if (!ioUtils) return { version: RECORD_VERSION, records: {} };
  try {
    const parsed = await ioUtils.readJSON(`${root()}/records.json`, { maxBytes: 1 << 20 });
    if (parsed && parsed.version === RECORD_VERSION && parsed.records && typeof parsed.records === "object") {
      _recordsCache = parsed;
      return parsed;
    }
  } catch {
    // No record yet, or an unreadable one. Start empty; never invent records.
  }
  _recordsCache = { version: RECORD_VERSION, records: {} };
  return _recordsCache;
}

async function writeRecords(doc) {
  const ioUtils = io();
  if (!ioUtils) throw fail("unavailable", "the profile store is not writable");
  const path = `${root()}/records.json`;
  await ioUtils.makeDirectory(root(), { createAncestors: true, ignoreExisting: true });
  await ioUtils.writeJSON(path, doc, { tmpPath: `${path}.tmp`, mode: "overwrite" });
  _recordsCache = doc;
}

async function recordFor(installId) {
  const doc = await readRecords();
  return doc.records[installId] ?? null;
}

async function putRecord(record) {
  const doc = await readRecords();
  doc.records[record.install_id] = record;
  await writeRecords(doc);
}

async function dropRecord(installId) {
  const doc = await readRecords();
  delete doc.records[installId];
  await writeRecords(doc);
}

function signatureRequired() {
  try {
    return Services.prefs.getBoolPref("xpinstall.signatures.required", true) === true;
  } catch {
    return true;
  }
}

function persistenceForCurrentBuild() {
  // The adapted XPI is not signed by Mozilla. A signature-required build can
  // install it only as a temporary add-on; Astra then restores it at startup
  // from its own package store. A build that allows unsigned add-ons can
  // install it persistently through AddonManager.
  return signatureRequired() ? "session" : "profile";
}

async function waitForAddon(manager, id, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const addon = await manager.getAddonByID(id);
    if (addon) return addon;
    await delay(100);
  }
  return null;
}

async function waitForGone(manager, id, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const addon = await manager.getAddonByID(id);
    if (!addon) return true;
    await delay(100);
  }
  return false;
}

async function readBounded(response, limit) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw fail("too_large", "the package is larger than the intake limit");
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw fail("too_large", "the package is larger than the intake limit");
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // Already gone.
      }
      throw fail("too_large", "the package is larger than the intake limit");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function downloadCrx(chromeId) {
  if (!CHROME_ID.test(chromeId)) throw fail("invalid_id", "this is not a Chrome Web Store extension id");
  const version = String(Services.appinfo.version ?? "120.0").split("esr")[0].split(".").slice(0, 3).join(".");
  const url = `${STORE_UPDATE_URL}&prodversion=${encodeURIComponent(version)}&x=id%3D${chromeId}%26uc`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal,
      headers: { Accept: "application/x-chrome-extension" },
    });
  } catch (error) {
    throw fail(
      "store_failed",
      `the Chrome Web Store did not answer (${String(error?.message ?? error)}); download the package and use “Install from file” instead`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw fail(
      "store_failed",
      `the Chrome Web Store returned HTTP ${response.status}; the listing may not allow this update service`,
    );
  }
  const bytes = await readBounded(response, MAX_PACKAGE_BYTES);
  if (!(bytes[0] === 0x43 && bytes[1] === 0x72 && bytes[2] === 0x32 && bytes[3] === 0x34)) {
    throw fail(
      "store_failed",
      "the Chrome Web Store returned something that is not a CRX; use “Install from file” with the downloaded package",
    );
  }
  const ioUtils = io();
  if (!ioUtils) throw fail("unavailable", "the profile store is not writable");
  const dir = `${root()}/downloads`;
  await ioUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  const path = `${dir}/${chromeId}.crx`;
  await ioUtils.write(path, bytes, { tmpPath: `${path}.tmp`, mode: "overwrite" });
  return path;
}

async function inspectPath(path, source = "chrome") {
  const payload = await coreCall("extensions.inspect", { path, source });
  const report = payload?.report;
  if (!report || typeof report !== "object") {
    throw fail("core_error", "the extension analyzer returned no report");
  }
  return report;
}

function newReviewId() {
  _nextReview += 1;
  return `chrome-review-${_nextReview}`;
}

async function rememberReview(report, { path, source, fromFile }) {
  const reviewId = newReviewId();
  const persistence = persistenceForCurrentBuild();
  const review = reviewFromReport(report, { reviewId, persistence, fromFile });
  REVIEWS.set(reviewId, {
    path,
    source,
    report,
    review,
    created: Date.now(),
    storeUrl: report.store_url ?? null,
  });
  // A bounded map: an abandoned review expires instead of accumulating.
  const now = Date.now();
  for (const [key, value] of REVIEWS) {
    if (now - value.created > REVIEW_TTL_MS) REVIEWS.delete(key);
  }
  return review;
}

async function installStaged(staged, report) {
  const manager = await addonManager();
  if (!manager) throw fail("unavailable", "the engine cannot install extensions");
  const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
  const file = new FileUtils.File(staged.xpi_path);
  const id = String(report.identity.install_id);
  const persistence = persistenceForCurrentBuild();

  // A stale add-on with the same id would make temp install fail. Only remove
  // one that this module owns; never touch an unrelated Firefox add-on.
  const existing = await manager.getAddonByID(id);
  if (existing) {
    const record = await recordFor(id);
    if (!record) {
      throw fail(
        "conflict",
        `another add-on already uses the id ${id}; Astra will not replace it automatically`,
      );
    }
    try {
      await existing.uninstall();
    } catch {
      throw fail("install_failed", "the previous copy could not be removed before the update");
    }
    await waitForGone(manager, id);
  }

  if (persistence === "session") {
    try {
      await manager.installTemporaryAddon(file);
    } catch (error) {
      const details = Array.isArray(error?.additionalErrors)
        ? `: ${error.additionalErrors.join("; ")}`
        : "";
      throw fail(
        "install_failed",
        `the engine refused the package: ${String(error?.message ?? error)}${details}`,
      );
    }
  } else {
    let install = null;
    try {
      install = await manager.getInstallForFile(file, null);
    } catch {
      install = null;
    }
    if (!install) throw fail("install_failed", "the engine could not read the package");
    try {
      await install.install();
    } catch (error) {
      const details = Array.isArray(error?.additionalErrors)
        ? `: ${error.additionalErrors.join("; ")}`
        : "";
      throw fail(
        "install_failed",
        `the engine refused the install: ${String(error?.message ?? error)}${details}`,
      );
    }
  }

  const addon = await waitForAddon(manager, id);
  if (!addon) throw fail("install_failed", "the engine did not register the extension");
  return { addon, persistence };
}

async function moveStaged(staged, installId, version) {
  const ioUtils = io();
  if (!ioUtils) return { work_dir: staged.work_dir, xpi_path: staged.xpi_path };
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/gu, "_");
  const destination = `${root()}/packages/${installId}/${safeVersion}`;
  try {
    await ioUtils.remove(destination, { recursive: true, ignoreAbsent: true });
    await ioUtils.makeDirectory(`${root()}/packages/${installId}`, {
      createAncestors: true,
      ignoreExisting: true,
    });
    await ioUtils.move(staged.work_dir, destination);
    return { work_dir: destination, xpi_path: `${destination}/package.xpi` };
  } catch {
    // A temporary add-on keeps reading its source path, so a failed move
    // must not be hidden: keep the staging path (the record still works).
    return { work_dir: staged.work_dir, xpi_path: staged.xpi_path };
  }
}

async function removePackageDir(installId) {
  const ioUtils = io();
  if (!ioUtils) return;
  try {
    await ioUtils.remove(`${root()}/packages/${installId}`, { recursive: true, ignoreAbsent: true });
  } catch {
    // A leftover package is harmless and is retried on the next uninstall.
  }
}

export const ChromeExtensions = {
  /** What this engine can do, straight from the Rust core. */
  async capabilities() {
    return coreCall("extensions.capabilities", {});
  },

  /** Inspect a local CRX/ZIP and return a review. Writes nothing. */
  async prepareFile({ path = "", source = "chrome" } = {}) {
    if (typeof path !== "string" || path === "") throw fail("invalid_path", "no package selected");
    const report = await inspectPath(path, source);
    return rememberReview(report, { path, source, fromFile: true });
  },

  /**
   * Review a Chrome Web Store listing. Acquisition uses Chrome's update
   * service (an unversioned endpoint Google can change); the CRX3 signature
   * is verified and a store-sourced package without a valid signature is
   * refused. File import is the supported fallback and is offered by the UI.
   */
  async prepareStore({ url = "" } = {}) {
    const chromeId = storeIdFromUrl(url);
    if (!chromeId) throw fail("not_a_listing", "this page is not a Chrome Web Store extension listing");
    const path = await downloadCrx(chromeId);
    const report = await inspectPath(path, "chrome");
    if (signatureKind(report.signature) !== "verified") {
      throw fail("unverified_store_package", "the store package's CRX3 signature did not verify, so Astra refused it");
    }
    report.store_url = `https://chromewebstore.google.com/detail/${chromeId}`;
    return rememberReview(report, { path, source: "chrome", fromFile: false });
  },

  /** Inspect a path without preparing an install (probe and diagnostics). */
  async inspect({ path = "", source = "chrome" } = {}) {
    if (typeof path !== "string" || path === "") throw fail("invalid_path", "no package selected");
    return inspectPath(path, source);
  },

  /** Cancel a Chrome review. */
  cancel({ review_id = "", reviewId = "" } = {}) {
    const key = review_id || reviewId;
    REVIEWS.delete(key);
    return undefined;
  },

  /** Stage and install the package the review named. */
  async confirm({ review_id = "", reviewId = "" } = {}) {
    const key = review_id || reviewId;
    const entry = REVIEWS.get(key);
    if (!entry) throw fail("no_review", "this review is no longer available");
    const report = entry.report;
    if (report.security?.blocked === true) {
      REVIEWS.delete(key);
      throw fail(
        "blocked",
        "Astra refused this package: it combines a known mining service with remote code or data exfiltration",
      );
    }
    const destination = `${root()}/staging/${key}`;
    let staged = null;
    try {
      const payload = await coreCall("extensions.stage", {
        path: entry.path,
        source: entry.source,
        dest: destination,
      });
      staged = payload?.staged;
      if (!staged || typeof staged.xpi_path !== "string") {
        throw fail("stage_failed", "the adapter produced no package");
      }
    } catch (error) {
      REVIEWS.delete(key);
      throw error;
    }

    // Move the staged package into its stable home *before* installing: a
    // temporary add-on keeps reading the XPI it was installed from, so moving
    // it afterwards makes its background and content scripts unloadable.
    const placed = await moveStaged(staged, report.identity.install_id, report.manifest.version);
    staged.work_dir = placed.work_dir;
    staged.xpi_path = placed.xpi_path;

    let installed = null;
    try {
      installed = await installStaged(staged, report);
    } catch (error) {
      try {
        const ioUtils = io();
        await ioUtils?.remove(destination, { recursive: true, ignoreAbsent: true });
        await ioUtils?.remove(placed.work_dir, { recursive: true, ignoreAbsent: true });
      } catch {
        // Nothing to clean.
      }
      REVIEWS.delete(key);
      throw error;
    }

    const record = {
      install_id: report.identity.install_id,
      chrome_id: report.identity.chrome_id ?? null,
      name: report.manifest.name,
      version: report.manifest.version,
      source: report.source,
      signature: signatureKind(report.signature),
      verdict: report.compatibility.verdict,
      security_level: report.security.level,
      package_sha256: report.package_sha256,
      xpi_sha256: staged.xpi_sha256,
      xpi_path: staged.xpi_path,
      work_dir: staged.work_dir,
      persistence: installed.persistence,
      enabled: true,
      store_url: entry.storeUrl,
      installed_at: new Date().toISOString(),
    };
    record.work_dir = placed.work_dir;
    record.xpi_path = placed.xpi_path;
    // Only the current version is kept; older package directories would
    // accumulate on every update.
    try {
      const ioUtils = io();
      const base = `${root()}/packages/${record.install_id}`;
      const children = await ioUtils.getChildren(base);
      const current = placed.work_dir.split("/").pop();
      for (const child of children) {
        if (child.split("/").pop() !== current) {
          await ioUtils.remove(child, { recursive: true, ignoreAbsent: true });
        }
      }
    } catch {
      // Pruning is housekeeping; the install and record are already valid.
    }
    try {
      await putRecord(record);
    } catch (error) {
      // The extension is installed. Report the record failure instead of
      // pretending the install is durable across restart.
      REVIEWS.delete(key);
      throw fail("record_failed", `the extension installed but its restore record could not be written: ${String(error?.message ?? error)}`);
    }
    REVIEWS.delete(key);
    return installed.persistence;
  },

  /** Restore session-installed packages after a browser restart. */
  async restore() {
    if (_restorePromise) return _restorePromise;
    _restorePromise = (async () => {
      const manager = await addonManager();
      if (!manager) return { restored: 0, failed: 0 };
      const doc = await readRecords();
      let restored = 0;
      let failed = 0;
      for (const record of Object.values(doc.records)) {
        if (!record || typeof record.install_id !== "string") continue;
        const existing = await manager.getAddonByID(record.install_id);
        if (existing) continue;
        let xpi = record.xpi_path;
        try {
          const ioUtils = io();
          const info = await ioUtils?.stat(xpi);
          if (!info || info.size <= 0) throw new Error("missing");
        } catch {
          record.missing = true;
          failed += 1;
          continue;
        }
        try {
          if (record.persistence === "session") {
            const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
            await manager.installTemporaryAddon(new FileUtils.File(xpi));
          } else {
            const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
            const install = await manager.getInstallForFile(new FileUtils.File(xpi), null);
            if (!install) throw new Error("unreadable");
            await install.install();
          }
          record.missing = false;
          record.restored_at = new Date().toISOString();
          if (record.enabled === false) {
            const addon = await manager.getAddonByID(record.install_id);
            if (addon) await addon.disable().catch(() => {});
          }
          restored += 1;
        } catch {
          record.missing = true;
          failed += 1;
        }
      }
      try {
        await writeRecords(doc);
      } catch {
        // The next list() still reflects AddonManager, which is the truth.
      }
      return { restored, failed };
    })().finally(() => {
      _restorePromise = null;
    });
    return _restorePromise;
  },

  /** Decorate AddonManager views with Astra's Chrome provenance. */
  async decorate(views) {
    const doc = await readRecords();
    const byId = new Map(views.map((view) => [view.id, view]));
    for (const view of views) {
      const record = doc.records[view.id];
      if (!record) continue;
      view.source = record.source === "firefox" ? "firefox" : "chrome";
      view.compatibility = record.verdict ?? "limited";
      view.security_level = record.security_level ?? "none";
      view.persistence = record.persistence ?? "profile";
      view.store_url = record.store_url ?? null;
    }
    // A record whose package could not be restored is shown as failed, not
    // silently omitted.
    for (const [id, record] of Object.entries(doc.records)) {
      if (byId.has(id) || record.missing !== true) continue;
      views.push({
        profile_id: "default",
        install_id: id,
        id,
        name: String(record.name ?? id),
        version: String(record.version ?? ""),
        description: "",
        enabled: false,
        icon: null,
        state: "failed",
        error: "Astra could not restore this package after restart. Install it again from the package or the store.",
        warnings: [],
        limitations: [],
        access: "all",
        sites: [],
        site_scoped: false,
        has_options: false,
        held_update: null,
        sideloaded: true,
        pinned: false,
        source: "chrome",
        compatibility: record.verdict ?? "limited",
        security_level: record.security_level ?? "none",
        persistence: record.persistence ?? "session",
        store_url: record.store_url ?? null,
      });
    }
    return views;
  },

  /** Keep the record's enabled state in step with the engine. */
  async setEnabled({ id = "", enabled = true } = {}) {
    if (typeof id !== "string" || id === "") return;
    const record = await recordFor(id);
    if (!record) return;
    record.enabled = enabled === true;
    await putRecord(record);
  },

  /** Forget the record after AddonManager removed the add-on. */
  async forget({ id = "" } = {}) {
    if (typeof id !== "string" || id === "") return;
    const record = await recordFor(id);
    if (!record) return;
    await dropRecord(id);
    await removePackageDir(id);
  },

  /** The record for one installed extension, for diagnostics. */
  async record({ id = "" } = {}) {
    if (typeof id !== "string" || id === "") return null;
    return recordFor(id);
  },

  /** Store listing metadata for a tab, used by `prepare`. */
  async prepareFromTab({ url = "" } = {}) {
    return ChromeExtensions.prepareStore({ url });
  },
};

/**
 * Restore session packages once per process. The observer is the first
 * window's startup point; the immediate call is the fallback for a window
 * opened after that point.
 */
export function installStartupRestore() {
  if (!hasChrome()) return;
  try {
    if (Services.__astraChromeRestore) return;
    Services.__astraChromeRestore = true;
  } catch {
    // A scope without Services is a Node test; nothing to restore.
    return;
  }
  const run = () => {
    void ChromeExtensions.restore().catch(() => {
      // A failed restore is recorded per package; startup must not throw.
    });
  };
  try {
    const observer = {
      observe(_subject, topic) {
        if (topic !== "sessionstore-windows-restored") return;
        try {
          Services.obs.removeObserver(observer, topic);
        } catch {
          // Already removed.
        }
        run();
      },
    };
    Services.obs.addObserver(observer, "sessionstore-windows-restored");
  } catch {
    run();
  }
  setTimeout(run, 2500);
}

// Test-only reset.
export function __resetChromeExtensionsForTests() {
  REVIEWS.clear();
  _nextReview = 0;
  _recordsCache = null;
  _restorePromise = null;
}

installStartupRestore();

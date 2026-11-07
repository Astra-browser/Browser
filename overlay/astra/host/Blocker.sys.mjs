/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Blocker module (Lane 3, P4-T02 consumer).
//
// What exists natively in this tree:
// - `mozilla::AstraBlocker` (`toolkit/components/astra_blocker_engine/`,
//   patch ASTRA-0004) with `InstallRules(const nsACString&)`, `SetEnabled`,
//   `SetSiteEnabled`, `IsInitialized` and `IsEnabled`; the network hook is
//   ASTRA-0005 in `netwerk/url-classifier/AsyncUrlChannelClassifier.cpp`.
// - `astra.blocker.enabled`, read by the hook (default false: no rules means
//   no blocks).
// - The Rust engine/seed lists live in `crates/astra-blocker/` (a library,
//   not a sidecar binary), with `seed/v1/easylist.txt.gz` and
//   `seed/v1/easyprivacy.txt.gz`.
//
// What is missing in this build — and why this module reports `unavailable`
// instead of pretending to be active:
// - `AstraBlocker::InstallRules` is a C++ namespace function reached only by
//   the C++ channel hook. There is no `nsIAstraBlockerService`, no
//   `components.conf` entry and no JS/XPCOM bridge that can call it. The
//   patch comment in ASTRA-0004 calls that wrapper "future".
// - `crates/astra-blocker` is not linked into `astra-core` and has no
//   `[[bin]]`, so there is no sidecar process to install rules either.
// - The seed lists are not packaged into `chrome://astra/` or
//   `resource://astra/`.
//
// This module therefore owns the preference, the projection, operations and
// the exact truth: `protection: "unavailable"`, `failure:
// "native_unsupported"` when someone asks for protection, and null stats. It
// never reports `active` and never invents blocked counts. If a later engine
// patch publishes the JS seam, `resolveNative()` below accepts either
// `Services.astraBlocker` or `@astra/blocker;1`, and the same status/install
// path becomes live without a UI change.
//
// Operation contract: every mutation returns an OperationAdmission and settles
// through the Operations ledger, because the app waits for that disposition.

import { emit } from "./Events.sys.mjs";
import { admit, refuse } from "./Operations.sys.mjs";

const PREF = "astra.blocker.enabled";
const LISTS_PREF = "astra.blocker.lists";
const SCHEDULE_PREF = "astra.blocker.update-hours";
const AUTO_UPDATE_PREF = "astra.blocker.update-on-startup";
const COSMETIC_PREF = "astra.blocker.cosmetic";
const SCRIPTLETS_PREF = "astra.blocker.scriptlets";
const LAST_UPDATE_PREF = "astra.blocker.last-update";
const MANIFEST_PREF = "astra.blocker.installed";
const SITE_EXCEPTIONS_PREF = "astra.blocker.site-exceptions";

// One list is capped at 16 MiB; a whole bundle at 48 MiB. These match the
// engine's realistic upper bound (uBO + EasyList + privacy) with room for a
// regional subscription, and keep a hostile URL from exhausting memory.
const MAX_LIST_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 48 * 1024 * 1024;
const MAX_LISTS = 128;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_UPDATE_HOURS = 24;
const DEFAULT_ENABLED = true;
const DATA_ROOT = "resource://astra/blocker/";
const HEX16 = /^[0-9a-f]{16}$/u;

/** Failure categories the UI understands; unknown values are never echoed. */
const FAILURES = new Set([
  "site_preferences_unavailable",
  "generation_exhausted",
  "compiler_dispatch_rejected",
  "compiler_unavailable",
  "compile_source_unavailable",
  "compile_invalid_source",
  "compile_resource_limit",
  "compile_internal",
  "compiled_artifact_mismatch",
  "native_dispatch_rejected",
  "native_unsupported",
  "native_unsupported_artifact",
  "native_invalid_artifact",
  "native_compilation",
  "native_installation",
  "native_cleanup",
  "native_superseded",
  "contradictory_native_settlement",
]);

const SOURCE_FAILURES = new Set([
  "transport",
  "metadata",
  "clock",
  "manifest",
  "target",
  "license",
  "rollback",
  "storage",
  "catalog",
  "internal",
]);

const SOURCE_PHASES = new Set([
  "not_configured",
  "durable_activation_unsupported",
  "storage_unavailable",
  "clock_unsafe",
  "idle",
  "fresh",
  "stale",
  "refreshing",
  "failed",
  "shutdown",
]);

const PROVENANCE = new Set(["release_bundle", "tuf_repository", "official_https"]);

const COVERAGE_FIELDS = [
  "source_rules",
  "accepted_rules",
  "rejected_rules",
  "platform_omitted_rules",
  "platform_approximated_rules",
  "platform_resource_approximated_rules",
  "platform_source_kind_approximated_rules",
  "platform_attribution_approximated_rules",
  "blocking_rule_entries",
];

const DIAGNOSTIC_FIELDS = [
  "total_decisions",
  "candidate_budget_exhausted",
  "matcher_unavailable",
  "matcher_unprepared",
  "attribution_unavailable",
  "evaluation_errors",
];

// --- Injectable seam (tests) + live adapter --------------------------------

let _backend = null;
let _live = null;
let _installed = false;
let _revision = 0;
let _generationSeq = 0;
let _installing = null;
let _refreshTimer = null;
let _startupTimer = null;
let _actorRegistered = false;

/** Test-only: swap the native/pref adapter. */
export function __setBlockerBackend(backend) {
  _backend = backend;
  return () => {
    if (_backend === backend) _backend = null;
  };
}

export function __resetBlockerForTests() {
  uninstall();
  _backend = null;
  _live = null;
  _installed = false;
  _revision = 0;
  _generationSeq = 0;
  _installing = null;
  _state = freshState();
}

function freshState() {
  return {
    desired: null,
    applied: null,
    failure: null,
    sourcePhase: "not_configured",
    sourceFailure: null,
    sourceCount: null,
    sourceBytes: null,
    sourcePackageRevision: null,
    sourceInstalledRevision: null,
    sourcePackageProvenance: null,
    sourceInstalledProvenance: null,
    sourceIdentities: null,
    sourcePackageCreatedUnix: null,
    sourcePackageExpiresUnix: null,
    sourcePackageStale: null,
    sourceRefreshDue: false,
    sourceActivationPending: false,
  };
}

let _state = freshState();

function mintRevision() {
  _revision += 1;
  return _revision.toString(16).padStart(32, "0").slice(-32);
}

function mintGeneration() {
  _generationSeq += 1;
  const counter = _generationSeq.toString(16).padStart(8, "0").slice(-8);
  const buffer = new Uint8Array(4);
  const crypto = globalThis.crypto;
  if (typeof crypto?.getRandomValues === "function") {
    crypto.getRandomValues(buffer);
  } else {
    for (let i = 0; i < buffer.length; i += 1) {
      buffer[i] = Math.floor(Math.random() * 256);
    }
  }
  const salt = Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${counter}${salt}`;
}

function text(value, max = 2048) {
  return typeof value === "string" && value !== "" && value.length <= max
    ? value
    : "";
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function coverage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const field of COVERAGE_FIELDS) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return null;
    out[field] = value[field];
  }
  return out;
}

function diagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    if (typeof value[field] !== "string" || !/^\d+$/u.test(value[field])) {
      return null;
    }
    out[field] = value[field];
  }
  return out;
}

function failure(value) {
  return typeof value === "string" && FAILURES.has(value) ? value : null;
}

function sourceFailure(value) {
  return typeof value === "string" && SOURCE_FAILURES.has(value) ? value : null;
}

function provenance(value) {
  return typeof value === "string" && PROVENANCE.has(value) ? value : null;
}

function safeSourcePhase(value) {
  return typeof value === "string" && SOURCE_PHASES.has(value)
    ? value
    : "not_configured";
}

/** The live native seam: `@astra/blocker;1` from ASTRA-0004. */
function resolveNative() {
  try {
    if (typeof Cc === "undefined" || typeof Ci === "undefined") return null;
    const service = Cc["@astra/blocker;1"]?.getService(Ci.nsIAstraBlockerService);
    if (!service) return null;
    return {
      installRules: (rules) => service.installRules(rules),
      setResources: (json) => service.setResources(json),
      setEnabled: (enabled) => service.setEnabled(enabled),
      setSiteEnabled: (host, enabled) => service.setSiteEnabled(host, enabled),
      isSiteEnabled: (host) => service.isSiteEnabled(host) === true,
      isInitialized: () => service.initialized === true,
      isEnabled: () => service.enabled === true,
      statusJson: () => service.status(),
      statsJson: () => service.stats(),
      resetStats: () => service.resetStats(),
      siteExceptionsJson: () => service.siteExceptions(),
      cosmeticFor: (url, classesJson, idsJson) =>
        service.cosmeticFor(String(url), classesJson, idsJson),
    };
  } catch {
    return null;
  }
}

function nativeState(backend) {
  const fallback = {
    available: false,
    ready: false,
    initialized: false,
    enabled: false,
    coverage: null,
    diagnostics: null,
    failure: "native_unsupported",
  };
  if (!backend || typeof backend.nativeStatus !== "function") return fallback;
  try {
    const value = backend.nativeStatus();
    if (!value || typeof value !== "object") return fallback;
    return {
      available: value.available === true,
      ready: value.ready === true,
      initialized: value.initialized === true,
      enabled: value.enabled === true,
      coverage: coverage(value.coverage),
      diagnostics: diagnostics(value.diagnostics),
      failure: failure(value.failure),
    };
  } catch {
    return fallback;
  }
}

function readEnabled(backend) {
  try {
    const value = backend.readEnabled();
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

function writeEnabled(backend, enabled) {
  try {
    return backend.writeEnabled(enabled) === true;
  } catch {
    return false;
  }
}

function emptyBackend() {
  return {
    readEnabled: () => null,
    writeEnabled: () => false,
    nativeStatus: () => ({ available: false }),
    site: () => null,
    stats: () => null,
  };
}

// --- Filter source pipeline ------------------------------------------------
// The native service only compiles what it is handed. The Host owns the
// catalog, the on-disk cache and the network, so an engine update is one
// native install and a list failure never removes working rules.

let _catalogCache = null;

function chromeScope() {
  try {
    if (
      typeof ChromeUtils !== "undefined" &&
      typeof Services !== "undefined" &&
      typeof Cc !== "undefined" &&
      typeof Ci !== "undefined"
    ) {
      return { ChromeUtils, Services, Cc, Ci };
    }
  } catch {
    // Node contract tests have no chrome globals.
  }
  return null;
}

function prefBool(name, fallback) {
  try {
    return Services.prefs.getBoolPref(name, fallback);
  } catch {
    return fallback;
  }
}

function prefInt(name, fallback) {
  try {
    return Services.prefs.getIntPref(name, fallback);
  } catch {
    return fallback;
  }
}

function prefString(name, fallback) {
  try {
    return Services.prefs.getStringPref(name, fallback);
  } catch {
    return fallback;
  }
}

function writePrefString(name, value) {
  try {
    Services.prefs.setStringPref(name, String(value));
    return true;
  } catch {
    return false;
  }
}

function importGecko(path) {
  try {
    return ChromeUtils.importESModule(path);
  } catch {
    return null;
  }
}

async function readResourceText(url) {
  const chrome = chromeScope();
  if (!chrome) throw new Error("no_chrome");
  if (typeof fetch === "function") {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error(`http_${response.status}`);
    return await response.text();
  }
  const { NetUtil } = importGecko("resource://gre/modules/NetUtil.sys.mjs") ?? {};
  if (!NetUtil) throw new Error("no_netutil");
  return await new Promise((resolve, reject) => {
    NetUtil.asyncFetch(
      { uri: url, loadUsingSystemPrincipal: true },
      (stream, status) => {
        try {
          if (!Components.isSuccessCode(status)) {
            return reject(new Error(`status_${status}`));
          }
          resolve(
            NetUtil.readInputStreamToString(stream, stream.available(), {
              charset: "utf-8",
            }),
          );
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

async function readResourceGzipText(url) {
  if (typeof fetch !== "function" || typeof DecompressionStream !== "function") {
    throw new Error("gzip_unavailable");
  }
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

/** Reads a response body, refusing to buffer more than `max` bytes. */
async function readCapped(response, max) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > max) throw new Error("too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (text.length > max) throw new Error("too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > max) {
        await reader.cancel();
        throw new Error("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchListText(url) {
  if (typeof fetch !== "function") throw new Error("transport");
  if (!/^https:\/\//iu.test(url)) throw new Error("insecure_source");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    // A source that starts on HTTPS must stay on HTTPS; a downgraded body is
    // scriptlet input and is not trusted.
    if (response.url && !/^https:/iu.test(response.url)) {
      throw new Error("insecure_redirect");
    }
    const text = await readCapped(response, MAX_LIST_BYTES);
    if (text.length === 0) throw new Error("empty");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function cachePaths() {
  const chrome = chromeScope();
  if (!chrome) return null;
  const { PathUtils } = importGecko("resource://gre/modules/PathUtils.sys.mjs") ?? {};
  const { IOUtils } = importGecko("resource://gre/modules/IOUtils.sys.mjs") ?? {};
  if (!PathUtils || !IOUtils) return null;
  const dir = PathUtils.join(PathUtils.profileDir, "astra", "blocker", "lists");
  return { IOUtils, PathUtils, dir };
}

async function readCachedList(id) {
  const cache = cachePaths();
  if (!cache) return "";
  try {
    const text = await cache.IOUtils.readUTF8(
      cache.PathUtils.join(cache.dir, `${id}.txt`),
    );
    if (!text || text.length > MAX_LIST_BYTES) return "";
    return text;
  } catch {
    return "";
  }
}

async function writeCachedList(id, text) {
  const cache = cachePaths();
  if (!cache) return false;
  try {
    await cache.IOUtils.makeDirectory(cache.dir, { ignoreExisting: true });
    await cache.IOUtils.writeUTF8(
      cache.PathUtils.join(cache.dir, `${id}.txt`),
      text,
    );
    return true;
  } catch {
    return false;
  }
}

async function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  const text = await readResourceText(`${DATA_ROOT}catalog.json`);
  const parsed = JSON.parse(text);
  if (
    !parsed ||
    parsed.schema_version !== 1 ||
    !Array.isArray(parsed.lists) ||
    parsed.lists.length === 0
  ) {
    throw new Error("bad_catalog");
  }
  _catalogCache = parsed;
  return parsed;
}

function selectedListIds(catalog) {
  const known = new Set(catalog.lists.map((entry) => entry.id));
  const raw = prefString(LISTS_PREF, "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((id) => typeof id === "string" && known.has(id));
      }
    } catch {
      // Fall through to defaults.
    }
  }
  return catalog.lists
    .filter((entry) => entry.default_enabled === true)
    .map((entry) => entry.id);
}

function countRules(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("!") && !trimmed.startsWith("[")) {
      count += 1;
    }
  }
  return count;
}

async function sha256Hex(text) {
  try {
    if (typeof crypto?.subtle?.digest === "function") {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }
  } catch {
    // Fall through to a cheap deterministic revision.
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${text.length
    .toString(16)
    .padStart(8, "0")}`;
}

async function loadOneList(entry, { refresh = false } = {}) {
  let text = "";
  let from = "cache";
  if (!refresh) {
    text = await readCachedList(entry.id);
  }
  if (!text) {
    try {
      text = await fetchListText(entry.source_url);
      from = "network";
    } catch {
      // A failed refresh must fall back to the last good cache, not to an
      // older bundled seed that would silently downgrade a list.
      from = "cache";
      text = await readCachedList(entry.id);
      if (!text && entry.bundled) {
        from = "bundled";
        try {
          text = await readResourceGzipText(
            `${DATA_ROOT}seed/${entry.id}.txt.gz`,
          );
          if (text.length > MAX_LIST_BYTES) text = "";
        } catch {
          text = "";
        }
      }
    }
  }
  if (text) {
    await writeCachedList(entry.id, text);
  }
  return { id: entry.id, text, from, bytes: text.length };
}

async function buildBundle({ refresh = false } = {}) {
  const catalog = await loadCatalog();
  const ids = selectedListIds(catalog).slice(0, MAX_LISTS);
  const byId = new Map(ids.map((id) => [id, catalog.lists.find((l) => l.id === id)]));
  const sources = [];
  const manifest = {};
  const missing = [];
  let totalBytes = 0;
  let totalRules = 0;

  // Bounded concurrency: four sources at a time keeps the network and the
  // parse buffers small; a slow subscription cannot stall the rest.
  const queue = [...byId.values()].filter(Boolean);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      const loaded = await loadOneList(entry, { refresh });
      if (!loaded.text) {
        missing.push(entry.id);
        continue;
      }
      if (totalBytes + loaded.bytes > MAX_BUNDLE_BYTES) continue;
      totalBytes += loaded.bytes;
      totalRules += countRules(loaded.text);
      sources.push(loaded);
      manifest[loaded.id] = {
        bytes: loaded.bytes,
        from: loaded.from,
        sha256: (await sha256Hex(loaded.text)).slice(0, 64),
      };
    }
  });
  await Promise.all(workers);

  if (sources.length === 0) {
    return {
      ok: false,
      failure: "transport",
      rules: "",
      count: 0,
      bytes: 0,
      missing,
    };
  }
  sources.sort((left, right) => left.id.localeCompare(right.id));
  const rules = sources
    .map((source) => `! ==== astra:${source.id} ====\n${source.text}`)
    .join("\n");
  return {
    ok: true,
    failure: null,
    rules,
    count: sources.length,
    bytes: totalBytes,
    compiledRules: totalRules,
    manifest,
    missing,
    revision: (await sha256Hex(rules)).slice(0, 16),
  };
}

function readManifest() {
  try {
    const parsed = JSON.parse(prefString(MANIFEST_PREF, ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function recordInstall(bundle) {
  const now = Math.floor(Date.now() / 1000);
  _state.sourcePhase = "fresh";
  _state.sourceFailure = null;
  _state.sourceCount = bundle.count;
  _state.sourceBytes = bundle.bytes;
  _state.sourcePackageRevision = bundle.revision;
  _state.sourceInstalledRevision = bundle.revision;
  _state.sourcePackageProvenance = "official_https";
  _state.sourceInstalledProvenance = "official_https";
  _state.sourcePackageCreatedUnix = String(now);
  _state.sourcePackageExpiresUnix = String(now + 86_400 * 2);
  _state.sourcePackageStale = false;
  _state.sourceRefreshDue = false;
  try {
    Services.prefs.setIntPref(LAST_UPDATE_PREF, now);
  } catch {
    // A locked pref is not fatal: the manifest still carries the revision.
  }
  writePrefString(
    MANIFEST_PREF,
    JSON.stringify({
      revision: bundle.revision,
      updated_unix: now,
      count: bundle.count,
      bytes: bundle.bytes,
      lists: bundle.manifest,
    }),
  );
}

function hydrateState() {
  const manifest = readManifest();
  if (!manifest) return;
  if (typeof manifest.revision === "string" && HEX16.test(manifest.revision)) {
    _state.sourcePackageRevision = manifest.revision;
    _state.sourceInstalledRevision = manifest.revision;
    _state.sourcePackageProvenance = "official_https";
    _state.sourceInstalledProvenance = "official_https";
  }
  if (Number.isSafeInteger(manifest.count)) _state.sourceCount = manifest.count;
  if (Number.isSafeInteger(manifest.bytes)) _state.sourceBytes = manifest.bytes;
  if (Number.isSafeInteger(manifest.updated_unix)) {
    _state.sourcePackageCreatedUnix = String(manifest.updated_unix);
    _state.sourcePhase = "stale";
  }
}

function readSiteExceptions() {
  try {
    const parsed = JSON.parse(prefString(SITE_EXCEPTIONS_PREF, "[]"));
    return Array.isArray(parsed)
      ? parsed.filter((host) => typeof host === "string" && host !== "")
      : [];
  } catch {
    return [];
  }
}

function writeSiteException(host, paused) {
  const site = String(host ?? "").trim().toLowerCase();
  if (!site) return false;
  const current = new Set(readSiteExceptions());
  if (paused) current.add(site);
  else current.delete(site);
  return writePrefString(
    SITE_EXCEPTIONS_PREF,
    JSON.stringify([...current].sort()),
  );
}

function applySiteExceptions(native) {
  for (const host of readSiteExceptions()) {
    try {
      native.setSiteEnabled(host, false);
    } catch {
      // A single bad host must not stop the install.
    }
  }
}

async function installNative(native) {
  await Promise.resolve();
  try {
    const resources = await readResourceText(`${DATA_ROOT}resources.json`);
    if (resources) native.setResources(resources);
  } catch {
    // Cosmetic resources are an enhancement; network blocking still installs.
  }
  const bundle = await buildBundle({ refresh: false });
  if (!bundle.ok) return { ok: false, failure: bundle.failure ?? "transport" };
  applySiteExceptions(native);
  try {
    native.installRules(bundle.rules);
  } catch {
    return { ok: false, failure: "native_installation" };
  }
  recordInstall(bundle);
  return {
    ok: true,
    generation: mintGeneration(),
    coverage: null,
    missing: bundle.missing,
  };
}

async function refreshNative(native) {
  const bundle = await buildBundle({ refresh: true });
  if (!bundle.ok) return { ok: false, failure: bundle.failure ?? "transport" };
  try {
    const resources = await readResourceText(`${DATA_ROOT}resources.json`);
    if (resources) native.setResources(resources);
  } catch {
    // Keep the previous resource set.
  }
  applySiteExceptions(native);
  try {
    native.installRules(bundle.rules);
  } catch {
    return { ok: false, failure: "native_installation" };
  }
  recordInstall(bundle);
  return {
    ok: true,
    generation: mintGeneration(),
    coverage: null,
    revision: bundle.revision,
    count: bundle.count,
    bytes: bundle.bytes,
    provenance: "official_https",
    missing: bundle.missing,
  };
}

function liveBackend() {
  if (_live) return _live;
  if (typeof ChromeUtils === "undefined" || typeof Services === "undefined") {
    _live = emptyBackend();
    return _live;
  }
  const privateWindow = () => {
    try {
      const win =
        Services.focus?.activeWindow ??
        Services.wm.getMostRecentWindow("navigator:browser");
      if (!win) return false;
      const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
      );
      return PrivateBrowsingUtils.isWindowPrivate(win) === true;
    } catch {
      return false;
    }
  };
  let siteKey = "";
  let siteRevision = "";
  _live = {
    readEnabled() {
      try {
        if (Services.prefs.getPrefType(PREF) === Services.prefs.PREF_INVALID) {
          return DEFAULT_ENABLED;
        }
        return Services.prefs.getBoolPref(PREF, DEFAULT_ENABLED);
      } catch {
        return null;
      }
    },
    writeEnabled(enabled) {
      try {
        Services.prefs.setBoolPref(PREF, enabled);
        return true;
      } catch {
        return false;
      }
    },
    nativeStatus() {
      const native = resolveNative();
      if (!native) {
        return {
          available: false,
          ready: false,
          initialized: false,
          enabled: false,
          coverage: null,
          diagnostics: null,
          failure: "native_unsupported",
        };
      }
      let info = {};
      try {
        info = JSON.parse(native.statusJson() || "{}");
      } catch {
        info = {};
      }
      const initialized = info.initialized === true;
      const enabled = info.enabled === true;
      return {
        available: true,
        ready: initialized,
        initialized,
        enabled,
        coverage: null,
        diagnostics: null,
        failure: null,
      };
    },
    async installRules() {
      const native = resolveNative();
      if (!native) return { ok: false, failure: "native_unsupported" };
      try {
        return await installNative(native);
      } catch {
        return { ok: false, failure: "native_installation" };
      }
    },
    async refreshSources() {
      const native = resolveNative();
      if (!native) return { ok: false, failure: "native_unsupported" };
      try {
        return await refreshNative(native);
      } catch {
        return { ok: false, failure: "internal" };
      }
    },
    setEnabled(enabled) {
      try {
        const native = resolveNative();
        native?.setEnabled?.(enabled);
        return true;
      } catch {
        return false;
      }
    },
    setSiteEnabled(site, enabled) {
      try {
        const native = resolveNative();
        if (!native?.setSiteEnabled) return false;
        native.setSiteEnabled(site, enabled);
        return writeSiteException(site, enabled === false);
      } catch {
        return false;
      }
    },
    site() {
      const native = resolveNative();
      if (!native) return null;
      let win = null;
      let browser = null;
      try {
        win =
          Services.focus?.activeWindow ??
          Services.wm.getMostRecentWindow("navigator:browser");
        browser = win?.gBrowser?.selectedBrowser ?? null;
      } catch {
        browser = null;
      }
      if (!browser) return null;
      let url = "";
      try {
        url = browser.currentURI?.spec ?? "";
      } catch {
        url = "";
      }
      const site = hostOf(url);
      if (site === "") return null;
      let tab = "";
      try {
        tab = win.gBrowser.getTabForBrowser?.(browser)?.getAttribute?.("astra-tab-id") ?? "";
      } catch {
        tab = "";
      }
      if (tab === "") return null;
      const profile = privateWindow() ? "incognito" : "default";
      let paused = false;
      try {
        paused = native.isSiteEnabled(site) === false;
      } catch {
        paused = false;
      }
      const key = `${profile}\n${tab}\n${site}`;
      if (key !== siteKey) {
        siteKey = key;
        siteRevision = mintGeneration();
      }
      return {
        context: {
          profile,
          tab,
          site,
          revision: siteRevision,
        },
        paused,
        private_session: profile === "incognito",
        ready: native.isInitialized() === true,
        busy: false,
        hides: [],
      };
    },
    stats(profile) {
      // Private windows are blocked but never recorded (D-41).
      if (profile === "incognito") {
        return { today: null, last7Days: null, days: [] };
      }
      try {
        const native = resolveNative();
        if (!native) return null;
        const parsed = JSON.parse(native.statsJson() || "{}");
        return {
          today: integer(parsed.today),
          last7Days: integer(parsed.last_7_days ?? parsed.last7Days),
          days: Array.isArray(parsed.days)
            ? parsed.days.map((value) => integer(value))
            : [],
        };
      } catch {
        return null;
      }
    },
    async picker() {
      return null;
    },
  };
  return _live;
}

function getBackend() {
  return _backend ?? liveBackend();
}

function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname;
  } catch {
    return "";
  }
}

// --- Projection -------------------------------------------------------------

function siteView(backend) {
  if (!backend || typeof backend.site !== "function") return null;
  let raw = null;
  try {
    raw = backend.site();
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return null;
  const context = raw.context ?? raw;
  const profile = text(context?.profile, 64);
  const tab = text(context?.tab, 256);
  const site = text(context?.site, 255);
  let revision = text(context?.revision, 32);
  if (!profile || !tab || !site) return null;
  if (!HEX16.test(revision)) revision = mintGeneration();
  return {
    context: { profile, tab, site, revision },
    paused: raw.paused === true,
    private_session: raw.private_session === true,
    ready: raw.ready === true,
    busy: raw.busy === true,
    hides: Array.isArray(raw.hides)
      ? raw.hides.filter((hide) => hide && typeof hide === "object")
      : [],
  };
}

function buildStatus() {
  const backend = getBackend();
  const desired = readEnabled(backend);
  const native = nativeState(backend);
  const applied = _state.applied;
  const ignoredFailure = _state.failure ?? native.failure;
  const failureValue = desired === true ? failure(ignoredFailure) : null;

  let protection = "unavailable";
  if (desired === null) {
    protection = "unavailable";
  } else if (desired === false) {
    protection = "disabled";
  } else if (native.available && applied) {
    protection = "active";
    const cov = applied.coverage;
    if (
      cov &&
      (cov.rejected_rules > 0 ||
        cov.platform_omitted_rules > 0 ||
        cov.platform_approximated_rules > 0 ||
        cov.platform_resource_approximated_rules > 0 ||
        cov.platform_source_kind_approximated_rules > 0 ||
        cov.platform_attribution_approximated_rules > 0)
    ) {
      protection = "degraded";
    }
  } else if (native.available) {
    protection = failureValue ? "degraded" : "pending";
  }

  const phase = !native.available
    ? "unavailable"
    : applied
      ? "ready"
      : failureValue
        ? "failed"
        : "uninitialized";

  let sourcePhase = safeSourcePhase(_state.sourcePhase);
  if (!native.available) sourcePhase = "not_configured";

  return {
    site: siteView(backend),
    projection_revision: mintRevision(),
    protection,
    phase,
    preference: desired === null ? "unavailable" : "authoritative",
    config_revision: applied ? applied.generation : null,
    desired_enabled: desired,
    applied_enabled: native.available
      ? applied !== null
      : desired === false
        ? false
        : null,
    desired_generation: _state.desired ? _state.desired.generation : null,
    retained_generation: applied ? applied.generation : null,
    failure: failureValue,
    retryable: failureValue !== null && native.available,
    retries_remaining: failureValue !== null && native.available ? 1 : 0,
    applied_coverage: applied ? applied.coverage : null,
    runtime_diagnostics: native.diagnostics,
    source_phase: sourcePhase,
    source_failure: sourceFailure(_state.sourceFailure),
    source_package_revision: _state.sourcePackageRevision,
    source_installed_revision: _state.sourceInstalledRevision,
    source_package_provenance: provenance(_state.sourcePackageProvenance),
    source_installed_provenance: provenance(_state.sourceInstalledProvenance),
    source_identities: _state.sourceIdentities,
    source_package_created_unix: _state.sourcePackageCreatedUnix,
    source_package_expires_unix: _state.sourcePackageExpiresUnix,
    source_package_stale: _state.sourcePackageStale,
    source_refresh_due: _state.sourceRefreshDue === true,
    source_count: _state.sourceCount,
    source_bytes: _state.sourceBytes,
    source_activation_pending: _state.sourceActivationPending === true,
    source_material_repair_pending: false,
    source_material_repair_retry_pending: false,
    source_repair_retry_pending: false,
    source_last_refresh_attempt_unix: null,
    source_refresh_operation: null,
    can_enable:
      desired !== null &&
      native.available &&
      typeof backend.installRules === "function",
    can_refresh_sources:
      native.available &&
      typeof backend.refreshSources === "function" &&
      sourcePhase !== "refreshing",
  };
}

function publish() {
  const view = buildStatus();
  emit("blocker-status-changed", view);
  return view;
}

async function installRules(backend) {
  const generation = mintGeneration();
  _state.desired = { generation };
  _state.sourceActivationPending = true;
  let result = null;
  try {
    result = await Promise.resolve(backend.installRules());
  } catch {
    result = null;
  }
  _state.sourceActivationPending = false;
  if (result && result.ok === true) {
    const installed =
      typeof result.generation === "string" && HEX16.test(result.generation)
        ? result.generation
        : generation;
    const cov = coverage(result.coverage);
    _state.applied = { generation: installed, coverage: cov };
    _state.failure = null;
    return { ok: true, generation: installed };
  }
  // The Rust side keeps the previous engine on a failed compile; keep the
  // retained generation here too so status does not claim protection vanished.
  _state.failure = failure(result?.failure) ?? "native_installation";
  return { ok: false, failure: _state.failure };
}

/** One in-flight install shared by status reconciliation and a toggle. */
function ensureInstalled(backend) {
  if (_installing) return _installing;
  const task = installRules(backend);
  _installing = task;
  void task.finally(() => {
    if (_installing === task) _installing = null;
  });
  return task;
}

async function refreshAndInstall(backend) {
  if (!backend || typeof backend.refreshSources !== "function") {
    return { ok: false, failure: "internal" };
  }
  _state.sourcePhase = "refreshing";
  publish();
  let result = null;
  try {
    result = await Promise.resolve(backend.refreshSources());
  } catch {
    result = null;
  }
  if (!result || result.ok !== true) {
    _state.sourcePhase = "failed";
    _state.sourceFailure = sourceFailure(result?.failure) ?? "internal";
    return { ok: false, failure: _state.sourceFailure };
  }
  _state.sourcePhase = "fresh";
  _state.sourceFailure = null;
  _state.sourceCount = integer(result.count);
  _state.sourceBytes = integer(result.bytes);
  _state.sourcePackageRevision =
    typeof result.revision === "string" && HEX16.test(result.revision)
      ? result.revision
      : null;
  _state.sourceInstalledRevision = _state.sourcePackageRevision;
  _state.sourcePackageProvenance = provenance(result.provenance);
  _state.sourceInstalledProvenance = _state.sourcePackageProvenance;
  const generation =
    typeof result.generation === "string" && HEX16.test(result.generation)
      ? result.generation
      : mintGeneration();
  _state.desired = { generation };
  _state.applied = {
    generation,
    coverage: coverage(result.coverage),
  };
  _state.failure = null;
  return { ok: true, generation };
}

/** Watch the preference so a direct pref write republishes the projection. */
const OBSERVER = {
  observe(_subject, topic, data) {
    if (topic === "nsPref:changed" && data === PREF) publish();
  },
};

export function install() {
  if (_installed) return true;
  try {
    if (typeof Services !== "undefined" && Services?.prefs?.addObserver) {
      Services.prefs.addObserver(PREF, OBSERVER);
      try {
        if (Services.prefs.getPrefType(PREF) === Services.prefs.PREF_INVALID) {
          // Define the gate the C++ hook reads; a user value still wins.
          Services.prefs.getDefaultBranch("").setBoolPref(PREF, DEFAULT_ENABLED);
        }
      } catch {
        // A locked default is fine: the read below reports what exists.
      }
      hydrateState();
      registerActor();
      scheduleRefresh();
      scheduleStartupRefresh();
      _installed = true;
    }
  } catch {
    _installed = false;
  }
  return _installed;
}

function scheduleRefresh() {
  if (_refreshTimer !== null) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  const chrome = chromeScope();
  if (!chrome) return;
  if (prefBool(AUTO_UPDATE_PREF, true) !== true) return;
  const hours = Math.min(720, Math.max(0, prefInt(SCHEDULE_PREF, DEFAULT_UPDATE_HOURS)));
  if (hours <= 0) return;
  // Clamp to the 32-bit timer ceiling; a chained timer re-arms for longer
  // intervals instead of wrapping to a near-zero delay.
  const interval = Math.min(hours * 60 * 60 * 1000, 2_147_483_647);
  _refreshTimer = setInterval(() => {
    void autoRefresh("scheduled").catch(() => {
      // The next scheduled run retries; a failed refresh keeps the engine.
    });
  }, interval);
}

function scheduleStartupRefresh() {
  if (_startupTimer !== null) return;
  const chrome = chromeScope();
  if (!chrome || prefBool(AUTO_UPDATE_PREF, true) !== true) return;
  const hours = Math.min(720, Math.max(0, prefInt(SCHEDULE_PREF, DEFAULT_UPDATE_HOURS)));
  if (hours <= 0) return;
  const now = Math.floor(Date.now() / 1000);
  const last = prefInt(LAST_UPDATE_PREF, 0);
  if (last > 0 && now - last < hours * 3600) return;
  // Let the window and the first page settle before the updater competes
  // with boot; the timer is cleared on uninstall.
  _startupTimer = setTimeout(() => {
    _startupTimer = null;
    void autoRefresh("startup").catch(() => {});
  }, 20_000);
}

async function autoRefresh(reason) {
  if (prefBool(AUTO_UPDATE_PREF, true) !== true) return;
  const backend = getBackend();
  if (readEnabled(backend) !== true) return;
  if (!nativeState(backend).available) return;
  const result = await refreshAndInstall(backend);
  publish();
  return { reason, ...result };
}

function registerActor() {
  const chrome = chromeScope();
  if (!chrome || _actorRegistered) return;
  try {
    chrome.ChromeUtils.registerWindowActor("AstraBlocker", {
      parent: {
        esModuleURI: "resource://astra/actors/AstraBlockerParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource://astra/actors/AstraBlockerChild.sys.mjs",
        events: { DOMContentLoaded: {} },
      },
      allFrames: true,
      includeChrome: false,
    });
    _actorRegistered = true;
  } catch {
    // Already registered by another window, or an older engine without
    // dynamic actors. Network blocking does not depend on the actor.
    _actorRegistered = false;
  }
}

export function uninstall() {
  if (!_installed) return;
  _installed = false;
  if (_refreshTimer !== null) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  if (_startupTimer !== null) {
    clearTimeout(_startupTimer);
    _startupTimer = null;
  }
  if (_actorRegistered) {
    try {
      ChromeUtils.unregisterWindowActor("AstraBlocker");
    } catch {
      // The actor was never registered in this process.
    }
    _actorRegistered = false;
  }
  try {
    Services.prefs.removeObserver(PREF, OBSERVER);
  } catch {
    // The pref service is already gone.
  }
}

function validContext(context) {
  if (!context || typeof context !== "object") return false;
  return (
    text(context.profile, 64) !== "" &&
    text(context.tab, 256) !== "" &&
    text(context.site, 255) !== "" &&
    typeof context.revision === "string" &&
    context.revision !== ""
  );
}

async function retryGeneration(backend, failedGeneration) {
  if (!HEX16.test(failedGeneration)) return { ok: false, reason: "invalid_input" };
  if (!nativeState(backend).available) {
    return { ok: false, reason: "native_dispatch_rejected" };
  }
  const matches =
    (_state.desired && _state.desired.generation === failedGeneration) ||
    (_state.applied && _state.applied.generation === failedGeneration);
  if (!_state.failure || !matches) {
    return { ok: false, reason: "invalid_scope" };
  }
  return installRules(backend);
}

export const Blocker = {
  /** The full projection, read from the running backend every call. */
  async status() {
    install();
    const view = buildStatus();
    // A profile that left protection on must not sit pending forever after a
    // restart: the pref is the arming gate, and an install is idempotent.
    if (
      view.desired_enabled === true &&
      view.applied_enabled !== true &&
      view.can_enable &&
      view.failure === null &&
      _installing === null
    ) {
      void ensureInstalled(getBackend())
        .then(() => publish())
        .catch(() => {
          // The next status call reports the failure; never reject a
          // projection read.
        });
    }
    return view;
  },

  /** Real counts only; null when the native runtime cannot report them. */
  async stats({ profile = "" } = {}) {
    if (typeof profile !== "string" || profile === "") {
      return { today: null, last7Days: null, days: [] };
    }
    install();
    const backend = getBackend();
    let result = null;
    try {
      result = backend.stats(profile);
    } catch {
      result = null;
    }
    if (!result || typeof result !== "object") {
      return { today: null, last7Days: null, days: [] };
    }
    const days = Array.isArray(result.days)
      ? result.days.map((value) => integer(value))
      : [];
    return {
      today: integer(result.today),
      last7Days: integer(result.last7Days),
      days,
    };
  },

  /**
   * Turn protection on/off. Enabling is refused when no native management
   * seam exists: writing the pref alone would arm a switch the engine never
   * reads because no rules can be installed.
   */
  async setEnabled({ enabled = null } = {}) {
    if (typeof enabled !== "boolean") return refuse("invalid_input");
    install();
    const backend = getBackend();
    const current = readEnabled(backend);
    if (current === null) return refuse("unsupported_command");
    if (current === enabled) {
      publish();
      return admit({ outcome: "no_op", reason: "state_unchanged" });
    }
    const native = nativeState(backend);
    if (enabled && !native.available) {
      return refuse("native_dispatch_rejected");
    }
    if (!writeEnabled(backend, enabled)) {
      return refuse("store_admission_rejected");
    }
    if (!enabled) {
      try {
        backend.setEnabled?.(false);
      } catch {
        // The pref gate is already off; a native toggle failure cannot arm it.
      }
      publish();
      return admit({ outcome: "applied", reason: "mutation_applied" });
    }
    try {
      backend.setEnabled?.(true);
    } catch {
      // Installation below reports the real outcome.
    }
    const result = await ensureInstalled(backend);
    publish();
    return result.ok
      ? admit({ outcome: "applied", reason: "mutation_applied" })
      : refuse("native_work_pending");
  },

  /** Refresh/validate the filter source and install the new revision. */
  async refreshSources() {
    install();
    const backend = getBackend();
    const native = nativeState(backend);
    if (!native.available || typeof backend.refreshSources !== "function") {
      return refuse("native_dispatch_rejected");
    }
    const result = await refreshAndInstall(backend);
    publish();
    return result.ok
      ? admit({ outcome: "applied", reason: "mutation_applied" })
      : refuse("native_work_pending");
  },

  /** Reinstall after a failed generation; a stale id changes nothing. */
  async retry({ failed_generation = "" } = {}) {
    install();
    const backend = getBackend();
    const result = await retryGeneration(backend, failed_generation);
    publish();
    if (result.ok) return admit({ outcome: "applied", reason: "mutation_applied" });
    return refuse(result.reason ?? "native_work_pending");
  },

  /** Pause/resume this site, or retry the site's failed generation. */
  async siteChange({ context = null, action = null } = {}) {
    install();
    if (!validContext(context) || !action || typeof action.kind !== "string") {
      return refuse("invalid_input");
    }
    const backend = getBackend();
    if (!nativeState(backend).available) {
      return refuse("native_dispatch_rejected");
    }
    if (context.profile !== "default") {
      // The native site switch is process-wide; a private pause must not
      // leak into normal windows or the shared exception pref.
      return refuse("invalid_scope");
    }
    const current = siteView(backend);
    if (
      !current ||
      current.context.profile !== context.profile ||
      current.context.tab !== context.tab ||
      current.context.site !== context.site ||
      current.context.revision !== context.revision
    ) {
      // The page moved since the menu was drawn: do not pause another site.
      return refuse("invalid_scope");
    }
    if (action.kind === "pause") {
      if (typeof action.paused !== "boolean") return refuse("invalid_input");
      let ok = false;
      try {
        ok = backend.setSiteEnabled(context.site, action.paused !== true) === true;
      } catch {
        ok = false;
      }
      if (!ok) return refuse("store_admission_rejected");
      publish();
      return admit({ outcome: "applied", reason: "mutation_applied" });
    }
    if (action.kind === "retry") {
      const token =
        _state.desired?.generation ??
        _state.applied?.generation ??
        context.revision;
      const result = await retryGeneration(backend, token);
      publish();
      if (result.ok) {
        return admit({ outcome: "applied", reason: "mutation_applied" });
      }
      return refuse(result.reason ?? "native_work_pending");
    }
    // Element-hiding picker/removal actions belong to ContentHide; refusing
    // here is honest (never a silent success).
    return refuse("unsupported_command");
  },

  /** Picker controls are owned by ContentHide; the blocker itself has none. */
  async picker() {
    return null;
  },

  /**
   * The Settings page's source of truth: catalog entries, which ones are
   * enabled, the scheduler and the bounded counters. Reads the running
   * native engine; never invents a list or a count.
   */
  async lists() {
    install();
    let catalog = null;
    try {
      catalog = await loadCatalog();
    } catch {
      catalog = null;
    }
    const backend = getBackend();
    const native = nativeState(backend);
    const manifest = readManifest();
    const selected = catalog ? new Set(selectedListIds(catalog)) : new Set();
    const stats = await Blocker.stats({ profile: "default" });
    const hours = Math.max(
      0,
      Math.min(720, prefInt(SCHEDULE_PREF, DEFAULT_UPDATE_HOURS)),
    );
    const last = prefInt(LAST_UPDATE_PREF, 0);
    let installedRules = 0;
    try {
      const service = resolveNative();
      const info = service ? JSON.parse(service.statusJson() || "{}") : {};
      installedRules = Number.isSafeInteger(info?.version?.rules)
        ? info.version.rules
        : 0;
    } catch {
      installedRules = 0;
    }
    return {
      available: catalog !== null && native.available,
      lists: catalog
        ? catalog.lists.map((entry) => {
            const installed = manifest?.lists?.[entry.id] ?? null;
            return {
              id: entry.id,
              title: entry.title,
              group: entry.group,
              enabled: selected.has(entry.id),
              bundled: entry.bundled === true,
              source_url: entry.source_url,
              support_url: entry.support_url ?? "",
              license: entry.license?.license_expression ?? "",
              updated_unix:
                installed && Number.isSafeInteger(manifest?.updated_unix)
                  ? manifest.updated_unix
                  : null,
              bytes:
                installed && Number.isSafeInteger(installed.bytes)
                  ? installed.bytes
                  : null,
            };
          })
        : [],
      update_hours: hours,
      auto_update: prefBool(AUTO_UPDATE_PREF, true),
      cosmetic: prefBool(COSMETIC_PREF, true),
      scriptlets: prefBool(SCRIPTLETS_PREF, true),
      last_update_unix: last > 0 ? last : null,
      next_update_unix:
        hours > 0
          ? last > 0
            ? last + hours * 3600
            : Math.floor(Date.now() / 1000) + hours * 3600
          : null,
      installed_rules: installedRules,
      stats,
    };
  },

  /**
   * Update the user-facing parameters. List membership triggers one
   * reinstall from the on-disk cache (network only if a list was never
   * fetched); the other switches take effect in the running engine and the
   * actor immediately. Validation happens before any pref is written.
   */
  async configure({
    list_ids = null,
    update_hours = null,
    auto_update = null,
    cosmetic = null,
    scriptlets = null,
  } = {}) {
    install();
    if (
      (list_ids !== null &&
        (!Array.isArray(list_ids) ||
          list_ids.length > MAX_LISTS ||
          list_ids.some((id) => typeof id !== "string" || id === ""))) ||
      (update_hours !== null &&
        (!Number.isSafeInteger(update_hours) ||
          update_hours < 0 ||
          update_hours > 720)) ||
      (auto_update !== null && typeof auto_update !== "boolean") ||
      (cosmetic !== null && typeof cosmetic !== "boolean") ||
      (scriptlets !== null && typeof scriptlets !== "boolean")
    ) {
      return refuse("invalid_input");
    }
    const chrome = chromeScope();
    if (!chrome) return refuse("unsupported_command");
    const native = nativeState(getBackend());
    if (!native.available || typeof getBackend().installRules !== "function") {
      return refuse("native_dispatch_rejected");
    }
    let ids = null;
    if (list_ids !== null) {
      try {
        const catalog = await loadCatalog();
        const known = new Set(catalog.lists.map((entry) => entry.id));
        ids = [...new Set(list_ids)].filter((id) => known.has(id));
        if (ids.length === 0) return refuse("invalid_input");
      } catch {
        return refuse("store_admission_rejected");
      }
    }
    const previous = (() => {
      try {
        return new Set(JSON.parse(prefString(LISTS_PREF, "[]")));
      } catch {
        return new Set();
      }
    })();
    let listsChanged = false;
    try {
      if (ids !== null) {
        if (!writePrefString(LISTS_PREF, JSON.stringify(ids))) {
          return refuse("store_admission_rejected");
        }
        listsChanged =
          ids.length !== previous.size ||
          ids.some((id) => !previous.has(id));
      }
      if (update_hours !== null) {
        Services.prefs.setIntPref(SCHEDULE_PREF, update_hours);
      }
      if (auto_update !== null) {
        Services.prefs.setBoolPref(AUTO_UPDATE_PREF, auto_update);
      }
      if (cosmetic !== null) {
        Services.prefs.setBoolPref(COSMETIC_PREF, cosmetic);
      }
      if (scriptlets !== null) {
        Services.prefs.setBoolPref(SCRIPTLETS_PREF, scriptlets);
      }
    } catch {
      return refuse("store_admission_rejected");
    }
    scheduleRefresh();
    if (listsChanged) {
      const result = await ensureInstalled(getBackend());
      publish();
      if (!result.ok) return refuse("native_work_pending");
      if (Array.isArray(result.missing) && result.missing.length > 0) {
        return refuse("native_work_pending");
      }
    } else {
      publish();
    }
    return admit({ outcome: "applied", reason: "mutation_applied" });
  },

  /** Clear the bounded counters (settings action; never touches rules). */
  async resetStats() {
    install();
    const native = resolveNative();
    if (!native || typeof native.resetStats !== "function") {
      return refuse("native_dispatch_rejected");
    }
    try {
      native.resetStats();
    } catch {
      return refuse("native_work_pending");
    }
    publish();
    return admit({ outcome: "applied", reason: "mutation_applied" });
  },

  /**
   * CSS selectors the page at `url` should hide, plus the scriptlet payload.
   * Synchronous on purpose: the ContentHide provider and the actor both read
   * it per page and per mutation batch. Empty when cosmetic filtering is
   * off, the engine is absent or the lookup fails.
   */
  cosmeticPayload(url, classes = [], ids = []) {
    const empty = { selectors: [], script: "", procedural: [] };
    try {
      if (!prefBool(COSMETIC_PREF, true)) return empty;
      const native = resolveNative();
      if (!native) return empty;
      const parsed = JSON.parse(
        native.cosmeticFor(
          String(url ?? ""),
          JSON.stringify(Array.isArray(classes) ? classes.slice(0, 512) : []),
          JSON.stringify(Array.isArray(ids) ? ids.slice(0, 512) : []),
        ) || "{}",
      );
      return {
        selectors: Array.isArray(parsed.selectors) ? parsed.selectors : [],
        script: prefBool(SCRIPTLETS_PREF, true)
          ? typeof parsed.script === "string"
            ? parsed.script
            : ""
          : "",
        procedural: Array.isArray(parsed.procedural) ? parsed.procedural : [],
      };
    } catch {
      return empty;
    }
  },

  cosmeticSelectors(url, classes = [], ids = []) {
    return Blocker.cosmeticPayload(url, classes, ids).selectors;
  },

  /** "Check for updates now" (same path as the scheduler). */
  async updateNow() {
    return Blocker.refreshSources();
  },

  install,
  uninstall,

  /** Test/diagnostic seams only. */
  __backend: () => getBackend(),
  __reset: __resetBlockerForTests,
};

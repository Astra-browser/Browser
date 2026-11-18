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
const MODE_PREF = "astra.blocker.mode";
const REMOVE_PARAM_PREF = "astra.blocker.removeparam";
const BOUNCE_PREF = "astra.blocker.bounce";
const BLOCK_SCRIPTS_PREF = "astra.blocker.block-scripts";
const REDIRECTS_PREF = "astra.blocker.redirects";
const CNAME_PREF = "astra.blocker.cname-uncloaking";
const CUSTOM_LISTS_PREF = "astra.blocker.custom-lists";
const USER_RULES_PREF = "astra.blocker.user-rules";
const SITE_POLICIES_PREF = "astra.blocker.site-policies";

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

const PROVENANCE = new Set([
  "release_bundle",
  "tuf_repository",
  "official_https",
]);

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
  const salt = Array.from(buffer, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
    const service = Cc["@astra/blocker;1"]?.getService(
      Ci.nsIAstraBlockerService,
    );
    if (!service) return null;
    return {
      installRules: (rules) => service.installRules(rules),
      setResources: (json) => service.setResources(json),
      setEnabled: (enabled) => service.setEnabled(enabled),
      setSiteEnabled: (host, enabled) => service.setSiteEnabled(host, enabled),
      isSiteEnabled: (host) => service.isSiteEnabled(host) === true,
      setSitePolicy: (host, enabled, aggressive, scripts) =>
        service.setSitePolicy(host, enabled, aggressive, scripts),
      sitePolicy: (host) =>
        JSON.parse(service.sitePolicy(String(host)) || "{}"),
      classifyHost: (host) =>
        JSON.parse(service.classifyHost(String(host)) || "{}"),
      classifyBounce: (url) =>
        JSON.parse(service.classifyBounce(String(url)) || "{}"),
      checkUrl: (url, source, type) =>
        JSON.parse(
          service.checkUrl(String(url), String(source), String(type)) || "{}",
        ),
      // Diagnostic seam only. `CnameJson` performs a synchronous resolver
      // query, so it must never be called on the chrome main thread; the
      // uncloaking path reads the async record's canonical name instead.
      cname: (host) => JSON.parse(service.cname(String(host)) || "{}"),
      setCloakedHost: (host, blocked) => service.setCloakedHost(host, blocked),
      isCloaked: (host) => service.isCloaked(host) === true,
      cloakedHosts: () => JSON.parse(service.cloakedHosts() || "[]"),
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
  const { NetUtil } =
    importGecko("resource://gre/modules/NetUtil.sys.mjs") ?? {};
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
  if (
    typeof fetch !== "function" ||
    typeof DecompressionStream !== "function"
  ) {
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

function isPrivateHost(host) {
  const key = normalizeHostKey(host);
  if (!key) return true;
  if (
    key === "localhost" ||
    key.endsWith(".localhost") ||
    key.endsWith(".local")
  ) {
    return true;
  }
  if (
    key === "::1" ||
    key === "[::1]" ||
    key.startsWith("fc") ||
    key.startsWith("fd")
  ) {
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(key)) {
    const [a, b] = key.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  return false;
}

async function fetchListText(url) {
  if (typeof fetch !== "function") throw new Error("transport");
  if (!/^https:\/\//iu.test(url)) throw new Error("insecure_source");
  try {
    if (isPrivateHost(new URL(url).hostname)) throw new Error("private_source");
  } catch (error) {
    if (error?.message === "private_source") throw error;
    throw new Error("insecure_source");
  }
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
    if (response.url) {
      try {
        if (isPrivateHost(new URL(response.url).hostname)) {
          throw new Error("private_redirect");
        }
      } catch (error) {
        if (error?.message === "private_redirect") throw error;
        throw new Error("insecure_redirect");
      }
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
  // PathUtils and IOUtils are chrome-only WebIDL globals in this engine
  // (dom/chrome-webidl/PathUtils.webidl + IOUtils.webidl). The old
  // `resource://gre/modules/*.sys.mjs` files no longer exist, so importing
  // them printed "Missing chrome or resource URL" on every list and left the
  // cache directory disabled. Read the globals first and keep the module form
  // only as a fallback for an engine that still ships it.
  const PathUtils =
    globalThis.PathUtils ??
    importGecko("resource://gre/modules/PathUtils.sys.mjs")?.PathUtils;
  const IOUtils =
    globalThis.IOUtils ??
    importGecko("resource://gre/modules/IOUtils.sys.mjs")?.IOUtils;
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

function readMode() {
  return prefInt(MODE_PREF, 0) === 1 ? "aggressive" : "standard";
}

function readCustomLists() {
  try {
    const parsed = JSON.parse(prefString(CUSTOM_LISTS_PREF, "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          HEX16.test(entry.id) &&
          typeof entry.url === "string" &&
          /^https:\/\//iu.test(entry.url),
      )
      .slice(0, 32)
      .map((entry) => ({
        id: entry.id,
        title: text(entry.title, 120) || entry.url,
        url: entry.url,
      }));
  } catch {
    return [];
  }
}

function writeCustomLists(entries) {
  return writePrefString(CUSTOM_LISTS_PREF, JSON.stringify(entries));
}

function customListId(url) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${(hash ^ url.length)
    .toString(16)
    .padStart(8, "0")}`.slice(-16);
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
  if (readMode() === "aggressive") {
    return catalog.lists
      .filter(
        (entry) =>
          entry.group === "ads" ||
          entry.group === "privacy" ||
          entry.group === "malware" ||
          entry.group === "annoyances",
      )
      .map((entry) => entry.id);
  }
  return catalog.lists
    .filter((entry) => entry.default_enabled === true)
    .map((entry) => entry.id);
}

/** The list preset written when the person switches protection mode. */
function modePreset(catalog, mode) {
  if (mode === "aggressive") {
    return catalog.lists
      .filter(
        (entry) =>
          entry.group === "ads" ||
          entry.group === "privacy" ||
          entry.group === "malware" ||
          entry.group === "annoyances",
      )
      .map((entry) => entry.id);
  }
  return catalog.lists
    .filter((entry) => entry.default_enabled === true)
    .map((entry) => entry.id);
}

function readSitePolicies() {
  try {
    const parsed = JSON.parse(prefString(SITE_POLICIES_PREF, "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeSitePolicy(host, policy) {
  const key = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  const all = readSitePolicies();
  if (!policy.enabled && !policy.aggressive && !policy.scripts) {
    delete all[key];
  } else {
    all[key] = {
      enabled: policy.enabled === true,
      aggressive: policy.aggressive === true,
      scripts: policy.scripts === true,
    };
  }
  return writePrefString(SITE_POLICIES_PREF, JSON.stringify(all));
}

// --- CNAME uncloaking -------------------------------------------------------
// A request host whose DNS chain ends in a tracker domain is marked here; the
// native hook then blocks every later request to the cloaked first-party host.
// The first request necessarily passes (the answer arrives after it starts).

let _cloakObserved = false;
let _cloakCache = new Map();
const CLOAK_CACHE_MAX = 512;

function normalizeHostKey(host) {
  return String(host ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "");
}

function cnameSpoofingEnabled() {
  return prefBool(CNAME_PREF, true);
}

function installCloakObserver() {
  if (_cloakObserved || !cnameSpoofingEnabled()) return;
  const chrome = chromeScope();
  if (!chrome) return;
  try {
    Services.obs.addObserver(CLOAK_OBSERVER, "http-on-modify-request");
    _cloakObserved = true;
  } catch {
    _cloakObserved = false;
  }
}

function uninstallCloakObserver() {
  if (!_cloakObserved) return;
  try {
    Services.obs.removeObserver(CLOAK_OBSERVER, "http-on-modify-request");
  } catch {
    // The observer service is already gone.
  }
  _cloakObserved = false;
}

function baseDomain(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch {
    return host;
  }
}

function resolveCloakedHost(host, sourceHost) {
  const key = normalizeHostKey(host);
  const source = normalizeHostKey(sourceHost);
  if (!key || !/^[a-z0-9.-]+$/u.test(key) || key === "localhost") return;
  if (!source || key === source) return;
  // CNAME cloaking is a first-party disguise: the request host is a subdomain
  // of the page the person is on, but its DNS chain ends at a tracker.
  if (baseDomain(key) !== baseDomain(source)) return;
  const now = Date.now();
  const cached = _cloakCache.get(key);
  if (cached && now - cached.at < 6 * 60 * 60 * 1000) return;
  if (_cloakCache.size >= CLOAK_CACHE_MAX) {
    const oldest = [..._cloakCache.entries()].sort(
      (left, right) => left[1].at - right[1].at,
    )[0];
    if (oldest) _cloakCache.delete(oldest[0]);
  }
  _cloakCache.set(key, { at: now, pending: true });
  // A resolver that never calls back must not pin the host as pending for the
  // full six-hour cache window.
  setTimeout(() => {
    const entry = _cloakCache.get(key);
    if (entry?.pending) _cloakCache.delete(key);
  }, 30_000);
  try {
    const dns = Cc["@mozilla.org/network/dns-service;1"].getService(
      Ci.nsIDNSService,
    );
    const listener = {
      _host: key,
      _source: source,
      onLookupComplete(_request, record, status) {
        const native = resolveNative();
        if (!native) return;
        let canonical = "";
        try {
          canonical = record?.canonicalName || "";
        } catch {
          canonical = "";
        }
        const targets = canonical ? [canonical] : [];
        // Never ask the engine for a CNAME record here. That seam performs a
        // synchronous system DNS query, and this callback runs on the chrome
        // main thread: on a resolver that does not answer CNAME queries it
        // blocks for the whole timeout (11 s here) and freezes the window on
        // the first page load. The async lookup above asked for
        // RESOLVE_CANONICAL_NAME, so use what it carries and fail open
        // (uncloaked) when the platform does not expose one.
        try {
          let cloaked = false;
          for (const target of targets) {
            if (normalizeHostKey(target) === key) continue;
            const verdict = native.classifyHost(target);
            if (verdict && verdict.tracker === true) {
              cloaked = true;
              break;
            }
          }
          // A later resolution that finds no tracker must lift an earlier
          // marking; a shared CDN can change its canonical target.
          native.setCloakedHost(key, cloaked);
        } catch {
          // A failed classification leaves the host uncloaked (fail open).
        }
        _cloakCache.set(key, { at: Date.now() });
      },
    };
    // RESOLVE_CANONICAL_NAME: without this flag the record has no
    // canonicalName, which is exactly the CNAME chain we need.
    dns.asyncResolve(
      key,
      0,
      Ci.nsIDNSService.RESOLVE_CANONICAL_NAME |
        Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
      null,
      listener,
      Services.tm?.mainThread ?? null,
    );
  } catch {
    _cloakCache.delete(key);
  }
}

const CLOAK_OBSERVER = {
  observe(subject, topic) {
    if (topic !== "http-on-modify-request" || !cnameSpoofingEnabled()) return;
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const uri = channel.URI;
      if (!uri || (uri.scheme !== "http" && uri.scheme !== "https")) return;
      const native = resolveNative();
      let isPrivate = false;
      try {
        isPrivate =
          (channel.loadInfo?.originAttributes?.privateBrowsingId ?? 0) !== 0;
      } catch {
        isPrivate = false;
      }
      if (isPrivate) return;
      let sourceHost = "";
      try {
        const loadInfo = channel.loadInfo;
        const principal =
          loadInfo?.loadingPrincipal ?? loadInfo?.triggeringPrincipal;
        sourceHost = principal?.URI?.host ?? "";
      } catch {
        sourceHost = "";
      }
      resolveCloakedHost(uri.host, sourceHost);
    } catch {
      // Ignore requests without a resolvable host.
    }
  },
};

// Block Scripts covers inline scripts too. The channel hook cancels script
// requests; a response CSP is the only way to stop inline execution without
// patching the engine's script compiler.
const CSP_OBSERVER = {
  observe(subject, topic) {
    if (topic !== "http-on-examine-response") return;
    try {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      const type = channel.loadInfo?.externalContentPolicyType;
      if (
        type !== Ci.nsIContentPolicy.TYPE_DOCUMENT &&
        type !== Ci.nsIContentPolicy.TYPE_SUBDOCUMENT
      ) {
        return;
      }
      let host = "";
      try {
        host =
          channel.loadInfo?.loadingPrincipal?.URI?.host ??
          channel.URI?.host ??
          "";
      } catch {
        host = channel.URI?.host ?? "";
      }
      if (!prefBool(PREF, DEFAULT_ENABLED)) return;
      const policy = host
        ? readSitePolicies()[normalizeHostKey(host)]
        : undefined;
      if (policy && policy.enabled === false) return;
      const blocked =
        prefBool(BLOCK_SCRIPTS_PREF, false) || policy?.scripts === true;
      if (!blocked) return;
      channel.setResponseHeader(
        "Content-Security-Policy",
        "script-src 'none'",
        true,
      );
    } catch {
      // Non-HTTP channels are left alone.
    }
  },
};

let _cspObserved = false;

function installCspObserver() {
  if (_cspObserved) return;
  try {
    Services.obs.addObserver(CSP_OBSERVER, "http-on-examine-response");
    _cspObserved = true;
  } catch {
    _cspObserved = false;
  }
}

function uninstallCspObserver() {
  if (!_cspObserved) return;
  try {
    Services.obs.removeObserver(CSP_OBSERVER, "http-on-examine-response");
  } catch {
    // Already gone.
  }
  _cspObserved = false;
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
  const byId = new Map(
    ids.map((id) => [id, catalog.lists.find((l) => l.id === id)]),
  );
  for (const entry of readCustomLists()) {
    byId.set(`custom:${entry.id}`, {
      id: `custom:${entry.id}`,
      source_url: entry.url,
      title: entry.title,
      bundled: false,
    });
  }
  const sources = [];
  const manifest = {};
  const missing = [];
  let totalBytes = 0;
  let totalRules = 0;

  // Bounded concurrency: four sources at a time keeps the network and the
  // parse buffers small; a slow subscription cannot stall the rest.
  const queue = [...byId.values()].filter(Boolean);
  const workers = Array.from(
    { length: Math.min(4, queue.length) },
    async () => {
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
    },
  );
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
  const userRules = prefString(USER_RULES_PREF, "");
  const rules = sources
    .map((source) => `! ==== astra:${source.id} ====\n${source.text}`)
    .join("\n")
    .concat(userRules.trim() ? `\n! ==== astra:user ====\n${userRules}\n` : "");
  return {
    ok: true,
    failure: null,
    rules,
    count: sources.length + (userRules.trim() ? 1 : 0),
    bytes: totalBytes + userRules.length,
    compiledRules: totalRules + (userRules.trim() ? countRules(userRules) : 0),
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
  const site = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!site) return false;
  const current = new Set(readSiteExceptions());
  if (paused) current.add(site);
  else current.delete(site);
  return writePrefString(
    SITE_EXCEPTIONS_PREF,
    JSON.stringify([...current].sort()),
  );
}

/**
 * The site shield must also pause the engine's own tracker lists (ETP). The
 * Astra engine pause alone leaves Disconnect-listed hosts blocked, so the
 * shield would report "off" while requests were still cancelled. Firefox
 * stores a per-site ETP exception as a `trackingprotection` permission on the
 * top-level principal (and `trackingprotection-pb` in private windows).
 */
function setNativeSiteException(host, paused) {
  const site = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!site) return;
  try {
    const uri = Services.io.newURI(`https://${site}`);
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      {},
    );
    const pm = Services.perms;
    for (const type of ["trackingprotection", "trackingprotection-pb"]) {
      if (paused) {
        pm.addFromPrincipal(
          principal,
          type,
          Ci.nsIPermissionManager.ALLOW_ACTION,
          Ci.nsIPermissionManager.EXPIRE_NEVER,
        );
      } else {
        pm.removeFromPrincipal(principal, type);
      }
    }
  } catch {
    // A malformed host or a locked permission store must not stop the engine.
  }
}

function applySiteExceptions(native) {
  for (const host of readSiteExceptions()) {
    try {
      native.setSiteEnabled(host, false);
      setNativeSiteException(host, true);
    } catch {
      // A single bad host must not stop the install.
    }
  }
  const policies = readSitePolicies();
  for (const [host, policy] of Object.entries(policies)) {
    try {
      native.setSitePolicy?.(
        host,
        policy.enabled === true,
        policy.aggressive === true,
        policy.scripts === true,
      );
      setNativeSiteException(host, policy.enabled !== true);
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
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
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
        setNativeSiteException(site, enabled === false);
        return writeSiteException(site, enabled === false);
      } catch {
        return false;
      }
    },
    setSitePolicy(site, enabled, aggressive, scripts) {
      try {
        const native = resolveNative();
        if (!native?.setSitePolicy) return false;
        native.setSitePolicy(site, enabled, aggressive, scripts);
        setNativeSiteException(site, enabled === false);
        writeSiteException(site, enabled === false);
        return writeSitePolicy(site, { enabled, aggressive, scripts });
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
        tab =
          win.gBrowser
            .getTabForBrowser?.(browser)
            ?.getAttribute?.("astra-tab-id") ?? "";
      } catch {
        tab = "";
      }
      if (tab === "") return null;
      const profile = privateWindow() ? "incognito" : "default";
      let policy = { enabled: true, aggressive: false, scripts: false };
      try {
        const nativePolicy = native.sitePolicy?.(site);
        if (nativePolicy && typeof nativePolicy === "object") {
          policy = {
            enabled: nativePolicy.enabled !== false,
            aggressive: nativePolicy.aggressive === true,
            scripts: nativePolicy.scripts === true,
          };
        } else {
          policy.enabled = native.isSiteEnabled(site) !== false;
        }
      } catch {
        // A transient FFI read must not make the site look paused.
        policy.enabled = true;
      }
      const paused = policy.enabled === false;
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
        mode: paused ? "off" : policy.aggressive ? "aggressive" : "standard",
        block_scripts: policy.scripts,
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
    mode:
      raw.mode === "off" || raw.mode === "aggressive"
        ? raw.mode
        : raw.paused === true
          ? "off"
          : "standard",
    block_scripts: raw.block_scripts === true,
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
// Every compile/refresh is serialized: bundle building is async, and two
// overlapping installs would leave the engine and the recorded generation
// describing different rule sets.
let _installQueue = Promise.resolve();

function enqueueInstall(task) {
  const next = _installQueue.then(task, task);
  _installQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

function ensureInstalled(backend, force = false) {
  if (_installing && !force) return _installing;
  const previous = _installing;
  const task = enqueueInstall(async () => {
    if (force && previous) {
      // A configuration write landed while an install was running; that
      // install read the previous bundle. Let it settle, then compile the
      // current one so the new rule/list is actually in the engine.
      try {
        await previous;
      } catch {
        // The new install reports its own failure.
      }
    }
    return installRules(backend);
  });
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
  return enqueueInstall(async () => {
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
  });
}

/** Watch the preference so a direct pref write republishes the projection. */
const OBSERVER = {
  observe(_subject, topic, data) {
    if (topic !== "nsPref:changed") return;
    if (data === PREF) publish();
    if (data === CNAME_PREF) {
      if (prefBool(CNAME_PREF, true)) installCloakObserver();
      else uninstallCloakObserver();
    }
  },
};

export function install() {
  if (_installed) return true;
  try {
    if (typeof Services !== "undefined" && Services?.prefs?.addObserver) {
      Services.prefs.addObserver(PREF, OBSERVER);
      Services.prefs.addObserver(CNAME_PREF, OBSERVER);
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
      installCloakObserver();
      installCspObserver();
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
  const hours = Math.min(
    720,
    Math.max(0, prefInt(SCHEDULE_PREF, DEFAULT_UPDATE_HOURS)),
  );
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
  const hours = Math.min(
    720,
    Math.max(0, prefInt(SCHEDULE_PREF, DEFAULT_UPDATE_HOURS)),
  );
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
    Services.prefs.removeObserver(CNAME_PREF, OBSERVER);
  } catch {
    // The pref service is already gone.
  }
  uninstallCloakObserver();
  uninstallCspObserver();
  _cloakCache.clear();
}

function applySitePolicy(backend, site, enabled, aggressive, scripts) {
  try {
    if (typeof backend.setSitePolicy === "function") {
      return backend.setSitePolicy(site, enabled, aggressive, scripts) === true;
    }
    // Compatibility seam for a build/test backend that predates per-site
    // modes: it can still answer the on/off part.
    if (typeof backend.setSiteEnabled === "function") {
      return backend.setSiteEnabled(site, enabled) === true;
    }
  } catch {
    // Fall through to the refusal below.
  }
  return false;
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
  if (!HEX16.test(failedGeneration))
    return { ok: false, reason: "invalid_input" };
  if (!nativeState(backend).available) {
    return { ok: false, reason: "native_dispatch_rejected" };
  }
  const matches =
    (_state.desired && _state.desired.generation === failedGeneration) ||
    (_state.applied && _state.applied.generation === failedGeneration);
  if (!_state.failure || !matches) {
    return { ok: false, reason: "invalid_scope" };
  }
  return ensureInstalled(backend, true);
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
    if (result.ok)
      return admit({ outcome: "applied", reason: "mutation_applied" });
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
      const enabled = action.paused !== true;
      const ok = applySitePolicy(
        backend,
        context.site,
        enabled,
        current.mode === "aggressive",
        current.block_scripts === true,
      );
      if (!ok) return refuse("store_admission_rejected");
      publish();
      return admit({ outcome: "applied", reason: "mutation_applied" });
    }
    if (action.kind === "mode") {
      const mode = action.mode;
      if (mode !== "off" && mode !== "standard" && mode !== "aggressive") {
        return refuse("invalid_input");
      }
      const ok = applySitePolicy(
        backend,
        context.site,
        mode !== "off",
        mode === "aggressive",
        current.block_scripts === true,
      );
      if (!ok) return refuse("store_admission_rejected");
      publish();
      return admit({ outcome: "applied", reason: "mutation_applied" });
    }
    if (action.kind === "scripts") {
      if (typeof action.blocked !== "boolean") return refuse("invalid_input");
      const ok = applySitePolicy(
        backend,
        context.site,
        current.mode !== "off",
        current.mode === "aggressive",
        action.blocked,
      );
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
      mode: readMode(),
      removeparam: prefBool(REMOVE_PARAM_PREF, true),
      bounce: prefBool(BOUNCE_PREF, true),
      block_scripts: prefBool(BLOCK_SCRIPTS_PREF, false),
      redirects: prefBool(REDIRECTS_PREF, true),
      cname: prefBool(CNAME_PREF, true),
      custom_lists: readCustomLists().map((entry) => ({
        title: entry.title,
        url: entry.url,
      })),
      user_rules: prefString(USER_RULES_PREF, ""),
      cloaked: (() => {
        try {
          return resolveNative()?.cloakedHosts?.() ?? [];
        } catch {
          return [];
        }
      })(),
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
    mode = null,
    removeparam = null,
    bounce = null,
    block_scripts = null,
    redirects = null,
    cname = null,
    custom_lists = null,
    user_rules = null,
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
      (scriptlets !== null && typeof scriptlets !== "boolean") ||
      (mode !== null && mode !== "standard" && mode !== "aggressive") ||
      (removeparam !== null && typeof removeparam !== "boolean") ||
      (bounce !== null && typeof bounce !== "boolean") ||
      (block_scripts !== null && typeof block_scripts !== "boolean") ||
      (redirects !== null && typeof redirects !== "boolean") ||
      (cname !== null && typeof cname !== "boolean") ||
      (custom_lists !== null &&
        (!Array.isArray(custom_lists) ||
          custom_lists.length > 32 ||
          custom_lists.some(
            (entry) =>
              (typeof entry !== "string" &&
                (!entry || typeof entry !== "object")) ||
              (typeof entry === "string"
                ? !/^https:\/\/[^\s]+$/iu.test(entry)
                : typeof entry.url !== "string" ||
                  !/^https:\/\/[^\s]+$/iu.test(entry.url) ||
                  (entry.title !== undefined &&
                    typeof entry.title !== "string")),
          ))) ||
      (user_rules !== null &&
        (typeof user_rules !== "string" || user_rules.length > 262_144))
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
    let preset = null;
    if (list_ids !== null || mode !== null) {
      try {
        const catalog = await loadCatalog();
        if (mode !== null) {
          preset = modePreset(catalog, mode);
        }
        const source = list_ids !== null ? list_ids : preset;
        const known = new Set(catalog.lists.map((entry) => entry.id));
        ids = [...new Set(source)].filter((id) => known.has(id));
        if (ids.length === 0) return refuse("invalid_input");
      } catch {
        return refuse("store_admission_rejected");
      }
    }
    let nextCustom = null;
    if (custom_lists !== null) {
      const seen = new Set();
      nextCustom = [];
      for (const raw of custom_lists) {
        const url = (typeof raw === "string" ? raw : raw.url).trim();
        if (seen.has(url)) continue;
        seen.add(url);
        nextCustom.push({
          id: customListId(url),
          title:
            (typeof raw === "string" ? "" : text(raw.title, 120)) ||
            (() => {
              try {
                return new URL(url).hostname;
              } catch {
                return url;
              }
            })(),
          url,
        });
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
          ids.length !== previous.size || ids.some((id) => !previous.has(id));
      }
      if (mode !== null) {
        Services.prefs.setIntPref(MODE_PREF, mode === "aggressive" ? 1 : 0);
        listsChanged = true;
      }
      if (nextCustom !== null) {
        if (!writeCustomLists(nextCustom)) {
          return refuse("store_admission_rejected");
        }
        listsChanged = true;
      }
      if (user_rules !== null) {
        if (!writePrefString(USER_RULES_PREF, user_rules)) {
          return refuse("store_admission_rejected");
        }
        listsChanged = true;
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
      if (removeparam !== null) {
        Services.prefs.setBoolPref(REMOVE_PARAM_PREF, removeparam);
      }
      if (bounce !== null) {
        Services.prefs.setBoolPref(BOUNCE_PREF, bounce);
      }
      if (block_scripts !== null) {
        Services.prefs.setBoolPref(BLOCK_SCRIPTS_PREF, block_scripts);
      }
      if (redirects !== null) {
        Services.prefs.setBoolPref(REDIRECTS_PREF, redirects);
      }
      if (cname !== null) {
        Services.prefs.setBoolPref(CNAME_PREF, cname);
        if (cname) installCloakObserver();
        else uninstallCloakObserver();
      }
    } catch {
      return refuse("store_admission_rejected");
    }
    scheduleRefresh();
    if (listsChanged) {
      const result = await ensureInstalled(getBackend(), true);
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

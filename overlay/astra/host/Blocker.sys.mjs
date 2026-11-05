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

/** The C++ management seam, if a later engine patch publishes one. */
function resolveNative() {
  try {
    if (
      typeof Services !== "undefined" &&
      Services?.astraBlocker &&
      typeof Services.astraBlocker.installRules === "function"
    ) {
      return Services.astraBlocker;
    }
  } catch {
    // No published object.
  }
  try {
    if (typeof Cc !== "undefined" && typeof Ci !== "undefined") {
      const service = Cc["@astra/blocker;1"]?.getService(
        Ci.nsIAstraBlockerService
      );
      if (service) {
        // Normalise the XPCOM service onto the same small shape as the
        // published object. Only methods the engine actually exposes are
        // required; everything optional is probed at call time.
        return {
          installRules: (rules) => service.installRules(rules),
          setEnabled: (enabled) => service.setEnabled(enabled),
          setSiteEnabled: (host, enabled) => service.setSiteEnabled(host, enabled),
          isSiteEnabled: (host) => service.isSiteEnabled?.(host) ?? true,
          isInitialized: () => service.isInitialized === true,
          isEnabled: () => service.isEnabled === true,
          coverage: () => service.coverage ?? null,
          diagnostics: () => service.diagnostics ?? null,
          stats: (profile) => service.stats?.(profile) ?? null,
          refreshSources: () => service.refreshSources?.() ?? null,
          picker: (context, action) => service.picker?.(context, action) ?? null,
        };
      }
    }
  } catch {
    // No XPCOM seam in this build (the expected state; see the header).
  }
  return null;
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
        return Services.prefs.getBoolPref(PREF, false);
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
      let initialized = false;
      let enabled = false;
      try {
        initialized = native.isInitialized?.() === true;
      } catch {
        initialized = false;
      }
      try {
        enabled = native.isEnabled?.() === true;
      } catch {
        enabled = false;
      }
      let cov = null;
      let diag = null;
      try {
        cov = coverage(native.coverage?.());
      } catch {
        cov = null;
      }
      try {
        diag = diagnostics(native.diagnostics?.());
      } catch {
        diag = null;
      }
      return {
        available: true,
        ready: initialized,
        initialized,
        enabled,
        coverage: cov,
        diagnostics: diag,
        failure: null,
      };
    },
    async installRules() {
      const native = resolveNative();
      if (!native) return { ok: false, failure: "native_unsupported" };
      let rules = null;
      if (typeof native.readRules === "function") {
        try {
          rules = await Promise.resolve(native.readRules());
        } catch {
          rules = null;
        }
        if (typeof rules !== "string" || rules.trim() === "") {
          return { ok: false, failure: "compile_source_unavailable" };
        }
        if (rules.length > 64 * 1024 * 1024) {
          return { ok: false, failure: "compile_resource_limit" };
        }
      }
      try {
        const result = await Promise.resolve(native.installRules(rules ?? undefined));
        if (typeof result === "number") {
          // A future XPCOM wrapper may return nsresult; 0 is success.
          if (result !== 0) return { ok: false, failure: "native_installation" };
          return { ok: true, generation: null, coverage: null };
        }
        if (result && result.ok === false) {
          return {
            ok: false,
            failure: failure(result.failure) ?? "native_installation",
          };
        }
        const generation =
          typeof result?.generation === "string" && HEX16.test(result.generation)
            ? result.generation
            : null;
        return {
          ok: true,
          generation,
          coverage: coverage(result?.coverage),
        };
      } catch {
        return { ok: false, failure: "native_installation" };
      }
    },
    async refreshSources() {
      const native = resolveNative();
      if (!native || typeof native.refreshSources !== "function") {
        return { ok: false, failure: "internal" };
      }
      try {
        const result = await Promise.resolve(native.refreshSources());
        if (typeof result === "number") {
          if (result !== 0) return { ok: false, failure: "internal" };
          return { ok: true, generation: null, coverage: null };
        }
        if (!result || result.ok !== true) {
          return { ok: false, failure: sourceFailure(result?.failure) ?? "internal" };
        }
        return {
          ok: true,
          generation:
            typeof result.generation === "string" && HEX16.test(result.generation)
              ? result.generation
              : null,
          coverage: coverage(result.coverage),
          revision:
            typeof result.revision === "string" && HEX16.test(result.revision)
              ? result.revision
              : null,
          count: integer(result.count),
          bytes: integer(result.bytes),
          provenance: provenance(result.provenance),
        };
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
        return true;
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
        if (native.isSiteEnabled) paused = native.isSiteEnabled(site) === false;
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
        ready: native.isInitialized?.() === true,
        busy: false,
        hides: [],
      };
    },
    stats(profile) {
      try {
        const native = resolveNative();
        return native?.stats?.(profile) ?? null;
      } catch {
        return null;
      }
    },
    async picker(context, action) {
      try {
        const native = resolveNative();
        return native?.picker?.(context, action) ?? null;
      } catch {
        return null;
      }
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
  _state.applied = null;
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
          Services.prefs.getDefaultBranch("").setBoolPref(PREF, false);
        }
      } catch {
        // A locked default is fine: the read below reports what exists.
      }
      _installed = true;
    }
  } catch {
    _installed = false;
  }
  return _installed;
}

export function uninstall() {
  if (!_installed) return;
  _installed = false;
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
      const result = await retryGeneration(backend, context.revision);
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

  /** Picker controls are not wired while the native seam is missing. */
  async picker() {
    return null;
  },

  install,
  uninstall,

  /** Test/diagnostic seams only. */
  __backend: () => getBackend(),
  __reset: __resetBlockerForTests,
};

#!/usr/bin/env node
// Lane 3 contract test: Blocker host.
//
// The engine hook exists (ASTRA-0004/0005) but this build exposes no
// management interface to JS. The test pins both halves of that truth:
//   - without a native seam, status is unavailable, no pref is armed, no
//     count is invented;
//   - with an injected seam, enable/refresh/retry/site-change install and
//     settle through Operations, and the projection only says `active` after
//     the native install actually succeeded.
//
// Usage: node tests/contract/blocker_host.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const { Blocker, __setBlockerBackend, __resetBlockerForTests } = await import(pathToFileURL(path.join(HOST, "Blocker.sys.mjs")).href);
const { Operations, __resetOperationsForTests } = await import(pathToFileURL(path.join(HOST, "Operations.sys.mjs")).href);
const Events = await import(pathToFileURL(path.join(HOST, "Events.sys.mjs")).href);

const HEX16 = /^[0-9a-f]{16}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;

const COVERAGE = {
  source_rules: 10,
  accepted_rules: 9,
  rejected_rules: 0,
  platform_omitted_rules: 0,
  platform_approximated_rules: 0,
  platform_resource_approximated_rules: 0,
  platform_source_kind_approximated_rules: 0,
  platform_attribution_approximated_rules: 0,
  blocking_rule_entries: 9,
};

const DIAGNOSTICS = {
  total_decisions: "0",
  candidate_budget_exhausted: "0",
  matcher_unavailable: "0",
  matcher_unprepared: "0",
  attribution_unavailable: "0",
  evaluation_errors: "0",
};

const SITE = {
  context: { profile: "default", tab: "tab-1", site: "news.example", revision: "1111111111111111" },
  paused: false,
  private_session: false,
  ready: true,
  busy: false,
  hides: [],
};

function fake({
  available = false,
  pref = false,
  installOk = true,
  refreshOk = true,
  failWrite = false,
  stats = null,
  site = null,
} = {}) {
  const state = {
    pref,
    installed: false,
    installOk,
    refreshOk,
    failWrite,
    writes: [],
    installs: 0,
    refreshes: 0,
    enabledCalls: [],
    siteCalls: [],
    statsCalls: [],
  };
  return {
    state,
    readEnabled: () => state.pref,
    writeEnabled(value) {
      if (state.failWrite) return false;
      state.writes.push(value);
      state.pref = value;
      return true;
    },
    nativeStatus() {
      return {
        available,
        ready: available && state.installed,
        initialized: available && state.installed,
        enabled: available && state.installed && state.pref,
        coverage: available && state.installed ? COVERAGE : null,
        diagnostics: available ? DIAGNOSTICS : null,
        failure: available ? null : "native_unsupported",
      };
    },
    async installRules() {
      state.installs += 1;
      if (!state.installOk) return { ok: false, failure: "native_installation" };
      state.installed = true;
      return { ok: true, generation: "2222222222222222", coverage: COVERAGE };
    },
    async refreshSources() {
      state.refreshes += 1;
      if (!state.refreshOk) return { ok: false, failure: "transport" };
      state.installed = true;
      return {
        ok: true,
        generation: "3333333333333333",
        coverage: COVERAGE,
        revision: "4444444444444444",
        count: 2,
        bytes: 1024,
        provenance: "official_https",
      };
    },
    setEnabled(value) {
      state.enabledCalls.push(value);
    },
    setSiteEnabled(siteName, enabled) {
      state.siteCalls.push({ site: siteName, enabled });
      return true;
    },
    site: () => site,
    stats(profile) {
      state.statsCalls.push(profile);
      return stats;
    },
  };
}

function reset() {
  __resetOperationsForTests();
  __resetBlockerForTests();
  seen.length = 0;
}

function inject(backend) {
  __setBlockerBackend(backend);
}

async function disposition(admission) {
  return (await Operations.status(admission)).disposition;
}

const seen = [];
const off = Events.addEventListener((event) => seen.push(event));
const statusEvents = () => seen.filter((event) => event.type === "blocker-status-changed");

function validStatus(view) {
  const required = [
    "site",
    "projection_revision",
    "protection",
    "phase",
    "preference",
    "config_revision",
    "desired_enabled",
    "applied_enabled",
    "desired_generation",
    "retained_generation",
    "failure",
    "retryable",
    "retries_remaining",
    "applied_coverage",
    "runtime_diagnostics",
    "source_phase",
    "source_failure",
    "source_package_revision",
    "source_installed_revision",
    "source_package_provenance",
    "source_installed_provenance",
    "source_identities",
    "source_package_created_unix",
    "source_package_expires_unix",
    "source_package_stale",
    "source_refresh_due",
    "source_count",
    "source_bytes",
    "source_activation_pending",
    "source_material_repair_pending",
    "source_material_repair_retry_pending",
    "source_repair_retry_pending",
    "source_last_refresh_attempt_unix",
    "source_refresh_operation",
    "can_enable",
    "can_refresh_sources",
  ];
  if (!required.every((key) => Object.hasOwn(view, key))) return false;
  if (!HEX32.test(view.projection_revision)) return false;
  if (!["disabled", "pending", "active", "degraded", "unavailable"].includes(view.protection)) return false;
  if (!["unavailable", "uninitialized", "compiling", "installing", "ready", "failed", "retired"].includes(view.phase)) return false;
  if (!["authoritative", "updating", "reconciling", "unavailable"].includes(view.preference)) return false;
  if (!["not_configured", "durable_activation_unsupported", "storage_unavailable", "clock_unsafe", "idle", "fresh", "stale", "refreshing", "failed", "shutdown"].includes(view.source_phase)) return false;
  if (view.desired_enabled !== null && typeof view.desired_enabled !== "boolean") return false;
  if (view.applied_enabled !== null && typeof view.applied_enabled !== "boolean") return false;
  if (typeof view.retryable !== "boolean" || typeof view.can_enable !== "boolean") return false;
  if (typeof view.can_refresh_sources !== "boolean") return false;
  if (!Number.isSafeInteger(view.retries_remaining)) return false;
  if (view.site !== null) {
    const context = view.site.context;
    if (!context || typeof context.profile !== "string" || typeof context.tab !== "string" || typeof context.site !== "string") return false;
    if (!HEX16.test(context.revision)) return false;
  }
  return true;
}

// --- No native seam ----------------------------------------------------------
{
  reset();
  const view = await Blocker.status();
  check("no backend: status matches the wire shape", validStatus(view));
  check("no backend: preference is unavailable", view.preference === "unavailable");
  check("no backend: protection is unavailable", view.protection === "unavailable");
  check("no backend: nothing can be enabled", view.can_enable === false);
  check("no backend: nothing can be refreshed", view.can_refresh_sources === false);
  check("no backend: no generation is claimed", view.config_revision === null && view.applied_enabled === null);
  check("no backend: no site is claimed", view.site === null);
}

{
  reset();
  inject(fake({ available: false, pref: false }));
  const view = await Blocker.status();
  check("off with no native seam: protection is disabled", view.protection === "disabled");
  check("off with no native seam: the preference is authoritative", view.preference === "authoritative");
  check("off with no native seam: phase is unavailable", view.phase === "unavailable");
  check("off with no native seam: no failure is surfaced", view.failure === null);
  check("off with no native seam: applied is false", view.applied_enabled === false);
  check("off with no native seam: can_enable is false", view.can_enable === false);
}

{
  reset();
  const backend = fake({ available: false, pref: true });
  inject(backend);
  const view = await Blocker.status();
  check("on with no native seam: protection is unavailable", view.protection === "unavailable");
  check("on with no native seam: failure says native_unsupported", view.failure === "native_unsupported");
  check("on with no native seam: applied state is unknown", view.applied_enabled === null);
  check("on with no native seam: retry cannot work", view.retryable === false);
  check("on with no native seam: stats are null", (await Blocker.stats({ profile: "default" })).today === null);
}

{
  reset();
  const backend = fake({ available: false, pref: false });
  inject(backend);
  const admission = await Blocker.setEnabled({ enabled: true });
  check("enabling without a seam is rejected", (await disposition(admission)).reason === "native_dispatch_rejected");
  check("enabling without a seam writes no pref", backend.state.writes.length === 0 && backend.state.pref === false);
  check("enabling without a seam installs nothing", backend.state.installs === 0);
  check("a refusal emits no status change", statusEvents().length === 0);
}

{
  reset();
  const backend = fake({ available: false, pref: true });
  inject(backend);
  const admission = await Blocker.setEnabled({ enabled: false });
  check("disabling is allowed without a seam", (await disposition(admission)).outcome === "applied");
  check("disabling writes the gate", backend.state.pref === false && backend.state.writes[0] === false);
  check("disabling tells the native toggle", backend.state.enabledCalls[0] === false);
  check("disabling emits a projection", statusEvents().length === 1);
  const view = await Blocker.status();
  check("after disable protection is off", view.protection === "disabled");
}

{
  reset();
  inject(fake({ available: true, pref: false }));
  const admission = await Blocker.setEnabled({ enabled: "yes" });
  check("a non-boolean enable is invalid_input", (await disposition(admission)).reason === "invalid_input");
}

// --- Native seam: enable / disable ------------------------------------------
{
  reset();
  const backend = fake({ available: true, pref: false });
  inject(backend);
  const admission = await Blocker.setEnabled({ enabled: true });
  const dispositionValue = await disposition(admission);
  check("enable with a seam is applied", dispositionValue.outcome === "applied");
  check("enable writes the pref", backend.state.pref === true);
  check("enable installs rules", backend.state.installs === 1);
  check("enable tells the native toggle", backend.state.enabledCalls[0] === true);
  check("enable emits one projection", statusEvents().length === 1);
  const view = await Blocker.status();
  check("after install status matches the wire shape", validStatus(view));
  check("after install protection is active", view.protection === "active");
  check("after install phase is ready", view.phase === "ready");
  check("after install applied_enabled is true", view.applied_enabled === true);
  check("after install can_enable is true", view.can_enable === true);
  check("after install retains a 16-hex generation", HEX16.test(view.retained_generation));
  check("after install config_revision is that generation", view.config_revision === view.retained_generation);
  check("after install applies the native coverage", view.applied_coverage?.accepted_rules === 9);
  check("after install exposes native diagnostics", view.runtime_diagnostics?.total_decisions === "0");

  const again = await Blocker.setEnabled({ enabled: true });
  check("enabling an armed blocker is no_op", (await disposition(again)).outcome === "no_op");
  check("no_op installs nothing new", backend.state.installs === 1);

  const disable = await Blocker.setEnabled({ enabled: false });
  check("disable is applied", (await disposition(disable)).outcome === "applied");
  check("disable keeps the retained generation", (await Blocker.status()).retained_generation === view.retained_generation);
  check("disable reports protection off", (await Blocker.status()).protection === "disabled");
}

// --- Restart reconciliation --------------------------------------------------
{
  reset();
  const backend = fake({ available: true, pref: true });
  inject(backend);
  const first = await Blocker.status();
  check("a pref-on restart starts pending", first.protection === "pending");
  check("the first status kicks off exactly one install", backend.state.installs === 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await Blocker.status();
  check("the reconciled status becomes active", second.protection === "active");
  check("the reconciled status claims applied", second.applied_enabled === true);
  check("reconciliation does not install twice", backend.state.installs === 1);
  check("a reconciled install emitted a projection", statusEvents().length >= 1);
}

// --- Failure, retry ----------------------------------------------------------
{
  reset();
  const backend = fake({ available: true, pref: false, installOk: false });
  inject(backend);
  const admission = await Blocker.setEnabled({ enabled: true });
  check("a failed install is rejected", (await disposition(admission)).reason === "native_work_pending");
  const failed = await Blocker.status();
  check("a failed install is reported", failed.failure === "native_installation");
  check("a failed install phase is failed", failed.phase === "failed");
  check("a failed install is retryable", failed.retryable === true);
  check("a failed install never claims active", failed.protection !== "active");
  check("a failed install reports degraded protection", failed.protection === "degraded");
  check("a failed install exposes its failed generation", HEX16.test(failed.desired_generation));

  const stale = await Blocker.retry({ failed_generation: "0000000000000000" });
  check("retry with an unknown generation is refused", (await disposition(stale)).reason === "invalid_scope");
  const bad = await Blocker.retry({ failed_generation: "nope" });
  check("retry with a malformed generation is invalid", (await disposition(bad)).reason === "invalid_input");

  backend.state.installOk = true;
  const retry = await Blocker.retry({ failed_generation: failed.desired_generation });
  check("retry with the failed generation is applied", (await disposition(retry)).outcome === "applied");
  const recovered = await Blocker.status();
  check("retry clears the failure", recovered.failure === null);
  check("retry reaches active", recovered.protection === "active");
}

// --- Refresh sources ---------------------------------------------------------
{
  reset();
  const backend = fake({ available: true, pref: true });
  inject(backend);
  const admission = await Blocker.refreshSources();
  check("refresh with a seam is applied", (await disposition(admission)).outcome === "applied");
  check("refresh calls the native refresh", backend.state.refreshes === 1);
  const view = await Blocker.status();
  check("refresh reports a fresh source", view.source_phase === "fresh");
  check("refresh carries the source count", view.source_count === 2);
  check("refresh carries the source bytes", view.source_bytes === 1024);
  check("refresh carries the source revision", view.source_package_revision === "4444444444444444");
  check("refresh carries provenance", view.source_installed_provenance === "official_https");
  check("refresh clears failure", view.failure === null);
  check("can_refresh_sources is true with a seam", view.can_refresh_sources === true);
}

{
  reset();
  const backend = fake({ available: true, pref: true, refreshOk: false });
  inject(backend);
  const admission = await Blocker.refreshSources();
  check("a failed refresh is rejected", (await disposition(admission)).reason === "native_work_pending");
  const view = await Blocker.status();
  check("a failed refresh phase is failed", view.source_phase === "failed");
  check("a failed refresh keeps a stable category", view.source_failure === "transport");
}

{
  reset();
  const backend = fake({ available: false, pref: true });
  inject(backend);
  const admission = await Blocker.refreshSources();
  check("refresh without a seam is refused", (await disposition(admission)).reason === "native_dispatch_rejected");
  check("refresh without a seam changes nothing", backend.state.refreshes === 0);
}

// --- Site change -------------------------------------------------------------
{
  reset();
  const backend = fake({ available: true, pref: false, site: SITE });
  inject(backend);
  const view = await Blocker.status();
  check("site context is exposed when a tab is present", validStatus(view) && view.site.context.site === "news.example");
  const admission = await Blocker.siteChange({
    context: SITE.context,
    action: { kind: "pause", paused: true },
  });
  check("pausing a site is applied", (await disposition(admission)).outcome === "applied");
  check("pausing tells the native toggle", backend.state.siteCalls[0].site === "news.example" && backend.state.siteCalls[0].enabled === false);
  const resume = await Blocker.siteChange({
    context: SITE.context,
    action: { kind: "pause", paused: false },
  });
  check("resuming a site is applied", (await disposition(resume)).outcome === "applied");
  check("resuming enables the site", backend.state.siteCalls[1].enabled === true);
  const unsupported = await Blocker.siteChange({
    context: SITE.context,
    action: { kind: "set_hide_enabled", id: "x", enabled: true },
  });
  check("an unwired site action is refused", (await disposition(unsupported)).reason === "unsupported_command");
  const invalid = await Blocker.siteChange({ context: null, action: { kind: "pause", paused: true } });
  check("a missing context is invalid", (await disposition(invalid)).reason === "invalid_input");
}

{
  reset();
  const backend = fake({ available: false, pref: true, site: SITE });
  inject(backend);
  const admission = await Blocker.siteChange({
    context: SITE.context,
    action: { kind: "pause", paused: true },
  });
  check("a site change without a seam is refused", (await disposition(admission)).reason === "native_dispatch_rejected");
  check("a refused site change reaches no toggle", backend.state.siteCalls.length === 0);
}

// --- Stats -------------------------------------------------------------------
{
  reset();
  const backend = fake({
    available: true,
    pref: true,
    stats: { today: 12, last7Days: 40, days: [1, 2, null] },
  });
  inject(backend);
  const stats = await Blocker.stats({ profile: "default" });
  check("stats pass through real counts", stats.today === 12 && stats.last7Days === 40);
  check("stats preserve per-day holes", stats.days.length === 3 && stats.days[2] === null);
  check("stats name the profile to the native side", backend.state.statsCalls[0] === "default");
}

{
  reset();
  inject(fake({ available: true, pref: true, stats: null }));
  const stats = await Blocker.stats({ profile: "default" });
  check("a native side with no counts returns nulls, never 0", stats.today === null && stats.last7Days === null);
}

{
  reset();
  inject(fake({ available: true, pref: true, stats: { today: -1, last7Days: "x", days: [-2, "y"] } }));
  const stats = await Blocker.stats({ profile: "default" });
  check("malformed counts are dropped", stats.today === null && stats.last7Days === null);
  check("malformed days become holes", stats.days[0] === null && stats.days[1] === null);
}

{
  reset();
  const stats = await Blocker.stats({ profile: "" });
  check("an empty profile never reads counts", stats.today === null && stats.days.length === 0);
}

// --- Picker / teardown -------------------------------------------------------
{
  reset();
  check("the picker answers null while unwired", (await Blocker.picker()) === null);
  Blocker.uninstall();
  check("uninstall is safe without a chrome pref service", true);
}

off();

console.log(
  `\nblocker host contract: ${failed === 0 ? "PASS" : "FAIL"} (${passed} checks, ${failed} failed)`,
);
process.exit(failed === 0 ? 0 : 1);

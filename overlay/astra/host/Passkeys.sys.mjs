/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Astra platform passkeys: the Settings surface, the WebAuthn prompt bridge
// and the vault path hand-off.
//
// The vault itself lives in Rust (`toolkit/components/astra_passkeys`) and is
// reached through `@astra/passkeys;1`. The WebAuthn token reads the same file
// directly; this module never handles a private key, only the management verbs
// Settings needs.
//
// Prompt flow: `WebAuthnPromptHelper` suppresses its native notification while
// `astra.passkeys.ui` is true, and this module observes the same
// `webauthn-prompt` topic. A prompt is emitted to the app as
// `astra-passkey-prompt`; the answer goes back through the browser's own
// `nsIWebAuthnService` callback. A private browsing context is refused at this
// seam, before the token can create or use a credential.

import { emit } from "./Events.sys.mjs";

const VAULT_PREF = "astra.passkeys.vault";
const ENABLED_PREF = "security.webauthn.astra_passkeys";
const UI_PREF = "astra.passkeys.ui";
const UNLOCK_TIMEOUT_MS = 5 * 60 * 1000;

const Services = globalThis.Services;

// Node contract tests import this module without a chrome environment; keep
// the privileged lookups behind calls so import stays inert.
function classes() {
  return globalThis.Cc ?? globalThis.Components.classes;
}
function interfaces() {
  return globalThis.Ci ?? globalThis.Components.interfaces;
}
function results() {
  return globalThis.Cr ?? globalThis.Components.results;
}

let activated = false;
let promptObserver = null;
let activePrompt = null;
let lockTimer = null;

function vaultService() {
  return classes()["@astra/passkeys;1"].getService(interfaces().nsIAstraPasskeys);
}

function webauthnService() {
  return classes()["@mozilla.org/webauthn/service;1"].getService(interfaces().nsIWebAuthnService);
}

function vaultPath() {
  const profile = Services.dirsvc.get("ProfD", interfaces().nsIFile).path;
  return `${profile}/astra/passkeys/vault.json`;
}

/** Keep the JS-side vault unlocked only while Settings is in use. */
function armLock() {
  if (lockTimer !== null) {
    clearTimeout(lockTimer);
  }
  lockTimer = setTimeout(() => {
    lockTimer = null;
    try {
      vaultService().lock();
    } catch {
      // The service goes away with the window; nothing to release.
    }
  }, UNLOCK_TIMEOUT_MS);
}

function disarmLock() {
  if (lockTimer !== null) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
}

function errorCode(error) {
  const Cr = results();
  const result = error?.result ?? Cr.NS_ERROR_FAILURE;
  if (result === Cr.NS_ERROR_INVALID_ARG) return "pin_policy";
  if (result === Cr.NS_ERROR_DOM_NOT_ALLOWED_ERR) return "auth";
  if (result === Cr.NS_ERROR_DOM_INVALID_STATE_ERR) return "unavailable";
  if (result === Cr.NS_ERROR_NOT_IMPLEMENTED) return "unsupported";
  if (result === Cr.NS_ERROR_FILE_NOT_FOUND) return "not_initialized";
  return "unavailable";
}

function readStatus() {
  if (!Services) {
    return {
      enabled: false,
      exists: false,
      has_pin: false,
      unlocked: false,
      system_unlock: false,
      system_auth_available: false,
      credential_count: 0,
      pin_retries_left: 0,
      locked_for_secs: 0,
      error: "unavailable",
    };
  }
  const enabled = Services.prefs.getBoolPref(ENABLED_PREF, true);
  let raw = null;
  let error = null;
  try {
    raw = JSON.parse(vaultService().statusJson);
  } catch (e) {
    error = errorCode(e);
  }
  return {
    enabled,
    exists: raw?.exists === true,
    has_pin: raw?.has_pin === true,
    unlocked: raw?.unlocked === true,
    system_unlock: raw?.system_unlock === true,
    system_auth_available: raw?.system_auth_available === true,
    credential_count: raw?.credential_count ?? 0,
    pin_retries_left: raw?.pin_retries_left ?? 0,
    locked_for_secs: raw?.locked_for_secs ?? 0,
    error,
  };
}

function statusResult(run) {
  try {
    run();
    return { ok: true, error: null, status: readStatus() };
  } catch (e) {
    return { ok: false, error: errorCode(e), status: readStatus() };
  }
}

/** True when the request belongs to a private browsing context. */
function isPrivateContext(browsingContextId) {
  try {
    const context = globalThis.BrowsingContext?.get?.(browsingContextId);
    return context?.usePrivateBrowsing === true;
  } catch {
    return false;
  }
}

function onPrompt(subject, topic, data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (payload?.prompt?.type === "cancel") {
    activePrompt = null;
    emit("passkey-prompt-changed", { prompt: null });
    return;
  }
  if (isPrivateContext(payload?.browsingContextId)) {
    // Refuse before the token can act: a private window records nothing.
    try {
      webauthnService().cancel(payload.tid);
    } catch {
      // Already gone.
    }
    activePrompt = null;
    emit("passkey-prompt-changed", { prompt: { type: "private-blocked" } });
    return;
  }
  activePrompt = payload;
  emit("passkey-prompt-changed", { prompt: payload.prompt, origin: payload.origin, tid: payload.tid });
}

/**
 * Publish the vault path and take over the WebAuthn prompt. Called once, when
 * the app imports the Host API; a later Settings visit must not re-register
 * the observer.
 */
export function activate() {
  if (activated || !Services) return;
  activated = true;
  try {
    Services.prefs.setStringPref(VAULT_PREF, vaultPath());
  } catch {
    // No profile directory means no passkey vault; status reports unavailable.
  }
  try {
    Services.prefs.setBoolPref(UI_PREF, true);
  } catch {
    // The native prompt stays in charge if the preference is locked.
  }
  promptObserver = onPrompt;
  Services.obs.addObserver(promptObserver, "webauthn-prompt");
}

export function deactivate() {
  if (!activated) return;
  activated = false;
  if (promptObserver) {
    try {
      Services.obs.removeObserver(promptObserver, "webauthn-prompt");
    } catch {
      // The observer service is gone during shutdown.
    }
    promptObserver = null;
  }
  disarmLock();
  activePrompt = null;
}

export function status() {
  return readStatus();
}

export function setEnabled({ enabled }) {
  try {
    Services.prefs.setBoolPref(ENABLED_PREF, enabled === true);
    if (!enabled) {
      disarmLock();
      try {
        vaultService().lock();
      } catch {
        // No vault yet.
      }
    }
    return { ok: true, error: null, status: readStatus() };
  } catch (e) {
    return { ok: false, error: errorCode(e), status: readStatus() };
  }
}

export function enable({ pin, system_unlock }) {
  const result = statusResult(() => vaultService().create(pin, system_unlock === true));
  if (result.ok) armLock();
  return result;
}

export function unlock({ pin }) {
  const result = statusResult(() => vaultService().unlock(pin));
  if (result.ok) armLock();
  return result;
}

export function lock() {
  disarmLock();
  return statusResult(() => vaultService().lock());
}

export function changePin({ old_pin, new_pin }) {
  const result = statusResult(() => vaultService().changePin(old_pin, new_pin));
  if (result.ok) armLock();
  return result;
}

export function setSystemUnlock({ enabled }) {
  return statusResult(() => vaultService().setSystemUnlock(enabled === true));
}

export function list() {
  try {
    return { ok: true, error: null, credentials: JSON.parse(vaultService().listJson()) };
  } catch (e) {
    return { ok: false, error: errorCode(e), credentials: [] };
  }
}

export function remove({ id }) {
  const result = statusResult(() => vaultService().removeCredential(id));
  if (result.ok) armLock();
  return result;
}

export function removeAll() {
  return statusResult(() => vaultService().removeAllCredentials());
}

export function destroy() {
  disarmLock();
  return statusResult(() => vaultService().destroy());
}

export function currentPrompt() {
  return activePrompt;
}

/** Answer the browser's pending WebAuthn prompt. */
export function answerPrompt({ tid, action, value }) {
  const service = webauthnService();
  const transaction = Number(tid);
  try {
    if (action === "cancel") {
      service.cancel(transaction);
    } else if (action === "select") {
      service.selectionCallback(transaction, Number(value));
    } else {
      service.pinCallback(transaction, String(value ?? ""));
    }
    return true;
  } catch {
    return false;
  } finally {
    activePrompt = null;
    emit("passkey-prompt-changed", { prompt: null });
  }
}

export function __resetForTests() {
  deactivate();
  activated = false;
}

/**
 * `passkey_call` entry point. Every answer has the same shape so the surface
 * can render one status line and, when asked, the credential list.
 */
export function call({ call }) {
  const kind = call?.kind;
  const addList = (result) => {
    if (!result.ok) return { ...result, credentials: [] };
    const listed = list();
    return {
      ok: listed.ok,
      error: listed.error,
      status: result.status,
      credentials: listed.credentials,
    };
  };
  switch (kind) {
    case "status":
      return { ok: true, error: null, status: readStatus(), credentials: [] };
    case "list":
      return addList(statusResult(() => {}));
    case "set_enabled":
      return { ...setEnabled({ enabled: call.enabled === true }), credentials: [] };
    case "enable":
      return addList(enable({ pin: String(call.pin ?? ""), system_unlock: call.system_unlock === true }));
    case "unlock":
      return addList(unlock({ pin: String(call.pin ?? "") }));
    case "lock":
      return { ...lock(), credentials: [] };
    case "change_pin":
      return {
        ...changePin({ old_pin: String(call.old_pin ?? ""), new_pin: String(call.new_pin ?? "") }),
        credentials: [],
      };
    case "set_system_unlock":
      return { ...setSystemUnlock({ enabled: call.enabled === true }), credentials: [] };
    case "remove":
      return addList(remove({ id: String(call.id ?? "") }));
    case "remove_all":
      return { ...removeAll(), credentials: [] };
    case "destroy":
      return { ...destroy(), credentials: [] };
    default:
      return {
        ok: false,
        error: "unknown_call",
        status: readStatus(),
        credentials: [],
      };
  }
}

/** `passkey_answer_prompt` entry point. */
export function answer({ tid, action, value }) {
  return answerPrompt({ tid, action, value });
}

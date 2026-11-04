/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API DialogPrompts module (P6c-1). HTTP auth is the first engine dialog
// wired to Astra's existing sign-in card (`PageRequestCard`).
//
// The engine seam is `Services.prompt.asyncPromptAuth`: the prompt service is
// wrapped once per process, and each window publishes an entry on
// `Services.astraDialogWindows` (the shell instance owns that window's pending
// map, exactly like `Permissions`). An Astra tab's challenge becomes a
// `Dialogs` record plus a `page_request` on the tab; the app answers with
// `tabs_answer_sign_in`, and this module sets the credentials on the engine's
// `authInfo` and resolves the engine promise.
//
// SECURITY:
// - Credentials live only in this closure; they never enter an event, the tab
//   projection, the operation ledger or a log.
// - A response must match the exact tab and request token; anything else is
//   refused as `invalid_scope` and the engine promise is left alone.
// - A navigation or tab close cancels the engine prompt (resolve false) and
//   clears the card, so a stale answer cannot authenticate a new document.
// - Unsupported schemes (NTLM/Negotiate/password-only) are cancelled instead
//   of falling back to Firefox's dialog, so Astra remains the only UI.

import { addEventListener } from "./Events.sys.mjs";
import { Dialogs } from "./Dialogs.sys.mjs";
import { admit, refuse } from "./Operations.sys.mjs";
import {
  Tabs,
  __setPageRequest,
  __clearPageRequest,
  __setFailure,
  __setCertificateException,
  __tabsState,
} from "./Tabs.sys.mjs";

const AUTH_SCHEMES = new Set(["basic", "digest"]);

// nsIAuthInformation flags; the literals keep this module importable in Node.
const AUTH_PROXY = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.AUTH_PROXY : 2;
const NEED_DOMAIN = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.NEED_DOMAIN : 4;
const ONLY_PASSWORD = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.ONLY_PASSWORD : 8;
const PREVIOUS_FAILED =
  typeof Ci !== "undefined" ? Ci.nsIAuthInformation.PREVIOUS_FAILED : 16;

const _pending = new Map(); // numeric request -> pending record
const _certPending = new Map(); // astra_tab_id -> certificate challenge
const _certOverrides = new Map(); // astra_tab_id -> {host, port, originAttributes}
let _nextRequest = 0;
let _off = null;

const CERT_OVERRIDE_SERVICE = "@mozilla.org/security/certoverride;1";
const NSS_ERRORS_SERVICE = "@mozilla.org/nss_errors_service;1";

function certificateProblem(code) {
  const text = String(code ?? "").toUpperCase();
  if (text.includes("EXPIRED")) return "expired";
  if (text.includes("REVOKED")) return "revoked";
  if (text.includes("DOMAIN") || text.includes("NAME")) return "name_mismatch";
  if (text.includes("UNKNOWN_ISSUER") || text.includes("SELF_SIGNED")) return "untrusted";
  return "other";
}

/** The person's own network: loopback, link-local, private ranges, and
 *  single-label hosts. A public name is never continuable. */
export function isLocalHost(host) {
  const name = String(host ?? "").toLowerCase();
  if (name === "") return false;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) {
    return true;
  }
  if (name === "::1" || name.startsWith("fe80:")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // A single-label intranet name has no public suffix.
  return !name.includes(".");
}

function certKey(tabId) {
  return typeof tabId === "string" ? tabId : "";
}

function clearOverride(tabId) {
  const entry = _certOverrides.get(tabId);
  if (!entry) return false;
  _certOverrides.delete(tabId);
  try {
    const service = Cc[CERT_OVERRIDE_SERVICE].getService(Ci.nsICertOverrideService);
    service.clearValidityOverride(entry.host, entry.port, entry.originAttributes);
  } catch {
    // The service or the override is already gone.
  }
  return true;
}

function sharedServices() {
  try {
    return typeof Services !== "undefined" && Services ? Services : null;
  } catch {
    return null;
  }
}

function tabIdFor(browser) {
  try {
    const win = browser?.ownerDocument?.defaultView ?? browser?.ownerGlobal ?? null;
    return win?.gBrowser?.getTabForBrowser?.(browser)?.getAttribute?.("astra-tab-id") ?? "";
  } catch {
    return "";
  }
}

function authTarget(channel, authInfo) {
  try {
    const { PromptUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/PromptUtils.sys.mjs"
    );
    return PromptUtils.getAuthTarget(channel, authInfo);
  } catch {
    let host = "";
    try {
      host = channel.URI.host;
    } catch {
      host = "";
    }
    return { displayHost: host, displayHostOnly: host, realm: "" };
  }
}

function isInsecure(channel) {
  try {
    return channel.URI.schemeIs("http");
  } catch {
    return false;
  }
}

function ensureWatch() {
  if (_off !== null) return;
  _off = addEventListener((event) => {
    const id = event?.data?.astra_tab_id;
    if (typeof id !== "string" || id === "") return;
    if (event.type === "tab.closed" || event.type === "nav.committed") {
      for (const request of [..._pending.keys()]) {
        if (_pending.get(request)?.tabId === id) cancelPending(request);
      }
    }
    if (event.type === "tab.closed") {
      _certPending.delete(id);
      clearOverride(id);
    }
    // The reload after "continue" commits: proceed-once ends here. Any other
    // navigation also makes a pending certificate challenge stale.
    if (event.type === "nav.committed") {
      _certPending.delete(id);
      clearOverride(id);
    }
  });
}

function cancelPending(request, { notifyEngine = true } = {}) {
  const pending = _pending.get(request);
  if (!pending) return false;
  _pending.delete(request);
  __clearPageRequest(pending.tabId, request);
  if (pending.observer && pending.loadGroup) {
    try {
      pending.loadGroup.removeRequestObserver(pending.observer, false);
    } catch {
      // The load group is gone with the channel.
    }
  }
  clearTimeout(pending.timer);
  pending.resolve?.(false);
  if (notifyEngine) {
    void Dialogs.respondAuth({
      request_id: `auth-cancel-${request}`,
      dialog_id: pending.dialogId,
      cancel: true,
      actor: "chrome",
    });
  }
  return true;
}

export const DialogPrompts = {
  /** One process-wide wrapper; this window joins the routing registry. */
  async install({ window: win = null } = {}) {
    ensureWatch();
    if (win) {
      const shared = sharedServices();
      if (shared) {
        if (typeof shared.astraDialogWindows?.get !== "function") {
          shared.astraDialogWindows = new Map();
        }
        shared.astraDialogWindows.set(win, { promptAuth: DialogPrompts.promptAuth });
        try {
          win.addEventListener(
            "unload",
            () => void DialogPrompts.uninstall({ window: win }),
            { once: true }
          );
        } catch {
          // A preview DOM without a window.
        }
        return true;
      }
    }
    return win === null;
  },

  async uninstall({ window: win = null } = {}) {
    if (win) {
      try {
        sharedServices()?.astraDialogWindows?.delete(win);
      } catch {
        // Already gone with the window.
      }
    }
    for (const request of [..._pending.keys()]) cancelPending(request);
    _off?.();
    _off = null;
  },

  /**
   * Engine entry. Returns a `Promise<boolean>` when Astra owns the challenge,
   * or null to let the caller keep the engine's prompt.
   */
  promptAuth({ browser = null, channel = null, authInfo = null } = {}) {
    if (!browser || !channel || !authInfo) return null;
    ensureWatch();
    const tabId = tabIdFor(browser);
    // The window is Astra-owned (this entry exists), so never fall back to
    // Firefox's dialog for a tab Astra does not model yet.
    if (tabId === "") return Promise.resolve(false);
    let scheme = "basic";
    try {
      scheme = String(authInfo.authenticationScheme || "basic").toLowerCase();
    } catch {
      scheme = "basic";
    }
    if (!AUTH_SCHEMES.has(scheme)) {
      // Astra stays the only UI: refuse rather than open Firefox's dialog.
      return Promise.resolve(false);
    }
    const target = authTarget(channel, authInfo);
    const host =
      target?.displayHost || target?.displayHostOnly || (() => {
        try {
          return channel.URI.host;
        } catch {
          return "";
        }
      })();
    if (typeof host !== "string" || host === "") return null;

    const flags = Number(authInfo.flags) || 0;
    const proxy = (flags & AUTH_PROXY) !== 0;
    const retry = (flags & PREVIOUS_FAILED) !== 0;
    const onlyPassword = (flags & ONLY_PASSWORD) !== 0;
    const insecure = isInsecure(channel);
    const realm = typeof authInfo.realm === "string" ? authInfo.realm : "";
    const request = ++_nextRequest;

    return Dialogs.requestAuth({
      request_id: `auth-${request}`,
      astra_tab_id: tabId,
      host,
      realm,
      scheme,
      proxy,
      insecure,
      retry,
      only_password: onlyPassword,
      actor: "chrome",
    }).then((res) => {
      if (res?.error) return false;
      const pending = {
        request,
        tabId,
        authInfo,
        dialogId: res.dialog?.dialog_id ?? "",
        resolve: null,
        channel,
        loadGroup: channel.loadGroup ?? null,
        observer: null,
        timer: 0,
      };
      // A cancelled channel (aborted fetch, destroyed iframe, unload) must
      // settle the engine prompt instead of leaving it waiting.
      try {
        if (pending.loadGroup) {
          pending.observer = {
            onStartRequest() {},
            onStopRequest(_request, status) {
              if (!Components.isSuccessCode(status)) cancelPending(request);
            },
          };
          pending.loadGroup.addRequestObserver(pending.observer, false);
        }
      } catch {
        pending.observer = null;
      }
      // Hard bound for a challenge the person never answers.
      pending.timer = setTimeout(() => cancelPending(request), 120_000);
      _pending.set(request, pending);
      __setPageRequest(tabId, {
        kind: "http_auth",
        request,
        host,
        insecure,
        proxy,
        retry,
      });
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    });
  },

  /** Route target for `tabs_answer_sign_in`. */
  async answerAuth({ astra_tab_id = "", request = 0, credentials = null } = {}) {
    const numeric = Number(request);
    const pending = _pending.get(numeric);
    if (!pending || pending.tabId !== astra_tab_id) {
      return refuse("invalid_scope");
    }
    if (credentials === null || credentials === undefined) {
      _pending.delete(numeric);
      __clearPageRequest(astra_tab_id, numeric);
      clearTimeout(pending.timer);
      if (pending.observer && pending.loadGroup) {
        try { pending.loadGroup.removeRequestObserver(pending.observer, false); } catch {}
      }
      await Dialogs.respondAuth({
        request_id: `auth-${numeric}`,
        dialog_id: pending.dialogId,
        cancel: true,
        actor: "chrome",
      });
      pending.resolve?.(false);
      return admit({ outcome: "no_op", reason: "state_unchanged" });
    }
    const username = typeof credentials.username === "string" ? credentials.username : "";
    const password = typeof credentials.password === "string" ? credentials.password : "";
    if (username === "") {
      _pending.delete(numeric);
      __clearPageRequest(astra_tab_id, numeric);
      clearTimeout(pending.timer);
      if (pending.observer && pending.loadGroup) {
        try { pending.loadGroup.removeRequestObserver(pending.observer, false); } catch {}
      }
      await Dialogs.respondAuth({
        request_id: `auth-${numeric}`,
        dialog_id: pending.dialogId,
        cancel: true,
        actor: "chrome",
      });
      pending.resolve?.(false);
      return refuse("invalid_input");
    }
    const res = await Dialogs.respondAuth({
      request_id: `auth-${numeric}`,
      dialog_id: pending.dialogId,
      username,
      password,
      actor: "chrome",
    });
    _pending.delete(numeric);
    __clearPageRequest(astra_tab_id, numeric);
    clearTimeout(pending.timer);
    if (pending.observer && pending.loadGroup) {
      try { pending.loadGroup.removeRequestObserver(pending.observer, false); } catch {}
    }
    if (res?.error) {
      pending.resolve?.(false);
      return refuse("invalid_scope");
    }
    try {
      pending.authInfo.username = username;
      pending.authInfo.password = password;
      if (
        (pending.authInfo.flags & NEED_DOMAIN) &&
        typeof credentials.domain === "string"
      ) {
        pending.authInfo.domain = credentials.domain;
      }
    } catch {
      pending.resolve?.(false);
      return admit({ outcome: "rejected", reason: "native_dispatch_rejected" });
    }
    pending.resolve?.(true);
    return admit({ outcome: "applied", reason: "mutation_applied" });
  },

  /**
   * A certificate error page. Chrome derives every fact from the failed
   * channel at this moment; the event/projection never carries engine text.
   */
  async certErrorFor({ browser = null, failedURI = "", tabId = "" } = {}) {
    if (!browser || typeof failedURI !== "string" || failedURI === "") return false;
    if (typeof tabId !== "string" || tabId === "") return false;
    let uri = null;
    let channel = null;
    let securityInfo = null;
    try {
      uri = Services.io.newURI(failedURI);
      if (!uri.schemeIs("https")) return false;
      const global = browser.browsingContext?.currentWindowGlobal ?? null;
      channel = global?.failedChannel ?? null;
      securityInfo = channel?.securityInfo ?? null;
    } catch {
      return false;
    }
    if (!uri || !channel) return false;
    const host = uri.host ?? "";
    if (host === "") return false;
    const port = uri.port > 0 ? uri.port : 443;
    let originAttributes = {};
    try {
      originAttributes = channel.loadInfo?.originAttributes ?? {};
    } catch {
      originAttributes = {};
    }
    let code = "";
    let overridable = false;
    try {
      code = securityInfo?.errorCodeString ?? "";
      const nss = Cc[NSS_ERRORS_SERVICE].getService(Ci.nsINSSErrorsService);
      overridable = nss.isErrorOverridable(channel.status) === true;
    } catch {
      overridable = false;
    }
    // Only a TLS error is a certificate interstitial. A DNS/timeout error on
    // an https URL has no securityInfo and keeps the normal failed-page path.
    if (!securityInfo) return false;
    const certificate = certificateProblem(code);
    const canContinue = overridable && isLocalHost(host);
    const res = await Dialogs.requestCertError({
      request_id: `cert-${tabId}`,
      astra_tab_id: tabId,
      url: failedURI,
      code: code || certificate,
      actor: "chrome",
    });
    if (res?.error) return false;
    const dialogId = res.dialog?.dialog_id ?? "";
    const cert = (() => {
      try {
        return securityInfo?.serverCert ?? null;
      } catch {
        return null;
      }
    })();
    _certPending.set(tabId, {
      dialogId,
      host,
      port,
      origin: uri.prePath ?? `https://${host}:${port}`,
      url: failedURI,
      browser,
      originAttributes,
      cert,
      canContinue,
    });
    __setFailure(tabId, {
      url: failedURI,
      reason: "insecure",
      certificate,
      can_continue: canContinue,
      covers_page: true,
    });
    __setCertificateException(tabId, false);
    return true;
  },

  /** Route target for `tabs_continue_past_certificate`. */
  async answerCert({ astra_tab_id = "", decision = "proceed-once" } = {}) {
    const pending = _certPending.get(certKey(astra_tab_id));
    if (!pending) return refuse("invalid_scope");
    // A late "continue" must belong to the failed page still on screen.
    const tab = __tabsState().tabs.get(astra_tab_id);
    if (!tab || tab.failure?.url !== pending.url) {
      _certPending.delete(certKey(astra_tab_id));
      return refuse("invalid_scope");
    }
    if (decision !== "proceed-once" && decision !== "cancel") {
      return refuse("invalid_input");
    }
    const res = await Dialogs.decideCert({
      request_id: `cert-${astra_tab_id}`,
      dialog_id: pending.dialogId,
      decision,
      actor: "chrome",
    });
    if (res?.error) return refuse("invalid_scope");
    _certPending.delete(astra_tab_id);
    if (decision === "cancel") {
      return admit({ outcome: "no_op", reason: "state_unchanged" });
    }
    if (!pending.canContinue) {
      // The engine refused the override; keep the failed page.
      return admit({ outcome: "rejected", reason: "invalid_scope" });
    }
    let applied = false;
    try {
      const service = Cc[CERT_OVERRIDE_SERVICE].getService(Ci.nsICertOverrideService);
      const cert = pending.cert;
      if (!cert) return admit({ outcome: "rejected", reason: "native_dispatch_rejected" });
      service.rememberValidityOverride(
        pending.host,
        pending.port,
        pending.originAttributes,
        cert,
        true
      );
      _certOverrides.set(astra_tab_id, {
        host: pending.host,
        port: pending.port,
        originAttributes: pending.originAttributes,
      });
      applied = true;
    } catch {
      applied = false;
    }
    if (!applied) return admit({ outcome: "rejected", reason: "native_dispatch_rejected" });
    __setCertificateException(astra_tab_id, true, pending.origin);
    try {
      pending.browser?.reload();
    } catch {
      // The tab went away; the override clears with it.
    }
    return admit({ outcome: "applied", reason: "mutation_applied" });
  },

  /** Diagnostics/tests: what is waiting, without any credentials. */
  pending() {
    return [..._pending.values()].map((entry) => ({
      request: entry.request,
      tab_id: entry.tabId,
      dialog_id: entry.dialogId,
    }));
  },

  __resetForTests() {
    for (const request of [..._pending.keys()]) cancelPending(request, { notifyEngine: false });
    for (const tabId of [..._certOverrides.keys()]) clearOverride(tabId);
    _certPending.clear();
    _pending.clear();
    _nextRequest = 0;
    _off?.();
    _off = null;
    try {
      sharedServices()?.astraDialogWindows?.clear();
    } catch {
      // No shared Services in a Node test.
    }
  },
};

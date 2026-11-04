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
import { Tabs, __setPageRequest } from "./Tabs.sys.mjs";

const AUTH_SCHEMES = new Set(["basic", "digest"]);

// nsIAuthInformation flags; the literals keep this module importable in Node.
const AUTH_PROXY = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.AUTH_PROXY : 2;
const NEED_DOMAIN = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.NEED_DOMAIN : 4;
const ONLY_PASSWORD = typeof Ci !== "undefined" ? Ci.nsIAuthInformation.ONLY_PASSWORD : 8;
const PREVIOUS_FAILED =
  typeof Ci !== "undefined" ? Ci.nsIAuthInformation.PREVIOUS_FAILED : 16;

const _pending = new Map(); // numeric request -> pending record
let _nextRequest = 0;
let _off = null;

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
  });
}

function cancelPending(request, { notifyEngine = true } = {}) {
  const pending = _pending.get(request);
  if (!pending) return false;
  _pending.delete(request);
  __setPageRequest(pending.tabId, null);
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
        if (!(shared.astraDialogWindows instanceof Map)) {
          shared.astraDialogWindows = new Map();
        }
        shared.astraDialogWindows.set(win, { promptAuth: DialogPrompts.promptAuth });
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
    if (tabId === "") return null;
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
      };
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
      __setPageRequest(astra_tab_id, null);
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
      __setPageRequest(astra_tab_id, null);
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
    __setPageRequest(astra_tab_id, null);
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

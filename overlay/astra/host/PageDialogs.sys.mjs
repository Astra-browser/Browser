/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Page dialogs (ASTRA-0020). A page's `alert`, `confirm`, `prompt` and
// `beforeunload` are Astra surfaces: the engine actor asks the chrome window
// instead of loading `commonDialog.xhtml`.
//
// One controller per chrome window, published as `win.__astraPageDialogs`.
// The controller emits `page-dialog-prompt-changed` with the dialog's text
// and awaits `page_dialog_answer` for that exact request token. A window that
// never answers (closed, crashed, app not mounted) is cancelled after the
// timeout, so a page is never blocked forever. Pieces:
//
// - `present(args)` is the engine-facing call. It returns null for prompts
//   Astra does not own (select, HTTP auth, certificate and any other
//   commonDialog type), and a plain answer object otherwise.
// - `answer(...)` is the routed app call. It only settles a request that is
//   pending in this window's controller; a token from another window is
//   `invalid_scope` and leaves that window's request alone.
//
// Dialogs are never stored: text lives in the pending record until it is
// answered or timed out, and nothing is logged (the text is page-controlled).
// Private windows behave exactly like normal ones; the request still belongs
// to the window that raised it.

import { emit } from "./Events.sys.mjs";
import { admit, refuse } from "./Operations.sys.mjs";

const EVENT = "page-dialog-prompt-changed";
const TIMEOUT_MS = 60_000;
const MAX_TEXT = 10_000;
const MAX_LABEL = 500;

let _timeoutMs = TIMEOUT_MS;
let _nextRequest = 0;
let _own = null; // the controller of the chrome document this module runs in
const _controllers = new Set();

function textOf(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function hostOf(value) {
  if (typeof value !== "string") return "";
  const host = value.trim();
  // A host is a name or an address, never a path, query or credential.
  return /^[a-z0-9.-]+(:\d{1,5})?$/iu.test(host) ? host.slice(0, 255) : "";
}

function hostFromPrincipal(principal) {
  try {
    if (!principal || principal.isSystemPrincipal) return "";
    return hostOf(principal.URI.displayHostPort || principal.originNoSuffix || "");
  } catch {
    return "";
  }
}

/**
 * The dialog kinds Astra draws. `select`, HTTP auth (`promptUserAndPass`,
 * `promptPassword`), and the other `confirmEx` uses (repost, folder upload)
 * keep the engine's own path.
 */
export function pageDialogKind(args) {
  if (!args || typeof args !== "object") return null;
  if (args.inPermitUnload === true) {
    return ["confirm", "confirmCheck", "confirmEx"].includes(args.promptType)
      ? "beforeunload"
      : null;
  }
  switch (args.promptType) {
    case "alert":
    case "alertCheck":
      return "alert";
    case "confirm":
    case "confirmCheck":
      return "confirm";
    case "prompt":
      return "prompt";
    default:
      return null;
  }
}

function cancelAnswer(kind) {
  return {
    confirmed: false,
    buttonNum: 1,
    value: "",
    checked: false,
    kind,
  };
}

function createController(win) {
  const pending = new Map(); // request -> { resolve, timer, kind }
  const controller = {
    __astraPageDialogs: true,
    windowId: "",
    /** Engine entry: one pending request, one wire event, one answer. */
    present(args, hint = {}) {
      const kind = pageDialogKind(args);
      if (kind === null) return null;
      controller.windowId = controller.windowId || windowIdOf(win);
      const request = `page-dialog-${++_nextRequest}-${Math.random()
        .toString(16)
        .slice(2, 10)}`;
      const payload = {
        kind,
        host:
          hostOf(hint.host) ||
          hostFromPrincipal(hint.principal ?? args.promptPrincipal) ||
          hostOf(hint.fallbackHost),
        title: textOf(args.title, MAX_LABEL),
        text: textOf(args.text, MAX_TEXT),
        defaultValue: kind === "prompt" ? textOf(args.value, MAX_TEXT) : "",
        checkboxLabel: textOf(args.checkLabel, MAX_LABEL),
        request,
      };
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!pending.delete(request)) return;
          // The app may still be showing it; clear the card as well.
          emit(EVENT, { request, closed: true });
          resolve(cancelAnswer(kind));
        }, _timeoutMs);
        pending.set(request, { resolve, timer, kind });
        emit(EVENT, payload);
      });
    },

    /** Settle one request raised in this controller. */
    answer({ request = "", confirmed = false, value = "", checked = false } = {}) {
      const record = pending.get(String(request));
      if (!record) return refuse("invalid_scope");
      pending.delete(String(request));
      clearTimeout(record.timer);
      const answer = {
        confirmed: confirmed === true,
        buttonNum: confirmed === true ? 0 : 1,
        value: record.kind === "prompt" ? textOf(value, MAX_TEXT) : "",
        checked: checked === true,
        kind: record.kind,
      };
      emit(EVENT, { request: String(request), closed: true });
      record.resolve(answer);
      return admit({ outcome: "applied", reason: "mutation_applied" });
    },

    dispose() {
      for (const [request, record] of pending) {
        clearTimeout(record.timer);
        record.resolve(cancelAnswer(record.kind));
        emit(EVENT, { request, closed: true });
      }
      pending.clear();
      _controllers.delete(controller);
      if (_own === controller) _own = null;
      try {
        if (win.__astraPageDialogs === controller) {
          delete win.__astraPageDialogs;
        }
      } catch {
        // A window that is already gone has nothing to clear.
      }
    },

    pending() {
      return [...pending.keys()];
    },
  };
  return controller;
}

function windowIdOf(win) {
  try {
    const direct = win?.__astraWindowId;
    if (typeof direct === "string" && direct !== "") return direct;
  } catch {
    // No expando: the shared window record still names it.
  }
  try {
    const ids = Services.astraWindows?.ids;
    const id = typeof ids?.get === "function" ? ids.get(win) : "";
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** The chrome window this module instance belongs to, if it is one. */
function ownChromeWindow() {
  try {
    const global = globalThis;
    if (global?.document && global.gBrowser) {
      return global;
    }
  } catch {
    // Node, a content document, or a window without gBrowser.
  }
  return null;
}

function controllerForAnswer(windowId) {
  // In the browser every chrome window has its own module instance, so the
  // controller installed here is the only one that may answer.
  if (_own) {
    if (windowId && _own.windowId && _own.windowId !== windowId) return null;
    return _own;
  }
  // Contract tests install several fake windows in one module instance; the
  // relay stamp selects exactly one of them.
  if (!windowId) return null;
  for (const controller of _controllers) {
    if (controller.windowId === windowId) return controller;
  }
  return null;
}

export const PageDialogs = {
  /** Publish this window's controller for the engine actor. */
  install({ window: win = null } = {}) {
    if (!win || typeof win !== "object") return false;
    if (win.__astraPageDialogs?.__astraPageDialogs) {
      const existing = win.__astraPageDialogs;
      _controllers.add(existing);
      if (!_own) _own = existing;
      return true;
    }
    const controller = createController(win);
    controller.windowId = windowIdOf(win);
    _controllers.add(controller);
    win.__astraPageDialogs = controller;
    if (!_own && win === ownChromeWindow()) _own = controller;
    try {
      win.addEventListener(
        "unload",
        () => PageDialogs.uninstall({ window: win }),
        { once: true }
      );
    } catch {
      // A preview object without a window still answers.
    }
    return true;
  },

  uninstall({ window: win = null } = {}) {
    if (!win) return false;
    const controller = win.__astraPageDialogs;
    if (!controller?.__astraPageDialogs) return false;
    controller.dispose();
    return true;
  },

  /** Route target for `page_dialog_answer`. */
  async answer({
    request = "",
    confirmed = false,
    value = "",
    checked = false,
    window_id = "",
  } = {}) {
    const controller = controllerForAnswer(
      typeof window_id === "string" ? window_id : ""
    );
    if (!controller) return refuse("invalid_scope");
    return controller.answer({ request, confirmed, value, checked });
  },

  /** Diagnostics/tests: requests still waiting in this module's windows. */
  pending() {
    return [..._controllers].map((controller) => ({
      window_id: controller.windowId,
      requests: controller.pending(),
    }));
  },

  __setTimeoutForTests(milliseconds) {
    _timeoutMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : TIMEOUT_MS;
  },

  __resetForTests() {
    for (const controller of [..._controllers]) controller.dispose();
    _controllers.clear();
    _own = null;
    _nextRequest = 0;
    _timeoutMs = TIMEOUT_MS;
  },
};

// The shell imports HostAPI inside the chrome document; Boot installs this
// window's controller from that import (see Boot.sys.mjs).

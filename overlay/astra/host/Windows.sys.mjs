/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Windows module (v1). Firefox owns live chrome windows; this
// module maps stable `window_id`s onto them and keeps the projection the UI
// reads. Tabs reference their window via `window_id` (`Tabs.create ...
// { window_id }`, default `win-1`). Closing a window closes its tabs through
// `Tabs.__closeTabsInWindow` and reports the ids.
//
// The module is importable by Node contract tests: when no chrome `Services`
// is present it keeps the model-only behaviour. In chrome it binds the
// current browser window to `win-1`, opens real windows through
// `BrowserWindowTracker`, and mirrors focus/fullscreen/close onto the native
// window. No parallel window map is allowed to become the truth: `get`/`list`
// sync the native state on every read.
//
// The binding is process-wide, not per module. `resource://` modules are
// loaded per chrome document, so every window gets its own copy of this
// module; keeping `_native`/`_windows` module-local made the second window
// call itself `win-1` as well and hid the first window's id from it (P2-1).
// `Services` is the one object all chrome documents share, so the record
// lives there — the same pattern `Boot` uses for the core. Node contract
// tests have no `Services` and keep the module-local record.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import { __closeTabsInWindow } from "./Tabs.sys.mjs";
import { bindClose } from "./Close.sys.mjs";

/**
 * One process-wide binding record:
 *   windows  window_id -> { window_id, focused, fullscreen, private, title }
 *   native   window_id -> chrome window
 *   ids      chrome window -> window_id
 *   next     next `win-N` number to hand out
 *   focused  the focused window_id ("" before the first bind)
 */
function emptyRecord() {
  return {
    windows: new Map(),
    native: new Map(),
    ids: new WeakMap(),
    next: 1,
    focused: "",
  };
}

const _local = emptyRecord();

function chromeServices() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

/** The shared record in chrome, the module record in Node tests. */
function recordOf() {
  const services = chromeServices();
  if (!services) return _local;
  try {
    let record = services.astraWindows;
    // Duck-typed, never `instanceof`: each chrome window is its own realm, so
    // `Map` from this document is not the constructor of another's Map.
    if (
      !record ||
      typeof record !== "object" ||
      typeof record.windows?.get !== "function" ||
      typeof record.native?.get !== "function"
    ) {
      record = emptyRecord();
      services.astraWindows = record;
    }
    return record;
  } catch {
    // A frozen Services object still leaves this window working on its own.
    return _local;
  }
}

function snapshot(id) {
  return recordOf().windows.get(id) ?? null;
}

/**
 * The process-wide id bound to a native chrome window, or "". Read-only:
 * `Metadata` uses it to order a merged capture without binding anything.
 */
export function __windowIdFor(win) {
  if (!win) return "";
  try {
    const id = recordOf().ids.get(win);
    return typeof id === "string" ? id : "";
  } catch {
    // Not a window object, or a WeakMap that refuses the key.
    return "";
  }
}

/**
 * The live chrome windows this process has bound, newest read of the shared
 * record. `Metadata` walks this to merge every window's tab model; a
 * `WeakMap` cannot be enumerated on every runtime (Node's `WeakMap` has no
 * `forEach`), and the bound windows are the keys of `Services.astraHosts`.
 */
export function __nativeWindows() {
  const record = recordOf();
  const found = [];
  for (const [id, win] of [...record.native]) {
    if (!win || win.closed === true) {
      record.native.delete(id);
      continue;
    }
    found.push(win);
  }
  return found;
}

function currentChromeWindow() {
  try {
    return chromeServices()?.wm?.getMostRecentWindow("navigator:browser") ?? null;
  } catch {
    return null;
  }
}

function isPrivateWindow(win) {
  try {
    if (win?.PrivateBrowsingUtils?.isWindowPrivate?.(win) === true) {
      return true;
    }
  } catch {
    // Fall through to the module/document marker.
  }
  try {
    const CU = globalThis.ChromeUtils;
    if (CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      if (PrivateBrowsingUtils.isWindowPrivate(win) === true) {
        return true;
      }
    }
  } catch {
    // A chrome that refuses the module keeps the document marker.
  }
  try {
    return (
      win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary"
    );
  } catch {
    return false;
  }
}

function nativeOf(id) {
  const record = recordOf();
  const win = record.native.get(id) ?? null;
  if (win && win.closed === true) {
    record.native.delete(id);
    return null;
  }
  return win;
}

async function openNativeWindow(isPrivate) {
  const CU = globalThis.ChromeUtils;
  if (!CU) {
    return null;
  }
  try {
    const { BrowserWindowTracker } = CU.importESModule(
      "resource:///modules/BrowserWindowTracker.sys.mjs",
    );
    const win = await BrowserWindowTracker.openWindow({
      private: isPrivate === true,
      openerWindow: currentChromeWindow() ?? undefined,
    });
    return win ?? null;
  } catch {
    return null;
  }
}

/** Attach an unload handler once, so a native close updates the projection. */
function bindNative(id, win, { replace = false } = {}) {
  const record = recordOf();
  if (!win || (!replace && record.native.has(id))) {
    return;
  }
  record.native.set(id, win);
  // Ask the app to flush before the window goes (Close.sys.mjs). Bound before
  // the projection listener, so the handshake sees the close first.
  bindClose(win);
  const model = record.windows.get(id);
  if (model) {
    model.private = isPrivateWindow(win);
  }
  try {
    record.ids.set(win, id);
  } catch {
    // A window without an expando still works through the map.
  }
  try {
    win.addEventListener(
      "close",
      () => {
        // Re-read the record: this listener outlives the call that bound it,
        // and the shared record is the truth from any window's module.
        const live = recordOf();
        if (live.native.get(id) !== win) {
          return;
        }
        live.native.delete(id);
        const tabsClosed = __closeTabsInWindow(id);
        const existed = live.windows.delete(id);
        if (existed) {
          emit("window.closed", { window_id: id, tabs_closed: tabsClosed });
        }
        if (live.focused === id) {
          live.focused = "";
          const first = live.windows.keys().next();
          if (!first.done) {
            focusInternal(first.value);
          }
        }
      },
      { once: true },
    );
  } catch {
    // A window that refuses listeners still closes through the model.
  }
}

/**
 * Bind the shell's own window to `win-1`. The shell calls this once at boot;
 * `getMostRecentWindow` is not reliable during startup (the new window may be
 * the most recent before the original is bound) and must never steal `win-1`.
 */
export function __bindCurrentWindow(win) {
  if (!win) {
    return "";
  }
  const record = recordOf();
  // A window keeps its identity for its whole life. Binding the same native
  // window again is a read, never a rebind.
  const bound = record.ids.get(win);
  if (bound && record.native.get(bound) === win && win.closed !== true) {
    return bound;
  }
  // Drop ids whose native window is gone, then reuse `win-1` only when no
  // live window owns it — in this process, across every window's module.
  for (const [candidate, native] of [...record.native]) {
    if (native?.closed === true) {
      record.native.delete(candidate);
      record.windows.delete(candidate);
      record.ids.delete(native);
    }
  }
  let id = "";
  for (const [candidate, native] of record.native) {
    if (native === win) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    const first = record.native.get("win-1");
    if (!first || first.closed === true) {
      id = "win-1";
    } else {
      do {
        id = `win-${record.next++}`;
      } while (record.windows.has(id) || record.native.has(id));
    }
  }
  if (!record.windows.has(id)) {
    record.windows.set(id, {
      window_id: id,
      focused: record.focused === "",
      fullscreen: false,
      private: isPrivateWindow(win),
      title: "Astra",
    });
    if (record.focused === "") {
      record.focused = id;
    }
    emit("window.created", { window_id: id, private: isPrivateWindow(win) });
  }
  bindNative(id, win, { replace: true });
  return id;
}

/** Read native state back into the projection before answering. */
function syncNative(id) {
  const win = nativeOf(id);
  if (!win) {
    return;
  }
  const model = recordOf().windows.get(id);
  if (model) {
    model.private = isPrivateWindow(win);
    try {
      model.fullscreen = win.fullScreen === true;
    } catch {
      // A closing window may refuse the read.
    }
  }
}

function focusInternal(id) {
  const record = recordOf();
  for (const w of record.windows.values()) {
    w.focused = w.window_id === id;
  }
  record.focused = id;
  try {
    nativeOf(id)?.focus?.();
  } catch {
    // A window that cannot focus still updates the projection.
  }
  emit("window.focused", { window_id: id });
}

// Ensures the default window exists (Boot.handshake and first use call
// this). Idempotent. In chrome the current window is bound to `win-1`.
export function __ensureDefaultWindow() {
  const record = recordOf();
  // Only an empty process gets the default window. Once something is bound,
  // `win-1` belongs to that window: recreating it after the window closes
  // would hand `win-1` to a different window whose model still names `win-2`.
  if (record.windows.size === 0) {
    record.windows.set("win-1", {
      window_id: "win-1",
      focused: true,
      fullscreen: false,
      private: false,
      title: "Astra",
    });
    record.focused = "win-1";
    emit("window.created", { window_id: "win-1", private: false });
  }
  if (!record.native.has("win-1")) {
    const win = currentChromeWindow();
    // Never steal a window that already answers to another id.
    if (win && __windowIdFor(win) === "") {
      bindNative("win-1", win);
    }
  }
  return record.windows.has("win-1") ? "win-1" : record.focused;
}

export const Windows = {
  async create({ request_id = "", private: isPrivate = false, background = false, title = "" } = {}) {
    __ensureDefaultWindow();
    const real = await openNativeWindow(isPrivate);
    if (!real && chromeServices()) {
      return err(request_id, "window_create_failed", "the chrome window did not open");
    }
    const record = recordOf();
    const window_id = `win-${++record.next}`;
    record.windows.set(window_id, {
      window_id,
      focused: false,
      fullscreen: false,
      private: isPrivate === true,
      title: typeof title === "string" ? title : "",
    });
    if (real) {
      bindNative(window_id, real);
    }
    emit("window.created", { window_id, private: isPrivate === true });
    if (!background) {
      focusInternal(window_id);
    }
    return ok(request_id, { window_id, private: isPrivate === true });
  },

  async close({ request_id = "", window_id = "" } = {}) {
    const record = recordOf();
    if (!record.windows.has(window_id)) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    const real = nativeOf(window_id);
    if (record.windows.size <= 1 && !real) {
      return err(request_id, "last_window", "refusing to close the last window");
    }
    const wasFocused = window_id === record.focused;
    const tabsClosed = __closeTabsInWindow(window_id);
    record.windows.delete(window_id);
    record.native.delete(window_id);
    emit("window.closed", { window_id, tabs_closed: tabsClosed });
    if (wasFocused) {
      record.focused = "";
      const first = record.windows.keys().next();
      if (!first.done) {
        focusInternal(first.value);
      }
    }
    try {
      real?.close?.();
    } catch {
      // The window may already be closing.
    }
    return ok(request_id, { closed: true, window_id, tabs_closed: tabsClosed });
  },

  async focus({ request_id = "", window_id = "" } = {}) {
    if (!recordOf().windows.has(window_id)) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    focusInternal(window_id);
    return ok(request_id, { window_id, focused: true });
  },

  async setFullscreen({ request_id = "", window_id = "", fullscreen = true } = {}) {
    const win = recordOf().windows.get(window_id);
    if (!win) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    const real = nativeOf(window_id);
    if (real) {
      try {
        real.fullScreen = fullscreen === true;
      } catch {
        // A closing window keeps the model answer.
      }
    }
    win.fullscreen = real ? real.fullScreen === true : fullscreen === true;
    emit("window.fullscreen-changed", { window_id, fullscreen: win.fullscreen });
    return ok(request_id, { window_id, fullscreen: win.fullscreen });
  },

  async setTitle({ request_id = "", window_id = "", title = "" } = {}) {
    const win = recordOf().windows.get(window_id);
    if (!win) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    if (typeof title !== "string") {
      return err(request_id, "invalid_title", "title must be a string");
    }
    win.title = title;
    return ok(request_id, { window_id, title });
  },

  async get({ request_id = "", window_id = "" } = {}) {
    syncNative(window_id);
    const win = snapshot(window_id);
    if (!win) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    return ok(request_id, { window: { ...win } });
  },

  async list({ request_id = "" } = {}) {
    __ensureDefaultWindow();
    const record = recordOf();
    for (const id of [...record.windows.keys()]) {
      syncNative(id);
    }
    return ok(request_id, {
      windows: [...record.windows.values()].map((w) => ({ ...w })),
      focused_window_id: record.focused,
    });
  },
};

// Test-only reset so contract tests start from a clean slate. Native windows
// are not closed: tests never create them.
export function __resetWindowsForTests() {
  for (const record of [_local, recordOf()]) {
    if (!record) continue;
    record.windows.clear();
    record.native.clear();
    record.ids = new WeakMap();
    record.next = 1;
    record.focused = "";
  }
}

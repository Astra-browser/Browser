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

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION, __closeTabsInWindow } from "./Tabs.sys.mjs";

const _windows = new Map(); // window_id -> { window_id, focused, fullscreen, private, title }
const _native = new Map(); // window_id -> chrome window
let _nativeIds = new WeakMap(); // chrome window -> window_id
let _nextId = 1;
let _focusedId = "";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function snapshot(id) {
  return _windows.get(id) ?? null;
}

function chromeServices() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

function currentChromeWindow() {
  try {
    return chromeServices()?.wm?.getMostRecentWindow("navigator:browser") ?? null;
  } catch {
    return null;
  }
}

function nativeOf(id) {
  const win = _native.get(id) ?? null;
  if (win && win.closed === true) {
    _native.delete(id);
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
    const win = await BrowserWindowTracker.openWindow({ private: isPrivate === true });
    return win ?? null;
  } catch {
    return null;
  }
}

/** Attach an unload handler once, so a native close updates the projection. */
function bindNative(id, win, { replace = false } = {}) {
  if (!win || (!replace && _native.has(id))) {
    return;
  }
  _native.set(id, win);
  try {
    _nativeIds.set(win, id);
  } catch {
    // A window without an expando still works through the map.
  }
  try {
    win.addEventListener(
      "close",
      () => {
        _native.delete(id);
        const existed = _windows.delete(id);
        if (existed) {
          emit("window.closed", { window_id: id, tabs_closed: 0 });
        }
        if (_focusedId === id) {
          _focusedId = "";
          const first = _windows.keys().next();
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
    return false;
  }
  const existing = _native.get("win-1");
  // A second window's shell may share this module instance. Never let it
  // steal win-1 from the window that already owns it.
  if (existing && existing !== win && existing.closed !== true) {
    return false;
  }
  bindNative("win-1", win, { replace: true });
  return true;
}

/** Read native state back into the projection before answering. */
function syncNative(id) {
  const win = nativeOf(id);
  if (!win) {
    return;
  }
  const model = _windows.get(id);
  if (model) {
    try {
      model.fullscreen = win.fullScreen === true;
    } catch {
      // A closing window may refuse the read.
    }
  }
}

function focusInternal(id) {
  for (const w of _windows.values()) {
    w.focused = w.window_id === id;
  }
  _focusedId = id;
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
  if (!_windows.has("win-1")) {
    _windows.set("win-1", {
      window_id: "win-1",
      focused: _focusedId === "",
      fullscreen: false,
      private: false,
      title: "Astra",
    });
    if (_focusedId === "") {
      _focusedId = "win-1";
    }
    emit("window.created", { window_id: "win-1", private: false });
  }
  if (!_native.has("win-1")) {
    const win = currentChromeWindow();
    if (win) {
      bindNative("win-1", win);
    }
  }
  return "win-1";
}

export const Windows = {
  async create({ request_id = "", private: isPrivate = false, background = false, title = "" } = {}) {
    __ensureDefaultWindow();
    const real = await openNativeWindow(isPrivate);
    const window_id = `win-${++_nextId}`;
    _windows.set(window_id, {
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
    if (!_windows.has(window_id)) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    if (_windows.size <= 1) {
      return err(request_id, "last_window", "refusing to close the last window");
    }
    const real = nativeOf(window_id);
    const wasFocused = window_id === _focusedId;
    const tabsClosed = __closeTabsInWindow(window_id);
    _windows.delete(window_id);
    _native.delete(window_id);
    emit("window.closed", { window_id, tabs_closed: tabsClosed });
    if (wasFocused) {
      _focusedId = "";
      const first = _windows.keys().next();
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
    if (!_windows.has(window_id)) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    focusInternal(window_id);
    return ok(request_id, { window_id, focused: true });
  },

  async setFullscreen({ request_id = "", window_id = "", fullscreen = true } = {}) {
    const win = _windows.get(window_id);
    if (!win) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    // The owning shell applies `window.fullScreen` to its own window when it
    // sees this event. Setting it here would hit whichever window this module
    // instance is bound to and could fullscreen the wrong one.
    win.fullscreen = fullscreen === true;
    emit("window.fullscreen-changed", { window_id, fullscreen: win.fullscreen });
    return ok(request_id, { window_id, fullscreen: win.fullscreen });
  },

  async setTitle({ request_id = "", window_id = "", title = "" } = {}) {
    const win = _windows.get(window_id);
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
    for (const id of [..._windows.keys()]) {
      syncNative(id);
    }
    return ok(request_id, {
      windows: [..._windows.values()].map((w) => ({ ...w })),
      focused_window_id: _focusedId,
    });
  },
};

// Test-only reset so contract tests start from a clean slate. Native windows
// are not closed: tests never create them.
export function __resetWindowsForTests() {
  _windows.clear();
  _native.clear();
  _nativeIds = new WeakMap();
  _nextId = 1;
  _focusedId = "";
}

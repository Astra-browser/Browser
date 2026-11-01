/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Windows module (v1). Firefox owns live chrome windows; this
// module owns the *model*: stable `window_id`s, focus, fullscreen and
// private state. Tabs reference their window via `window_id`
// (`Tabs.create ... { window_id }`, default `win-1`). Closing a window
// closes its tabs through `Tabs.__closeTabsInWindow` and reports the ids.
// Pure logic, no Firefox internals. The live binding (`win.focus()`,
// `window.fullScreen`, private `openWindowInfo`) lives in the chrome
// shell and mirrors these ops; see docs/astra/HOST_API_v1.md.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION, __closeTabsInWindow } from "./Tabs.sys.mjs";

const _windows = new Map(); // window_id -> { window_id, focused, fullscreen, private, title }
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

function focusInternal(id) {
  for (const w of _windows.values()) {
    w.focused = w.window_id === id;
  }
  _focusedId = id;
  emit("window.focused", { window_id: id });
}

// Ensures the default window exists (Boot.handshake and first use call
// this). Idempotent.
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
  return "win-1";
}

export const Windows = {
  async create({ request_id = "", private: isPrivate = false, background = false, title = "" } = {}) {
    __ensureDefaultWindow();
    const window_id = `win-${++_nextId}`;
    _windows.set(window_id, {
      window_id,
      focused: false,
      fullscreen: false,
      private: isPrivate === true,
      title: typeof title === "string" ? title : "",
    });
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
    const wasFocused = window_id === _focusedId;
    const tabsClosed = __closeTabsInWindow(window_id);
    _windows.delete(window_id);
    emit("window.closed", { window_id, tabs_closed: tabsClosed });
    if (wasFocused) {
      _focusedId = "";
      const first = _windows.keys().next();
      if (!first.done) {
        focusInternal(first.value);
      }
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
    const win = snapshot(window_id);
    if (!win) {
      return err(request_id, "no_such_window", `unknown window ${window_id}`);
    }
    return ok(request_id, { window: { ...win } });
  },

  async list({ request_id = "" } = {}) {
    __ensureDefaultWindow();
    return ok(request_id, {
      windows: [..._windows.values()].map((w) => ({ ...w })),
      focused_window_id: _focusedId,
    });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetWindowsForTests() {
  _windows.clear();
  _nextId = 1;
  _focusedId = "";
}

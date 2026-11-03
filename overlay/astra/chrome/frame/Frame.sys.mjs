/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Astra window-frame chrome binding (P3-T03, Linux first).
//
// Owns two things the Host API model deliberately does not:
//   1. Drag-region reporting — which frame elements participate in native
//      window dragging (`-moz-window-dragging: drag`) vs opt out
//      (`no-drag`). Read back via getComputedStyle so contract tests assert
//      the *effective* style, not the stylesheet text.
//   2. Window-control dispatch — titlebar buttons route through the Host
//      API Windows module (`close`, `setFullscreen`, `setTitle`, `get`);
//      minimize/maximize/restore are chrome-window ops with no Host API
//      equivalent, so they go through an injected `chrome` adapter
//      (`{ minimize, maximize, restore }`) that the live shell wires to
//      the DOM window and tests fake.
//
// Pure logic: no Firefox globals at import time. `doc`/`win` are passed in
// so the same module imports in Node contract tests with fakes and in the
// chrome window with the live document.

export const FRAME_VERSION = 1;

// Window-control actions. `close` and `toggle-fullscreen` dispatch through
// the Host API; the rest need the chrome adapter.
export const WINDOW_ACTIONS = Object.freeze([
  "minimize",
  "maximize",
  "restore",
  "close",
  "toggle-fullscreen",
]);

// Selectors (scoped under #astra-root by convention; kept relative so
// tests can mount the frame in any container).
export const SELECTORS = Object.freeze({
  frame: "[data-astra-frame]",
  titlebar: "[data-astra-titlebar]",
  windowControls: "[data-astra-window-controls]",
  controlButton: "[data-astra-window-controls] [data-action]",
  sidebar: "[data-astra-sidebar]",
  toolbar: "[data-astra-toolbar]",
});

/**
 * Report the effective drag participation of every notable frame element.
 *
 * @param {Document} doc - frame document (live or fake).
 * @param {Window} win - window for getComputedStyle (live or fake).
 * @returns {{ version: number, regions: Array<{role, selector, dragging, rect}> }}
 *   `dragging` is the computed `-moz-window-dragging` value (`drag`,
 *   `no-drag`, or `""` where the property is unknown, e.g. plain Node
 *   fakes). `rect` is the bounding client rect or null when unavailable.
 */
export function reportDragRegions(doc, win) {
  const roles = [
    ["titlebar", SELECTORS.titlebar],
    ["window-controls", SELECTORS.windowControls],
    ["sidebar", SELECTORS.sidebar],
    ["toolbar", SELECTORS.toolbar],
  ];
  const regions = [];
  for (const [role, selector] of roles) {
    const el = doc.querySelector(selector);
    if (!el) {
      regions.push({ role, selector, dragging: "missing", rect: null });
      continue;
    }
    let dragging = "";
    try {
      const cs = win.getComputedStyle(el);
      dragging =
        typeof cs.getPropertyValue === "function"
          ? cs.getPropertyValue("-moz-window-dragging").trim()
          : (cs["-moz-window-dragging"] ?? "").trim();
    } catch {
      dragging = "";
    }
    let rect = null;
    try {
      const r = el.getBoundingClientRect();
      rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    } catch {
      rect = null;
    }
    regions.push({ role, selector, dragging, rect });
  }
  // Per-button opt-out: every window-control button must be no-drag so
  // clicks reach the button instead of moving the window.
  const buttons = [...doc.querySelectorAll(SELECTORS.controlButton)];
  for (const btn of buttons) {
    let dragging = "";
    try {
      const cs = win.getComputedStyle(btn);
      dragging =
        typeof cs.getPropertyValue === "function"
          ? cs.getPropertyValue("-moz-window-dragging").trim()
          : (cs["-moz-window-dragging"] ?? "").trim();
    } catch {
      dragging = "";
    }
    regions.push({
      role: "control-button",
      selector: `${SELECTORS.controlButton}[${btn.getAttribute("data-action")}]`,
      dragging,
      rect: null,
    });
  }
  return { version: FRAME_VERSION, regions };
}

/**
 * Dispatch a titlebar window-control action.
 *
 * @param {object} host - Host API (`{ Windows }` from HostAPI.sys.mjs).
 * @param {object|null} chrome - chrome-window adapter
 *   (`{ minimize(), maximize(), restore() }`) or null.
 * @param {object} opts - `{ action, window_id, request_id }`.
 * @returns {Promise<object>} Host API envelope (or a same-shaped error for
 *   chrome-only ops without an adapter).
 */
export async function dispatchWindowControl(host, chrome, opts = {}) {
  const { action = "", window_id = "", request_id = "" } = opts;
  if (!WINDOW_ACTIONS.includes(action)) {
    return {
      request_id,
      host_api_version: 1,
      error: { code: "invalid_window_action", message: `unknown action ${action}` },
    };
  }
  if (typeof window_id !== "string" || window_id === "") {
    return {
      request_id,
      host_api_version: 1,
      error: { code: "no_such_window", message: "window_id is required" },
    };
  }
  switch (action) {
    case "close":
      return host.Windows.close({ request_id, window_id });
    case "toggle-fullscreen": {
      const cur = await host.Windows.get({ request_id, window_id });
      if (cur?.error) {
        return cur;
      }
      return host.Windows.setFullscreen({
        request_id,
        window_id,
        fullscreen: !(cur.window?.fullscreen === true),
      });
    }
    case "minimize":
    case "maximize":
    case "restore": {
      if (!chrome || typeof chrome[action] !== "function") {
        return {
          request_id,
          host_api_version: 1,
          error: {
            code: "unsupported_chrome_op",
            message: `${action} needs a chrome-window adapter`,
          },
        };
      }
      chrome[action]();
      return { request_id, host_api_version: 1, window_id, action, dispatched: true };
    }
    default:
      return {
        request_id,
        host_api_version: 1,
        error: { code: "invalid_window_action", message: `unknown action ${action}` },
      };
  }
}

/**
 * Decide CSD vs SSD mode for the frame. The live shell passes
 * `win.matchMedia("(-moz-gtk-csd-available)").matches` (the same gate
 * Firefox's own customtitlebar uses); tests pass either boolean.
 *
 * @returns {"csd"|"ssd"}
 */
export function csdMode(csdAvailable) {
  return csdAvailable === true ? "csd" : "ssd";
}

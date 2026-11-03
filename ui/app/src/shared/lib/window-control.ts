/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Window actions for the product's own window, behind one call so the chrome
 * never reaches for a window API directly.
 *
 * In Firefox the app is a first-party `chrome://astra/` document inside the
 * shell page, which exposes the Host API's Frame dispatch on
 * `__astraHost` — that already owns minimize / maximize / restore / close
 * (`overlay/astra/chrome/frame/Frame.sys.mjs`). This adds no host route and no
 * new wire command: when the seam is absent (standalone preview, tests, a
 * torn-down window) the action is a no-op, like every other unwired control in
 * this phase.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowAction = "minimize" | "maximize" | "restore" | "close";

type HostFrame = {
  dispatchWindowControl?: (opts: { action: string }) => Promise<unknown>;
};

/** Firefox's `nsIDOMWindow.windowState`: 0 normal, 1 maximized, 2 minimized,
 *  3 fullscreen. (A minimized window is not a maximized one.) */
const MAXIMIZED = 1;

function hostFrame(): HostFrame | null {
  try {
    const parent = window.parent as unknown as { __astraHost?: { Frame?: HostFrame } };
    // Same document means there is no shell to ask.
    if (parent === window) return null;
    return parent.__astraHost?.Frame ?? null;
  } catch {
    return null;
  }
}

/** Whether the window is maximized, asked of the chrome window itself. */
export function maximized(): boolean {
  try {
    const parent = window.parent as unknown as { windowState?: number };
    if (parent !== window && typeof parent.windowState === "number") {
      return parent.windowState === MAXIMIZED;
    }
  } catch {
    // A window we cannot ask is treated as restored.
  }
  return false;
}

export function windowAction(action: WindowAction): void {
  // Closing the product's own window is a chrome-window op, not a Host API
  // model op: `Windows.close` refuses the last window on purpose, so routing
  // close through it made the close control dead in the only window there is.
  if (action === "close") {
    try {
      const parent = window.parent as Window;
      if (parent !== window && typeof parent?.close === "function") {
        parent.close();
        return;
      }
    } catch {
      // No chrome parent: fall through to the standalone path.
    }
  }
  const frame = hostFrame();
  if (frame?.dispatchWindowControl) {
    void frame.dispatchWindowControl({ action }).catch(() => {});
    return;
  }
  try {
    const win = getCurrentWindow() as unknown as Record<string, unknown>;
    const fn = action === "maximize" ? win.toggleMaximize : win[action];
    if (typeof fn === "function") {
      void (fn as () => Promise<void>).call(win).catch(() => {});
    }
  } catch {
    // No window to act on.
  }
}

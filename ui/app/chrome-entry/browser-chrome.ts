/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P3-T21 chrome entry: the real app, running as a first-party chrome document.
//
// The page is packaged at `chrome://astra/content/app/browser-chrome.html`
// (jar.mn) and embedded by the shell in a chrome-privileged iframe. Same
// principal, same process: the bridge imports the Host API directly through
// `resource://astra/host/HostAPI.sys.mjs` — no relay, no nonce, no `file://`
// browser, no framescript.
//
// Two boot paths:
//   - Embedded (`chrome:` document): HOST mode over the Host API modules.
//   - Standalone (dev preview, goldens, a plain tab): the existing mode
//     detection applies (`ensureBridge`: MOCK for `file:`/`http(s):`/`about:`
//     and `?astra-mock=1`), so the same bundle still runs outside the browser.
//
// The document title doubles as a cross-document status line for the shell
// (and for live suites): `Astra` once mounted, `Astra unavailable: …` on
// failure.

import { getCurrentWindow, setWindowLabel } from "@astra/bridge";
import type { Bridge } from "@astra/bridge";
import { ensureBridge } from "$shared/ipc/bridge.js";
import { mount, flushSync } from "svelte";
import App from "$app/browser/BrowserApp.svelte";

const SURFACE = "browser-chrome";
const SHELL_NS = "astra-shell";

/** Announce readiness to the embedding shell (no-op standalone). */
function announce(bridge: Bridge): void {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ ns: SHELL_NS, kind: "ready", mode: bridge.mode }, "*");
    }
  } catch {
    // No shell to tell; the app still runs.
  }
}

function fail(message: string, error: unknown): void {
  console.error("[astra-chrome-entry]", message, error);
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ ns: SHELL_NS, kind: "error", message }, "*");
    }
  } catch {
    // No shell to report to.
  }
  const target = document.getElementById("root");
  if (target instanceof HTMLElement) {
    target.innerHTML = "";
    const doc = target.ownerDocument;
    try {
      doc.title = `Astra unavailable: ${message.slice(0, 120)}`;
    } catch {
      // Title update is best-effort; the alert below is the real signal.
    }
    const box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("class", "slot-error");
    const stack = error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    box.textContent = `Astra unavailable: ${message}${stack.slice(0, 600)}`;
    target.appendChild(box);
  }
}

try {
  document.title = "Astra [entry]";
  setWindowLabel(SURFACE);

  const bridge = await ensureBridge(SURFACE, window.location.search);
  if (getCurrentWindow().label !== SURFACE) {
    throw new Error("unexpected native surface");
  }

  const target = document.getElementById("root");
  if (!(target instanceof HTMLElement)) {
    throw new Error("trusted UI root is unavailable");
  }
  // Test seam (live suites + SHELL_APP.md): which bridge mode actually booted.
  target.dataset.bridgeMode = bridge.mode;

  // --- Bridge events → the DOM channels the app listens on -----------------
  // In the Tauri build Rust dispatches `astra:*` CustomEvents into the
  // webview, so `native-events.ts` subscribes to `window`. Re-dispatch the
  // bridge bus onto those same channels; the app code stays untouched.
  const DOM_CHANNELS: Record<string, string> = {
    "items-changed": "astra:items",
    "ui-command": "astra:ui-command",
    "operation-processed": "astra:operation-processed",
    "runtime-status-changed": "astra:runtime-status",
    "blocker-status-changed": "astra:blocker-status",
    "focus-changed": "astra:focus",
    "downloads-changed": "astra:downloads-changed",
    "search-changed": "astra:search",
    "layout-changed": "astra:layout",
    "profiles-changed": "astra:profiles",
    "notes-changed": "astra:notes-changed",
  };
  for (const [wire, dom] of Object.entries(DOM_CHANNELS)) {
    bridge.listen(wire, (event) => {
      window.dispatchEvent(new CustomEvent(dom, { detail: event.payload }));
    });
  }

  try {
    document.title = "Astra";
  } catch {
    // Title is best-effort diagnostics; the mount below is the real work.
  }
  mount(App, { target });
  // The presentation barrier observes this DOM synchronously.
  flushSync();
  announce(bridge);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), error);
}

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
import { ensureBridge, framedInShell } from "$shared/ipc/bridge.js";
import { shouldOpenOnboarding } from "$features/welcome/lib/first-run";
import { mount, flushSync } from "svelte";
import App from "$app/browser/BrowserApp.svelte";

const SURFACE = "browser-chrome";
const SHELL_NS = "astra-shell";
/** The shell hands over its ready hook (P3-T23). */
const READY_HOOK = "__ASTRA_READY__";
/** The first-run document staged beside this one (vite.onboarding.config.ts). */
const ONBOARDING_PAGE = "./onboarding.html";

/** The frame is leaving for onboarding; not a failure. */
class Navigating extends Error {}

/**
 * True only in a private window. Chrome documents expose
 * `PrivateBrowsingUtils`; the parent document's marker covers a build without
 * it. A private window never shows onboarding and never records it.
 */
function inPrivateWindow(): boolean {
  try {
    if (document.documentElement.getAttribute("privatebrowsingmode") === "temporary") return true;
  } catch {
    // No marker to read.
  }
  try {
    const parent = window.parent;
    if (parent && parent !== window) {
      if (parent.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary")
        return true;
    }
  } catch {
    // A parent that refuses the read keeps the marker check below.
  }
  try {
    const chrome = globalThis as unknown as {
      ChromeUtils?: {
        importESModule: (id: string) => {
          PrivateBrowsingUtils?: { isWindowPrivate: (win: Window) => boolean };
        };
      };
    };
    const pbu = chrome.ChromeUtils?.importESModule(
      "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    )?.PrivateBrowsingUtils;
    return pbu?.isWindowPrivate((window.parent ?? window) as Window) === true;
  } catch {
    return false;
  }
}

/** Announce readiness to the embedding shell (no-op standalone). */
function announce(bridge: Bridge): void {
  try {
    // In-tree mount (P3-T23): the shell installs `__ASTRA_READY__` before it
    // imports this module. Same document, same principal — no relay.
    const hook = (globalThis as Record<string, unknown>)[READY_HOOK];
    if (typeof hook === "function") {
      (hook as (mode: string) => void)(bridge.mode);
      return;
    }
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ ns: SHELL_NS, kind: "ready", mode: bridge.mode }, "*");
    }
  } catch {
    // No shell to tell; the app still runs.
  }
}

/** Tell the shell which light/dark the app chose, now and on every change.
 *  Web pages follow it through `layout.css.prefers-color-scheme`. */
function announceTheme(): void {
  try {
    if (!window.parent || window.parent === window) return;
    const theme = document.documentElement.getAttribute("data-theme");
    if (theme !== "light" && theme !== "dark") return;
    window.parent.postMessage({ ns: SHELL_NS, kind: "theme", theme }, "*");
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
    target.style.opacity = "";
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
    const stack =
      error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    box.textContent = `Astra unavailable: ${message}${stack.slice(0, 600)}`;
    target.appendChild(box);
  }
}

try {
  document.title = "Astra [entry]";
  setWindowLabel(SURFACE);
  // Boot diagnostics (cheap dataset stamps; read by the startup probes).
  const bootMark = (name: string) => {
    try {
      document.documentElement.dataset[name] = String(Math.round(performance.now()));
    } catch {
      // Diagnostics only.
    }
  };
  bootMark("astraEntry");

  const bridge = await ensureBridge(SURFACE, window.location.search);
  bootMark("astraBridge");
  // Probe seam: the live route table, not a direct Host module call. Chrome
  // code already has this capability; it adds no new privilege.
  try {
    (window as unknown as Record<string, unknown>).__astraInvoke = (
      name: string,
      args: Record<string, unknown> = {},
    ) => bridge.invoke(name, args);
  } catch {
    // A locked-down window keeps the app; the probe reports the missing seam.
  }
  if (getCurrentWindow().label !== SURFACE) {
    throw new Error("unexpected native surface");
  }

  const target = document.getElementById("root");
  if (!(target instanceof HTMLElement)) {
    throw new Error("trusted UI root is unavailable");
  }

  // First run: the profile has not finished onboarding, so this frame hands
  // itself to the standalone onboarding document before any browser UI
  // mounts. The host decides nothing here it cannot undo: completion lives in
  // the settings store, and `Boot.onboardingFinish` marks it and points the
  // frame back at this page. A private window never opens the flow. An
  // unreadable store fails open, as `isFirstRun` does.
  if (bridge.mode === "host" && framedInShell()) {
    const completed = await bridge
      .invoke<string | null>("setting_get", { key: "onboarding.completed" })
      .catch(() => null);
    // The host owns the rule (private windows, an automation profile, an
    // explicit force). Its answer is authoritative; the local rule is only the
    // fallback for a build with no host route.
    const decision = await bridge
      .invoke<{ open: boolean; reason: string } | null>("onboarding_pending")
      .catch(() => null);
    const open =
      decision !== null && typeof decision?.open === "boolean"
        ? decision.open
        : shouldOpenOnboarding(completed, inPrivateWindow());
    if (open) {
      try {
        document.documentElement.dataset.astraFirstRun = "1";
      } catch {
        // Diagnostics only.
      }
      window.location.replace(ONBOARDING_PAGE);
      throw new Navigating();
    }
  }

  // Test seam (live suites + SHELL_APP.md): which bridge mode actually booted,
  // and whether it reaches the shell's Host API over the relay or its own.
  target.dataset.bridgeMode = bridge.mode;
  target.dataset.bridgePath = framedInShell() ? "relay" : "direct";

  // First-paint gate (P3-T22): the window must never show a half-built chrome.
  // The app mounts immediately but stays invisible until its first projection
  // (sidebar Space section, tab rows, essentials target) has been applied, so
  // the first visible frame is the finished UI — no late sections popping in.
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    target.style.opacity = "";
    // Perf seam: when the first complete frame became visible, in document
    // time. Live suites assert it stays inside the boot budget.
    try {
      document.documentElement.dataset.astraReveal = String(Math.round(performance.now()));
    } catch {
      // Diagnostics only.
    }
    announce(bridge);
  };
  // Everything the person sees in the first frame must already be there and
  // settled: the Space bar (with its label), the tab row (with its title), the
  // essentials drop target and the account foot. The sidebar can render an
  // empty shell first and fill in a pass later, so require the condition to
  // hold for three consecutive frames before showing anything.
  const sectionsReady = () => {
    const bar = target.querySelector(".space-bar");
    const row = target.querySelector("[data-astra-tab-id]");
    const hasBar = !!bar && (bar.textContent ?? "").includes("Space");
    const hasRow = !!row && (row.textContent ?? "").trim().length > 0;
    const hasEssentials = !!target.querySelector("[data-essentials-drop]");
    const hasShelf = !!target.querySelector(".shelf .case");
    if (hasBar) bootMark("astraBar");
    if (hasRow) bootMark("astraRow");
    if (hasEssentials) bootMark("astraEssentials");
    if (hasShelf) bootMark("astraShelf");
    const ready = hasBar && hasRow && hasEssentials && hasShelf;
    if (ready) bootMark("astraSections");
    return ready;
  };
  let gateTimer = 0;
  let stable = 0;
  let itemsSeen = false;
  const waitForStablePaint = () => {
    if (revealed) return;
    requestAnimationFrame(() => {
      stable = sectionsReady() ? stable + 1 : 0;
      if (stable >= 3) {
        reveal();
        return;
      }
      gateTimer = window.setTimeout(waitForStablePaint, 32);
    });
  };
  // `visibility` would leak: a descendant can set `visibility: visible` and
  // paint through it (measured — the sidebar did). `opacity` composites the
  // whole subtree and cannot be overridden by children, while still laying
  // out normally (the app measures its own box).
  target.style.opacity = "0";

  try {
    document.title = "Astra";
  } catch {
    // Title is best-effort diagnostics; the mount below is the real work.
  }
  // --- Bridge events → the DOM channels the app listens on -----------------
  // In the Tauri build Rust dispatches `astra:*` CustomEvents into the
  // webview, so `native-events.ts` subscribes to `window`. Re-dispatch the
  // bridge bus onto those same channels; the app code stays untouched.
  const DOM_CHANNELS: Record<string, string> = {
    "items-changed": "astra:items",
    "extension-actions-changed": "astra:extension-actions",
    "extension-action-failed": "astra:extension-action-failed",
    "extension-action-shortcut": "astra:extension-action-shortcut",
    "ui-command": "astra:ui-command",
    "operation-processed": "astra:operation-processed",
    "page-permission-prompt-changed": "astra:page-permission-prompt",
    "page-dialog-prompt-changed": "astra:page-dialog-prompt",
    "passkey-prompt-changed": "astra:passkey-prompt",
    "web-extension-prompt-changed": "astra:web-extension-prompt",
    "nav.find-result": "astra:find",
    "runtime-status-changed": "astra:runtime-status",
    "blocker-status-changed": "astra:blocker-status",
    "focus-changed": "astra:focus",
    "downloads-changed": "astra:downloads-changed",
    "search-changed": "astra:search",
    "layout-changed": "astra:layout",
    "profiles-changed": "astra:profiles",
    "notes-changed": "astra:notes-changed",
    "keymap-changed": "astra:keymap-changed",
    "import-progress": "astra:import-progress",
    "work-changed": "astra:work-changed",
    "work-environment-changed": "astra:work-environment-changed",
    "media-player-changed": "astra:media-player",
    "favicons-changed": "astra:favicons",
    "note-open-requested": "astra:note-open-requested",
    "browser-return": "astra:browser-return",
    "presentation-tab": "astra:presentation-tab",
    "peek-changed": "astra:peek",
  };
  for (const [wire, dom] of Object.entries(DOM_CHANNELS)) {
    bridge.listen(wire, (event) => {
      const payload = event.payload as Record<string, unknown> | null;
      const detail =
        wire === "nav.find-result" && payload
          ? {
              query: payload.query,
              matches: payload.matchCount,
              active: payload.activeMatch ? payload.activeMatch : null,
            }
          : event.payload;
      window.dispatchEvent(new CustomEvent(dom, { detail }));
      if (wire === "items-changed" && !revealed) {
        itemsSeen = true;
        bootMark("astraItems");
        waitForStablePaint();
      }
    });
  }

  mount(App, { target });
  // The presentation barrier observes this DOM synchronously.
  flushSync();
  bootMark("astraMounted");
  // The theme is written by the app's own appearance init, a pass after the
  // mount; watch the one attribute and tell the shell each time it changes.
  try {
    new MutationObserver(announceTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    announceTheme();
  } catch {
    // No observer: the first `ready` still proves the UI, pages just keep the
    // system colour scheme.
  }
  // `announce` is called from `reveal()`: the shell only shows this frame once
  // the first paint is complete, so a half-built chrome is never displayed.
  // Guarantee the first projection: the app asks for its own snapshot during
  // onMount, but the very first request can race the shell's relay wiring, and
  // a lost response leaves the sidebar empty until a later host event (~0.9 s
  // on a cold launch). `bootstrap` is idempotent and re-emits `items-changed`,
  // so retry briefly until the projection is seen instead of waiting for an
  // unrelated event.
  const askForItems = (attempt: number) => {
    if (itemsSeen || revealed || attempt > 3) return;
    window.setTimeout(
      () => {
        if (itemsSeen || revealed) return;
        bootMark("astraAsk");
        void bridge
          .invoke("tabs_bootstrap")
          .then(() => bootMark("astraBootstrap"))
          .catch(() => {
            // The app's own bootstrap still runs; this is only a safety net.
          });
        askForItems(attempt + 1);
      },
      attempt === 1 ? 60 : 150,
    );
  };
  askForItems(1);
  // Start the gate as soon as the app is mounted, and never leave the window
  // blank if a section never arrives. The 600 ms ceiling only applies when the
  // projection never lands; each retry above normally resolves it in <250 ms.
  waitForStablePaint();
  setTimeout(() => {
    window.clearTimeout(gateTimer);
    reveal();
  }, 600);
} catch (error) {
  // The frame is handing itself to the onboarding document; nothing failed.
  if (!(error instanceof Navigating)) {
    fail(error instanceof Error ? error.message : String(error), error);
  }
}

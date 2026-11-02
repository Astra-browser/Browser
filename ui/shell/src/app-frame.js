/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P3-T21: the product UI is a first-party chrome package, not a page loaded
// from disk.
//
// The app ships as `chrome://astra/content/app/browser-chrome.html` (staged
// into the jar by `bun run --filter @astra/frame build:chrome`), and this
// frame embeds it as a chrome-privileged document. Because both documents are
// `chrome://astra/` they share one principal and one process: the app imports
// the Host API directly (`resource://astra/host/HostAPI.sys.mjs`) and there is
// no message relay, no nonce, no `file://` URL and no out-of-process browser.
//
// The engine change that makes this possible is the `chrome://astra/`
// exemption from the default system-principal innerHTML sanitization
// (`nsContentUtils.cpp`, `IsAstraTrustedChromeDocument`): Svelte compiles
// every component template through `template.innerHTML`, which the sanitizer
// would otherwise strip.
//
// The embed is an XHTML <iframe> on purpose: a XUL <browser> created outside
// the tabbrowser has an inert docshell on this ESR, while a chrome-privileged
// iframe runs its own document normally. Readiness is reported by the app
// itself (a `postMessage` handshake), so the shell never guesses when to
// retire its fallback chrome.

const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Packaged app page (jar.mn: `% content astra %content/astra/`). */
export const APP_PAGE = "chrome://astra/content/app/browser-chrome.html";

/** Handshake namespace between the app document and this frame. */
export const SHELL_NS = "astra-shell";

/** How long to wait for the app to announce before falling back. */
export const APP_BOOT_TIMEOUT_MS = 60000;

/**
 * Mount the packaged app into `container`.
 *
 * @param {Element} container chrome-window element that owns the app
 * @param {object} _host retained for the call signature; the app imports the
 *   Host API itself now, so the frame does not relay anything
 * @param {{onReady?: (mode: string) => void, onFailure?: (message: string) => void}} hooks
 */
export function mountAppFrame(container, _host, { onReady, onFailure } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? null;
  if (!win) {
    if (onFailure) {
      onFailure("app frame failed to load");
    }
    return { url: APP_PAGE, element: null, destroy() {} };
  }

  let settled = false;
  let timer = 0;
  let frame = null;

  const settle = (fn, value) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    win.removeEventListener("message", onMessage);
    if (fn) {
      fn(value);
    }
  };

  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.ns !== SHELL_NS) {
      return;
    }
    // Chrome-privileged documents share one principal, so `event.source` is
    // null here (measured) and `origin` is the system principal's
    // `chrome://browser` for every sender. Only our own chrome documents can
    // reach this listener at all — web content is never a child of the
    // browser window — so the namespace is the whole authentication.
    if (data.kind === "ready") {
      const mode = typeof data.mode === "string" ? data.mode : "host";
      try {
        container.dataset.appReady = mode;
      } catch {
        // Diagnostics only.
      }
      if (mode === "host") {
        try {
          frame.style.opacity = "";
          // Measured: a chrome iframe keeps painting the layer it cached
          // while transparent, so the first visible frame could be the
          // half-built one. Invalidate both layers on reveal.
          frame.style.transform = "translateZ(0)";
          void frame.offsetHeight;
          frame.style.transform = "";
          const child = frame.contentDocument;
          if (child) {
            const html = child.documentElement;
            html.style.opacity = "0.999";
            void html.offsetHeight;
            html.style.opacity = "";
          }
        } catch {
          // Frame already torn down; nothing to reveal.
        }
        settle(onReady, mode);
      } else {
        settle(onFailure, `app booted in ${mode} mode, expected host`);
      }
    } else if (data.kind === "error") {
      const message = typeof data.message === "string" ? data.message : "app reported an error";
      settle(onFailure, message);
    }
  };

  win.addEventListener("message", onMessage);

  try {
    frame = doc.createElementNS(XHTML_NS, "iframe");
    frame.setAttribute("class", "astra-app-frame");
    frame.setAttribute("data-astra-app-frame", "");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    // The embed is first-party chrome, so it may run with the chrome
    // principal it already has; nothing here grants page content anything.
    frame.setAttribute("src", APP_PAGE);
    // Composited out until the app reports a complete first frame. Opacity
    // (not display:none) keeps the child document laying out, so it can
    // measure itself and settle.
    frame.style.opacity = "0";
    container.appendChild(frame);
  } catch (error) {
    settle(onFailure, `app frame failed to load (${error instanceof Error ? error.message : String(error)})`);
    return { url: APP_PAGE, element: frame, destroy() {} };
  }

  timer = setTimeout(() => settle(onFailure, "app frame timed out"), APP_BOOT_TIMEOUT_MS);

  function destroy() {
    settled = true;
    clearTimeout(timer);
    win.removeEventListener("message", onMessage);
    try {
      if (frame) {
        frame.remove();
      }
    } catch {
      // Window teardown: the frame is already gone.
    }
  }

  return { url: APP_PAGE, element: frame, destroy };
}

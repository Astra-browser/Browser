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
 * @param {object} host this window's Host API instance: the frame relays the
 *   app's calls to it, because `resource://` modules are per document and a
 *   second import would give the app its own tab model while this window owns
 *   the content browser
 * @param {{onReady?: (mode: string) => void, onFailure?: (message: string) => void}} hooks
 */
export function mountAppFrame(container, host, { onReady, onFailure } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? null;
  if (!win) {
    if (onFailure) {
      onFailure("app frame failed to load");
    }
    return { url: APP_PAGE, element: null, destroy() {} };
  }

  let settled = false;
  let destroyed = false;
  let timer = 0;
  let frame = null;

  /** True when a message really came from our embed. Chrome documents report
   *  `null` as `source` (measured), so a named sender that is not the frame
   *  is refused; the namespace still has to match. */
  const fromOurFrame = (event) => {
    try {
      if (!frame) return true;
      if (event.source === null || event.source === undefined) return true;
      return event.source === frame.contentWindow;
    } catch {
      // Frame torn down between the post and the dispatch.
      return false;
    }
  };

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
    if (!data || typeof data !== "object" || data.ns !== SHELL_NS) {
      return;
    }
    if (!fromOurFrame(event)) {
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

  // --- Relay: the app's calls reach this window's Host API ------------------
  // The app cannot import the same instance (`resource://` modules are per
  // document) and cannot read an expando across compartments, so every call
  // is a message and every event is posted back. Only this window's own frame
  // can reach the listener, and the namespace is checked.
  const post = (message) => {
    try {
      frame?.contentWindow?.postMessage({ ns: SHELL_NS, ...message }, "*");
    } catch {
      // Frame gone: the reply has no reader.
    }
  };
  const relay = async (event) => {
    if (destroyed) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object" || data.ns !== SHELL_NS) {
      return;
    }
    if (!fromOurFrame(event)) {
      return;
    }
    if (data.kind === "req") {
      try {
        win.__astraRelayCount = (win.__astraRelayCount ?? 0) + 1;
      } catch {
        // Diagnostics only.
      }
      const id = data.id;
      let payload = null;
      let error = null;
      try {
        // Only the host's own module objects and their own public methods are
        // reachable. A name like `constructor` or `call` must not resolve
        // through a prototype into a Function, and internals (`_`/`__`) stay
        // private to the window.
        const moduleName = typeof data.module === "string" ? data.module : "";
        const methodName = typeof data.method === "string" ? data.method : "";
        const module = host?.[moduleName];
        const reachable =
          moduleName !== "" &&
          methodName !== "" &&
          !moduleName.startsWith("_") &&
          !methodName.startsWith("_") &&
          module !== null &&
          typeof module === "object" &&
          Object.prototype.hasOwnProperty.call(module, methodName);
        const fn = reachable ? module[methodName] : null;
        if (typeof fn !== "function") {
          error = {
            code: "unknown_command",
            message: `host has no ${String(data.module)}.${String(data.method)}`,
          };
        } else {
          payload = await fn(data.args ?? {});
        }
      } catch (e) {
        error = { code: "host_error", message: String(e?.message ?? e) };
      }
      if (destroyed) {
        return;
      }
      try {
        if (error) win.__astraLastRelayError = `${String(data.module)}.${String(data.method)}: ${String(error.message ?? "")}`;
        if (data.module === "Search") {
          win.__astraLastSearch = JSON.stringify({ method: data.method, args: data.args, payload });
        }
      } catch {
        // Diagnostics only.
      }
      post({ kind: "res", id, payload, error });
    } else if (data.kind === "window") {
      // The window's own controls: Frame owns minimize/maximize/restore/close.
      post({ kind: "window-res", id: data.id, action: data.action });
      try {
        const frameMod = await import(/* @vite-ignore */ "resource://astra/frame/Frame.sys.mjs");
        const chrome = {};
        for (const op of ["minimize", "maximize", "restore"]) {
          if (typeof win[op] === "function") chrome[op] = () => win[op]();
        }
        const list = await host.Windows.list({ request_id: `win-${Date.now()}` });
        await frameMod.dispatchWindowControl(host, chrome, {
          action: data.action,
          window_id: list.focused_window_id ?? "win-1",
          request_id: `ctl-${Date.now()}`,
        });
      } catch {
        // No Frame module: the control is unavailable, as before.
      }
    }
  };
  win.addEventListener("message", relay);

  const relayEvents = host?.addEventListener
    ? host.addEventListener((event) => {
        try {
          if (event.type === "search-changed") {
            win.__astraLastSearchEvent = JSON.stringify(event.data);
          }
        } catch {
          // Diagnostics only.
        }
        post({ kind: "evt", type: event.type, data: event.data, seq: event.event_seq });
      })
    : null;

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
    win.removeEventListener("message", relay);
    try {
      relayEvents?.();
    } catch {
      // Already torn down.
    }
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

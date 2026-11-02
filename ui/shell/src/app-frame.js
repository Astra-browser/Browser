// P3-T15 app frame: mounts the full product UI into the shell.
//
// The app is packaged at `overlay/astra/chrome/app/` (built by
// `bun run --filter @astra/frame build:chrome`, registered in jar.mn).
//
// Loading mechanism (every alternative measured dead, 2026-11-02):
//   - Subframe navigation to chrome:// or resource:// URLs fails in this
//     build config (`No chrome package registered` / silent error events —
//     even for the long-registered `chrome://astra/hello.html`).
//   - An about:blank iframe + fetch + document.write DOES boot the app, but
//     the resulting system/about-principal document sanitizes innerHTML
//     (drops button/input/form/script — see ShouldSanitize in
//     engine/dom/base/nsContentUtils.cpp), and Svelte builds every template
//     with innerHTML, so the app dies in `document.importNode` on its first
//     component. No overlay-side code can lift that sanitizer.
// Hence: the app runs in a REMOTE content <browser> (like the P1-T10 content
// slot) pointed at the staged files through their file:// URL (resolved from
// the `resource://astra-app/` mapping at runtime, so no path is hardcoded).
// file:// documents carry a content principal — no sanitizer, Svelte works —
// and module scripts resolve same-directory.
// The bridge crosses the privilege boundary over the message manager:
// `window.parent.postMessage` from out-of-process content never reaches the
// chrome window (measured: zero messages delivered), so a tiny framescript
// (`relay-framescript.js`, loaded per-browser) forwards the entry's relay
// frames up, and re-posts chrome's replies down into the page. The relay
// terminates in the existing host transport (`createHostDispatch` over the
// loaded Host API, exactly like `ui/shell/src/host.js`), and host events
// pump back into the frame. A per-mount nonce (delivered in the shell's
// `hello`, echoed on every frame) authenticates the mount; the shell polls
// hello until the entry announces, so a slow boot still links up (and a
// standalone open with no shell falls back to the entry's MOCK path).
// The interim P1-T10/P3 bar/split/slot mounts stay visible and wired as the
// fallback (live contract tests drive them). On any failure here the app
// region shows the `slot-error` pattern and names the cause.

import { createHostDispatch } from "../../packages/bridge/src/host-transport.js";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

/** Packaged app page (jar.mn: content + resource registrations). */
export const APP_PAGE = "resource://astra-app/browser-chrome.html";

/** Relay framescript (staged next to the app by stage-chrome.mjs). */
export const RELAY_FRAME_SCRIPT = "resource://astra-app/relay-framescript.js";

const RELAY_NS = "astra-app-relay";

/** How long to wait for the app entry's ready/error report before giving up. */
export const APP_BOOT_TIMEOUT_MS = 60000;

/** Interval for the shell's `hello` poll until the entry announces. */
const HELLO_INTERVAL_MS = 2000;

function chromeServices() {
  const services = globalThis.Services;
  if (!services || !services.io || !services.scriptSecurityManager) {
    throw new Error("chrome services unavailable");
  }
  return services;
}

/** Resolve the staged page to a file:// URL (content browsers need one). */
export function resolveAppFileURL() {
  const Services = chromeServices();
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Components.interfaces.nsIResProtocolHandler);
  const fileURL = handler.resolveURI(Services.io.newURI(APP_PAGE));
  if (!fileURL.startsWith("file://")) {
    throw new Error(`packaged app not on disk (${fileURL.slice(0, 24)}…)`);
  }
  return fileURL;
}

export function mountAppFrame(container, host, { onReady, onFailure } = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView ?? null;
  if (!win) {
    if (onFailure) onFailure("app frame failed to load");
    return { url: APP_PAGE, element: null, destroy() {} };
  }

  let settled = false;
  let timer = 0;
  let helloTimer = 0;
  let browser = null;
  let mm = null;
  let commitTimer = 0;
  const ready = (mode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(helloTimer);
    if (mode !== "host") {
      if (onFailure) onFailure(`app booted in ${mode} mode, expected host`);
      return;
    }
    if (onReady) onReady(mode);
  };
  const fail = (message) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(helloTimer);
    if (onFailure) onFailure(message);
  };

  const nonce = (() => {
    try {
      return crypto.randomUUID();
    } catch {
      return `relay-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
  })();

  const postToFrame = (frame) => {
    try {
      // Re-fetch per send: the message manager object is replaced across
      // navigations (measured: a pre-commit manager throws
      // NS_ERROR_NOT_INITIALIZED afterwards).
      browser.messageManager.sendAsyncMessage("astra-relay-chrome", {
        ns: RELAY_NS,
        nonce,
        ...frame,
      });
    } catch {
      // Frame tearing down; the entry side times its relay out.
    }
  };

  const onRelayMessage = (msg) => {
    const data = msg.data;
    if (!data || data.ns !== RELAY_NS) return;
    try {
      const el = container;
      el.dataset.relaySeen = String((Number(el.dataset.relaySeen ?? 0) || 0) + 1);
      el.dataset.relayLast = `${data.kind ?? "?"}:${data.nonce === nonce ? "ok" : "nonce-mismatch"}`;
    } catch {
      // Best-effort diagnostics only.
    }
    if (data.nonce !== nonce) return;
    if (data.kind === "req" && data.req) {
      const req = data.req;
      void (async () => {
        let res;
        try {
          res = await dispatch(req);
        } catch (error) {
          res = {
            v: 1,
            id: req.id,
            kind: "res",
            name: req.name,
            payload: {},
            error: {
              code: "relay_error",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
        postToFrame({ kind: "res", res });
      })();
    } else if (data.kind === "ready") {
      ready(data.mode);
    } else if (data.kind === "error") {
      fail(`app reported: ${data.message ?? "unknown error"}`);
    }
  };

  let dispatch;
  try {
    // Host event pump: forwarded into the frame, where the entry ingests
    // them with their event_seq (end-to-end gap detection).
    dispatch = createHostDispatch(host, (event) => {
      postToFrame({ kind: "evt", event });
    });
  } catch (error) {
    fail(`app relay unavailable (${error instanceof Error ? error.message : String(error)})`);
    return { url: APP_PAGE, element: null, destroy() {} };
  }

  try {
    const fileURL = resolveAppFileURL();
    browser = doc.createElementNS(XUL_NS, "browser");
    // Remote content browser: on ESR 153 a non-remote type=content browser
    // created outside the tabbrowser has an inert docshell (loads never
    // commit); remote is the only live path (see Content.sys.mjs).
    browser.setAttribute("type", "content");
    browser.setAttribute("remote", "true");
    browser.setAttribute("remoteType", "web");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("class", "astra-app-frame");
    browser.setAttribute("data-astra-app-frame", "");
    browser.setAttribute("flex", "1");
    container.appendChild(browser);
    // Channel setup happens after the file:// navigation commits (below):
    // the message manager object is replaced across navigations (a cached
    // pre-commit manager throws NS_ERROR_NOT_INITIALIZED), so the framescript
    // loads and the listener registers on the committed manager.
    const principal = chromeServices().scriptSecurityManager.getSystemPrincipal();
    browser.fixupAndLoadURIString(fileURL, { triggeringPrincipal: principal });
    const started = Date.now();
    commitTimer = setInterval(() => {
      if (settled) {
        clearInterval(commitTimer);
        return;
      }
      let spec = "";
      try {
        spec = browser.currentURI ? browser.currentURI.spec : "";
      } catch {
        return;
      }
      if (spec.startsWith("about:neterror")) {
        clearInterval(commitTimer);
        fail("app page failed to load");
        return;
      }
      if (!spec.includes("browser-chrome.html")) {
        if (Date.now() - started > APP_BOOT_TIMEOUT_MS) {
          clearInterval(commitTimer);
          fail("app frame failed to commit");
        }
        return;
      }
      clearInterval(commitTimer);
      try {
        mm = browser.messageManager;
        mm.loadFrameScript(RELAY_FRAME_SCRIPT, false);
        mm.addMessageListener("astra-relay-content", onRelayMessage);
      } catch (error) {
        fail(`app frame failed to load (${error instanceof Error ? error.message : String(error)})`);
      }
    }, 250);
  } catch (error) {
    fail(`app frame failed to load (${error instanceof Error ? error.message : String(error)})`);
    return { url: APP_PAGE, element: browser, destroy };
  }
  // The entry announces after mounting; poll hello in case the framescript
  // attached after the entry's first announce. Sends go through the current
  // manager (see postToFrame); failures surface on the dataset until one
  // gets through.
  helloTimer = setInterval(() => {
    if (settled) return;
    const before = Number(container.dataset.relaySeen ?? 0) || 0;
    postToFrame({ kind: "hello" });
    try {
      const seen = Number(container.dataset.relaySeen ?? 0) || 0;
      if (seen === before) {
        container.dataset.relayHelloError = "no relay traffic yet";
      } else {
        delete container.dataset.relayHelloError;
      }
    } catch {
      // Best-effort diagnostics only.
    }
  }, HELLO_INTERVAL_MS);
  timer = setTimeout(() => fail("app frame timed out"), APP_BOOT_TIMEOUT_MS);

  function destroy() {
    settled = true;
    clearTimeout(timer);
    clearInterval(helloTimer);
    clearInterval(commitTimer);
    try {
      // Listener may live on a replaced manager; removal is best-effort —
      // the browser element (and its managers) is removed just below.
      if (mm) mm.removeMessageListener("astra-relay-content", onRelayMessage);
    } catch {
      // Already torn down with the window.
    }
    try {
      if (browser) browser.remove();
    } catch {
      // Window teardown: the frame is already gone.
    }
  }

  return { url: APP_PAGE, element: browser, destroy };
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P3-T15 chrome entry: boots the real app inside the Astra shell with the
// bridge in HOST mode.
//
// Two boot paths, selected by a handshake with the parent shell:
//   - Embedded (the shell): the shell loads this page in a REMOTE content
//     <browser> (file:// URL — the only subframe kind that runs Svelte here;
//     see app-frame.js) and polls `hello` frames carrying a per-mount nonce.
//     On the first hello the entry configures the bridge in `host` mode over
//     a relay dispatch and mounts; the relay forwards Appendix C envelopes
//     to the shell (which terminates them in the Host API) and pumps host
//     events back. Requests resolve by `req.id`; the nonce on every frame
//     authenticates the mount.
//   - Standalone (no shell answers within HELLO_WAIT_MS — dev preview,
//     goldens, direct file:// open): the existing mode detection applies
//     (`ensureBridge`: MOCK host for `file:`/`http(s):`/`?astra-mock=1`).
//
// Transport notes (all measured in the engine build):
// `window.parent.postMessage` from out-of-process content never reaches the
// chrome window, so frames go through the relay framescript instead: the
// entry posts to its OWN window, the framescript (loaded per-browser by the
// shell) forwards namespace-matching frames up via `sendAsyncMessage`, and
// re-posts chrome's replies down here. `file://` page URLs must stay
// query-free (a `?query` breaks subresource loads through
// fixupAndLoadURIString), so the nonce travels in the hello, not the URL.

import { configureBridge, getBridge, getCurrentWindow, setWindowLabel } from "@astra/bridge";
import type { Bridge, DispatchFn, Envelope } from "@astra/bridge";
import { PROTOCOL_VERSION } from "@astra/bridge";
import { ensureBridge } from "$shared/ipc/bridge.js";
import { mount, flushSync } from "svelte";
import App from "$app/browser/BrowserApp.svelte";

const RELAY_NS = "astra-app-relay";
const RELAY_TIMEOUT_MS = 30000;

/** Shell hello wait: longer than commit + cold boot + the shell's hello poll. */
const HELLO_WAIT_MS = 30000;

/** Nonce adopted from the shell's hello (null until the first hello). */
let nonce: string | null = null;

function fail(message: string, error: unknown): void {
  console.error("[astra-chrome-entry]", message, error);
  try {
    // Self-post: the relay framescript forwards it to the shell (standalone:
    // no framescript, and the entry's own listener ignores error frames).
    window.postMessage({ ns: RELAY_NS, nonce, kind: "error", message }, "*");
  } catch {
    // No shell to report to (standalone open); the alert below still shows.
  }
  const target = document.getElementById("root");
  if (target instanceof HTMLElement) {
    target.innerHTML = "";
    const doc = target.ownerDocument;
    // Title doubles as a cross-process status line: content titles are
    // readable from chrome (unlike frame DOM), so the shell and live
    // suites can tell boot failure apart from a silent hang.
    try {
      doc.title = `Astra unavailable: ${message.slice(0, 120)}`;
    } catch {
      // Title update is best-effort; the alert below is the real signal.
    }
    const box = doc.createElement("div");
    box.setAttribute("role", "alert");
    box.setAttribute("class", "slot-error");
    // Stack included: chrome has no devtools-on-startup here, and the
    // message alone (e.g. a DOM exception from a dependency) rarely names
    // the failing call. Trimmed to keep the alert readable.
    const stack = error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
    box.textContent = `Astra unavailable: ${message}${stack.slice(0, 600)}`;
    target.appendChild(box);
  }
}

/** Host dispatch over the shell relay (one resolver per `req.id`). */
function createRelayDispatch(): {
  dispatch: DispatchFn;
  connected: () => boolean;
  announce: (bridge: Bridge) => void;
} {
  const pending = new Map<string, (res: Envelope) => void>();
  let bridge: Bridge | null = null;
  let mounted = false;
  const post = (frame: unknown) => {
    window.postMessage({ ns: RELAY_NS, nonce, ...frame } as object, "*");
  };
  window.addEventListener("message", (event) => {
    // No event.source check: framescript re-posts arrive with a chrome-realm
    // (null) source, not the page window. The namespace + per-mount nonce
    // authenticate the channel instead; the entry's own self-posts only ever
    // carry req/ready/error kinds, which this listener ignores except to
    // forward errors nowhere.
    const data = event.data as
      | { ns?: unknown; nonce?: unknown; kind?: unknown; res?: Envelope }
      | null;
    if (!data || data.ns !== RELAY_NS) return;
    // Hellos carry the nonce that authenticates every later frame; adopt it.
    if (data.kind === "hello" && typeof data.nonce === "string") {
      nonce = data.nonce;
      if (bridge && mounted) post({ kind: "ready", mode: bridge.mode });
      helloResolve(true);
      return;
    }
    if (data.nonce !== nonce) return;
    if (data.kind === "res" && data.res && typeof data.res.id === "string") {
      const resolve = pending.get(data.res.id);
      pending.delete(data.res.id);
      if (resolve) resolve(data.res);
    } else if (data.kind === "evt") {
      const evt = (data as { event?: { type: string; data: unknown; event_seq: number } }).event;
      if (evt && bridge) bridge.ingestEvent(evt.type, evt.data, `evt-${evt.event_seq}`, evt.event_seq);
    }
  });
  return {
    dispatch: (req) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(req.id);
          resolve({
            v: PROTOCOL_VERSION,
            id: req.id,
            kind: "res",
            name: req.name,
            payload: {},
            error: { code: "relay_timeout", message: "shell relay timed out" },
          });
        }, RELAY_TIMEOUT_MS);
        pending.set(req.id, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        post({ kind: "req", req });
      }),
    connected: () => nonce !== null,
    announce: (b) => {
      bridge = b;
      mounted = true;
      post({ kind: "ready", mode: b.mode });
    },
  };
}

let helloResolve: (v: boolean) => void = () => {};
const helloSeen = new Promise<boolean>((resolve) => {
  helloResolve = resolve;
});

try {
  // Surface label doubles as the expected window label: both paths record it
  // via setWindowLabel (ensureBridge does it internally), so the guard below
  // verifies this entry booted the surface it configured.
  document.title = "Astra [entry]";
  const SURFACE = "browser-chrome";
  setWindowLabel(SURFACE);
  // Embedded iff a shell hello arrives in time; standalone otherwise.
  const relay = createRelayDispatch();
  const embedded = await Promise.race([
    helloSeen,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HELLO_WAIT_MS)),
  ]);
  let bridge: Bridge;
  let announce: ((b: Bridge) => void) | null = null;
  if (embedded && relay.connected()) {
    bridge = configureBridge({ mode: "host", dispatch: relay.dispatch });
    announce = relay.announce;
  } else {
    bridge = await ensureBridge(SURFACE, window.location.search);
  }
  if (getCurrentWindow().label !== SURFACE) throw new Error("unexpected native surface");
  const target = document.getElementById("root");
  if (!(target instanceof HTMLElement)) throw new Error("trusted UI root is unavailable");
  // Test seam for the P3-T15 contract (live suites + SHELL_APP.md): records
  // which bridge mode the app actually booted in.
  target.dataset.bridgeMode = bridge.mode;
  // Hand the title back to the app: the "[entry]" marker above only needs to
  // survive until mount (it tells a silent hang apart from a dead module).
  try {
    document.title = "Astra";
  } catch {
    // Title is best-effort diagnostics; the mount below is the real work.
  }
  mount(App, { target });
  // The native presentation barrier observes this DOM synchronously.
  flushSync();

  // --- Bridge events → the DOM channels the app listens on (P3-T20) -------
  // In the Tauri build Rust dispatches `astra:*` CustomEvents into the
  // webview, so the app's `native-events.ts` subscribes to `window`. The
  // shell relay feeds the bridge bus instead; re-dispatch here so every
  // projection reaches the UI exactly like the native path did.
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

  // Report to the shell (no-op standalone: no shell is listening, and the
  // request listener above ignores everything but relay res/evt frames).
  announce?.(bridge);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), error);
}

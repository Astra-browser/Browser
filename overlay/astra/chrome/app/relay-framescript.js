/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// P3-T15 relay framescript (plain script, NOT a module): bridges the app
// page's window messages to the chrome process and back.
//
// Why a framescript: the app runs in a REMOTE (out-of-process) content
// <browser>, and `window.parent.postMessage` from out-of-process content
// never reaches the chrome window (measured 2026-11-02: delivered zero
// messages). The message-manager channel is the only live path:
//   - page -> chrome: the entry posts relay frames to its OWN window;
//     this script forwards `{ns, nonce, kind, ...}` frames with the
//     `astra-app-relay` namespace to chrome via `sendAsyncMessage`.
//   - chrome -> page: chrome sends `astra-relay-chrome` messages down this
//     browser's message manager; this script re-posts them into the page,
//     where the entry's window listener picks them up (source is the page
//     window itself; the nonce authenticates the mount).
// Loaded per-browser (`browser.messageManager.loadFrameScript`), so no other
// tab ever evaluates it. Only namespace-matching frames are forwarded.

const RELAY_NS = "astra-app-relay";

addMessageListener("astra-relay-chrome", (msg) => {
  try {
    content.postMessage(msg.data, "*");
  } catch (e) {
    // Frame tearing down; the chrome side times the relay out.
  }
});

content.addEventListener(
  "message",
  (event) => {
    const data = event.data;
    if (!data || data.ns !== RELAY_NS) return;
    sendAsyncMessage("astra-relay-content", data);
  },
  false,
);

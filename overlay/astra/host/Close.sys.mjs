/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Window-close handshake.
//
// The app keeps notes, tasks and Work state that must be flushed before the
// window goes away. Chrome asks first (`resource-close`), the app's close
// service answers with `resource_close_ready(token, success)`, and only then
// does the window close. A refusal (success=false) keeps the window open and
// tells the app to lift its inert cover.
//
// Everything is bounded. The app's own flush deadline is 12 s; chrome waits a
// little longer and then closes anyway, so an app that never answers cannot
// trap the window. A second close request while one is in flight is ignored
// (the close is already being handled).
//
// One handshake exists per window, keyed by the window's own close event, so a
// second window closing at the same time gets its own token.

import { emit } from "./Events.sys.mjs";

/** A little longer than the app's own 12 s flush deadline. Tests shorten it. */
let askTimeoutMs = 12_500;

/** Test seam: shorten the handshake deadline. */
export function __setAskTimeoutForTests(ms) {
  askTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : 12_500;
}

let counter = 0;

/** token -> { win, timer }, while the app still owes an answer. */
const asking = new Map();
/** Windows we are closing ourselves, so the listener lets the close through. */
const closing = new WeakSet();

function finish(win, token, allow) {
  if (!asking.has(token)) {
    return false;
  }
  const entry = asking.get(token);
  asking.delete(token);
  if (entry?.timer) {
    clearTimeout(entry.timer);
  }
  if (!allow) {
    try {
      emit("resource-close-cancelled", token);
    } catch {
      // No event pump in a test process; the refusal still stands.
    }
    return true;
  }
  closing.add(win);
  try {
    win.close();
  } catch {
    closing.delete(win);
  }
  return true;
}

/**
 * Ask the app before this window closes. Returns a teardown for the listener.
 * `win` is the chrome window; a window without `addEventListener` is ignored.
 */
export function bindClose(win) {
  if (!win || typeof win.addEventListener !== "function") {
    return () => {};
  }
  const onClose = (event) => {
    if (event?.target && event.target !== win && event.target !== win.document) {
      return;
    }
    if (closing.has(win)) {
      closing.delete(win);
      return;
    }
    // A handshake is already in flight for this window: hold the close.
    for (const [, entry] of asking) {
      if (entry.win === win) {
        event?.preventDefault?.();
        return;
      }
    }
    event?.preventDefault?.();
    const token = `close-${++counter}`;
    const timer = setTimeout(() => finish(win, token, true), askTimeoutMs);
    asking.set(token, { win, timer });
    try {
      emit("resource-close", token);
    } catch {
      finish(win, token, true);
    }
  };
  win.addEventListener("close", onClose, true);
  return () => {
    try {
      win.removeEventListener("close", onClose, true);
    } catch {
      // A window already gone.
    }
  };
}

export const Close = {
  /**
   * The app's answer to `resource-close`. `true` closes the window, `false`
   * keeps it open. Returns whether the token named a live handshake, so a
   * stale answer cannot close a window it never saw.
   */
  async ready({ request_id = "", token = "", success = false } = {}) {
    const entry = asking.get(token);
    if (!entry) {
      return false;
    }
    return finish(entry.win, token, success === true);
  },
};

/** Test seam: forget every handshake. */
export function __resetCloseForTests() {
  for (const [, entry] of asking) {
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
  }
  asking.clear();
}

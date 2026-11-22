/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Sidebar module (v1, P3-T17). The app's sidebar publisher
// (`ui/app/src/session/sidebar-mode.svelte.ts`) reports its laid-out state
// through `sidebar_set_width` / `sidebar_set_hidden` on every shape change —
// including the publish-on-init during boot, which is why those calls
// surfaced as `no host route` BridgeErrors in the chrome console before this
// module existed (out/p3t17-r2/poll.jsonl).
//
// There is no native sidebar to drive from here (the shell sidebar is DOM in
// the chrome window, not a Host API actor), so this module keeps the last
// reported state (width/hidden/revision) and echoes it back. It also emits
// `sidebar.changed` (P3-T20) so the shell can inset the page surface to the
// app's own sidebar column instead of covering it.
// Pure logic, no Firefox internals.

import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import { emit } from "./Events.sys.mjs";

const _state = {
  width: null,
  animate: false,
  revision: null,
  hidden: false,
  peeking: false,
  lights: false,
  slide: true,
};

function snapshot() {
  return { ..._state };
}

export const Sidebar = {
  // Publish the app's laid-out sidebar state. `width` null clears the
  // override; `revision` orders concurrent publishers (last writer wins,
  // mirroring the native side's admit).
  async setWidth({ request_id = "", width = null, animate = false, revision = null } = {}) {
    // A negative column would inset the page outside the window.
    if (width !== null && (typeof width !== "number" || !Number.isFinite(width) || width < 0)) {
      return err(request_id, "invalid_width", "width must be a finite, non-negative number or null");
    }
    if (typeof animate !== "boolean") {
      return err(request_id, "invalid_animate", "animate must be a boolean");
    }
    if (revision !== null && (typeof revision !== "number" || !Number.isFinite(revision))) {
      return err(request_id, "invalid_revision", "revision must be a finite number or null");
    }
    // A revision orders concurrent publishers. A document (or a second copy
    // of the sidebar module) that reported before can still have a call in
    // flight after the newer one; its stale width must not move the page
    // back, so it is answered with the state that stands.
    if (revision !== null && _state.revision !== null && revision < _state.revision) {
      return ok(request_id, snapshot());
    }
    _state.width = width;
    _state.animate = animate;
    _state.revision = revision;
    emit("sidebar.changed", snapshot());
    return ok(request_id, snapshot());
  },

  // Put the sidebar away (the page takes the window) or bring it back.
  async setHidden({ request_id = "", hidden = false } = {}) {
    if (typeof hidden !== "boolean") {
      return err(request_id, "invalid_hidden", "hidden must be a boolean");
    }
    _state.hidden = hidden;
    emit("sidebar.changed", snapshot());
    return ok(request_id, snapshot());
  },

  // Bring the hidden column out over the page, or let it go. `lights` says
  // whether the column's controls travel with it, `slide` whether it moves at
  // all (a reduced-motion preference asks for none). Nothing is laid out
  // again: the card is out of the row while hidden, so peeking never moves
  // the page.
  async peek({ request_id = "", peek = false, lights = false, slide = true } = {}) {
    if (typeof peek !== "boolean" || typeof lights !== "boolean" || typeof slide !== "boolean") {
      return err(request_id, "invalid_peek", "peek, lights and slide must be booleans");
    }
    _state.peeking = peek;
    _state.lights = lights;
    _state.slide = slide;
    emit("sidebar.changed", snapshot());
    return ok(request_id, snapshot());
  },

  // Last reported state (diagnostics; the shell layout owns the truth).
  async get({ request_id = "" } = {}) {
    return ok(request_id, snapshot());
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetSidebarForTests() {
  _state.width = null;
  _state.animate = false;
  _state.revision = null;
  _state.hidden = false;
  _state.peeking = false;
  _state.lights = false;
  _state.slide = true;
}

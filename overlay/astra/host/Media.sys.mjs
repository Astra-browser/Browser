/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Media module (P9). The sidebar player is a projection of the tab
// playing *behind* the page in front; the engine side lives in `Content`
// (`browsingContext.mediaController` + native mute), which installs the
// engine object and projects views here.
//
// Contract (bindings.ts `MediaPlayerView`):
// - one view or `null`, emitted as `media-player-changed` only on change
// - transport actions answer the admission `settle()` expects
// - position/duration are null unless the page publishes them; `can_pip`
//   follows playback and `in_pip` follows the engine's tab marker.
//
// Pure logic, no Firefox internals: the shell/Content supply the engine.

import { emit } from "./Events.sys.mjs";

const ACTIONS = new Set([
  "play",
  "pause",
  "seek",
  "picture_in_picture",
  "show",
  "close",
]);

let _engine = null;
let _view = null;

function sameView(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.tab_id === b.tab_id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.duration === b.duration &&
    a.position === b.position &&
    a.rate === b.rate &&
    a.playing === b.playing &&
    a.waiting === b.waiting &&
    a.can_pip === b.can_pip &&
    a.in_pip === b.in_pip &&
    a.muted === b.muted &&
    a.can_mute === b.can_mute
  );
}

function silent(tabId) {
  return { operation_id: null, accepted: false, tab_id: tabId, view: _view };
}

export const Media = {
  player({ id = "", action = null } = {}) {
    if (typeof id !== "string" || id === "") return silent(id);
    if (!action || typeof action !== "object" || !ACTIONS.has(action.kind)) {
      return silent(id);
    }
    if (action.kind === "seek") {
      if (action.seconds !== null && !Number.isFinite(action.seconds)) {
        return silent(id);
      }
    }
    if (!_engine) return silent(id);
    try {
      const accepted = _engine.dispatch(id, action) === true;
      return { operation_id: null, accepted, tab_id: id, view: _view };
    } catch {
      return silent(id);
    }
  },

  /** The projection the app should be showing. */
  view() {
    return _view;
  },

  /** Content installs the engine (dispatch + teardown). */
  __setEngine(engine) {
    _engine = engine && typeof engine.dispatch === "function" ? engine : null;
  },

  /** Replace the projection; emits once per real change. */
  __projectMedia(tabId, view) {
    if (view !== null && (typeof view !== "object" || view.tab_id !== tabId)) return false;
    if (sameView(_view, view)) return false;
    _view = view;
    emit("media-player-changed", _view);
    return true;
  },

  __resetForTests() {
    _engine = null;
    _view = null;
  },
};

const _ACTIONS = ACTIONS;
const _silent = silent;
const _sameView = sameView;
export const __mediaInternals = { ACTIONS: _ACTIONS, silent: _silent, sameView: _sameView };

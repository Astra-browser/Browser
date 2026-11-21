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

/** One engine and one projection per chrome window: a private window's media
 *  must never replace or clear the card the normal window is showing. */
const _engines = new Map();
const _views = new Map();

function windowKey(window_id) {
  return typeof window_id === "string" ? window_id : "";
}

function sameEntry(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tab_id === b.tab_id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.icon?.origin === b.icon?.origin &&
    a.icon?.revision === b.icon?.revision &&
    a.artwork === b.artwork &&
    a.playing === b.playing &&
    a.muted === b.muted &&
    a.can_mute === b.can_mute &&
    a.can_pip === b.can_pip &&
    a.in_pip === b.in_pip
  );
}

function samePlayers(a, b) {
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!sameEntry(left[index], right[index])) return false;
  }
  return true;
}

function sameView(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.tab_id === b.tab_id &&
    a.title === b.title &&
    a.artist === b.artist &&
    a.icon?.origin === b.icon?.origin &&
    a.icon?.revision === b.icon?.revision &&
    a.artwork === b.artwork &&
    samePlayers(a.players, b.players) &&
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

function silent(tabId, view = null) {
  return { operation_id: null, accepted: false, tab_id: tabId, view };
}

export const Media = {
  player({ id = "", action = null, window_id = "" } = {}) {
    const key = windowKey(window_id);
    const view = _views.get(key) ?? null;
    if (typeof id !== "string" || id === "") return silent(id, view);
    if (!action || typeof action !== "object" || !ACTIONS.has(action.kind)) {
      return silent(id, view);
    }
    if (action.kind === "seek") {
      if (action.seconds !== null && !Number.isFinite(action.seconds)) {
        return silent(id, view);
      }
    }
    const engine = _engines.get(key) ?? null;
    if (!engine) return silent(id, view);
    try {
      const accepted = engine.dispatch(id, action) === true;
      return {
        operation_id: null,
        accepted,
        tab_id: id,
        view: _views.get(key) ?? null,
      };
    } catch {
      return silent(id, view);
    }
  },

  /** The projection one window should be showing. */
  view(window_id = "") {
    return _views.get(windowKey(window_id)) ?? null;
  },

  /** Content installs the engine (dispatch + teardown) for its window. */
  __setEngine(engine, window_id = "") {
    const key = windowKey(window_id);
    if (engine && typeof engine.dispatch === "function") {
      _engines.set(key, engine);
    } else {
      _engines.delete(key);
      // The window is going away; its card must not outlive the engine.
      _views.delete(key);
    }
  },

  /** Replace one window's projection; emits once per real change. */
  __projectMedia(tabId, view, window_id = "") {
    const key = windowKey(window_id);
    if (view !== null && (typeof view !== "object" || view.tab_id !== tabId)) return false;
    const current = _views.get(key) ?? null;
    if (sameView(current, view)) return false;
    if (view === null) {
      _views.delete(key);
    } else {
      _views.set(key, view);
    }
    // The shell drops another window's event; the app never reads this field.
    emit("media-player-changed", view === null ? null : { ...view, window_id: key });
    return true;
  },

  __resetForTests() {
    _engines.clear();
    _views.clear();
  },
};

const _ACTIONS = ACTIONS;
const _silent = silent;
const _sameView = sameView;
export const __mediaInternals = { ACTIONS: _ACTIONS, silent: _silent, sameView: _sameView };

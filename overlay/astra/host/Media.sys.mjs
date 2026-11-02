/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Media module (v1, wiring). The sidebar player is a projection of
// the tab that most recently started playing off screen: `media_player`
// admits transport actions and `media-player-changed` carries
// `MediaPlayerView | null` (`ui/app/src/shared/ipc/bindings.ts`). The engine
// owns the real media state (browser element playback flags, mute, picture
// in picture); this module is the host-side answer while that projection is
// not connected.
//
// What it says today: nothing is playing.
// - `player` answers the admission the UI's `settle()` expects plus
//   `view: null` — the shape a tab with no media has, since the event type is
//   `MediaPlayerView | null`. It never describes a track it does not have.
// - Every transport action on that tab is refused (`accepted: false`).
//   Reporting `applied` would claim playback that never happened, and
//   `operation_id` stays null because there is no native operation to
//   observe.
// - Nothing is emitted: no state changed. `media-player-changed` goes out
//   through `Events.emit` only when the engine projection reports an actual
//   change.
//
// Pure logic, no Firefox internals.

/** The actions `MediaPlayerAction` allows; anything else is not ours. */
const ACTIONS = new Set([
  "play",
  "pause",
  "seek",
  "picture_in_picture",
  "show",
  "close",
]);

/**
 * A tab with no media: an admission that changes nothing, and no view. The
 * `tab_id` echoes the tab the caller asked about so a refusal is never
 * mistaken for another tab's answer.
 */
function silent(tab_id) {
  return { operation_id: null, accepted: false, tab_id, view: null };
}

export const Media = {
  /**
   * Admit one transport action for `id`. `action` is a `MediaPlayerAction`.
   * On a tab with no media every action is a no-op that is reported as
   * refused, never as applied.
   */
  async player({ id = "", action = null } = {}) {
    if (typeof id !== "string" || id === "") {
      return silent("");
    }
    if (
      action === null ||
      typeof action !== "object" ||
      Array.isArray(action) ||
      !ACTIONS.has(action.kind)
    ) {
      return silent(id);
    }
    if (
      action.kind === "seek" &&
      action.seconds !== null &&
      !Number.isFinite(action.seconds)
    ) {
      return silent(id);
    }
    return silent(id);
  },

  /** The sidebar's player, or null while there is none. */
  async view() {
    return null;
  },
};

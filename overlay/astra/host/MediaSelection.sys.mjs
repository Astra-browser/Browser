/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Which tab the single "Now playing" player should show. Pure logic so the
// policy can be tested without a browser; `Content` supplies live flags and
// the engine view for the chosen id.
//
// The player is one card, but several tabs can have media. A silent tab must
// never clear a playing one, and a tab that starts playing should take the
// card from a paused one. While nothing plays the card keeps the tab it was
// showing so pause/resume stays on the same control.

/**
 * @param {object} input
 * @param {string} input.currentId the tab the card currently names ("" = none)
 * @param {boolean} input.currentLive the current tab still offers a view
 * @param {Array<{id: string, live: boolean, playing: boolean,
 *   playSince: number, activeSince: number}>} input.candidates
 * @returns {string|null}
 */
export function chooseMedia({ currentId = "", currentLive = false, candidates = [] } = {}) {
  const live = candidates.filter((entry) => entry && entry.live === true && entry.id);
  if (live.length === 0) return null;

  const playing = live.filter((entry) => entry.playing === true);
  if (playing.length > 0) {
    let best = playing[0];
    for (const entry of playing) {
      if ((entry.playSince ?? 0) > (best.playSince ?? 0)) best = entry;
    }
    return best.id;
  }

  if (currentLive && currentId && live.some((entry) => entry.id === currentId)) {
    return currentId;
  }

  let best = live[0];
  for (const entry of live) {
    if ((entry.activeSince ?? 0) > (best.activeSince ?? 0)) best = entry;
  }
  return best.id;
}

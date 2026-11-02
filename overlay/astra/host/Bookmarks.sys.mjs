/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Bookmarks module (v1, wiring). The Bookmarks panel is a projection
// over `bookmark_call` (`docs/astra/ipc-surface.md`; `BookmarkCall`,
// `BookmarkResponse` and `BookmarkError` in
// `ui/app/src/shared/ipc/bindings.ts`). The bookmark tree itself belongs to
// Places; this module is the host-side answer while that store is not
// connected, so the panel renders its real state (nothing held) instead of
// failing with `unknown_command`.
//
// What this module will and will not say:
// - The reads the panel makes (`list`, `reveal`, `search`) answer well-formed
//   replies with no items. The host holds no bookmarks and no folders yet, and
//   it never invents either.
// - `list` at the top level is an empty listing: no folder, no crumbs, no
//   items.
// - `list` inside a folder, and `reveal` of an id, answer the reply's own
//   `error: "missing"`. An empty tree holds no folder and no bookmark; the
//   panel already falls back to the top level on `missing` for a folder
//   (`BookmarksSession.read`), and naming an empty folder would be a folder
//   the host does not have.
// - `search` over an empty tree answers `results` with no items: nothing
//   matches because nothing is stored.
// - Every write (`add_folder`, `add_link`, `rename`, `move`, `remove`)
//   answers the reply's own `error: "unavailable"`. Nothing is reported as
//   `saved`, and no id is minted.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an
//   unknown `kind` is `invalid` too. The call never throws.
// - Every reply echoes the profile the caller asked for. Nothing is stored per
//   profile, so nothing can be read as another profile's state.
//
// The `bookmark.add` command is not answered here: `Commands.run` refuses ids
// it has not ported, so it never claims a page was saved, and this module
// leaves that refusal in place rather than minting a bookmark behind it.
//
// Pure logic, no Firefox internals, no Places import: nothing here changes
// state, so there is no `bookmarks-changed` to announce.

/** The panel caps a search at this many characters
 *  (`bookmarks-session.svelte.ts`); a longer query is not one it sent. */
const MAX_QUERY = 512;

/** The reply's own error variant: the panel renders `error` as it is. */
function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

/** `folder`/`parent`: the top level is `null`, a folder is a non-empty id. */
function isPlace(value) {
  return value === null || isText(value);
}

/** The empty top level: no folder in view, no crumbs, nothing in it. */
function emptyListing(profile) {
  return { kind: "listing", profile, folder: null, path: [], items: [] };
}

function answer(profile, call) {
  if (
    call === null ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    typeof call.kind !== "string"
  ) {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "list":
      if (!isPlace(call.folder)) {
        return error(profile, "invalid");
      }
      // Only the top level exists: it is empty. A named folder is one the
      // host does not have, and `missing` is how the panel learns to go back
      // up rather than paint a folder that is not there.
      return call.folder === null
        ? emptyListing(profile)
        : error(profile, "missing");

    case "reveal":
      // No bookmark is stored, so no folder holds this id.
      return isText(call.id)
        ? error(profile, "missing")
        : error(profile, "invalid");

    case "search":
      if (
        !isText(call.query) ||
        call.query.length > MAX_QUERY ||
        call.query.trim() === ""
      ) {
        return error(profile, "invalid");
      }
      // Nothing is stored, so nothing matches. An empty result is the honest
      // answer, not a failure.
      return { kind: "results", profile, items: [] };

    case "add_folder":
      return isPlace(call.parent) && isText(call.title)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "add_link":
      // An empty title is allowed on the wire (the page's site stands in), so
      // only the type is checked here.
      return isPlace(call.parent) &&
        typeof call.title === "string" &&
        isText(call.url)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "rename":
      return isText(call.id) && typeof call.title === "string"
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "move":
      // `index` is a position among the new siblings; the panel sends
      // 0xffff_ffff to mean "last", which is still a safe integer.
      return isText(call.id) &&
        isPlace(call.parent) &&
        Number.isSafeInteger(call.index) &&
        call.index >= 0
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "remove":
      return isText(call.id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    default:
      return error(profile, "invalid");
  }
}

export const Bookmarks = {
  /**
   * Answer one `bookmark_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `BookmarkResponse` variant plus the echoed `profile`.
   */
  async call({ profile = "", expected_profile = "", call = null } = {}) {
    const asked = isText(profile)
      ? profile
      : isText(expected_profile)
        ? expected_profile
        : "";
    if (!asked) {
      return error("", "invalid");
    }
    try {
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down. `runtime`
      // is not one of `BookmarkError`, so the refusal stays in the reply's own
      // vocabulary: the tree is not reachable, which is what `unavailable`
      // says.
      return error(asked, "unavailable");
    }
  },
};

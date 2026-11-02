/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Notes module (v1, wiring). The Notes panel is a projection over
// `note_call` (`ui/app/src/shared/ipc/bindings.ts`, `docs/astra/ipc-surface.md`).
// The Markdown file store, the index and the link graph belong to
// astra-notes; this module is the host-side answer while that store is not
// connected, so the panel renders its real state (no notes held) instead of
// failing with `unknown_command` and claiming notes are unavailable.
//
// What this module will and will not say:
// - `list` answers a well-formed empty page. The host holds no notes, and it
//   never invents one. The panel then shows its own empty state, which is the
//   truth: there are no notes yet.
// - `get` and `backlinks` answer `not_found`. The listing is authoritative and
//   empty, so an id cannot name a note; that is a different statement from
//   `unavailable`, which would claim a store that exists but cannot answer.
// - `resolve` answers one `null` target per link key asked for. Nothing in an
//   empty store is linked to anything, and the reply keeps the caller's order
//   so a caller can pair keys with notes.
// - Every call that would create, change or remove a file (`create`, `write`,
//   `set_pinned`, `trash`, `restore`, `delete`) answers the reply's own
//   `error: "unavailable"`. Nothing is reported as `applied` or `done`, so no
//   caller can mistake a refusal for a saved note.
// - `reveal` also answers `unavailable`: it needs a real file and the system
//   file manager, neither of which exists before the store does.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an unknown
//   `kind` is `invalid` too. The call never throws, and the defensive answer
//   for a payload that throws while being read stays inside `NoteError`.
// - Every reply echoes the profile the caller asked for, as `NoteReply`
//   allows (`string | null`). Nothing is stored per profile, so nothing can be
//   read as another profile's state; a call without a profile answers with
//   `profile: null`.
//
// Pure logic, no Firefox internals, no Events import: nothing here changes
// state, so there is no `notes-changed` to announce and no
// `note-open-requested` to send.

/** Largest page the UI may ask for; it asks for 100 while listing. */
const MAX_PAGE_LIMIT = 1000;

/** Longest search string the query may carry, as the UI slices it. */
const MAX_SEARCH = 512;

/** Most link keys one `resolve` call may ask about; the UI batches by 128. */
const MAX_TARGETS = 1024;

/** Longest single link key, so one call cannot be made unboundedly large. */
const MAX_TARGET = 512;

function reply(profile, response) {
  return { profile, response };
}

/** `NoteResponse`'s error variant; `code` is always a declared `NoteError`. */
function error(profile, code) {
  return reply(profile, { kind: "error", error: code });
}

function isText(value) {
  return typeof value === "string" && value !== "";
}

/** A `NoteQuery`: `{ search, trashed, after, limit }`, exactly as sent. */
function isQuery(query) {
  if (query === null || typeof query !== "object" || Array.isArray(query)) {
    return false;
  }
  const { search, trashed, after, limit } = query;
  const afterOk = after === null || isText(after);
  return (
    typeof search === "string" &&
    search.length <= MAX_SEARCH &&
    typeof trashed === "boolean" &&
    afterOk &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= MAX_PAGE_LIMIT
  );
}

/** `targets: string[]`, bounded so one call cannot carry unbounded work. */
function isTargets(targets) {
  return (
    Array.isArray(targets) &&
    targets.length <= MAX_TARGETS &&
    targets.every((target) => isText(target) && target.length <= MAX_TARGET)
  );
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
      if (!isQuery(call.query)) {
        return error(profile, "invalid");
      }
      // The store holds nothing, so the honest page is empty and final.
      return reply(profile, { kind: "page", items: [], next: null });

    case "get":
      // An id cannot name a note in an empty store. Saying `not_found` is
      // true; `unavailable` would claim a store that merely cannot answer.
      return isText(call.id)
        ? error(profile, "not_found")
        : error(profile, "invalid");

    case "backlinks":
      // Nothing links to a note that does not exist, and the note cannot.
      return isText(call.id)
        ? error(profile, "not_found")
        : error(profile, "invalid");

    case "resolve":
      if (!isTargets(call.targets)) {
        return error(profile, "invalid");
      }
      return reply(profile, {
        kind: "targets",
        items: call.targets.map((target) => ({ target, note: null })),
      });

    case "create":
      if (!isText(call.request_id) || typeof call.markdown !== "string") {
        return error(profile, "invalid");
      }
      return error(profile, "unavailable");

    case "write":
      if (
        !isText(call.request_id) ||
        !isText(call.id) ||
        !isText(call.base_revision) ||
        typeof call.markdown !== "string" ||
        (call.settle !== undefined && typeof call.settle !== "boolean")
      ) {
        return error(profile, "invalid");
      }
      return error(profile, "unavailable");

    case "set_pinned":
      return isText(call.id) && typeof call.pinned === "boolean"
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "trash":
    case "restore":
    case "delete":
      // These name one note; without the store there is none to act on.
      return isText(call.id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    case "reveal":
      // The folder is the note folder, which the store has not made yet.
      return call.id === null || isText(call.id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");

    default:
      return error(profile, "invalid");
  }
}

export const Notes = {
  /**
   * Answer one `note_call`. `profile` is the caller's scope (the wire payload
   * calls it `expected_profile`; both are accepted). The reply is a
   * `NoteReply`: the echoed `profile` plus one `NoteResponse` variant.
   */
  async call({ profile = "", expected_profile = "", call = null } = {}) {
    const asked =
      typeof profile === "string" && profile !== ""
        ? profile
        : typeof expected_profile === "string" && expected_profile !== ""
          ? expected_profile
          : null;
    if (asked === null) {
      return error(null, "invalid");
    }
    try {
      return answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down, and the
      // answer must stay a variant `NoteError` declares.
      return error(asked, "invalid");
    }
  },
};

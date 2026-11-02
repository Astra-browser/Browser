/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Notes module (v1, session store). The Notes panel is a projection
// over `note_call` (`ui/app/src/shared/ipc/bindings.ts`,
// `docs/astra/ipc-surface.md`).
//
// HONESTY: this is a session store, not a file store. Notes live in memory,
// per profile, for the window session. There is no folder, no file, no path
// and no watcher; a restart forgets every note. `crates/astra-notes` owns the
// Markdown files, the index and the link graph, and will replace this store
// when it is wired. Until then the panel's own actions really change the
// session state instead of being refused, so the editor can save and the list
// can create and remove notes.
//
// What this module says:
// - `create` mints a note (`note-<n>`, revision `1`) holding the caller's
//   markdown and answers `applied` with its summary. A repeated `request_id`
//   answers the same note, so a create retried after an unknown outcome does
//   not make a second one.
// - `write` replaces the markdown when `base_revision` is the current
//   revision, bumps the revision and answers `applied`; a different base
//   answers `conflict` with the current record, which the editor already
//   handles by keeping or taking the other text. A write whose markdown is
//   already the current text is a no-op that answers `applied` without a new
//   revision, so the editor's settling write and a replay after an unknown
//   outcome do not move the revision. A trashed note is `read_only`.
// - `list` answers a page of the profile's notes, pinned first and then
//   newest first, filtered by `trashed` and `search`; `after` is the id of
//   the last note of the previous page and `next` is the next such id.
// - `get` answers the record or `not_found`.
// - `trash`, `restore`, `delete` and `set_pinned` change the session state
//   and answer `applied` (or `done` for `delete`); `delete` removes the note
//   for good, and is only for a note already in the trash, as the wire
//   declares. Every real change announces `notes-changed`, so other surfaces
//   refresh their listing.
// - `backlinks` answers an empty page for a note: there is no link index yet.
// - `resolve` answers one `null` target per key, in the caller's order.
// - `reveal` answers `unavailable`: there is no file and no folder to show,
//   and claiming one opened would be false.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; an unknown
//   `kind` is `invalid` too. Every error code is a declared `NoteError`, the
//   call never throws, and a payload that throws while being read is answered
//   rather than allowed to take the host down.
// - Every reply echoes the profile the caller asked for (`string | null`), and
//   the store is per profile, so no profile reads another's notes. A call
//   without a profile answers `profile: null`.
//
// The only host module this imports is the event pump, to announce changes;
// it holds no Firefox internals, so Node contract tests import it by path.

import { emit } from "./Events.sys.mjs";

/** Largest page the UI may ask for; it asks for 100 while listing. */
const MAX_PAGE_LIMIT = 1000;

/** Longest search string the query may carry, as the UI slices it. */
const MAX_SEARCH = 512;

/** Most link keys one `resolve` call may ask about; the UI batches by 128. */
const MAX_TARGETS = 1024;

/** Longest single link key, so one call cannot be made unboundedly large. */
const MAX_TARGET = 512;

/** A row's preview is this many characters, as the editor's outline makes it. */
const PREVIEW_CHARS = 180;

const FRONT_MATTER = /^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u;

/** profile -> { notes: Map<id, note>, next: number, receipts: Map<request, id> }.
 *  Session only. */
const stores = new Map();

/** Strictly increasing wall clock, so two notes made in one millisecond still
 *  have a newest. */
let lastStamp = 0;

function stamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

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

/** One line of Markdown as the list reads it: links, marks and quotes gone. */
function plain(line) {
  return line
    .replace(
      /!?\[\[([^\]|]*)\|?([^\]]*)\]\]/gu,
      (_all, target, alias) => alias || target,
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u, "")
    .replace(/^\s{0,3}>\s?/u, "")
    .replace(/[*_~`]+/gu, "")
    .replace(/\\(.)/gu, "$1")
    .trim();
}

/** The title and preview the panel shows, from the same rules the editor's
 *  `outline` uses: a first heading names the note, otherwise its first line
 *  does, and the preview is the plain text after that. */
function describe(markdown) {
  const front = markdown.startsWith("---\n") ? FRONT_MATTER.exec(markdown) : null;
  let heading = null;
  let first = null;
  let seen = false;
  let preview = "";
  let start = front ? front[0].length : 0;
  while (start <= markdown.length) {
    const end = markdown.indexOf("\n", start);
    const line = markdown.slice(start, end === -1 ? markdown.length : end);
    if (!seen) {
      if (line.trim() === "") {
        if (end === -1) break;
        start = end + 1;
        continue;
      }
      seen = true;
      const title = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u.exec(line);
      if (title) {
        heading = plain(title[1]) || null;
        if (end === -1) break;
        start = end + 1;
        continue;
      }
      first = plain(line) || null;
    }
    if (!/^\s*(?:```|~~~|---\s*$)/u.test(line)) {
      const text = plain(
        line.slice(0, 4 * PREVIEW_CHARS).replace(/^\s{0,3}#{1,6}\s+/u, ""),
      );
      if (text) preview += (preview ? " " : "") + text;
      if (preview.length > PREVIEW_CHARS) break;
    }
    if (end === -1) break;
    start = end + 1;
  }
  const chars = [...preview];
  return {
    title: heading ?? first ?? "",
    preview:
      chars.length > PREVIEW_CHARS
        ? `${chars.slice(0, PREVIEW_CHARS).join("").trimEnd()}…`
        : preview,
  };
}

/** A `[[target]]` as the UI keys it, for `notes-changed`'s link list. */
function linkKey(target) {
  const text = target.split(/[#^]/u)[0].trim();
  const stem =
    text.endsWith(".md") || text.endsWith(".MD") ? text.slice(0, -3) : text;
  return stem.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function keysOf(title) {
  const key = linkKey(title);
  return key ? [key] : [];
}

function changedKeys(before, after) {
  return [...new Set([...keysOf(before), ...keysOf(after)])];
}

/** The listing's order: pinned first, then most recently changed. */
function order(a, b) {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    b.modified_at - a.modified_at ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

/** `NoteSummary`, as the wire declares it. A session note has no file, so its
 *  `path` is empty rather than a name that would not exist on disk. */
function summaryOf(note) {
  return {
    id: note.id,
    revision: String(note.revision),
    title: note.title,
    preview: note.preview,
    pinned: note.pinned,
    trashed: note.trashed,
    editable: true,
    created_at: String(note.created_at),
    modified_at: String(note.modified_at),
    path: "",
  };
}

function storeFor(profile) {
  let store = stores.get(profile);
  if (!store) {
    store = { notes: new Map(), next: 0, receipts: new Map() };
    stores.set(profile, store);
  }
  return store;
}

function noteOf(profile, id) {
  const store = stores.get(profile);
  return store ? store.notes.get(id) : undefined;
}

function newNote(store, markdown) {
  store.next += 1;
  const at = stamp();
  const note = {
    id: `note-${store.next}`,
    markdown,
    revision: 1,
    pinned: false,
    trashed: false,
    created_at: at,
    modified_at: at,
    title: "",
    preview: "",
  };
  const { title, preview } = describe(markdown);
  note.title = title;
  note.preview = preview;
  store.notes.set(note.id, note);
  return note;
}

function writeNote(note, markdown) {
  note.markdown = markdown;
  note.revision += 1;
  note.modified_at = stamp();
  const { title, preview } = describe(markdown);
  note.title = title;
  note.preview = preview;
}

function matches(note, needle) {
  return (
    note.title.normalize("NFC").toLowerCase().includes(needle) ||
    note.markdown.normalize("NFC").toLowerCase().includes(needle)
  );
}

/** The UI's `NoteChanges`, so every surface hears about a real change. */
function announce(profile, notes, reset, links) {
  emit("notes-changed", { profile, notes, reset, links });
}

function answer(profile, call, envelopeId) {
  if (
    call === null ||
    typeof call !== "object" ||
    Array.isArray(call) ||
    typeof call.kind !== "string"
  ) {
    return error(profile, "invalid");
  }

  switch (call.kind) {
    case "list": {
      const query = call.query;
      if (!isQuery(query)) {
        return error(profile, "invalid");
      }
      const { search, trashed, after, limit } = query;
      const store = stores.get(profile);
      const notes = store ? [...store.notes.values()] : [];
      const needle = search.normalize("NFC").toLowerCase();
      const ordered = notes
        .filter((note) => note.trashed === trashed)
        .filter((note) => needle === "" || matches(note, needle))
        .sort(order);
      let start = 0;
      if (after !== null) {
        const at = ordered.findIndex((note) => note.id === after);
        if (at === -1) {
          // The cursor names a note this page no longer holds; there is no
          // truthful place to continue from, so the page ends.
          return reply(profile, { kind: "page", items: [], next: null });
        }
        start = at + 1;
      }
      const end = Math.min(start + limit, ordered.length);
      const items = ordered.slice(start, end).map(summaryOf);
      const next =
        end < ordered.length && end > start ? ordered[end - 1].id : null;
      return reply(profile, { kind: "page", items, next });
    }

    case "get": {
      const id = call.id;
      if (!isText(id)) {
        return error(profile, "invalid");
      }
      const note = noteOf(profile, id);
      return note
        ? reply(profile, {
            kind: "record",
            record: { summary: summaryOf(note), markdown: note.markdown },
          })
        : error(profile, "not_found");
    }

    case "backlinks": {
      const id = call.id;
      if (!isText(id)) {
        return error(profile, "invalid");
      }
      // There is no link index yet. An existing note simply has no backlinks;
      // a missing one cannot be named at all.
      return noteOf(profile, id)
        ? reply(profile, { kind: "page", items: [], next: null })
        : error(profile, "not_found");
    }

    case "resolve": {
      const targets = call.targets;
      if (!isTargets(targets)) {
        return error(profile, "invalid");
      }
      // No link index: nothing resolves, and the caller's order is kept.
      return reply(profile, {
        kind: "targets",
        items: targets.map((target) => ({ target, note: null })),
      });
    }

    case "create": {
      const requestId = call.request_id;
      const markdown = call.markdown;
      if (!isText(requestId) || typeof markdown !== "string") {
        return error(profile, "invalid");
      }
      const store = storeFor(profile);
      const known = store.receipts.get(requestId);
      const existing = known ? store.notes.get(known) : undefined;
      if (existing) {
        // A retry of a create that already landed is the same note, not a
        // second one. Nothing changed, so nothing is announced.
        return reply(profile, {
          kind: "applied",
          request_id: requestId,
          summary: summaryOf(existing),
        });
      }
      const note = newNote(store, markdown);
      store.receipts.set(requestId, note.id);
      announce(
        profile,
        [{ id: note.id, revision: String(note.revision) }],
        true,
        [],
      );
      return reply(profile, {
        kind: "applied",
        request_id: requestId,
        summary: summaryOf(note),
      });
    }

    case "write": {
      const requestId = call.request_id;
      const id = call.id;
      const base = call.base_revision;
      const markdown = call.markdown;
      const settle = call.settle;
      if (
        !isText(requestId) ||
        !isText(id) ||
        !isText(base) ||
        typeof markdown !== "string" ||
        (settle !== undefined && typeof settle !== "boolean")
      ) {
        return error(profile, "invalid");
      }
      const note = noteOf(profile, id);
      if (!note) {
        return error(profile, "not_found");
      }
      if (note.trashed) {
        // A trashed note is not edited; restore it first.
        return error(profile, "read_only");
      }
      if (note.markdown === markdown) {
        // The text is already the current text. A settling write only moves
        // the file name, and a replay after an unknown outcome must not make
        // a second change, so the revision stays.
        return reply(profile, {
          kind: "applied",
          request_id: requestId,
          summary: summaryOf(note),
        });
      }
      if (String(note.revision) !== base) {
        // Nothing was written. The editor compares the markdown and either
        // takes the current version or shows the conflict.
        return reply(profile, {
          kind: "conflict",
          current: { summary: summaryOf(note), markdown: note.markdown },
        });
      }
      const before = note.title;
      writeNote(note, markdown);
      announce(
        profile,
        [{ id: note.id, revision: String(note.revision) }],
        false,
        changedKeys(before, note.title),
      );
      return reply(profile, {
        kind: "applied",
        request_id: requestId,
        summary: summaryOf(note),
      });
    }

    case "set_pinned": {
      const id = call.id;
      const pinned = call.pinned;
      if (!isText(id) || typeof pinned !== "boolean") {
        return error(profile, "invalid");
      }
      const note = noteOf(profile, id);
      if (!note) {
        return error(profile, "not_found");
      }
      if (note.pinned !== pinned) {
        note.pinned = pinned;
        announce(
          profile,
          [{ id: note.id, revision: String(note.revision) }],
          true,
          [],
        );
      }
      return reply(profile, {
        kind: "applied",
        request_id: envelopeId,
        summary: summaryOf(note),
      });
    }

    case "trash": {
      const id = call.id;
      if (!isText(id)) {
        return error(profile, "invalid");
      }
      const note = noteOf(profile, id);
      if (!note) {
        return error(profile, "not_found");
      }
      if (!note.trashed) {
        note.trashed = true;
        // The note still exists (get returns it); only the live listing lost
        // it. `null` is reserved for a note that is gone for good.
        announce(
          profile,
          [{ id: note.id, revision: String(note.revision) }],
          true,
          [],
        );
      }
      return reply(profile, {
        kind: "applied",
        request_id: envelopeId,
        summary: summaryOf(note),
      });
    }

    case "restore": {
      const id = call.id;
      if (!isText(id)) {
        return error(profile, "invalid");
      }
      const note = noteOf(profile, id);
      if (!note) {
        return error(profile, "not_found");
      }
      if (note.trashed) {
        note.trashed = false;
        announce(
          profile,
          [{ id: note.id, revision: String(note.revision) }],
          true,
          [],
        );
      }
      return reply(profile, {
        kind: "applied",
        request_id: envelopeId,
        summary: summaryOf(note),
      });
    }

    case "delete": {
      const id = call.id;
      if (!isText(id)) {
        return error(profile, "invalid");
      }
      const store = stores.get(profile);
      const note = store ? store.notes.get(id) : undefined;
      if (!note) {
        return error(profile, "not_found");
      }
      if (!note.trashed) {
        // The wire says only a note already in the trash can be deleted.
        return error(profile, "invalid");
      }
      store.notes.delete(id);
      announce(profile, [{ id, revision: null }], true, []);
      return reply(profile, { kind: "done" });
    }

    case "reveal": {
      const id = call.id;
      // There is no file and no folder yet. Saying `unavailable` is the truth;
      // claiming one opened would be a lie about the session store.
      return id === null || isText(id)
        ? error(profile, "unavailable")
        : error(profile, "invalid");
    }

    default:
      return error(profile, "invalid");
  }
}

/** Test-only reset so contract tests start from a clean slate. */
export function __resetNotesForTests() {
  stores.clear();
  lastStamp = 0;
}

export const Notes = {
  /**
   * Answer one `note_call`. `profile` is the caller's scope (the wire payload
   * calls it `expected_profile`; both are accepted). The reply is a
   * `NoteReply`: the echoed `profile` plus one `NoteResponse` variant.
   */
  async call(args = {}) {
    let profile = "";
    let expected = "";
    let call = null;
    let envelope = "";
    try {
      if (args !== null && typeof args === "object") {
        profile = args.profile ?? "";
        expected = args.expected_profile ?? "";
        call = args.call ?? null;
        envelope = args.request_id ?? "";
      }
    } catch {
      // Reading the envelope itself threw: answer rather than reject.
      return error(null, "invalid");
    }
    const asked =
      typeof profile === "string" && profile !== ""
        ? profile
        : typeof expected === "string" && expected !== ""
          ? expected
          : null;
    if (asked === null) {
      return error(null, "invalid");
    }
    const envelopeId = typeof envelope === "string" ? envelope : "";
    try {
      return answer(asked, call, envelopeId);
    } catch {
      // Defensive: a hostile payload must not take the host down, and the
      // answer must stay a variant `NoteError` declares.
      return error(asked, "invalid");
    }
  },
};

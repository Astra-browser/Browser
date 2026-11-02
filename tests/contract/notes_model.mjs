#!/usr/bin/env node
// Notes module contract (session store): `note_call` answers the UI's Notes
// panel natively instead of failing with `unknown_command`.
//
//   - the reads the panel makes when it opens (`list`, `get`, `backlinks`,
//     `resolve`) answer well-formed `NoteReply` variants; an untouched profile
//     holds no notes and none is invented
//   - `create` mints a note and `get` returns its record; a repeated
//     `request_id` answers the same note instead of a second one
//   - `write` applies markdown, bumps the revision, and the new markdown and
//     title are visible; a stale `base_revision` answers `conflict` with the
//     current record and writes nothing, while a replay of the same text is a
//     no-op that keeps the revision
//   - `list` pages newest first, keeps `next` while there is more, and filters
//     by `trashed` and `search`
//   - `trash`, `restore`, `delete` and `set_pinned` really change state;
//     `delete` removes a trashed note for good, and a trashed note is
//     `read_only` to writes
//   - every real change announces `notes-changed` with the UI's `NoteChanges`
//   - `reveal` refuses rather than claiming a file opened
//   - a malformed or unknown call answers `error: "invalid"`, every error code
//     stays inside `NoteError`, and nothing throws
//
// Usage: node tests/contract/notes_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Notes, __resetNotesForTests } = await import(
  path.join(HOST, "Notes.sys.mjs")
);
const { addEventListener, __resetEventsForTests } = await import(
  path.join(HOST, "Events.sys.mjs")
);

__resetNotesForTests();
__resetEventsForTests();

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

/** Every change the host announced, in order. */
const changes = [];
const stopChanges = addEventListener((event) => {
  if (event.type === "notes-changed") changes.push(event.data);
});
const changesFor = (profile) =>
  changes.filter((change) => change.profile === profile);

const EMPTY = "00000000000000000000000001";
const OTHER = "00000000000000000000000002";
const CREATED = "00000000000000000000000003";
const WRITTEN = "00000000000000000000000004";
const PAGED = "00000000000000000000000005";
const STATE = "00000000000000000000000006";
const MALFORMED = "00000000000000000000000007";
const HOSTILE = "00000000000000000000000008";
const INVARIANT = "00000000000000000000000009";
const NOTE = "0000000000000000000000000a";
const REQUEST = "0000000000000000000000000b";

/** `NoteError`, exactly as the wire declares it. */
const NOTE_ERRORS = new Set([
  "invalid",
  "not_found",
  "capacity",
  "too_large",
  "read_only",
  "unavailable",
  "outcome_unknown",
]);

/** `NoteResponse` discriminants, exactly as the wire declares them. */
const RESPONSE_KINDS = new Set([
  "done",
  "page",
  "record",
  "applied",
  "conflict",
  "targets",
  "error",
]);

const call = (profile, call_) => Notes.call({ profile, call: call_ });

const isError = (res, code) =>
  !!res &&
  !!res.response &&
  res.response.kind === "error" &&
  res.response.error === code;

const isPage = (res) =>
  !!res &&
  !!res.response &&
  res.response.kind === "page" &&
  Array.isArray(res.response.items);

const isFinalPage = (res) => isPage(res) && res.response.next === null;

const isRecord = (res) =>
  !!res && !!res.response && res.response.kind === "record";

const isApplied = (res) =>
  !!res && !!res.response && res.response.kind === "applied";

const list = (over = {}) => ({
  kind: "list",
  query: { search: "", trashed: false, after: null, limit: 100, ...over },
});

let createSeq = 0;

const create = (markdown, request) => ({
  kind: "create",
  request_id: request ?? `request-${++createSeq}`,
  markdown,
});

const write = (id, base, markdown, extra = {}) => ({
  kind: "write",
  request_id: REQUEST,
  id,
  base_revision: base,
  markdown,
  ...extra,
});

/** `NoteSummary` shape, exactly as the wire declares it. */
function summaryOk(summary) {
  return (
    !!summary &&
    typeof summary === "object" &&
    typeof summary.id === "string" &&
    summary.id !== "" &&
    typeof summary.revision === "string" &&
    /^\d+$/u.test(summary.revision) &&
    typeof summary.title === "string" &&
    typeof summary.preview === "string" &&
    typeof summary.pinned === "boolean" &&
    typeof summary.trashed === "boolean" &&
    typeof summary.editable === "boolean" &&
    typeof summary.created_at === "string" &&
    /^\d+$/u.test(summary.created_at) &&
    typeof summary.modified_at === "string" &&
    /^\d+$/u.test(summary.modified_at) &&
    typeof summary.path === "string"
  );
}

// === The read the panel opens with: an empty, final page ====================
{
  const res = await call(EMPTY, list());
  check("list is a page reply", res.response.kind === "page");
  check("list echoes the profile", res.profile === EMPTY);
  check("list holds no notes", isFinalPage(res) && res.response.items.length === 0);
  check("list has no next page", res.response.next === null);
  check("list is not an error", res.response.kind !== "error");
}

{
  const searched = await call(EMPTY, list({ search: "meeting", trashed: false }));
  check("list accepts a search", isFinalPage(searched) && searched.response.items.length === 0);
  const trashed = await call(EMPTY, list({ trashed: true }));
  check("list accepts the trash view", isFinalPage(trashed) && trashed.response.items.length === 0);
  const more = await call(EMPTY, list({ after: NOTE, limit: 8 }));
  check("list accepts a cursor", isFinalPage(more) && more.response.next === null);
}

// === Reads that name one note: not_found, never a record ===================
for (const kind of ["get", "backlinks"]) {
  const res = await call(EMPTY, { kind, id: NOTE });
  check(`${kind} answers error not_found`, isError(res, "not_found"));
  check(`${kind} never returns a record`, res.response.kind !== "record");
  check(`${kind} echoes the profile`, res.profile === EMPTY);
}

// === Link resolution: nothing resolves, in the caller's order ===============
{
  const targets = ["Alpha", "beta", "Alpha"];
  const res = await call(EMPTY, { kind: "resolve", targets });
  check("resolve is a targets reply", res.response.kind === "targets");
  check("resolve echoes the profile", res.profile === EMPTY);
  check("resolve answers one item per target",
    res.response.items.length === targets.length);
  check("resolve keeps the caller's order",
    res.response.items.every((item, at) => item.target === targets[at]));
  check("resolve points at no note",
    res.response.items.every((item) => item.note === null));
}

{
  const res = await call(EMPTY, { kind: "resolve", targets: [] });
  check("resolve accepts no targets", res.response.kind === "targets" && res.response.items.length === 0);
}

// === Empty honesty: repeated reads never invent a note ======================
{
  const first = await call(EMPTY, list());
  const second = await call(EMPTY, list());
  check("repeated list calls stay empty and identical",
    JSON.stringify(first) === JSON.stringify(second) &&
    first.response.items.length === 0);
  const page = await call(EMPTY, list({ search: "x" }));
  check("searching an empty store stays empty",
    page.response.items.length === first.response.items.length);
  check("no note-shaped object is returned",
    first.response.items.every((item) => item === undefined || item === null));
}

// === Profile scoping =======================================================
{
  const mine = await call(EMPTY, list());
  const theirs = await call(OTHER, list());
  check("each reply echoes its own profile", mine.profile === EMPTY && theirs.profile === OTHER);
  check("no profile inherits notes",
    mine.response.items.length === 0 && theirs.response.items.length === 0);
  const alias = await Notes.call({ expected_profile: EMPTY, call: list() });
  check("the wire field expected_profile scopes the same way", alias.profile === EMPTY);
  const both = await Notes.call({ profile: OTHER, expected_profile: EMPTY, call: list() });
  check("profile wins over expected_profile", both.profile === OTHER);
}

// === Create: a note exists, and get returns it ==============================
{
  const before = changesFor(CREATED).length;
  const res = await call(CREATED, create("# A note\n\nBody text.", REQUEST));
  check("create is applied", isApplied(res));
  check("create echoes the profile", res.profile === CREATED);
  check("create echoes its request id", res.response.request_id === REQUEST);
  const summary = isApplied(res) ? res.response.summary : null;
  check("create answers a summary", summaryOk(summary));
  check("create mints a stable id", !!summary && /^note-\d+$/u.test(summary.id));
  check("create starts at revision 1", summary?.revision === "1");
  check("create titles from its heading", summary?.title === "A note");
  check("create previews the text after the heading", summary?.preview === "Body text.");
  check("create is not pinned", summary?.pinned === false);
  check("create is not trashed", summary?.trashed === false);
  check("create is editable", summary?.editable === true);
  check("create has no file path", summary?.path === "");

  const events = changesFor(CREATED);
  check("create announces notes-changed", events.length === before + 1);
  const change = events.at(-1);
  check("create announces this profile", change?.profile === CREATED);
  check("create announces the new note",
    change?.notes?.length === 1 &&
    change.notes[0].id === summary?.id &&
    change.notes[0].revision === "1");
  check("create announces a listing reset", change?.reset === true);
  check("create announces no link keys",
    Array.isArray(change?.links) && change.links.length === 0);

  const replay = await call(CREATED, create("# Different\n\nbody", REQUEST));
  check("a create replay returns the same note",
    isApplied(replay) && replay.response.summary.id === summary?.id);
  check("a create replay announces nothing", changesFor(CREATED).length === events.length);

  const got = await call(CREATED, { kind: "get", id: summary?.id });
  check("get returns the created record", isRecord(got));
  check("get keeps the markdown", got.response?.record?.markdown === "# A note\n\nBody text.");
  check("get keeps the revision", got.response?.record?.summary?.revision === "1");
  check("get keeps the title", got.response?.record?.summary?.title === "A note");
  check("get echoes the profile", got.profile === CREATED);

  const empty = await call(CREATED, create(""));
  check("create admits an empty note", isApplied(empty));
  check("an empty note has no title or preview",
    empty.response?.summary?.title === "" && empty.response?.summary?.preview === "");
  const emptyGot = await call(CREATED, { kind: "get", id: empty.response?.summary?.id });
  check("get returns the empty note", isRecord(emptyGot) && emptyGot.response.record.markdown === "");
  check("create gives each note its own id",
    empty.response?.summary?.id !== summary?.id);
}

// === Notes stay inside the profile that made them ==========================
{
  const mine = await call(CREATED, list());
  check("the creating profile lists its notes", mine.response.items.length === 2);
  const theirs = await call(OTHER, list());
  check("another profile lists none of them", theirs.response.items.length === 0);
  const first = mine.response.items[0];
  const otherGet = await call(OTHER, { kind: "get", id: first.id });
  check("another profile cannot get the note", isError(otherGet, "not_found"));
  const otherWrite = await call(OTHER, write(first.id, first.revision, "# Hijack\n\nno"));
  check("another profile cannot write the note", isError(otherWrite, "not_found"));
  const otherTrash = await call(OTHER, { kind: "trash", id: first.id });
  check("another profile cannot trash the note", isError(otherTrash, "not_found"));
  const otherDelete = await call(OTHER, { kind: "delete", id: first.id });
  check("another profile cannot delete the note", isError(otherDelete, "not_found"));
}

// === Write: revision, markdown and title move forward ======================
{
  const created = await call(WRITTEN, create("# Draft\n\nfirst"));
  const id = created.response.summary.id;
  const before = changesFor(WRITTEN).length;
  const res = await call(WRITTEN, write(id, "1", "# Final\n\nsecond"));
  check("write is applied", isApplied(res));
  check("write echoes its request id", res.response.request_id === REQUEST);
  const summary = res.response?.summary;
  check("write bumps the revision", summary?.revision === "2");
  check("write retitles from the new heading", summary?.title === "Final");
  check("write repreviews from the new text", summary?.preview === "second");
  check("write keeps the id", summary?.id === id);

  const events = changesFor(WRITTEN);
  check("write announces notes-changed", events.length === before + 1);
  const change = events.at(-1);
  check("write announces the new revision", change?.notes?.[0]?.revision === "2");
  check("write does not reset the listing", change?.reset === false);
  check("write announces both title link keys",
    change?.links?.includes("draft") && change?.links?.includes("final"));

  const got = await call(WRITTEN, { kind: "get", id });
  check("write stores the new markdown", got.response?.record?.markdown === "# Final\n\nsecond");
  check("write stores the new title", got.response?.record?.summary?.title === "Final");
  check("write stores the new revision", got.response?.record?.summary?.revision === "2");

  const staleBefore = changesFor(WRITTEN).length;
  const conflict = await call(WRITTEN, write(id, "1", "# Other\n\nother"));
  check("a stale base conflicts", conflict.response?.kind === "conflict");
  check("the conflict carries the current record", conflict.response?.current?.markdown === "# Final\n\nsecond");
  check("the conflict carries the current revision", conflict.response?.current?.summary?.revision === "2");
  check("the conflict names the same note", conflict.response?.current?.summary?.id === id);
  check("a conflict writes nothing", changesFor(WRITTEN).length === staleBefore);
  const after = await call(WRITTEN, { kind: "get", id });
  check("a conflict leaves the markdown alone", after.response?.record?.markdown === "# Final\n\nsecond");

  const sameBefore = changesFor(WRITTEN).length;
  const same = await call(WRITTEN, write(id, "1", "# Final\n\nsecond"));
  check("a replay of the same text applies without a new revision",
    isApplied(same) && same.response.summary.revision === "2");
  check("a replay of the same text announces nothing",
    changesFor(WRITTEN).length === sameBefore);

  const settledSame = await call(WRITTEN, write(id, "2", "# Final\n\nsecond", { settle: true }));
  check("a settling write of the same text keeps the revision",
    isApplied(settledSame) && settledSame.response.summary.revision === "2");
  check("a settling write of the same text announces nothing",
    changesFor(WRITTEN).length === sameBefore);

  const missing = await call(WRITTEN, write("note-9999", "1", "x"));
  check("writing a missing note is not_found", isError(missing, "not_found"));

  const settled = await call(WRITTEN, write(id, "2", "# Settled\n\nbody", { settle: true }));
  check("a settling write applies",
    isApplied(settled) &&
    settled.response.summary.revision === "3" &&
    settled.response.summary.title === "Settled");

  await call(WRITTEN, { kind: "trash", id });
  const readOnly = await call(WRITTEN, write(id, "3", "# Nope\n\nnope"));
  check("writing a trashed note is read_only", isError(readOnly, "read_only"));
  const still = await call(WRITTEN, { kind: "get", id });
  check("a refused write leaves the note alone",
    still.response?.record?.markdown === "# Settled\n\nbody");
  check("restoring after the write test applies",
    isApplied(await call(WRITTEN, { kind: "restore", id })));

  const blank = await call(WRITTEN, create(""));
  const filled = await call(WRITTEN, write(blank.response.summary.id, "1", "# Filled\n\nnow"));
  check("writing an empty note fills it",
    isApplied(filled) &&
    filled.response.summary.title === "Filled" &&
    filled.response.summary.preview === "now");
}

// === List: newest first, pages, search, trash filter =======================
{
  const made = [];
  for (const [heading, body] of [
    ["# One", "body one"],
    ["# Two", "body two"],
    ["# Three", "body three"],
    ["# Four", "body four"],
    ["# Five", "body five"],
  ]) {
    const res = await call(PAGED, create(`${heading}\n\n${body}`));
    made.push(res.response.summary.id);
  }

  const first = await call(PAGED, list({ limit: 2 }));
  check("list pages two notes", isPage(first) && first.response.items.length === 2);
  check("list is newest first",
    first.response.items[0].id === made[4] &&
    first.response.items[1].id === made[3]);
  check("list has a next cursor",
    typeof first.response.next === "string" && first.response.next !== "");

  const second = await call(PAGED, list({ after: first.response.next, limit: 2 }));
  check("the next page continues",
    second.response?.items?.map((note) => note.id).join() === [made[2], made[1]].join());
  check("the next page has a next cursor", typeof second.response.next === "string");

  const third = await call(PAGED, list({ after: second.response.next, limit: 2 }));
  check("the last page ends",
    third.response?.items?.length === 1 &&
    third.response.items[0].id === made[0] &&
    third.response.next === null);

  const seen = [
    ...first.response.items,
    ...second.response.items,
    ...third.response.items,
  ].map((note) => note.id);
  check("paging visits every note once", seen.length === 5 && new Set(seen).size === 5);

  const after = await call(PAGED, list({ after: made[2], limit: 10 }));
  check("an id cursor starts after that note",
    after.response?.items?.map((note) => note.id).join() === [made[1], made[0]].join());

  const unknown = await call(PAGED, list({ after: "note-9999", limit: 10 }));
  check("an unknown cursor ends the page",
    isFinalPage(unknown) && unknown.response.items.length === 0);

  const one = await call(PAGED, list({ limit: 1 }));
  check("a one-note page has a next cursor",
    one.response.items.length === 1 && one.response.next === made[4]);

  const search = await call(PAGED, list({ search: "body two" }));
  check("search finds the matching note",
    search.response?.items?.length === 1 && search.response.items[0].id === made[1]);
  const upper = await call(PAGED, list({ search: "BODY TWO" }));
  check("search ignores case",
    upper.response?.items?.length === 1 && upper.response.items[0].id === made[1]);
  const none = await call(PAGED, list({ search: "nothing here" }));
  check("search with no match is empty", isFinalPage(none) && none.response.items.length === 0);

  const trashed = await call(PAGED, { kind: "trash", id: made[2] });
  check("trash applies while paging",
    isApplied(trashed) && trashed.response.summary.trashed === true);
  const live = await call(PAGED, list({ limit: 10 }));
  check("the live list drops a trashed note",
    live.response.items.length === 4 &&
    !live.response.items.some((note) => note.id === made[2]));
  const trashView = await call(PAGED, list({ trashed: true, limit: 10 }));
  check("the trash view lists only the trashed note",
    trashView.response.items.length === 1 && trashView.response.items[0].id === made[2]);
  const trashedSearch = await call(PAGED, list({ trashed: true, search: "three" }));
  check("the trash view can search",
    trashedSearch.response.items.length === 1 &&
    trashedSearch.response.items[0].id === made[2]);
  const liveSearch = await call(PAGED, list({ search: "three" }));
  check("the live search hides the trashed note", liveSearch.response.items.length === 0);

  const restored = await call(PAGED, { kind: "restore", id: made[2] });
  check("restore returns the note to the live list",
    isApplied(restored) && restored.response.summary.trashed === false);
  const back = await call(PAGED, list({ limit: 10 }));
  check("the restored note is listed again", back.response.items.length === 5);

  const pinned = await call(PAGED, { kind: "set_pinned", id: made[0], pinned: true });
  check("set_pinned applies", isApplied(pinned) && pinned.response.summary.pinned === true);
  const pinnedList = await call(PAGED, list({ limit: 10 }));
  check("the pinned note comes first",
    pinnedList.response.items[0].id === made[0] &&
    pinnedList.response.items[0].pinned === true);
  const unpinned = await call(PAGED, { kind: "set_pinned", id: made[0], pinned: false });
  check("unpinning applies", isApplied(unpinned) && unpinned.response.summary.pinned === false);
  const newest = await call(PAGED, list({ limit: 10 }));
  check("newest is first again after unpinning", newest.response.items[0].id === made[4]);
}

// === Trash, restore, delete and pin change real state ======================
{
  const created = await call(STATE, create("# State\n\nbody"));
  const id = created.response.summary.id;
  const revision = created.response.summary.revision;
  const base = changesFor(STATE).length;

  const trashed = await call(STATE, { kind: "trash", id });
  check("trash applies", isApplied(trashed) && trashed.response.summary.trashed === true);
  check("trash keeps the revision", trashed.response.summary.revision === revision);
  let events = changesFor(STATE);
  check("trash announces notes-changed", events.length === base + 1);
  check("trash announces the note",
    events.at(-1)?.notes?.[0]?.id === id &&
    events.at(-1)?.notes?.[0]?.revision === revision);
  check("trash resets the listing", events.at(-1)?.reset === true);
  const gotTrashed = await call(STATE, { kind: "get", id });
  check("get still returns a trashed note",
    isRecord(gotTrashed) && gotTrashed.response.record.summary.trashed === true);
  const live = await call(STATE, list());
  check("the live list hides a trashed note", live.response.items.length === 0);
  const trash = await call(STATE, list({ trashed: true }));
  check("the trash list holds it",
    trash.response.items.length === 1 && trash.response.items[0].id === id);
  const trashedAgain = await call(STATE, { kind: "trash", id });
  check("trashing twice applies without a change",
    isApplied(trashedAgain) && changesFor(STATE).length === base + 1);

  const restored = await call(STATE, { kind: "restore", id });
  check("restore applies", isApplied(restored) && restored.response.summary.trashed === false);
  events = changesFor(STATE);
  check("restore announces notes-changed", events.length === base + 2);
  check("restore announces the note",
    events.at(-1)?.notes?.[0]?.id === id &&
    events.at(-1)?.notes?.[0]?.revision === revision);
  const gotRestored = await call(STATE, { kind: "get", id });
  check("get returns a restored note",
    isRecord(gotRestored) && gotRestored.response.record.summary.trashed === false);
  const restoredAgain = await call(STATE, { kind: "restore", id });
  check("restoring twice applies without a change",
    isApplied(restoredAgain) && changesFor(STATE).length === base + 2);

  const pinned = await call(STATE, { kind: "set_pinned", id, pinned: true });
  check("set_pinned applies", isApplied(pinned) && pinned.response.summary.pinned === true);
  check("set_pinned announces notes-changed",
    changesFor(STATE).length === base + 3 && changesFor(STATE).at(-1)?.reset === true);
  const gotPinned = await call(STATE, { kind: "get", id });
  check("get returns the pinned note",
    isRecord(gotPinned) && gotPinned.response.record.summary.pinned === true);
  const unpinned = await call(STATE, { kind: "set_pinned", id, pinned: false });
  check("unpinning applies", isApplied(unpinned) && unpinned.response.summary.pinned === false);
  check("unpinning announces notes-changed", changesFor(STATE).length === base + 4);

  const retrashed = await call(STATE, { kind: "trash", id });
  check("trashing again before delete applies",
    isApplied(retrashed) && retrashed.response.summary.trashed === true);
  check("the second trash announces notes-changed",
    changesFor(STATE).length === base + 5);

  const deleted = await call(STATE, { kind: "delete", id });
  check("delete is done", deleted.response?.kind === "done");
  check("delete announces notes-changed",
    changesFor(STATE).length === base + 6 &&
    changesFor(STATE).at(-1)?.notes?.[0]?.revision === null);
  check("delete removes the note",
    isError(await call(STATE, { kind: "get", id }), "not_found"));
  check("the live list stays empty", (await call(STATE, list())).response.items.length === 0);
  check("the trash list stays empty", (await call(STATE, list({ trashed: true }))).response.items.length === 0);
  check("deleting twice is not_found",
    isError(await call(STATE, { kind: "delete", id }), "not_found"));
  check("deleting a missing note is not_found",
    isError(await call(STATE, { kind: "delete", id: "note-9999" }), "not_found"));

  check("trashing a missing note is not_found",
    isError(await call(STATE, { kind: "trash", id: "note-9999" }), "not_found"));
  check("restoring a missing note is not_found",
    isError(await call(STATE, { kind: "restore", id: "note-9999" }), "not_found"));
  check("pinning a missing note is not_found",
    isError(await call(STATE, { kind: "set_pinned", id: "note-9999", pinned: true }), "not_found"));

  const liveNote = await call(STATE, create("# Live\n\nbody"));
  const liveId = liveNote.response.summary.id;
  check("deleting a live note is invalid",
    isError(await call(STATE, { kind: "delete", id: liveId }), "invalid"));
  check("the live note survives a refused delete",
    isRecord(await call(STATE, { kind: "get", id: liveId })));

  const links = await call(STATE, create("# Links\n\nbody"));
  const linksId = links.response.summary.id;
  const backlinks = await call(STATE, { kind: "backlinks", id: linksId });
  check("backlinks is an empty page", isFinalPage(backlinks) && backlinks.response.items.length === 0);
  check("backlinks for a missing note is not_found",
    isError(await call(STATE, { kind: "backlinks", id: "note-9999" }), "not_found"));

  for (const [name, payload] of [
    ["a note", { kind: "reveal", id: linksId }],
    ["the folder", { kind: "reveal", id: null }],
    ["a missing note", { kind: "reveal", id: "note-9999" }],
  ]) {
    const res = await call(STATE, payload);
    check(`reveal refuses ${name}`, isError(res, "unavailable"));
    check(`reveal never claims a change for ${name}`,
      res.response.kind !== "applied" &&
      res.response.kind !== "done" &&
      res.response.kind !== "record" &&
      res.response.kind !== "page");
    check(`reveal echoes the profile for ${name}`, res.profile === STATE);
  }
}

// === Malformed reads: the reply's own invalid, never a throw ===============
{
  const cases = [
    ["list without a query", { kind: "list" }],
    ["list with a null query", { kind: "list", query: null }],
    ["list with a string query", { kind: "list", query: "recent" }],
    ["list without a limit", { kind: "list", query: { search: "", trashed: false, after: null } }],
    ["list with a zero limit", list({ limit: 0 })],
    ["list with a fractional limit", list({ limit: 1.5 })],
    ["list with a string limit", list({ limit: "100" })],
    ["list past the page cap", list({ limit: 1001 })],
    ["list with an empty cursor", list({ after: "" })],
    ["list with a non-string search", list({ search: 7 })],
    ["list with an over-long search", list({ search: "a".repeat(513) })],
    ["list with a non-boolean trash flag", list({ trashed: "yes" })],
    ["get without an id", { kind: "get" }],
    ["get with an empty id", { kind: "get", id: "" }],
    ["get with a numeric id", { kind: "get", id: 7 }],
    ["backlinks without an id", { kind: "backlinks" }],
    ["resolve without targets", { kind: "resolve" }],
    ["resolve with a string", { kind: "resolve", targets: "Alpha" }],
    ["resolve with an empty key", { kind: "resolve", targets: [""] }],
    ["resolve with a numeric key", { kind: "resolve", targets: [1] }],
    ["resolve with too many keys", { kind: "resolve", targets: Array(1025).fill("a") }],
    ["create without a request id", { kind: "create", markdown: "x" }],
    ["create with an empty request id", { kind: "create", request_id: "", markdown: "x" }],
    ["create without markdown", { kind: "create", request_id: REQUEST }],
    ["create with non-string markdown", { kind: "create", request_id: REQUEST, markdown: 7 }],
    ["write without a request id", { kind: "write", id: NOTE, base_revision: "1", markdown: "x" }],
    ["write without a base revision", { kind: "write", request_id: REQUEST, id: NOTE, markdown: "x" }],
    ["write with an empty base revision", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "", markdown: "x" }],
    ["write without an id", { kind: "write", request_id: REQUEST, base_revision: "1", markdown: "x" }],
    ["write with non-string markdown", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "1", markdown: 7 }],
    ["write with a non-boolean settle", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "1", markdown: "x", settle: "yes" }],
    ["set_pinned with a non-boolean", { kind: "set_pinned", id: NOTE, pinned: "yes" }],
    ["set_pinned without an id", { kind: "set_pinned", pinned: true }],
    ["trash without an id", { kind: "trash" }],
    ["trash with an empty id", { kind: "trash", id: "" }],
    ["restore with an empty id", { kind: "restore", id: "" }],
    ["delete without an id", { kind: "delete" }],
    ["reveal with no id field", { kind: "reveal" }],
    ["reveal with a numeric id", { kind: "reveal", id: 7 }],
  ];
  for (const [name, payload] of cases) {
    const res = await call(MALFORMED, payload);
    check(`${name} is invalid`, isError(res, "invalid"));
    check(`${name} echoes the profile`, res.profile === MALFORMED);
  }
}

// === Unknown kinds and non-calls: invalid, no crash =========================
for (const kind of ["delete_all", "sync", "entries", ""]) {
  const res = await call(MALFORMED, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isError(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === MALFORMED);
}

{
  const noKind = await call(MALFORMED, { id: NOTE });
  check("a call without a kind is invalid", isError(noKind, "invalid"));

  const nullCall = await call(MALFORMED, null);
  check("a null call is invalid", isError(nullCall, "invalid"));

  const arrayCall = await call(MALFORMED, []);
  check("an array call is invalid", isError(arrayCall, "invalid"));

  const stringCall = await call(MALFORMED, "list");
  check("a string call is invalid", isError(stringCall, "invalid"));
}

// === A call without a profile answers with none, and stays invalid ==========
{
  const noProfile = await Notes.call({ call: list() });
  check("a call without a profile is invalid",
    isError(noProfile, "invalid") && noProfile.profile === null);

  const badProfile = await Notes.call({ profile: 42, call: list() });
  check("a non-string profile is invalid",
    isError(badProfile, "invalid") && badProfile.profile === null);

  const emptyProfile = await Notes.call({ profile: "", expected_profile: "", call: list() });
  check("an empty profile is invalid",
    isError(emptyProfile, "invalid") && emptyProfile.profile === null);

  const nothing = await Notes.call();
  check("no arguments is invalid, not a throw",
    isError(nothing, "invalid") && nothing.profile === null);

  const nullArgs = await Notes.call(null);
  check("null arguments is invalid, not a throw",
    isError(nullArgs, "invalid") && nullArgs.profile === null);
}

// === Envelope and error-code invariants ====================================
{
  const matrix = [
    list(),
    { kind: "get", id: NOTE },
    { kind: "backlinks", id: NOTE },
    { kind: "resolve", targets: ["Alpha"] },
    create("# Matrix\n\nbody"),
    { kind: "list", query: null },
    { kind: "teleport" },
    null,
  ];
  let wellFormed = true;
  let codesKnown = true;
  for (const payload of matrix) {
    const res = await call(INVARIANT, payload);
    if (
      !res || typeof res !== "object" ||
      !Object.hasOwn(res, "profile") || res.profile !== INVARIANT ||
      !res.response || typeof res.response !== "object" ||
      !RESPONSE_KINDS.has(res.response.kind)
    ) {
      wellFormed = false;
    }
    if (res.response.kind === "error" && !NOTE_ERRORS.has(res.response.error)) {
      codesKnown = false;
    }
  }
  check("every reply is a NoteReply with the echoed profile", wellFormed);
  check("every error code is a declared NoteError", codesKnown);
}

// === The module never throws ===============================================
{
  let threw = false;
  const hostile = [
    { kind: "list", get query() { throw new Error("boom"); } },
    { kind: "list", query: { get search() { throw new Error("boom"); } } },
    { kind: "get", get id() { throw new Error("boom"); } },
    { kind: "resolve", get targets() { throw new Error("boom"); } },
    { kind: "create", request_id: REQUEST, get markdown() { throw new Error("boom"); } },
    { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "1", get markdown() { throw new Error("boom"); } },
    { kind: "set_pinned", get id() { throw new Error("boom"); }, pinned: true },
    { kind: "trash", get id() { throw new Error("boom"); } },
    { get kind() { throw new Error("boom"); } },
    Object.create(null),
    { kind: "get", id: { toString: () => NOTE } },
    new Proxy({}, { get() { throw new Error("boom"); } }),
  ];
  for (const bad of hostile) {
    try {
      const res = await call(HOSTILE, bad);
      if (!res || !res.response || res.response.kind !== "error") threw = true;
      if (res.response && !NOTE_ERRORS.has(res.response.error)) threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);
  const after = await call(HOSTILE, list());
  check("hostile payloads change nothing", after.response.items.length === 0);
}

stopChanges();
console.log(`\nnotes_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

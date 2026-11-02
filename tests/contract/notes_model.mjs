#!/usr/bin/env node
// Notes module contract (wiring): `note_call` answers the UI's Notes panel
// natively instead of failing with `unknown_command`.
//
//   - the reads the panel makes when it opens (`list`, `get`, `backlinks`,
//     `resolve`) answer well-formed `NoteReply` variants: the host holds no
//     notes, and it never invents one
//   - `list` answers an empty final page, so the panel shows its empty state
//     instead of "notes are unavailable"
//   - `get` and `backlinks` answer `not_found`, not a record: the listing is
//     authoritative and empty
//   - `resolve` answers one `null` note per link key, in the caller's order
//   - every call that would create, change or remove a file answers the
//     reply's own `error: "unavailable"` — never `applied` or `done`
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
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

const { Notes } = await import(path.join(HOST, "Notes.sys.mjs"));

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

const P = "00000000000000000000000001";
const OTHER = "00000000000000000000000002";
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
  !!res && !!res.response && res.response.kind === "error" && res.response.error === code;

const isPage = (res) =>
  !!res && !!res.response && res.response.kind === "page" &&
  Array.isArray(res.response.items) && res.response.next === null;

const list = (over = {}) =>
  ({ kind: "list", query: { search: "", trashed: false, after: null, limit: 100, ...over } });

// === The read the panel opens with: an empty, final page ====================
{
  const res = await call(P, list());
  check("list is a page reply", res.response.kind === "page");
  check("list echoes the profile", res.profile === P);
  check("list holds no notes", isPage(res) && res.response.items.length === 0);
  check("list has no next page", res.response.next === null);
  check("list is not an error", res.response.kind !== "error");
}

{
  const searched = await call(P, list({ search: "meeting", trashed: false }));
  check("list accepts a search", isPage(searched) && searched.response.items.length === 0);
  const trashed = await call(P, list({ trashed: true }));
  check("list accepts the trash view", isPage(trashed) && trashed.response.items.length === 0);
  const more = await call(P, list({ after: "0000000000000000000000000c", limit: 8 }));
  check("list accepts a cursor", isPage(more) && more.response.next === null);
}

// === Reads that name one note: not_found, never a record ===================
for (const kind of ["get", "backlinks"]) {
  const res = await call(P, { kind, id: NOTE });
  check(`${kind} answers error not_found`, isError(res, "not_found"));
  check(`${kind} never returns a record`, res.response.kind !== "record");
  check(`${kind} echoes the profile`, res.profile === P);
}

// === Link resolution: nothing resolves, in the caller's order ===============
{
  const targets = ["Alpha", "beta", "Alpha"];
  const res = await call(P, { kind: "resolve", targets });
  check("resolve is a targets reply", res.response.kind === "targets");
  check("resolve echoes the profile", res.profile === P);
  check("resolve answers one item per target",
    res.response.items.length === targets.length);
  check("resolve keeps the caller's order",
    res.response.items.every((item, at) => item.target === targets[at]));
  check("resolve points at no note",
    res.response.items.every((item) => item.note === null));
}

{
  const res = await call(P, { kind: "resolve", targets: [] });
  check("resolve accepts no targets", res.response.kind === "targets" && res.response.items.length === 0);
}

// === Empty honesty: repeated reads never invent a note ======================
{
  const first = await call(P, list());
  const second = await call(P, list());
  check("repeated list calls stay empty and identical",
    JSON.stringify(first) === JSON.stringify(second) &&
    first.response.items.length === 0);
  const page = await call(P, list({ search: "x" }));
  check("searching an empty store stays empty",
    page.response.items.length === first.response.items.length);
  check("no note-shaped object is returned",
    first.response.items.every((item) => item === undefined || item === null));
}

// === Profile scoping =======================================================
{
  const mine = await call(P, list());
  const theirs = await call(OTHER, list());
  check("each reply echoes its own profile", mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits notes",
    mine.response.items.length === 0 && theirs.response.items.length === 0);
  const alias = await Notes.call({ expected_profile: P, call: list() });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
  const both = await Notes.call({ profile: OTHER, expected_profile: P, call: list() });
  check("profile wins over expected_profile", both.profile === OTHER);
}

// === Calls that would write: error, never a fake success ====================
const WRITES = [
  ["create", { kind: "create", request_id: REQUEST, markdown: "# A note" }],
  ["create empty", { kind: "create", request_id: REQUEST, markdown: "" }],
  ["write", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "rev-1", markdown: "# A note" }],
  ["write settled", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "rev-1", markdown: "x", settle: true }],
  ["set_pinned", { kind: "set_pinned", id: NOTE, pinned: true }],
  ["unpin", { kind: "set_pinned", id: NOTE, pinned: false }],
  ["trash", { kind: "trash", id: NOTE }],
  ["restore", { kind: "restore", id: NOTE }],
  ["delete", { kind: "delete", id: NOTE }],
  ["reveal note", { kind: "reveal", id: NOTE }],
  ["reveal folder", { kind: "reveal", id: null }],
];

for (const [name, payload] of WRITES) {
  const res = await call(P, payload);
  check(`${name} answers error unavailable`, isError(res, "unavailable"));
  check(`${name} never claims a change`,
    res.response.kind !== "applied" && res.response.kind !== "done" &&
    res.response.kind !== "record" && res.response.kind !== "page");
  check(`${name} echoes the profile`, res.profile === P);
}

// === Malformed reads: the reply's own invalid, never a throw ================
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
    ["create without markdown", { kind: "create", request_id: REQUEST }],
    ["create with non-string markdown", { kind: "create", request_id: REQUEST, markdown: 7 }],
    ["write without a base revision", { kind: "write", request_id: REQUEST, id: NOTE, markdown: "x" }],
    ["write without an id", { kind: "write", request_id: REQUEST, base_revision: "rev-1", markdown: "x" }],
    ["write with a non-boolean settle", { kind: "write", request_id: REQUEST, id: NOTE, base_revision: "rev-1", markdown: "x", settle: "yes" }],
    ["set_pinned with a non-boolean", { kind: "set_pinned", id: NOTE, pinned: "yes" }],
    ["set_pinned without an id", { kind: "set_pinned", pinned: true }],
    ["trash without an id", { kind: "trash" }],
    ["restore with an empty id", { kind: "restore", id: "" }],
    ["delete without an id", { kind: "delete" }],
    ["reveal with no id field", { kind: "reveal" }],
    ["reveal with a numeric id", { kind: "reveal", id: 7 }],
  ];
  for (const [name, payload] of cases) {
    const res = await call(P, payload);
    check(`${name} is invalid`, isError(res, "invalid"));
    check(`${name} echoes the profile`, res.profile === P);
  }
}

// === Unknown kinds and non-calls: invalid, no crash =========================
for (const kind of ["delete_all", "sync", "entries", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isError(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: NOTE });
  check("a call without a kind is invalid", isError(noKind, "invalid"));

  const nullCall = await call(P, null);
  check("a null call is invalid", isError(nullCall, "invalid"));

  const arrayCall = await call(P, []);
  check("an array call is invalid", isError(arrayCall, "invalid"));

  const stringCall = await call(P, "list");
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
}

// === Envelope and error-code invariants ====================================
{
  const matrix = [
    list(),
    { kind: "get", id: NOTE },
    { kind: "backlinks", id: NOTE },
    { kind: "resolve", targets: ["Alpha"] },
    ...WRITES.map(([, payload]) => payload),
    { kind: "list", query: null },
    { kind: "teleport" },
    null,
  ];
  let wellFormed = true;
  let codesKnown = true;
  for (const payload of matrix) {
    const res = await call(P, payload);
    if (
      !res || typeof res !== "object" ||
      !Object.hasOwn(res, "profile") || res.profile !== P ||
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
    { kind: "get", get id() { throw new Error("boom"); } },
    { kind: "resolve", get targets() { throw new Error("boom"); } },
    { get kind() { throw new Error("boom"); } },
    Object.create(null),
    { kind: "get", id: { toString: () => NOTE } },
    new Proxy({}, { get() { throw new Error("boom"); } }),
  ];
  for (const bad of hostile) {
    try {
      const res = await call(P, bad);
      if (!res || !res.response || res.response.kind !== "error") threw = true;
      if (res.response && !NOTE_ERRORS.has(res.response.error)) threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);
}

console.log(`\nnotes_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

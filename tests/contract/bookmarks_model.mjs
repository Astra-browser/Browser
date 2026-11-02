#!/usr/bin/env node
// Bookmarks module contract (wiring): `bookmark_call` answers the UI's
// Bookmarks panel natively instead of failing with `unknown_command`.
//
//   - the reads the panel makes (`list`, `reveal`, `search`) answer
//     well-formed replies with no items: the host holds no bookmarks and no
//     folders, and it never invents either
//   - `list` at the top level is an empty listing; a named folder and a
//     revealed id answer `missing`, which is how the panel falls back up
//   - the profile the caller asked for is echoed on every reply, so no
//     profile's state can be read as another's
//   - every write (`add_folder`, `add_link`, `rename`, `move`, `remove`)
//     answers the reply's own `error: "unavailable"` — never a fake `saved`
//     and never a minted id
//   - a malformed or unknown call answers `error: "invalid"` and never throws
//
// Usage: node tests/contract/bookmarks_model.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const HOST = path.join(ROOT, "overlay", "astra", "host");

const { Bookmarks } = await import(path.join(HOST, "Bookmarks.sys.mjs"));

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
const FOLDER = "0000000000000000000000000a";
const BOOKMARK = "0000000000000000000000000b";
const URL = "https://astra.example/docs";

/** The reply kinds `BookmarkResponse` allows. */
const KINDS = new Set(["listing", "results", "saved", "error"]);
/** The codes `BookmarkError` allows. */
const ERRORS = new Set([
  "missing",
  "full",
  "cycle",
  "invalid",
  "unavailable",
  "capacity",
]);

const call = (profile, body) => Bookmarks.call({ profile, call: body });
const isRefusal = (res, code) =>
  !!res && res.kind === "error" && res.error === code;

/** Every reply is one `BookmarkResponse` variant with the profile echoed. */
function wellFormed(res, profile) {
  return (
    !!res &&
    typeof res === "object" &&
    KINDS.has(res.kind) &&
    res.profile === profile
  );
}

// === Read-only calls: well-formed, empty, honest ============================
{
  const res = await call(P, { kind: "list", folder: null });
  check("list is a listing reply", res.kind === "listing");
  check("list echoes the profile", res.profile === P);
  check("the top level has no folder in view", res.folder === null);
  check("the top level has no crumbs", Array.isArray(res.path) && res.path.length === 0);
  check("the top level holds no items", Array.isArray(res.items) && res.items.length === 0);
}

{
  const res = await call(P, { kind: "search", query: "astra" });
  check("search is a results reply", res.kind === "results");
  check("search echoes the profile", res.profile === P);
  check("search matches nothing in an empty tree",
    Array.isArray(res.items) && res.items.length === 0);
}

{
  const res = await call(P, { kind: "reveal", id: BOOKMARK });
  check("reveal of a stored bookmark is missing", isRefusal(res, "missing"));
  check("reveal echoes the profile", res.profile === P);
  check("reveal never names a folder it does not have", res.folder === undefined);
}

{
  const res = await call(P, { kind: "list", folder: FOLDER });
  check("a folder the host does not have is missing", isRefusal(res, "missing"));
  check("the missing folder is not painted as a listing", res.kind !== "listing");
  check("a missing folder echoes the profile", res.profile === P);
}

// === Empty honesty: repeated reads never invent an entry ====================
{
  const first = await call(P, { kind: "list", folder: null });
  const second = await call(P, { kind: "list", folder: null });
  check("repeated listings stay empty",
    JSON.stringify(first) === JSON.stringify(second) && first.items.length === 0);

  const search = await call(P, { kind: "search", query: "astra" });
  check("list and search agree on an empty set",
    search.items.length === first.items.length);
  check("no bookmark-shaped object is returned",
    [...first.items, ...search.items].every((item) => item === undefined || item === null));
  check("no crumb is returned", first.path.length === 0 && search.path === undefined);

  const reveal = await call(P, { kind: "reveal", id: BOOKMARK });
  check("reveal agrees with the empty tree", isRefusal(reveal, "missing"));
  check("nothing is ever saved by a read",
    [first, second, search, reveal].every((res) => res.kind !== "saved"));
}

// === Profile scoping =======================================================
{
  const mine = await call(P, { kind: "list", folder: null });
  const theirs = await call(OTHER, { kind: "search", query: "astra" });
  check("each reply echoes its own profile", mine.profile === P && theirs.profile === OTHER);
  check("no profile inherits items", mine.items.length === 0 && theirs.items.length === 0);
  const alias = await Bookmarks.call({
    expected_profile: P,
    call: { kind: "list", folder: null },
  });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
  check("a scoped reply is still well formed", wellFormed(alias, P));
}

// === Writes: the reply's own refusal, never a fake success =================
const WRITES = [
  ["add_folder", { kind: "add_folder", parent: null, title: "Reading" }],
  ["add_folder in a folder", { kind: "add_folder", parent: FOLDER, title: "Reading" }],
  ["add_link", { kind: "add_link", parent: null, title: "Docs", url: URL }],
  ["add_link with an empty title", { kind: "add_link", parent: FOLDER, title: "", url: URL }],
  ["rename", { kind: "rename", id: BOOKMARK, title: "Docs" }],
  ["move", { kind: "move", id: BOOKMARK, parent: null, index: 0 }],
  ["move to the end", { kind: "move", id: BOOKMARK, parent: FOLDER, index: 0xffff_ffff }],
  ["remove", { kind: "remove", id: BOOKMARK }],
];
for (const [name, body] of WRITES) {
  const res = await call(P, body);
  check(`${name} answers error unavailable`, isRefusal(res, "unavailable"));
  check(`${name} never claims a save`, res.kind !== "saved");
  check(`${name} mints no id`, res.id === undefined);
  check(`${name} echoes the profile`, res.profile === P);
}

{
  // The panel reads back after a write; a refused write must leave the tree
  // empty rather than half-applied.
  await call(P, { kind: "add_link", parent: null, title: "Docs", url: URL });
  const after = await call(P, { kind: "list", folder: null });
  check("a refused write leaves the tree empty",
    after.kind === "listing" && after.items.length === 0);

  // `bookmark.add` goes through `run_command`, not this module; it must not
  // turn into a save here either.
  const command = await call(P, { kind: "add", url: URL });
  check("a command-shaped add is refused, not saved",
    isRefusal(command, "invalid") && command.kind !== "saved");
}

// === Malformed writes: invalid, not unavailable ============================
const MALFORMED_WRITES = [
  ["add_folder without a title", { kind: "add_folder", parent: null }],
  ["add_folder with an empty title", { kind: "add_folder", parent: null, title: "" }],
  ["add_folder with a numeric parent", { kind: "add_folder", parent: 7, title: "Reading" }],
  ["add_link without a url", { kind: "add_link", parent: null, title: "Docs" }],
  ["add_link with an empty url", { kind: "add_link", parent: null, title: "Docs", url: "" }],
  ["add_link with a numeric title", { kind: "add_link", parent: null, title: 7, url: URL }],
  ["rename without an id", { kind: "rename", title: "Docs" }],
  ["rename with an empty id", { kind: "rename", id: "", title: "Docs" }],
  ["move without an index", { kind: "move", id: BOOKMARK, parent: null }],
  ["move with a fractional index", { kind: "move", id: BOOKMARK, parent: null, index: 1.5 }],
  ["move with a negative index", { kind: "move", id: BOOKMARK, parent: null, index: -1 }],
  ["move with a string index", { kind: "move", id: BOOKMARK, parent: null, index: "0" }],
  ["remove without an id", { kind: "remove" }],
  ["remove with an empty id", { kind: "remove", id: "" }],
];
for (const [name, body] of MALFORMED_WRITES) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} never claims a save`, res.kind !== "saved");
}

// === Malformed reads: invalid, not a guess =================================
const MALFORMED_READS = [
  ["list without a folder", { kind: "list" }],
  ["list with an empty folder", { kind: "list", folder: "" }],
  ["list with a numeric folder", { kind: "list", folder: 7 }],
  ["search without a query", { kind: "search" }],
  ["search with an empty query", { kind: "search", query: "" }],
  ["search with a blank query", { kind: "search", query: "   " }],
  ["search with a numeric query", { kind: "search", query: 7 }],
  ["search past the panel's cap", { kind: "search", query: "a".repeat(513) }],
  ["reveal without an id", { kind: "reveal" }],
  ["reveal with an empty id", { kind: "reveal", id: "" }],
];
for (const [name, body] of MALFORMED_READS) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} echoes the profile`, res.profile === P);
}

{
  const longest = await call(P, { kind: "search", query: "a".repeat(512) });
  check("a query at the panel's cap is accepted",
    longest.kind === "results" && longest.items.length === 0);
}

// === Malformed and unknown calls: the reply's own error, no crash ==========
for (const kind of ["tree", "teleport", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isRefusal(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: BOOKMARK });
  check("a call without a kind is invalid", isRefusal(noKind, "invalid"));

  const nullCall = await call(P, null);
  check("a null call is invalid", isRefusal(nullCall, "invalid"));

  const arrayCall = await call(P, []);
  check("an array call is invalid", isRefusal(arrayCall, "invalid"));

  const noProfile = await Bookmarks.call({ call: { kind: "list", folder: null } });
  check("a call without a profile is invalid",
    isRefusal(noProfile, "invalid") && noProfile.profile === "");

  const badProfile = await Bookmarks.call({
    profile: 42,
    call: { kind: "list", folder: null },
  });
  check("a non-string profile is invalid", isRefusal(badProfile, "invalid"));

  const emptyProfile = await Bookmarks.call({
    profile: "",
    expected_profile: "",
    call: { kind: "list", folder: null },
  });
  check("an empty profile is invalid", isRefusal(emptyProfile, "invalid"));

  const nothing = await Bookmarks.call();
  check("no arguments is invalid, not a throw", isRefusal(nothing, "invalid"));
}

// === Every refusal stays inside BookmarkError ==============================
{
  const replies = [
    await call(P, { kind: "list", folder: null }),
    await call(P, { kind: "search", query: "astra" }),
    await call(P, { kind: "reveal", id: BOOKMARK }),
    await call(P, { kind: "remove", id: BOOKMARK }),
    await call(P, { kind: "nope" }),
  ];
  check("every reply is a BookmarkResponse variant",
    replies.every((res) => wellFormed(res, P)));
  check("every error code is a BookmarkError",
    replies
      .filter((res) => res.kind === "error")
      .every((res) => ERRORS.has(res.error)));
}

// === The module never throws ===============================================
{
  let threw = false;
  const hostile = [
    { kind: "list", folder: null, extra: () => {} },
    Object.create(null),
    { kind: "search", query: { toString: () => "astra" } },
    { kind: "remove", id: { toString: () => BOOKMARK } },
    {
      get kind() {
        throw new Error("hostile payload");
      },
    },
  ];
  for (const bad of hostile) {
    try {
      const res = await call(P, bad);
      if (!wellFormed(res, P)) threw = true;
    } catch {
      threw = true;
    }
  }
  check("hostile payloads answer instead of throwing", threw === false);
}

console.log(`\nbookmarks_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

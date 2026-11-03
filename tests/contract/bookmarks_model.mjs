#!/usr/bin/env node
// Bookmarks module contract: `bookmark_call` answers the UI's Bookmarks panel
// from the real Places store (in Node: the injectable in-memory backend).
//
//   - the top level is Places' "Other Bookmarks" root, listed as
//     `folder: null` with no crumbs
//   - adds, renames, moves and removes are applied and read back; folders
//     list before links and a folder reports its direct child count
//   - `path` runs from the top down to the shown folder, the shown folder
//     last, the root never a crumb
//   - `reveal` answers the listing of the item's parent; `search` matches
//     title and URL case-insensitively across the tree, bounded
//   - every write answers `saved`; invalid input is `invalid`, an unknown id
//     or folder is `missing`, a folder moved into itself is `cycle`
//   - every reply echoes the profile the caller asked for
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

const Mod = await import(path.join(HOST, "Bookmarks.sys.mjs"));
const { Bookmarks, __resetBookmarksForTests, __setBookmarksBackend } = Mod;

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
const URL = "https://astra.example/docs";
const ROOT_GUID = "unfiled_____";

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

/** A listing item is shaped as `BookmarkView` and belongs to `parent`. */
function isView(item, parent) {
  return (
    !!item &&
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    (item.url === null || typeof item.url === "string") &&
    item.icon === null &&
    Number.isInteger(item.children) &&
    item.children >= 0 &&
    (item.parent === null || typeof item.parent === "string") &&
    (parent === undefined || item.parent === parent)
  );
}

__resetBookmarksForTests();

// === The top level starts empty ============================================
{
  const res = await call(P, { kind: "list", folder: null });
  check("list is a listing reply", res.kind === "listing");
  check("list echoes the profile", res.profile === P);
  check("the top level has no folder in view", res.folder === null);
  check("the top level has no crumbs", Array.isArray(res.path) && res.path.length === 0);
  check("the top level starts empty", Array.isArray(res.items) && res.items.length === 0);
}

// === A folder and a link are stored and read back ==========================
let folderId;
let linkId;
{
  const folder = await call(P, { kind: "add_folder", parent: null, title: "Reading" });
  check("add_folder is saved", folder.kind === "saved" && folder.profile === P);
  check("add_folder mints a guid", typeof folder.id === "string" && folder.id !== "");
  folderId = folder.id;

  const link = await call(P, {
    kind: "add_link",
    parent: folderId,
    title: "Docs",
    url: URL,
  });
  check("add_link is saved", link.kind === "saved" && link.profile === P);
  check("add_link mints a distinct guid",
    typeof link.id === "string" && link.id !== "" && link.id !== folderId);
  linkId = link.id;

  const top = await call(P, { kind: "list", folder: null });
  check("the top level holds the new folder", top.items.length === 1);
  check("the top level item is the folder", top.items[0].id === folderId);
  check("the folder has its title", top.items[0].title === "Reading");
  check("a folder has no url", top.items[0].url === null);
  check("the icon is left unwired", top.items[0].icon === null);
  check("a folder reports its direct child count", top.items[0].children === 1);
  check("a top-level item names no parent", top.items[0].parent === null);
  check("the top-level item is a BookmarkView", isView(top.items[0], null));

  const inside = await call(P, { kind: "list", folder: folderId });
  check("the folder listing names the folder", inside.folder === folderId);
  check("the folder listing has one crumb", inside.path.length === 1);
  check("the crumb is the folder itself",
    inside.path[0].id === folderId && inside.path[0].title === "Reading");
  check("the folder holds the link", inside.items.length === 1);
  check("the link keeps its title", inside.items[0].title === "Docs");
  check("the link keeps its url", inside.items[0].url === URL);
  check("the link reports its parent", inside.items[0].parent === folderId);
  check("a link has no children", inside.items[0].children === 0);
  check("the link is a BookmarkView", isView(inside.items[0], folderId));
}

// === Direct child counts and nesting =======================================
let archiveId;
let oldId;
{
  const archive = await call(P, {
    kind: "add_folder",
    parent: folderId,
    title: "Archive",
  });
  check("a nested folder is saved", archive.kind === "saved");
  archiveId = archive.id;

  const old = await call(P, {
    kind: "add_link",
    parent: archiveId,
    title: "Old",
    url: "https://astra.example/old",
  });
  check("a link in a nested folder is saved", old.kind === "saved");
  oldId = old.id;

  const reading = await call(P, { kind: "list", folder: folderId });
  check("folders list before links", reading.items.length === 2);
  check("the first item is the folder", reading.items[0].id === archiveId);
  check("the folder reports its direct child count",
    reading.items[0].children === 1);
  check("the link comes second", reading.items[1].id === linkId);

  const archiveListing = await call(P, { kind: "list", folder: archiveId });
  check("a nested folder lists its link", archiveListing.items.length === 1);
  check("the nested link is the old page", archiveListing.items[0].id === oldId);
  check("crumbs run top-down with the shown folder last",
    archiveListing.path.map((crumb) => crumb.id).join(",") ===
      [folderId, archiveId].join(","));
  check("the root is not a crumb",
    archiveListing.path.every((crumb) => crumb.id !== ROOT_GUID));
}

// === Missing folders and ids ==============================================
{
  const missingFolder = await call(P, {
    kind: "list",
    folder: "000000000000000000000000ff",
  });
  check("an unknown folder is missing", isRefusal(missingFolder, "missing"));
  check("a missing folder echoes the profile", missingFolder.profile === P);
  check("a missing folder is not painted as a listing",
    missingFolder.kind !== "listing");

  const outside = await call(P, { kind: "list", folder: "toolbar_____" });
  check("a folder outside the panel tree is missing", isRefusal(outside, "missing"));

  const unknownReveal = await call(P, {
    kind: "reveal",
    id: "000000000000000000000000ff",
  });
  check("revealing an unknown id is missing", isRefusal(unknownReveal, "missing"));
  check("reveal echoes the profile", unknownReveal.profile === P);
}

// === Reveal answers the parent listing ====================================
{
  const reveal = await call(P, { kind: "reveal", id: linkId });
  check("reveal is a listing", reveal.kind === "listing");
  check("reveal shows the item's folder", reveal.folder === folderId);
  check("reveal lists the siblings", reveal.items.some((item) => item.id === linkId));
  check("reveal carries the path to the folder",
    reveal.path.length === 1 && reveal.path[0].id === folderId);

  const revealTop = await call(P, { kind: "reveal", id: folderId });
  check("revealing a top-level item lists the top level",
    revealTop.kind === "listing" && revealTop.folder === null && revealTop.path.length === 0);
}

// === Search matches title and url, case-insensitively =====================
{
  const byTitle = await call(P, { kind: "search", query: "docs" });
  check("search is a results reply", byTitle.kind === "results");
  check("search echoes the profile", byTitle.profile === P);
  check("search finds by title", byTitle.items.some((item) => item.id === linkId));
  check("search results are BookmarkViews",
    byTitle.items.every((item) => isView(item)));
  check("search results name their parent",
    byTitle.items.find((item) => item.id === linkId).parent === folderId);

  const byUrl = await call(P, { kind: "search", query: "ASTRA.EXAMPLE/OLD" });
  check("search finds by url, case-insensitively",
    byUrl.items.some((item) => item.id === oldId));

  const folderHit = await call(P, { kind: "search", query: "READING" });
  check("search finds folders by title",
    folderHit.items.some((item) => item.id === folderId));

  const none = await call(P, { kind: "search", query: "no-such-bookmark" });
  check("a search with no match is an empty result",
    none.kind === "results" && none.items.length === 0);

  const atCap = await call(P, { kind: "search", query: "a".repeat(512) });
  check("a query at the panel's cap is accepted", atCap.kind === "results");
}

// === Rename ===============================================================
{
  const renamed = await call(P, { kind: "rename", id: linkId, title: "Handbook" });
  check("rename is saved", renamed.kind === "saved" && renamed.profile === P);
  check("rename creates nothing", renamed.id === null);

  const reading = await call(P, { kind: "list", folder: folderId });
  check("rename is read back",
    reading.items.find((item) => item.id === linkId).title === "Handbook");

  check("renaming an unknown id is missing",
    isRefusal(await call(P, { kind: "rename", id: "nope", title: "x" }), "missing"));
  check("renaming the panel root is invalid",
    isRefusal(await call(P, { kind: "rename", id: ROOT_GUID, title: "x" }), "invalid"));
}

// === Move =================================================================
let secondId;
{
  const second = await call(P, {
    kind: "add_link",
    parent: folderId,
    title: "Second",
    url: "https://astra.example/second",
  });
  secondId = second.id;

  const toTop = await call(P, {
    kind: "move",
    id: secondId,
    parent: null,
    index: 0,
  });
  check("move is saved", toTop.kind === "saved" && toTop.profile === P);
  check("move creates nothing", toTop.id === null);

  const top = await call(P, { kind: "list", folder: null });
  check("the moved link is at the top level",
    top.items.some((item) => item.id === secondId && item.parent === null));
  check("folders still list before the moved link",
    top.items[0].id === folderId && top.items[1].id === secondId);

  await call(P, { kind: "move", id: secondId, parent: folderId, index: 0 });
  let reading = await call(P, { kind: "list", folder: folderId });
  check("move to an index orders the links after the folders",
    reading.items.map((item) => item.id).join(",") ===
      [archiveId, secondId, linkId].join(","));

  await call(P, { kind: "move", id: secondId, parent: folderId, index: 0xffff_ffff });
  reading = await call(P, { kind: "list", folder: folderId });
  check("the append index puts the link last",
    reading.items.map((item) => item.id).join(",") ===
      [archiveId, linkId, secondId].join(","));

  await call(P, { kind: "move", id: linkId, parent: folderId, index: 2 });
  reading = await call(P, { kind: "list", folder: folderId });
  check("an index past the links moves the item down",
    reading.items.map((item) => item.id).join(",") ===
      [archiveId, secondId, linkId].join(","));

  await call(P, { kind: "move", id: linkId, parent: folderId, index: 0 });
  reading = await call(P, { kind: "list", folder: folderId });
  check("an index at the front moves the item up",
    reading.items.map((item) => item.id).join(",") ===
      [archiveId, linkId, secondId].join(","));

  check("moving a folder into itself is a cycle",
    isRefusal(await call(P, { kind: "move", id: folderId, parent: folderId, index: 0 }), "cycle"));
  check("moving a folder into its descendant is a cycle",
    isRefusal(await call(P, { kind: "move", id: folderId, parent: archiveId, index: 0 }), "cycle"));

  check("moving an unknown id is missing",
    isRefusal(await call(P, { kind: "move", id: "nope", parent: null, index: 0 }), "missing"));
  check("moving into an unknown folder is missing",
    isRefusal(await call(P, { kind: "move", id: linkId, parent: "nope", index: 0 }), "missing"));
  check("moving into a link is invalid",
    isRefusal(await call(P, { kind: "move", id: linkId, parent: secondId, index: 0 }), "invalid"));
  check("moving the panel root is invalid",
    isRefusal(await call(P, { kind: "move", id: ROOT_GUID, parent: null, index: 0 }), "invalid"));
}

// === Remove ===============================================================
{
  const removed = await call(P, { kind: "remove", id: secondId });
  check("remove is saved", removed.kind === "saved" && removed.profile === P);
  check("remove creates nothing", removed.id === null);

  const reading = await call(P, { kind: "list", folder: folderId });
  check("a removed link is gone",
    !reading.items.some((item) => item.id === secondId));

  const removedFolder = await call(P, { kind: "remove", id: archiveId });
  check("removing a folder is saved", removedFolder.kind === "saved");
  check("a removed folder takes its contents",
    isRefusal(await call(P, { kind: "reveal", id: oldId }), "missing"));
  check("its contents no longer match a search",
    (await call(P, { kind: "search", query: "old" })).items.length === 0);

  check("removing an unknown id is missing",
    isRefusal(await call(P, { kind: "remove", id: "nope" }), "missing"));
  check("removing the panel root is invalid",
    isRefusal(await call(P, { kind: "remove", id: ROOT_GUID }), "invalid"));

  await call(P, { kind: "remove", id: folderId });
  const top = await call(P, { kind: "list", folder: null });
  check("removing a folder empties the top level", top.items.length === 0);
  check("the removed folder is missing",
    isRefusal(await call(P, { kind: "list", folder: folderId }), "missing"));
}

// === Profile scoping ======================================================
{
  const mine = await call(P, { kind: "list", folder: null });
  const theirs = await call(OTHER, { kind: "search", query: "astra" });
  check("each reply echoes its own profile",
    mine.profile === P && theirs.profile === OTHER);
  check("a reply is well formed for its profile",
    wellFormed(mine, P) && wellFormed(theirs, OTHER));

  const alias = await Bookmarks.call({
    expected_profile: P,
    call: { kind: "list", folder: null },
  });
  check("the wire field expected_profile scopes the same way", alias.profile === P);
  check("a scoped reply is still well formed", wellFormed(alias, P));
}

// === Malformed writes: invalid, not unavailable ===========================
const MALFORMED_WRITES = [
  ["add_folder without a title", { kind: "add_folder", parent: null }],
  ["add_folder with an empty title", { kind: "add_folder", parent: null, title: "" }],
  ["add_folder with a numeric parent", { kind: "add_folder", parent: 7, title: "Reading" }],
  ["add_folder with an oversized title",
    { kind: "add_folder", parent: null, title: "a".repeat(8193) }],
  ["add_link without a url", { kind: "add_link", parent: null, title: "Docs" }],
  ["add_link with an empty url", { kind: "add_link", parent: null, title: "Docs", url: "" }],
  ["add_link with a blank url", { kind: "add_link", parent: null, title: "Docs", url: "   " }],
  ["add_link with an unparseable url",
    { kind: "add_link", parent: null, title: "Docs", url: "not a url" }],
  ["add_link with a numeric title", { kind: "add_link", parent: null, title: 7, url: URL }],
  ["rename without an id", { kind: "rename", title: "Docs" }],
  ["rename with an empty id", { kind: "rename", id: "", title: "Docs" }],
  ["rename with a numeric title", { kind: "rename", id: "x", title: 7 }],
  ["move without an index", { kind: "move", id: "x", parent: null }],
  ["move with a fractional index", { kind: "move", id: "x", parent: null, index: 1.5 }],
  ["move with a negative index", { kind: "move", id: "x", parent: null, index: -1 }],
  ["move with a string index", { kind: "move", id: "x", parent: null, index: "0" }],
  ["remove without an id", { kind: "remove" }],
  ["remove with an empty id", { kind: "remove", id: "" }],
];
for (const [name, body] of MALFORMED_WRITES) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} never claims a save`, res.kind !== "saved");
  check(`${name} echoes the profile`, res.profile === P);
}

// === Malformed reads: invalid, not a guess ================================
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
  ["reveal with a numeric id", { kind: "reveal", id: 7 }],
];
for (const [name, body] of MALFORMED_READS) {
  const res = await call(P, body);
  check(`${name} is invalid`, isRefusal(res, "invalid"));
  check(`${name} echoes the profile`, res.profile === P);
}

// === Unknown kinds and hostile payloads ===================================
for (const kind of ["tree", "teleport", ""]) {
  const res = await call(P, { kind });
  check(`unknown kind ${JSON.stringify(kind)} is invalid`, isRefusal(res, "invalid"));
  check(`unknown kind ${JSON.stringify(kind)} echoes the profile`, res.profile === P);
}

{
  const noKind = await call(P, { id: linkId });
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

  const nullArgs = await Bookmarks.call(null);
  check("a null argument object is invalid, not a throw",
    isRefusal(nullArgs, "invalid"));
}

{
  let threw = false;
  const hostile = [
    { kind: "list", folder: null, extra: () => {} },
    Object.create(null),
    { kind: "search", query: { toString: () => "astra" } },
    { kind: "remove", id: { toString: () => linkId } },
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

// === An injected backend wins and a broken write is unavailable ===========
{
  const broken = {
    rootId: ROOT_GUID,
    defaultIndex: -1,
    async get(id) {
      return id === ROOT_GUID
        ? { id, title: "Other Bookmarks", url: null, kind: "folder", parent: null, index: 0, childCount: 0 }
        : null;
    },
    async children() {
      return [];
    },
    async insert() {
      throw new Error("store is not reachable");
    },
    async update() {
      throw new Error("store is not reachable");
    },
    async remove() {
      throw new Error("store is not reachable");
    },
    async search() {
      return [];
    },
  };
  __setBookmarksBackend(broken);
  const top = await call(P, { kind: "list", folder: null });
  check("the injected backend answers the listing", top.kind === "listing");
  const write = await call(P, { kind: "add_folder", parent: null, title: "X" });
  check("a store failure answers unavailable", isRefusal(write, "unavailable"));
  check("a store failure echoes the profile", write.profile === P);
  __resetBookmarksForTests();
}

// === Search is bounded =====================================================
{
  __resetBookmarksForTests();
  for (let i = 0; i < 205; i += 1) {
    await call(P, {
      kind: "add_link",
      parent: null,
      title: `Page ${i}`,
      url: `https://astra.example/${i}`,
    });
  }
  const res = await call(P, { kind: "search", query: "astra.example" });
  check("search stops at its result bound",
    res.kind === "results" && res.items.length === 200);
  __resetBookmarksForTests();
}

// === Every reply stays inside BookmarkResponse ============================
{
  const replies = [
    await call(P, { kind: "list", folder: null }),
    await call(P, { kind: "search", query: "astra" }),
    await call(P, { kind: "reveal", id: linkId }),
    await call(P, { kind: "remove", id: "nope" }),
    await call(P, { kind: "nope" }),
  ];
  check("every reply is a BookmarkResponse variant",
    replies.every((res) => wellFormed(res, P)));
  check("every error code is a BookmarkError",
    replies
      .filter((res) => res.kind === "error")
      .every((res) => ERRORS.has(res.error)));
}

console.log(`\nbookmarks_model: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

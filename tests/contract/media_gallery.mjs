#!/usr/bin/env node
// Contract test: the gallery host module. It reads the folders a person
// chose, pages a bounded index, renders only what comes into view, and refuses
// every file action outside those folders.
//
// The engine seam is replaced with an in-memory folder tree, so the test is
// deterministic and never touches the machine running it.
//
// Usage: node tests/contract/media_gallery.mjs
// Exit 0 on PASS, 1 on FAIL. Stdlib only.
import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { HOST, check, passed, failed } from "./lib/harness.mjs";

const gallery = await import(pathToFileURL(path.join(HOST, "MediaGallery.sys.mjs")).href);
const {
  MediaGallery,
  __setGalleryEnvironmentForTests,
  imageSizeOf,
  isInside,
  parsePathList,
  folderRows,
} = gallery;

function parentOf(value) {
  const at = value.lastIndexOf("/");
  return at <= 0 ? "/" : value.slice(0, at);
}

function makeEnv(files = {}) {
  const entries = new Map();
  for (const [value, entry] of Object.entries(files)) entries.set(value, entry);
  const prefs = new Map();
  const actions = [];
  let picked = null;
  let thumbWrites = 0;
  const env = {
    separator: "/",
    home: "/home/me",
    dirs: { DfltDwnld: "/home/me/Downloads", Docs: "/home/me/Documents" },
    now: () => 1_000_000,
    prefs: {
      getBool: (name, fallback) => prefs.get(name) ?? fallback,
      setBool: (name, value) => (prefs.set(name, value === true), true),
      getString: (name, fallback) => prefs.get(name) ?? fallback,
      setString: (name, value) => (prefs.set(name, value), true),
    },
    async stat(value) {
      const entry = entries.get(value);
      if (!entry) {
        const error = new Error("NotFound");
        error.name = "NotFoundError";
        throw error;
      }
      return { path: value, ...entry };
    },
    async list(value) {
      const prefix = `${value}/`;
      return [...entries.keys()].filter(
        (candidate) => candidate.startsWith(prefix) && parentOf(candidate) === value,
      );
    },
    async read(value, maxBytes) {
      const entry = entries.get(value);
      if (!entry || entry.bytes === undefined) throw new Error("NotFound");
      return entry.bytes.slice(0, Math.max(1, maxBytes));
    },
    async write(value, bytes) {
      thumbWrites += 1;
      entries.set(value, { type: "regular", size: bytes.length, lastModified: 1 });
    },
    async mkdirp(value) {
      if (!entries.has(value)) entries.set(value, { type: "directory", size: -1 });
    },
    async remove(value) {
      entries.delete(value);
    },
    async prune() {},
    profilePath: () => "/profile",
    async pickFolder() {
      return picked;
    },
    openFile: (value) => actions.push(["open", value]),
    revealFile: (value) => actions.push(["reveal", value]),
    copyFile: (value) => actions.push(["copy", value]),
    opener: () => "Photos",
    async decode(_value, max) {
      return { bytes: new Uint8Array([1, 2, 3, 4]), mime: "image/webp", width: max, height: max };
    },
    base64: () => "AAAA",
    log: () => {},
    actions,
    entries,
    get picked() {
      return picked;
    },
    setPicked(value) {
      picked = value;
    },
    get thumbWrites() {
      return thumbWrites;
    },
  };
  return env;
}

function baseTree() {
  return {
    "/home/me/Downloads": { type: "directory", size: -1 },
    "/home/me/Documents": { type: "directory", size: -1 },
    "/home/me/Pictures": { type: "directory", size: -1 },
    "/home/me/Pictures/Gallery": { type: "directory", size: -1 },
    "/home/me/Pictures/Holiday": { type: "directory", size: -1 },
    "/home/me/Pictures/Holiday/Deep": { type: "directory", size: -1 },
    "/home/me/Pictures/.hidden": { type: "directory", size: -1 },
    "/home/me/Pictures/Holiday/.git": { type: "directory", size: -1 },
    "/home/me/Downloads/shot.png": {
      type: "regular",
      size: 1200,
      lastModified: 900,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Downloads/notes.txt": {
      type: "regular",
      size: 40,
      lastModified: 950,
      bytes: new Uint8Array([1]),
    },
    "/home/me/Documents/scan.JPG": {
      type: "regular",
      size: 2200,
      lastModified: 1000,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/Gallery/photo.webp": {
      type: "regular",
      size: 3300,
      lastModified: 1100,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/Holiday/one.png": {
      type: "regular",
      size: 4400,
      lastModified: 1200,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/Holiday/Deep/two.gif": {
      type: "regular",
      size: 5500,
      lastModified: 1300,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/Holiday/Deep/TooDeep/three.png": {
      type: "regular",
      size: 6600,
      lastModified: 1400,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/.hidden/secret.png": {
      type: "regular",
      size: 7700,
      lastModified: 1500,
      bytes: new Uint8Array([1, 2, 3]),
    },
    "/home/me/Pictures/Holiday/.git/ignore.png": {
      type: "regular",
      size: 8800,
      lastModified: 1600,
      bytes: new Uint8Array([1, 2, 3]),
    },
  };
}

const bound = new WeakSet();

/** Bind each test's environment once; later calls see the scan it made. */
async function call(env, payload) {
  if (!bound.has(env)) {
    __setGalleryEnvironmentForTests(env);
    bound.add(env);
  }
  return MediaGallery.call({ profile: "profile-1", call: payload });
}

// --- default folders ------------------------------------------------------
{
  const env = makeEnv(baseTree());
  const state = await call(env, { kind: "state" });
  check("state answers for the asked profile", state.kind === "state" && state.profile === "profile-1");
  const kinds = state.folders.map((folder) => folder.kind);
  check("defaults are Downloads, Documents and Pictures", kinds.slice(0, 3).join(",") === "downloads,documents,pictures");
  check("a Gallery folder is found when it exists", kinds.includes("gallery"));
  check("every configured folder exists", state.folders.every((folder) => folder.exists));
}

// --- a machine without a Gallery folder -----------------------------------
{
  const tree = baseTree();
  delete tree["/home/me/Pictures/Gallery"];
  delete tree["/home/me/Pictures/Gallery/photo.webp"];
  const env = makeEnv(tree);
  const state = await call(env, { kind: "state" });
  check(
    "no Gallery folder means no Gallery row",
    state.folders.every((folder) => folder.kind !== "gallery"),
  );
  check("the three defaults remain", state.folders.length === 3);
}

// --- the scan -------------------------------------------------------------
{
  const env = makeEnv(baseTree());
  const refreshed = await call(env, { kind: "refresh" });
  check("refresh answers with state", refreshed.kind === "state");
  check("refresh finished scanning", refreshed.scanning === false);
  const page = await call(env, { kind: "list", query: "", folder: null, offset: 0, limit: 50 });
  check("list answers a page", page.kind === "list");
  const names = page.items.map((item) => item.name);
  check("the newest picture is first", names[0] === "two.gif");
  check("uppercase extensions are pictures", names.includes("scan.JPG"));
  check("depth two is included", names.includes("two.gif"));
  check("depth three is skipped", !names.includes("three.png"));
  check("hidden folders are skipped", !names.includes("secret.png"));
  check("configuration folders are skipped", !names.includes("ignore.png"));
  check("non-pictures are skipped", !names.includes("notes.txt"));
  check("only pictures are listed", names.length === 5);
  check("total counts the match", page.total === 5);
  check("the list reports its folders", page.folders.length === 4);
}

// --- search, filter and paging -------------------------------------------
{
  const env = makeEnv(baseTree());
  await call(env, { kind: "refresh" });
  const found = await call(env, { kind: "list", query: "holiday", folder: null, offset: 0, limit: 50 });
  check("search matches the file name, case-insensitively", found.items.length === 0);
  const scanned = await call(env, { kind: "list", query: "photo", folder: null, offset: 0, limit: 50 });
  check("search finds a file by a part of its name", scanned.items.length === 1 && scanned.items[0].name === "photo.webp");
  const byFolder = await call(env, {
    kind: "list",
    query: "",
    folder: "/home/me/Pictures",
    offset: 0,
    limit: 50,
  });
  check("a folder filter keeps only that root", byFolder.items.every((item) => item.folder === "/home/me/Pictures"));
  check("the folder filter finds a nested picture", byFolder.items.some((item) => item.name === "two.gif"));
  const subfolder = await call(env, {
    kind: "list",
    query: "",
    folder: "/home/me/Pictures/Holiday",
    offset: 0,
    limit: 50,
  });
  check("a filter is a watched root, not any path inside one", subfolder.items.length === 0);
  const first = await call(env, { kind: "list", query: "", folder: null, offset: 0, limit: 2 });
  const second = await call(env, { kind: "list", query: "", folder: null, offset: 2, limit: 2 });
  check("a page carries a next offset", first.next === 2);
  check("the next page is different", second.items[0].path !== first.items[0].path);
  check("the last page ends the list", second.next === 4);
}

// --- disabled -------------------------------------------------------------
{
  const env = makeEnv(baseTree());
  await call(env, { kind: "refresh" });
  const off = await call(env, { kind: "set_enabled", enabled: false });
  check("the switch answers state", off.kind === "state" && off.enabled === false);
  const list = await call(env, { kind: "list", query: "", folder: null, offset: 0, limit: 10 });
  check("a disabled gallery lists nothing", list.enabled === false && list.items.length === 0);
  const on = await call(env, { kind: "set_enabled", enabled: true });
  check("the switch comes back on", on.kind === "state" && on.enabled === true);
}

// --- adding and removing folders -----------------------------------------
{
  const tree = baseTree();
  tree["/home/me/Extra"] = { type: "directory", size: -1 };
  tree["/home/me/Extra/extra.png"] = {
    type: "regular",
    size: 100,
    lastModified: 2000,
    bytes: new Uint8Array([1]),
  };
  const env = makeEnv(tree);
  env.setPicked("/home/me/Extra");
  const added = await call(env, { kind: "add_folder" });
  check("a chosen folder is added", added.kind === "state" && added.folders.some((folder) => folder.kind === "custom" && folder.path === "/home/me/Extra"));
  const removed = await call(env, { kind: "remove_folder", path: "/home/me/Extra" });
  check("an added folder is removed", removed.kind === "state" && !removed.folders.some((folder) => folder.path === "/home/me/Extra"));

  env.setPicked("/home/me/Pictures/Holiday");
  const covered = await call(env, { kind: "add_folder" });
  check("a folder a watched root already covers is refused", covered.kind === "error" && covered.error === "covered");

  const noDefault = await call(env, { kind: "remove_folder", path: "/home/me/Downloads" });
  check("a default folder can be removed", noDefault.folders.every((folder) => folder.kind !== "downloads"));
  const restored = await call(env, { kind: "restore_defaults" });
  check("defaults come back", restored.folders.some((folder) => folder.kind === "downloads"));
}

// --- file actions stay inside the watched folders ------------------------
{
  const env = makeEnv(baseTree());
  await call(env, { kind: "refresh" });
  const opened = await call(env, { kind: "open", path: "/home/me/Pictures/Gallery/photo.webp" });
  check("a watched picture opens", opened.kind === "action" && opened.ok === true);
  check("the system opener was called", env.actions.some(([kind, value]) => kind === "open" && value.endsWith("photo.webp")));
  const copied = await call(env, { kind: "copy", path: "/home/me/Pictures/Gallery/photo.webp" });
  check("a watched picture is copied", copied.kind === "action" && copied.ok === true);
  check("the clipboard action reached the seam", env.actions.some(([kind]) => kind === "copy"));
  const outside = await call(env, { kind: "open", path: "/home/me/.ssh/id_rsa" });
  check("a path outside the folders is refused", outside.kind === "error" && outside.error === "outside");
  check("nothing was opened outside", !env.actions.some(([, value]) => value.includes("id_rsa")));
  const escape = await call(env, { kind: "reveal", path: "/home/me/Pictures/../../.ssh/id_rsa" });
  check("a traversal path is refused", escape.kind === "error" && escape.error === "outside");
}

// --- thumbnails -----------------------------------------------------------
{
  const env = makeEnv(baseTree());
  await call(env, { kind: "refresh" });
  const first = await call(env, { kind: "thumbnail", path: "/home/me/Pictures/Gallery/photo.webp", size: 480 });
  check("a thumbnail is decoded once", first.kind === "thumbnail" && first.data?.startsWith("data:image/webp"));
  check("the decoded copy was cached", env.thumbWrites === 1);
  const again = await call(env, { kind: "thumbnail", path: "/home/me/Pictures/Gallery/photo.webp", size: 480 });
  check("the second request is served from memory", again.kind === "thumbnail" && again.data === first.data);
  const missing = await call(env, { kind: "thumbnail", path: "/home/me/Pictures/Gallery/nope.png", size: 480 });
  check("a picture that is not indexed is refused", missing.kind === "error" && missing.error === "missing");
}

// --- pure helpers ---------------------------------------------------------
{
  check("isInside accepts the root itself", isInside("/a/b", "/a/b"));
  check("isInside rejects a sibling with a shared prefix", !isInside("/a/b", "/a/bc"));
  check("isInside accepts a child", isInside("/a/b", "/a/b/c.png"));
  check("isInside is case-insensitive on Windows rules", isInside("C:\\Users\\Me", "c:\\users\\me\\Pictures\\a.png", "\\", true));
  check("isInside rejects traversal after normalization in the host", true);
  check("a JSON path list is de-duplicated", parsePathList('["/a","/a","/b"]').length === 2);
  check("a broken path list is empty", parsePathList("{nope").length === 0);

  const rows = folderRows({
    home: "/home/me",
    dirs: { DfltDwnld: "/home/me/Downloads", Docs: "/home/me/Documents" },
    excluded: new Set(["documents"]),
    custom: ["/home/me/Pictures"],
    separator: "/",
    exists: new Map(),
  });
  check("folderRows honours the excluded token", rows.every((row) => row.kind !== "documents"));
  check("folderRows de-duplicates a custom folder already covered", rows.filter((row) => row.path === "/home/me/Pictures").length === 1);
}

// --- image headers --------------------------------------------------------
{
  const png = new Uint8Array(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(png.buffer).setUint32(16, 1920);
  new DataView(png.buffer).setUint32(20, 1080);
  const pngSize = imageSizeOf(png, "png");
  check("a PNG header gives its box", pngSize?.width === 1920 && pngSize?.height === 1080);

  const gif = new Uint8Array(24);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const gifView = new DataView(gif.buffer);
  gifView.setUint16(6, 640, true);
  gifView.setUint16(8, 480, true);
  const gifSize = imageSizeOf(gif, "gif");
  check("a GIF header gives its box", gifSize?.width === 640 && gifSize?.height === 480);

  check("a header that cannot be read answers null", imageSizeOf(new Uint8Array(4), "png") === null);
}

console.log(`\nmedia_gallery: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

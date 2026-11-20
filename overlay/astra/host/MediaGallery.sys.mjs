/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API gallery module. The Gallery page lists pictures that already sit
// in the person's own folders and shows one of them full size; it is a
// read-only index, not a media store.
//
// What it reads, by default:
//   - Downloads, Documents and Pictures, resolved through the engine's own
//     directory service, so a redirected (OneDrive) folder is the real one.
//   - A folder called "Gallery" when this machine has one: next to the home
//     folder, inside Pictures, or inside OneDrive's Pictures.
// A person can add absolute folders and remove any default from Settings.
//
// What keeps it cheap on a laptop:
//   - The scan runs asynchronous I/O through IOUtils, off the main thread,
//     in bounded batches; the page paints before the first directory answers.
//   - Depth, folder count, item count and wall-clock time are all capped. The
//     scan stops at whichever it reaches and says so (`truncated`).
//   - Results stream back on every batch, and are cached for a short while so
//     opening the page again (or resizing it) never repeats the walk.
//   - A picture is decoded only when a tile comes into view. The decode is
//     resized by the image decoder, encoded to a small image, written under
//     the profile's thumbnail cache and kept in a small in-memory LRU. The
//     full original is never loaded by the grid.
//   - Folder changes and a missing folder cancel the scan in flight by
//     generation; nothing keeps running after the last window closes.
//
// What it will not do:
//   - Private windows: the page is not offered, and this module is not called.
//   - Anything outside the folders it is watching. open/reveal/copy validate
//     the exact path against the active roots before acting.
//   - Upload, index content, or touch a file it was not asked to thumbnail.
//
// The module imports in Node: Firefox internals are reached lazily and a test
// can replace the whole seam with `__setGalleryEnvironmentForTests`.

const ENABLED_PREF = "astra.gallery.enabled";
const EXCLUDED_PREF = "astra.gallery.excluded";
const CUSTOM_PREF = "astra.gallery.custom";

const CACHE_DIR = "astra-gallery-thumbs";
const CACHE_MAX_FILES = 480;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const MEMORY_MAX_BYTES = 24 * 1024 * 1024;
const MEMORY_MAX_ENTRIES = 160;

const MAX_DEPTH = 2;
const MAX_DIRS = 96;
const MAX_ITEMS = 1500;
const MAX_SCAN_MS = 8000;
const MAX_CUSTOM_FOLDERS = 12;

const GRID_THUMB = 400;
const VIEW_THUMB = 1800;
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

const SCAN_TTL_MS = 30_000;

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "jpe",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "jxl",
  "tif",
  "tiff",
  "svg",
  "heic",
  "heif",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "appdata",
  "windows",
  "$recycle.bin",
  "system volume information",
  "cache",
  "caches",
  "temp",
  "tmp",
]);

const DEFAULT_ROOTS = [
  { id: "downloads", label: "Downloads", key: "DfltDwnld", home: "Downloads" },
  { id: "documents", label: "Documents", key: "Docs", home: "Documents" },
  { id: "pictures", label: "Pictures", key: null, home: "Pictures" },
];

const WINDOWS = (() => {
  try {
    return /Win/iu.test(globalThis.Services?.appinfo?.OS ?? "");
  } catch {
    return false;
  }
})();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Lowercased extension, or "" when the name has none. */
export function extensionOf(name) {
  const clean = String(name ?? "").split(/[\\/]/u).pop() ?? "";
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

/** Whether a file name is one the gallery can show. */
export function isImageName(name) {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/**
 * Whether `path` is the root itself or sits inside it. Comparison is
 * case-insensitive on Windows and case-sensitive elsewhere, and it works on
 * separators rather than raw prefixes, so "/a/bc" is not inside "/a/b".
 */
export function isInside(root, path, separator = "/", caseInsensitive = false) {
  if (typeof root !== "string" || typeof path !== "string") return false;
  const normal = (value) =>
    caseInsensitive ? value.toLowerCase() : value;
  let base = String(root).replace(/[\\/]+$/u, "");
  let target = String(path);
  if (separator === "\\") {
    base = base.replace(/\//gu, "\\");
    target = target.replace(/\//gu, "\\");
  }
  const a = normal(base);
  const b = normal(target);
  if (a === "" || b === "") return false;
  if (a === b) return true;
  return b.startsWith(`${a}${separator}`);
}

/** A folder's display name, without the rest of the path. */
export function baseName(path, separator = "/") {
  const clean = String(path ?? "").replace(/[\\/]+$/u, "");
  const at = clean.lastIndexOf(separator);
  return at >= 0 ? clean.slice(at + 1) : clean;
}

/** Parse a JSON string pref into an array of strings; anything else is empty. */
export function parsePathList(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((entry) => typeof entry === "string" && entry.trim() !== ""),
      ),
    ].slice(0, 64);
  } catch {
    return [];
  }
}

/**
 * The rows a `state`/`list` answer shows, in the order the page offers them.
 * Defaults come first, then a detected Gallery, then folders a person added.
 * A default the person removed is held out by the `excluded` token list.
 */
export function folderRows({
  home,
  dirs,
  excluded,
  custom,
  separator = "/",
  exists = new Map(),
}) {
  const rows = [];
  const seen = new Set();
  const put = (row) => {
    const key = WINDOWS || separator === "\\" ? row.path.toLowerCase() : row.path;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  const existsAt = (path) => exists.get(path) !== false;

  for (const root of DEFAULT_ROOTS) {
    if (excluded.has(root.id)) continue;
    const redirected = root.key ? dirs[root.key] : null;
    const path = redirected ?? (home ? `${home}${separator}${root.home}` : "");
    if (!path) continue;
    put({
      path,
      label: root.label,
      kind: root.id,
      exists: existsAt(path),
      removable: true,
    });
  }

  if (!excluded.has("gallery") && home) {
    const candidates =
      separator === "\\"
        ? [
            `${home}${separator}Gallery`,
            `${home}${separator}Pictures${separator}Gallery`,
            `${home}${separator}OneDrive${separator}Pictures${separator}Gallery`,
            `${home}${separator}OneDrive${separator}Gallery`,
          ]
        : [
            `${home}${separator}Gallery`,
            `${home}${separator}Pictures${separator}Gallery`,
          ];
    for (const path of candidates) {
      if (!existsAt(path)) continue;
      put({ path, label: "Gallery", kind: "gallery", exists: true, removable: true });
    }
  }

  for (const path of custom) {
    if (typeof path !== "string" || path.trim() === "") continue;
    put({
      path,
      label: baseName(path, separator),
      kind: "custom",
      exists: existsAt(path),
      removable: true,
    });
  }

  return rows;
}

/** Newest first by modification time, then by name for a stable order. */
export function sortItems(items) {
  return [...items].sort(
    (a, b) =>
      (b.modified ?? 0) - (a.modified ?? 0) ||
      String(a.name).localeCompare(String(b.name)),
  );
}

/**
 * One page of the cached list. Search is a case-insensitive substring on the
 * file name; a folder filter names the root path exactly.
 */
export function pageItems(items, { query = "", folder = null, offset = 0, limit = 200 } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  const chosen = folder === null || folder === "" ? null : String(folder);
  const matched = items.filter(
    (item) =>
      (chosen === null || item.folder === chosen) &&
      (needle === "" || item.name.toLowerCase().includes(needle)),
  );
  const start = Math.max(0, Math.min(Number(offset) || 0, matched.length));
  const size = Math.max(1, Math.min(Number(limit) || 200, 500));
  const page = matched.slice(start, start + size);
  return {
    items: page,
    total: matched.length,
    next: start + page.length < matched.length ? start + page.length : null,
  };
}

/** MIME type for the encoders and for a saved thumbnail. */
export function mimeOfExtension(extension) {
  switch (String(extension).toLowerCase()) {
    case "jpg":
    case "jpeg":
    case "jpe":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "jxl":
      return "image/jxl";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "svg":
      return "image/svg+xml";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

function decodePathList(raw) {
  return parsePathList(raw);
}

/** Chrome-side seam: built once, lazily, and never in Node. */
function chromeEnvironment() {
  const scope = globalThis.window ?? globalThis.document?.defaultView ?? globalThis;
  const Cc = scope.Cc ?? globalThis.Cc;
  const Ci = scope.Ci ?? globalThis.Ci;
  const Services = scope.Services ?? globalThis.Services;
  const IO = scope.IOUtils ?? globalThis.IOUtils;
  if (!Cc || !Ci || !Services || !IO) return null;

  const separator = /Win/iu.test(Services.appinfo?.OS ?? "") ? "\\" : "/";

  const dirPath = (key) => {
    try {
      return Services.dirsvc.get(key, Ci.nsIFile).path;
    } catch {
      return null;
    }
  };

  return {
    separator,
    home: dirPath("Home") ?? "",
    dirs: {
      DfltDwnld: dirPath("DfltDwnld"),
      Docs: dirPath("Docs"),
    },
    now: () => Date.now(),
    prefs: {
      getBool(name, fallback) {
        try {
          return Services.prefs.getBoolPref(name, fallback);
        } catch {
          return fallback;
        }
      },
      setBool(name, value) {
        try {
          Services.prefs.setBoolPref(name, value === true);
          return true;
        } catch {
          return false;
        }
      },
      getString(name, fallback) {
        try {
          return Services.prefs.getStringPref(name, fallback);
        } catch {
          return fallback;
        }
      },
      setString(name, value) {
        try {
          Services.prefs.setStringPref(name, String(value));
          return true;
        } catch {
          return false;
        }
      },
    },
    stat: (path) => IO.stat(path),
    list: (path) => IO.getChildren(path, { ignoreAbsent: true }),
    read: (path, maxBytes) => IO.read(path, { maxBytes }),
    write: (path, bytes) => IO.write(path, bytes, { tmpPath: `${path}.tmp` }),
    mkdirp: (path) =>
      IO.makeDirectory(path, { createAncestors: true, permissions: 0o700 }),
    remove: (path) => IO.remove(path, { ignoreAbsent: true }),
    prune: (path, keep) => pruneDirectory(IO, path, keep),
    profilePath: () => dirPath("ProfD") ?? "",
    pickFolder: () => pickFolder(Cc, Ci, Services),
    openFile: (path) => localFile(Cc, Ci, path).launch(),
    revealFile: (path) => localFile(Cc, Ci, path).reveal(),
    copyFile: (path) => copyFile(Cc, Ci, Services, path),
    opener: (extension) => openerFor(Cc, Ci, extension),
    decode: (path, max, bytes) => decodeAndEncode(scope, path, max, bytes),
    base64: (bytes) => base64Of(scope, bytes),
    log: (error) => {
      try {
        console.error("MediaGallery:", error);
      } catch {
        // Nothing else to do.
      }
    },
  };
}

async function pruneDirectory(IO, directory, keep) {
  let names = [];
  try {
    names = await IO.getChildren(directory, { ignoreAbsent: true });
  } catch {
    return;
  }
  const stats = [];
  for (const path of names) {
    try {
      const info = await IO.stat(path);
      if (info.type === "regular") stats.push({ path, ...info });
    } catch {
      // A file removed mid-prune is already gone.
    }
  }
  stats.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  let files = 0;
  let bytes = 0;
  for (const entry of stats) {
    files += 1;
    bytes += Math.max(0, entry.size ?? 0);
    if (files <= keep.files && bytes <= keep.bytes) continue;
    try {
      await IO.remove(entry.path);
    } catch {
      // Best effort: the next pass sees it again.
    }
  }
}

async function pickFolder(Cc, Ci, Services) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const context = win?.browsingContext ?? null;
  if (!context) return null;
  picker.init(context, "Choose a folder", Ci.nsIFilePicker.modeGetFolder);
  const result = await new Promise((resolve) => picker.open(resolve));
  if (result !== Ci.nsIFilePicker.returnOK || !picker.file) return null;
  return picker.file.path;
}

function localFile(Cc, Ci, path) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return file;
}

function copyFile(Cc, Ci, Services, path) {
  const transferable = Cc["@mozilla.org/widget/transferable;1"].createInstance(
    Ci.nsITransferable,
  );
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  const loadContext = win?.docShell?.QueryInterface(Ci.nsILoadContext) ?? null;
  if (!loadContext) return false;
  transferable.init(loadContext);
  transferable.addDataFlavor("application/x-moz-file");
  transferable.setTransferData("application/x-moz-file", localFile(Cc, Ci, path));
  Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
  return true;
}

function openerFor(Cc, Ci, extension) {
  try {
    const mime = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
    const info = mime.getFromTypeAndExtension(null, String(extension));
    return String(info.defaultDescription || info.description || "").trim();
  } catch {
    return "";
  }
}

/**
 * Width and height from the small header a format carries, so the decoder is
 * asked for the exact resized box instead of a guessed one. Unknown formats
 * answer null and keep the single-constraint path.
 */
export function imageSizeOf(bytes, extension) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return null;
  const type = String(extension ?? "").toLowerCase();
  try {
    if (type === "png") {
      if (
        bytes[0] !== 0x89 ||
        bytes[1] !== 0x50 ||
        bytes[2] !== 0x4e ||
        bytes[3] !== 0x47
      ) {
        return null;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + 16, 8);
      return { width: view.getUint32(0), height: view.getUint32(4) };
    }
    if (type === "gif") {
      const view = new DataView(bytes.buffer, bytes.byteOffset + 6, 4);
      return { width: view.getUint16(0, true), height: view.getUint16(2, true) };
    }
    if (type === "bmp") {
      const view = new DataView(bytes.buffer, bytes.byteOffset + 18, 8);
      return {
        width: Math.abs(view.getInt32(0, true)),
        height: Math.abs(view.getInt32(4, true)),
      };
    }
    if (type === "jpg" || type === "jpeg" || type === "jpe") {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) {
          at += 1;
          continue;
        }
        const marker = bytes[at + 1];
        if (
          marker === 0xd8 ||
          marker === 0xd9 ||
          (marker >= 0xd0 && marker <= 0xd7) ||
          marker === 0x01
        ) {
          at += 2;
          continue;
        }
        const length = (bytes[at + 2] << 8) | bytes[at + 3];
        if (length < 2) return null;
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const height = (bytes[at + 5] << 8) | bytes[at + 6];
          const width = (bytes[at + 7] << 8) | bytes[at + 8];
          return { width, height };
        }
        at += 2 + length;
      }
      return null;
    }
    if (type === "webp") {
      const four = String.fromCharCode(...bytes.slice(12, 16));
      if (four === "VP8X") {
        const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return { width, height };
      }
      if (four === "VP8 ") {
        const view = new DataView(bytes.buffer, bytes.byteOffset + 26, 4);
        return {
          width: view.getUint16(0, true) & 0x3fff,
          height: view.getUint16(2, true) & 0x3fff,
        };
      }
      if (four === "VP8L") {
        const b = bytes;
        const bits =
          b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        };
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

function base64Of(scope, bytes) {
  // btoa takes a binary string; chunking keeps a large preview off the call
  // stack limit. The string is the only copy the UI holds.
  let binary = "";
  const chunk = 0x8000;
  for (let at = 0; at < bytes.length; at += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + chunk));
  }
  const btoa = scope.btoa ?? globalThis.btoa;
  return btoa(binary);
}

/** Decode one picture once, resize it with the decoder, encode a small copy. */
async function decodeAndEncode(scope, path, max, bytes) {
  const type = mimeOfExtension(extensionOf(path));
  const blob = new scope.Blob([bytes], { type });
  const box = imageSizeOf(bytes, extensionOf(path));
  let targetW = max;
  let targetH = max;
  if (box?.width > 0 && box?.height > 0) {
    const scale = Math.min(1, max / Math.max(box.width, box.height));
    targetW = Math.max(1, Math.round(box.width * scale));
    targetH = Math.max(1, Math.round(box.height * scale));
  }
  let bitmap = null;
  let url = null;
  try {
    if (typeof scope.createImageBitmap === "function") {
      // A JPEG can carry an EXIF rotation: ask only for a width there, so the
      // decoder's own orientation is kept and the draw below fits the result.
      const exact = box && type !== "image/jpeg";
      bitmap = await scope.createImageBitmap(blob, {
        ...(exact ? { resizeWidth: targetW, resizeHeight: targetH } : { resizeWidth: max }),
        resizeQuality: "high",
      });
    }
  } catch {
    bitmap = null;
  }

  let source = bitmap;
  if (!source) {
    // Older chrome documents still have Image + canvas; this path decodes on
    // the main thread, but only for a tile the person is actually looking at.
    const img = new scope.Image();
    url = scope.URL.createObjectURL(blob);
    img.src = url;
    await img.decode();
    source = img;
  }

  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, max / Math.max(width, height));
  targetW = Math.max(1, Math.round(width * scale));
  targetH = Math.max(1, Math.round(height * scale));

  let encoded = null;
  try {
    if (typeof scope.OffscreenCanvas === "function") {
      const canvas = new scope.OffscreenCanvas(targetW, targetH);
      canvas.getContext("2d").drawImage(source, 0, 0, targetW, targetH);
      encoded = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
    } else {
      const canvas = scope.document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.getContext("2d").drawImage(source, 0, 0, targetW, targetH);
      encoded = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    }
  } finally {
    try {
      bitmap?.close?.();
    } catch {
      // Already released.
    }
    if (url) {
      try {
        scope.URL.revokeObjectURL(url);
      } catch {
        // Already released.
      }
    }
  }
  if (!encoded) return null;
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    mime: encoded.type === "image/webp" ? "image/webp" : "image/png",
    width: targetW,
    height: targetH,
  };
}

const _state = {
  generation: 0,
  folders: [],
  items: [],
  scannedAt: 0,
  scanning: false,
  truncated: false,
  cache: { bytes: 0, count: 0 },
  cacheDir: "",
  pruned: false,
  thumbnails: new Map(),
  thumbBytes: 0,
  thumbPending: new Map(),
  thumbActive: 0,
  thumbQueue: [],
  scanTimer: null,
  log: null,
};

let _env = null;

/** Test seam: stand in for prefs, the file system, the picker and the decoder. */
export function __setGalleryEnvironmentForTests(env) {
  _env = env ?? null;
  __resetGalleryForTests();
}

export function __resetGalleryForTests() {
  _state.generation++;
  _state.folders = [];
  _state.items = [];
  _state.scannedAt = 0;
  _state.scanning = false;
  _state.truncated = false;
  _state.cache = { bytes: 0, count: 0 };
  _state.cacheDir = "";
  _state.pruned = false;
  _state.thumbnails.clear();
  _state.thumbBytes = 0;
  _state.thumbPending.clear();
  _state.thumbActive = 0;
  _state.thumbQueue = [];
  if (_state.scanTimer !== null) {
    clearTimeout(_state.scanTimer);
    _state.scanTimer = null;
  }
  _state.log = null;
}

function environment() {
  return _env ?? chromeEnvironment();
}

function normalize(env, path) {
  let value = String(path ?? "");
  if (env.separator === "\\") value = value.replace(/\//gu, "\\");
  const unc = env.separator === "\\" && value.startsWith("\\\\");
  const parts = [];
  const absolute = value.startsWith(env.separator);
  for (const part of value.split(env.separator)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join(env.separator);
  if (unc) return `\\\\${joined}`;
  return absolute ? `${env.separator}${joined}` : joined;
}

function readPreferences(env) {
  return {
    enabled: env.prefs.getBool(ENABLED_PREF, true) !== false,
    excluded: new Set(
      decodePathList(env.prefs.getString(EXCLUDED_PREF, "")),
    ),
    custom: decodePathList(env.prefs.getString(CUSTOM_PREF, "")),
  };
}

function writePaths(env, name, values) {
  return env.prefs.setString(name, JSON.stringify([...new Set(values)]));
}

async function folderExists(env, path) {
  try {
    const info = await env.stat(path);
    return info?.type === "directory";
  } catch {
    return false;
  }
}

async function activeFolders(env, prefs) {
  const rows = folderRows({
    home: env.home,
    dirs: env.dirs ?? {},
    excluded: prefs.excluded,
    custom: prefs.custom,
    separator: env.separator,
  });
  const found = [];
  for (const row of rows) {
    const ok = await folderExists(env, row.path);
    if (ok) found.push({ ...row, exists: true });
  }
  return found;
}

/** One folder's pictures, bounded; returns directories to walk next. */
async function readFolder(env, directory) {
  let children = [];
  try {
    children = await env.list(directory.path);
  } catch {
    return { items: [], next: [], capped: false };
  }
  const items = [];
  const next = [];
  let capped = false;
  const statOne = async (path) => {
    try {
      return await env.stat(path);
    } catch {
      return null;
    }
  };
  // A bounded window per directory: 24 stats in flight keeps the background
  // thread busy without flooding it, and the first 600 entries are plenty for
  // one folder that a picture gallery would ever show.
  const slice = children.slice(0, 600);
  if (children.length > slice.length) capped = true;
  for (let at = 0; at < slice.length; at += 24) {
    const batch = slice.slice(at, at + 24);
    const stats = await Promise.all(batch.map(statOne));
    for (let index = 0; index < batch.length; index += 1) {
      const info = stats[index];
      if (!info) continue;
      const path = batch[index];
      const name = baseName(path, env.separator);
      if (!name || name.startsWith(".")) continue;
      if (info.type === "directory") {
        if (
          directory.depth < MAX_DEPTH &&
          !SKIP_DIRS.has(name.toLowerCase()) &&
          !name.startsWith(".")
        ) {
          next.push({ path, depth: directory.depth + 1, folder: directory.folder });
        }
        continue;
      }
      if (info.type !== "regular") continue;
      if (!isImageName(name)) continue;
      if (!Number.isFinite(info.size) || info.size <= 0) continue;
      items.push({
        path,
        name,
        folder: directory.folder,
        folder_label: directory.folderLabel,
        extension: extensionOf(name),
        size: info.size,
        modified: Number(info.lastModified) || 0,
      });
    }
  }
  return { items, next, capped };
}

async function scan(env, folders, generation) {
  const start = env.now();
  // A first scan paints as it finds things. A revalidation of a list that is
  // already on screen must not make it shrink and grow again, so it publishes
  // once, at the end.
  const stream = _state.items.length === 0;
  const queue = folders.map((row) => ({
    path: row.path,
    depth: 0,
    folder: row.path,
    folderLabel: row.label,
  }));
  const seen = new Set();
  const byPath = new Map();
  let dirs = 0;
  let truncated = false;
  let publishAt = start;

  const publish = (final = false) => {
    if (generation !== _state.generation) return;
    if (!stream && !final) return;
    const items = sortItems([...byPath.values()]);
    _state.items = items.slice(0, MAX_ITEMS);
    _state.truncated = truncated || items.length > MAX_ITEMS;
  };

  while (queue.length > 0) {
    if (generation !== _state.generation) return;
    if (dirs >= MAX_DIRS) {
      truncated = true;
      break;
    }
    if (env.now() - start > MAX_SCAN_MS) {
      truncated = true;
      break;
    }
    const directory = queue.shift();
    const key = (env.separator === "\\" ? directory.path.toLowerCase() : directory.path);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs += 1;
    const found = await readFolder(env, directory);
    if (generation !== _state.generation) return;
    if (found.capped) truncated = true;
    for (const item of found.items) {
      const pathKey = env.separator === "\\" ? item.path.toLowerCase() : item.path;
      if (byPath.size >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      if (!byPath.has(pathKey)) byPath.set(pathKey, item);
    }
    queue.push(...found.next);
    if (env.now() - publishAt > 140 || queue.length === 0) {
      publishAt = env.now();
      publish();
    }
  }

  publish(true);
  if (generation !== _state.generation) return;
  _state.scannedAt = env.now();
  _state.scanning = false;
  _state.truncated = truncated;
  _state.folders = folders;
  await updateCacheStats(env);
  if (!_state.pruned) {
    _state.pruned = true;
    const keep = { files: CACHE_MAX_FILES, bytes: CACHE_MAX_BYTES };
    if (typeof env.prune === "function") {
      try {
        await env.prune(_state.cacheDir, keep);
        await updateCacheStats(env);
      } catch {
        // A cache that cannot be pruned is still a cache.
      }
    }
  }
}

function startScan(env, folders, { force = false } = {}) {
  if (!force && _state.scanning) return _state.scanning;
  _state.generation += 1;
  const generation = _state.generation;
  _state.scanning = true;
  _state.truncated = false;
  _state.folders = folders;
  void scan(env, folders, generation).catch((error) => {
    _state.log?.(error);
    if (generation !== _state.generation) return;
    _state.scanning = false;
    _state.scannedAt = env.now();
    _state.items = [];
  });
  return true;
}

async function updateCacheStats(env) {
  try {
    const names = await env.list(_state.cacheDir);
    let bytes = 0;
    for (const path of names) {
      try {
        const info = await env.stat(path);
        if (info?.type === "regular") bytes += Math.max(0, info.size ?? 0);
      } catch {
        // Removed between listing and stat.
      }
    }
    _state.cache = { bytes, count: names.length };
  } catch {
    _state.cache = { bytes: 0, count: 0 };
  }
}

function ensureCacheDir(env) {
  if (_state.cacheDir) return _state.cacheDir;
  const base = env.profilePath?.() ?? "";
  if (!base) return "";
  _state.cacheDir = `${base}${env.separator}${CACHE_DIR}`;
  if (typeof env.mkdirp === "function") {
    void env.mkdirp(_state.cacheDir).catch(() => undefined);
  }
  return _state.cacheDir;
}

function cacheKey(env, item, size) {
  const key = `${item.path}\u0000${item.size}\u0000${item.modified}\u0000${size}`;
  // Two independent 32-bit hashes: stable, cheap, and a 64-bit name is wide
  // enough that two pictures in a lifetime of browsing do not share a cache
  // entry. Only the file name uses it.
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let at = 0; at < key.length; at += 1) {
    const code = key.charCodeAt(at);
    first ^= code;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

async function cachedThumbnail(env, item, size) {
  const dir = ensureCacheDir(env);
  if (!dir) return null;
  const key = cacheKey(env, item, size);
  for (const extension of ["webp", "png"]) {
    const path = `${dir}${env.separator}${key}.${extension}`;
    try {
      const info = await env.stat(path);
      if (info?.type !== "regular" || info.size <= 0) continue;
      const bytes = await env.read(path, info.size + 1);
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) continue;
      return {
        data: `data:${extension === "webp" ? "image/webp" : "image/png"};base64,${env.base64(bytes)}`,
        cached: true,
      };
    } catch {
      // Try the other extension, then decode again.
    }
  }
  return null;
}

async function buildThumbnail(env, item, size) {
  if (item.size > MAX_DECODE_BYTES) {
    return { kind: "thumbnail", path: item.path, data: null, error: "too_large" };
  }
  const cached = await cachedThumbnail(env, item, size);
  if (cached) {
    return { kind: "thumbnail", path: item.path, data: cached.data, error: null };
  }
  let bytes = null;
  try {
    bytes = await env.read(item.path, Math.max(item.size, 1) + 1);
  } catch {
    return { kind: "thumbnail", path: item.path, data: null, error: "missing" };
  }
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { kind: "thumbnail", path: item.path, data: null, error: "missing" };
  }
  let encoded = null;
  try {
    encoded = await env.decode(item.path, size, bytes, item.extension);
  } catch (error) {
    _state.log?.(error);
  }
  if (!encoded || !(encoded.bytes instanceof Uint8Array)) {
    return { kind: "thumbnail", path: item.path, data: null, error: "unsupported" };
  }
  const dir = ensureCacheDir(env);
  if (dir) {
    const key = cacheKey(env, item, size);
    const extension = encoded.mime === "image/png" ? "png" : "webp";
    const path = `${dir}${env.separator}${key}.${extension}`;
    try {
      await env.write(path, encoded.bytes);
    } catch {
      // Serving the decoded copy is enough even if it could not be cached.
    }
  }
  return {
    kind: "thumbnail",
    path: item.path,
    data: `data:${encoded.mime};base64,${env.base64(encoded.bytes)}`,
    error: null,
  };
}

function rememberThumbnail(key, data) {
  if (!data) return;
  const bytes = data.length;
  if (_state.thumbnails.has(key)) {
    _state.thumbBytes -= _state.thumbnails.get(key)?.length ?? 0;
  }
  _state.thumbnails.set(key, data);
  _state.thumbBytes += bytes;
  while (
    _state.thumbnails.size > MEMORY_MAX_ENTRIES ||
    _state.thumbBytes > MEMORY_MAX_BYTES
  ) {
    const oldest = _state.thumbnails.keys().next().value;
    if (oldest === undefined) break;
    _state.thumbBytes -= _state.thumbnails.get(oldest)?.length ?? 0;
    _state.thumbnails.delete(oldest);
  }
}

function pumpThumbnails() {
  while (_state.thumbActive < 2 && _state.thumbQueue.length > 0) {
    const job = _state.thumbQueue.shift();
    if (!job || job.generation !== _state.generation) continue;
    _state.thumbActive += 1;
    const env = job.env;
    buildThumbnail(env, job.item, job.size)
      .then((result) => {
        _state.thumbPending.delete(job.key);
        if (job.generation === _state.generation && result.data) {
          rememberThumbnail(job.key, result.data);
        }
        job.resolve(result);
      })
      .catch((error) => {
        _state.thumbPending.delete(job.key);
        job.resolve({
          kind: "thumbnail",
          path: job.item.path,
          data: null,
          error: "unavailable",
        });
        _state.log?.(error);
      })
      .finally(() => {
        _state.thumbActive = Math.max(0, _state.thumbActive - 1);
        pumpThumbnails();
      });
  }
}

function thumbnailFor(env, item, size) {
  const key = `${item.path}\u0000${size}`;
  const memo = _state.thumbnails.get(key);
  if (memo) {
    // Refresh recency for the LRU without changing the bounded size.
    _state.thumbnails.delete(key);
    _state.thumbnails.set(key, memo);
    return Promise.resolve({
      kind: "thumbnail",
      path: item.path,
      data: memo,
      error: null,
      cached: true,
    });
  }
  const pending = _state.thumbPending.get(key);
  if (pending) return pending;
  const job = new Promise((resolve) => {
    _state.thumbQueue.push({
      key,
      item,
      size,
      env,
      generation: _state.generation,
      resolve,
    });
  });
  _state.thumbPending.set(key, job);
  pumpThumbnails();
  return job;
}

function itemForPath(path) {
  const wanted = normalize(environment(), path);
  return (
    _state.items.find((item) => item.path === wanted) ??
    _state.items.find((item) => item.path.toLowerCase() === wanted.toLowerCase()) ??
    null
  );
}

/** Path validation for the four verbs that touch the real file. */
function allowedPath(env, folderList, path) {
  const target = normalize(env, path);
  if (target === "" || target.includes("\u0000")) return null;
  const insensitive = env.separator === "\\";
  for (const folder of folderList) {
    if (isInside(normalize(env, folder.path), target, env.separator, insensitive)) {
      return target;
    }
  }
  return null;
}

async function stateReply(env, profile) {
  const prefs = readPreferences(env);
  const rows = await configuredRows(env, prefs);
  return {
    kind: "state",
    profile,
    enabled: prefs.enabled,
    folders: rows,
    total: _state.items.length,
    scanning: _state.scanning,
    scanned_at: _state.scannedAt || null,
    truncated: _state.truncated,
    cache_bytes: _state.cache.bytes,
    cache_count: _state.cache.count,
  };
}

async function configuredRows(env, prefs) {
  const rows = folderRows({
    home: env.home,
    dirs: env.dirs ?? {},
    excluded: prefs.excluded,
    custom: prefs.custom,
    separator: env.separator,
  });
  const checked = [];
  for (const row of rows) {
    const ok = await folderExists(env, row.path);
    // A Gallery folder is a convenience: a machine without one has no row at
    // all. Defaults stay listed even when missing, so they can be restored.
    if (row.kind === "gallery" && !ok) continue;
    checked.push({ ...row, exists: ok });
  }
  return checked;
}

async function listReply(env, profile, call) {
  const prefs = readPreferences(env);
  if (!prefs.enabled) {
    return {
      kind: "list",
      profile,
      enabled: false,
      items: [],
      next: null,
      total: 0,
      folders: await configuredRows(env, prefs),
      scanning: false,
      scanned_at: _state.scannedAt || null,
      truncated: false,
    };
  }
  const stale = env.now() - _state.scannedAt > SCAN_TTL_MS;
  if (stale && !_state.scanning) {
    const folders = await activeFolders(env, prefs);
    _state.folders = folders;
    startScan(env, folders);
  }
  const page = pageItems(_state.items, {
    query: typeof call.query === "string" ? call.query : "",
    folder: typeof call.folder === "string" && call.folder !== "" ? call.folder : null,
    offset: call.offset,
    limit: call.limit,
  });
  const rows = await configuredRows(env, prefs);
  return {
    kind: "list",
    profile,
      items: page.items,
    next: page.next,
    total: page.total,
    folders: rows,
    scanning: _state.scanning,
    scanned_at: _state.scannedAt || null,
    truncated: _state.truncated,
  };
}

function changedFolders(env, prefs, { keepItems = false } = {}) {
  const next = _state.generation + 1;
  _state.generation = next;
  if (!keepItems) {
    _state.items = [];
    // The grid's thumbnails belong to the list that just went away, and a
    // queued decode should not keep reading a folder the person removed.
    for (const job of _state.thumbQueue) {
      _state.thumbPending.delete(job.key);
      job.resolve({
        kind: "thumbnail",
        path: job.item.path,
        data: null,
        error: "cancelled",
      });
    }
    _state.thumbQueue = [];
    _state.thumbnails.clear();
    _state.thumbBytes = 0;
  }
  _state.scannedAt = 0;
  _state.scanning = false;
  _state.truncated = false;
  if (_state.scanTimer !== null) {
    clearTimeout(_state.scanTimer);
    _state.scanTimer = null;
  }
  void env;
}

export const MediaGallery = {
  /**
   * One gallery call. The UI speaks `GalleryCall`; every reply is real state
   * or an honest error (`invalid`, `disabled`, `covered`, `unavailable`).
   */
  async call({
    profile = "",
    expected_profile = "",
    call = null,
  } = {}) {
    const asked =
      typeof profile === "string" && profile !== ""
        ? profile
        : typeof expected_profile === "string"
          ? expected_profile
          : "";
    if (typeof asked !== "string" || asked === "") {
      return { kind: "error", error: "invalid", profile: "" };
    }
    const env = environment();
    if (!env) {
      return { kind: "error", error: "unavailable", profile: asked };
    }
    _state.log ??= env.log ?? null;
    ensureCacheDir(env);
    if (!isObject(call) || typeof call.kind !== "string") {
      return { kind: "error", error: "invalid", profile: asked };
    }
    try {
      switch (call.kind) {
        case "state":
          return await stateReply(env, asked);
        case "list":
          return await listReply(env, asked, call);
        case "refresh": {
          const prefs = readPreferences(env);
          const folders = await activeFolders(env, prefs);
          changedFolders(env, prefs, { keepItems: _state.items.length > 0 });
          startScan(env, folders, { force: true });
          // Wait for this one so a refresh has something to show when it says
          // it is done. The walk itself is bounded by MAX_SCAN_MS.
          await new Promise((resolve) => {
            const check = () => {
              if (!_state.scanning) {
                if (_state.scanTimer !== null) {
                  clearTimeout(_state.scanTimer);
                  _state.scanTimer = null;
                }
                resolve();
              } else {
                _state.scanTimer = setTimeout(check, 80);
              }
            };
            check();
          });
          return await stateReply(env, asked);
        }
        case "set_enabled": {
          if (typeof call.enabled !== "boolean") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const ok = env.prefs.setBool(ENABLED_PREF, call.enabled);
          if (!ok) return { kind: "error", error: "unavailable", profile: asked };
          if (!call.enabled) {
            changedFolders(env, readPreferences(env));
            _state.items = [];
          }
          return await stateReply(env, asked);
        }
        case "add_folder": {
          const prefs = readPreferences(env);
          if (typeof env.pickFolder !== "function") {
            return { kind: "error", error: "unavailable", profile: asked };
          }
          const picked = await env.pickFolder();
          if (picked === null) return { kind: "error", error: "cancelled", profile: asked };
          if (typeof picked !== "string" || picked === "") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const target = normalize(env, picked);
          const info = await env.stat(target).catch(() => null);
          if (info?.type !== "directory") {
            return { kind: "error", error: "missing", profile: asked };
          }
          const insensitive = env.separator === "\\";
          // Picking a folder a watched root already covers would walk the same
          // pictures twice. Say so instead of adding a redundant root.
          const known = await configuredRows(env, prefs);
          const covered = known.some(
            (row) =>
              row.path === target ||
              isInside(normalize(env, row.path), target, env.separator, insensitive),
          );
          if (covered) {
            return { kind: "error", error: "covered", profile: asked };
          }
          if (prefs.custom.length >= MAX_CUSTOM_FOLDERS) {
            return { kind: "error", error: "limit", profile: asked };
          }
          const next = [...prefs.custom, target];
          if (!writePaths(env, CUSTOM_PREF, next)) {
            return { kind: "error", error: "unavailable", profile: asked };
          }
          changedFolders(env, prefs);
          return await stateReply(env, asked);
        }
        case "remove_folder": {
          if (typeof call.path !== "string" || call.path === "") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const prefs = readPreferences(env);
          const rows = await configuredRows(env, prefs);
          const found = rows.find((row) => row.path === call.path);
          if (!found) return { kind: "error", error: "missing", profile: asked };
          if (found.kind === "custom") {
            const next = prefs.custom.filter((path) => path !== found.path);
            if (!writePaths(env, CUSTOM_PREF, next)) {
              return { kind: "error", error: "unavailable", profile: asked };
            }
          } else {
            const next = [...prefs.excluded, found.kind];
            if (!writePaths(env, EXCLUDED_PREF, next)) {
              return { kind: "error", error: "unavailable", profile: asked };
            }
          }
          changedFolders(env, prefs);
          return await stateReply(env, asked);
        }
        case "restore_defaults": {
          const prefs = readPreferences(env);
          if (!writePaths(env, EXCLUDED_PREF, [])) {
            return { kind: "error", error: "unavailable", profile: asked };
          }
          changedFolders(env, prefs);
          return await stateReply(env, asked);
        }
        case "thumbnail": {
          if (typeof call.path !== "string" || call.path === "") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const item = itemForPath(call.path);
          if (!item) return { kind: "error", error: "missing", profile: asked };
          const size = Number(call.size) === VIEW_THUMB ? VIEW_THUMB : GRID_THUMB;
          return await thumbnailFor(env, item, size);
        }
        case "open":
        case "reveal":
        case "copy": {
          if (typeof call.path !== "string" || call.path === "") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const prefs = readPreferences(env);
          const folders = await activeFolders(env, prefs);
          const target = allowedPath(env, folders, call.path);
          if (!target) return { kind: "error", error: "outside", profile: asked };
          const info = await env.stat(target).catch(() => null);
          if (info?.type !== "regular") {
            return { kind: "error", error: "missing", profile: asked };
          }
          if (call.kind === "open") env.openFile(target);
          else if (call.kind === "reveal") env.revealFile(target);
          else env.copyFile(target);
          return { kind: "action", action: call.kind, ok: true, profile: asked };
        }
        case "opener": {
          if (typeof call.path !== "string" || call.path === "") {
            return { kind: "error", error: "invalid", profile: asked };
          }
          const item = itemForPath(call.path);
          return {
            kind: "opener",
            profile: asked,
            opener: env.opener?.(item?.extension ?? extensionOf(call.path)) ?? "",
          };
        }
        default:
          return { kind: "error", error: "invalid", profile: asked };
      }
    } catch (error) {
      _state.log?.(error);
      return { kind: "error", error: "unavailable", profile: asked };
    }
  },

};

export const __galleryInternals = {
  DEFAULT_ROOTS,
  IMAGE_EXTENSIONS,
  MAX_DEPTH,
  MAX_DIRS,
  MAX_ITEMS,
  MAX_SCAN_MS,
  GRID_THUMB,
  VIEW_THUMB,
  CACHE_MAX_FILES,
  CACHE_MAX_BYTES,
  readFolder,
  scan,
  folderExists,
  activeFolders,
  normalize,
  allowedPath,
};

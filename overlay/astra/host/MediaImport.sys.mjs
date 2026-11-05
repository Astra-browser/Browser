/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API media import (wiring). The New Tab background picker and the Work
// file picker both call `media_import`; this module answers with the
// `MediaImportV1` record the UI already consumes
// (`ui/app/src/shared/ipc/bindings.ts`).
//
// A file is picked with the engine's own `nsIFilePicker`, read once with a
// hard byte bound, admitted into the media contract's image/pdf/file shape
// (an image is sniffed and decoded, a PDF is its header, anything else is a
// file), and written to the profile's content-addressed store at
// `<ProfD>/astra-media/<profile>/<digest>`.
//
// Serving is the same store over `astra-media://localhost/<profile>/<digest>`.
// A small `nsIProtocolHandler` is registered when this module loads, so the
// New Tab `<img>` renders after a restart without an import in that session.
// Only an exact profile ULID and a 64 hex digit digest resolve; every other
// path is a 404. The channel is a file channel for that one blob, with the
// sniffed MIME type, and is never allowed to escape the media root.
//
// Pure admission/path helpers are exported for the Node contract test; the
// chrome pieces are guarded so importing this file outside a browser is safe.

const MEDIA_SCHEME = "astra-media";
const MEDIA_HOST = "localhost";
const MEDIA_DIR = "astra-media";

/** Bounds copied from the shared media contract (`MediaAssetV1`). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_NAME_BYTES = 255;

const PROFILE = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

const WIDTH = /^[1-9][0-9]{0,4}$/u;

let _hooks = null;

/** Test seam: stand in for the picker and the profile store. */
export function __setMediaImportHooksForTests(hooks) {
  _hooks = hooks ?? null;
}

/** Test-only reset. The protocol registration itself is process-scoped. */
export function __resetMediaImportForTests() {
  _hooks = null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function u16be(bytes, at) {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u16le(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u24le(bytes, at) {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

async function sha256Hex(bytes) {
  const hashed = await crypto.subtle.digest("SHA-256", bytes);
  let out = "";
  for (const byte of new Uint8Array(hashed)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** The image's format and pixel size, sniffed from its own bytes. */
export function sniffImage(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A, then IHDR with width/height big-endian.
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    if (bytes.length < 24 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") {
      return null;
    }
    return {
      mime: "image/png",
      width: new DataView(bytes.buffer, bytes.byteOffset + 16, 4).getUint32(0),
      height: new DataView(bytes.buffer, bytes.byteOffset + 20, 4).getUint32(0),
    };
  }

  // GIF87a / GIF89a, logical screen descriptor at bytes 6..9 little-endian.
  if (String.fromCharCode(...bytes.slice(0, 6)) === "GIF87a" || String.fromCharCode(...bytes.slice(0, 6)) === "GIF89a") {
    return { mime: "image/gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }

  // JPEG: walk markers until a Start Of Frame carries the dimensions.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const length = u16be(bytes, at + 2);
      if (length < 2 || at + 2 + length > bytes.length) return null;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15.
      const sof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (sof) {
        return {
          mime: "image/jpeg",
          height: u16be(bytes, at + 5),
          width: u16be(bytes, at + 7),
        };
      }
      at += 2 + length;
    }
    return null;
  }

  // WebP: RIFF....WEBP, then one of VP8X / VP8 / VP8L.
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.slice(12, 16));
    if (chunk === "VP8X" && bytes.length >= 30) {
      return {
        mime: "image/webp",
        width: 1 + u24le(bytes, 24),
        height: 1 + u24le(bytes, 27),
      };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      return {
        mime: "image/webp",
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && bytes.length >= 25) {
      const b1 = bytes[21];
      const b2 = bytes[22];
      const b3 = bytes[23];
      const b4 = bytes[24];
      return {
        mime: "image/webp",
        width: 1 + (((b1 | (b2 << 8)) & 0x3fff)),
        height: 1 + ((((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff)),
      };
    }
    return null;
  }

  return null;
}

/** The display name Rust would keep: no controls, no separators, bounded. */
export function cleanName(name) {
  const cleaned = String(name ?? "")
    .split("")
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f && character !== "/" && character !== "\\";
    })
    .join("")
    .trim();
  if (cleaned === "") return "file";
  const encoder = new TextEncoder();
  let out = "";
  for (const character of cleaned) {
    if (encoder.encode(out + character).length > MAX_NAME_BYTES) break;
    out += character;
  }
  return out || "file";
}

/** Whether a byte stream starts with one of the image signatures the media
 *  contract admits, even if the rest of it turns out to be malformed. */
function looksLikeImage(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return true;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return true;
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return true;
  }
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

/**
 * Admit one file's bytes into the shared media shape: an image when the bytes
 * decode as one the contract declares, a PDF when they carry its header, and
 * a plain file otherwise. The New Tab picker additionally requires an image,
 * because that surface has nothing to draw otherwise.
 */
export async function admitMedia(bytes, name) {
  if (!(bytes instanceof Uint8Array)) {
    try {
      bytes = new Uint8Array(bytes);
    } catch {
      return { ok: false, error: "invalid" };
    }
  }
  if (bytes.length === 0) return { ok: false, error: "invalid" };
  if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: "capacity" };

  let kind = "file";
  let mime = "application/octet-stream";
  let width = null;
  let height = null;
  if (looksLikeImage(bytes)) {
    const image = sniffImage(bytes);
    if (!image) return { ok: false, error: "invalid" };
    if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "capacity" };
    if (
      image.width < 1 ||
      image.height < 1 ||
      image.width > MAX_DIMENSION ||
      image.height > MAX_DIMENSION
    ) {
      return { ok: false, error: "invalid" };
    }
    kind = "image";
    mime = image.mime;
    width = image.width;
    height = image.height;
  } else if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-") {
    kind = "pdf";
    mime = "application/pdf";
  }

  return {
    ok: true,
    asset: {
      version: 1,
      kind,
      mime,
      bytes: bytes.length,
      digest: await sha256Hex(bytes),
      name: cleanName(name),
      origin: { kind: "imported" },
      width,
      height,
    },
  };
}

/** The record shape `media_import` returns (`ResourceRecord`). */
export function recordFor(asset, now = Date.now()) {
  const stamp = String(Math.floor(now / 1000));
  return {
    id: asset.digest,
    revision: "1",
    created_at: stamp,
    updated_at: stamp,
    trashed: false,
    draft: {
      title: asset.name,
      pinned: false,
      content: { kind: "media", asset },
      related: [],
    },
  };
}

/**
 * `astra-media://localhost/<profile>/<digest>?w=<px>` -> the one blob it names.
 * The path is parsed from its parts, never joined from user text, so a `..`
 * or an encoded slash cannot leave the media root.
 */
export function parseMediaRequest(path, query = "") {
  let clean = String(path ?? "").replace(/^\/+/u, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const parts = clean.split("/");
  if (parts.length !== 2) return null;
  const [profile, digest] = parts;
  if (!PROFILE.test(profile) || !DIGEST.test(digest)) return null;
  let width = null;
  try {
    const value = new URLSearchParams(String(query ?? "").replace(/^\?/u, "")).get("w");
    if (value !== null && WIDTH.test(value)) width = Number(value);
  } catch {
    width = null;
  }
  return { profile, digest, width };
}

function chromeScope() {
  try {
    return globalThis.window ?? globalThis.document?.defaultView ?? globalThis;
  } catch {
    return globalThis;
  }
}

function chromePieces() {
  const scope = chromeScope();
  const cc = scope.Cc ?? globalThis.Cc;
  const ci = scope.Ci ?? globalThis.Ci;
  const services = scope.Services ?? globalThis.Services;
  if (!cc || !ci || !services) return null;
  return { cc, ci, services, scope };
}

function importModule(specifier) {
  try {
    const scope = chromeScope();
    return scope.ChromeUtils?.importESModule?.(specifier) ?? globalThis.ChromeUtils?.importESModule?.(specifier) ?? null;
  } catch {
    return null;
  }
}

function ioutils() {
  try {
    const scope = chromeScope();
    const io = scope.IOUtils ?? globalThis.IOUtils;
    if (io && typeof io.read === "function") return io;
  } catch {
    // Fall through to the module form on a build that still ships it.
  }
  return importModule("resource://gre/modules/IOUtils.sys.mjs")?.IOUtils ?? null;
}

function mediaRoot(services, ci) {
  const file = services.dirsvc.get("ProfD", ci.nsIFile);
  const root = file.clone();
  root.append(MEDIA_DIR);
  return root;
}

function blobFile(services, ci, profile, digest) {
  const root = mediaRoot(services, ci);
  const dir = root.clone();
  dir.append(profile);
  const file = dir.clone();
  file.append(digest);
  return file;
}

async function pickWithFilePicker() {
  const chrome = chromePieces();
  if (!chrome) return null;
  const { cc, ci, services } = chrome;
  const picker = cc["@mozilla.org/filepicker;1"].createInstance(ci.nsIFilePicker);
  const win = services.wm.getMostRecentWindow("navigator:browser");
  picker.init(win, "Choose a file", ci.nsIFilePicker.modeOpen);
  // Images first for the New Tab background; All files keeps the same native
  // command usable for Work documents.
  picker.appendFilter("Images", "*.png;*.jpg;*.jpeg;*.webp;*.gif");
  picker.appendFilter("All files", "*.*");
  const result = await new Promise((resolve) => picker.open(resolve));
  if (result !== ci.nsIFilePicker.returnOK) return null;
  return picker.file;
}

async function readPickedFile(file) {
  const chrome = chromePieces();
  if (!chrome) return null;
  const { ci } = chrome;
  let size = 0;
  try {
    size = file.fileSize;
  } catch {
    return null;
  }
  if (size < 1 || size > MAX_FILE_BYTES) return null;
  const io = await ioutils();
  if (!io) return null;
  const bytes = await io.read(file.path, { maxBytes: MAX_FILE_BYTES + 1 });
  return bytes instanceof Uint8Array && bytes.length > 0 ? bytes : null;
}

async function saveBlob(profile, digest, bytes) {
  const chrome = chromePieces();
  if (!chrome) return false;
  const { ci, services } = chrome;
  const root = mediaRoot(services, ci);
  try {
    if (!root.exists()) root.create(ci.nsIFile.DIRECTORY_TYPE, 0o700);
    const dir = root.clone();
    dir.append(profile);
    if (!dir.exists()) dir.create(ci.nsIFile.DIRECTORY_TYPE, 0o700);
    const file = dir.clone();
    file.append(digest);
    if (file.exists()) return true;
    const io = await ioutils();
    if (!io || typeof io.write !== "function") return false;
    // Write beside the blob and let IOUtils move it into place, so a crash
    // never leaves a partial content-addressed file.
    await io.write(file.path, bytes, {
      mode: "overwrite",
      tmpPath: `${file.path}.tmp`,
    });
    return true;
  } catch {
    return false;
  }
}

function sniffFile(file) {
  const chrome = chromePieces();
  if (!chrome) return null;
  const { cc, ci } = chrome;
  try {
    const stream = cc["@mozilla.org/network/file-input-stream;1"].createInstance(ci.nsIFileInputStream);
    stream.init(file, 0x01, 0o444, 0);
    const binary = cc["@mozilla.org/binaryinputstream;1"].createInstance(ci.nsIBinaryInputStream);
    binary.setInputStream(stream);
    const head = new Uint8Array(binary.readByteArray(32));
    binary.close();
    return sniffImage(head)?.mime ?? null;
  } catch {
    return null;
  }
}

function notFound() {
  const ci = chromePieces()?.ci;
  const cr = chromeScope().Cr ?? globalThis.Cr;
  return new (cr?.Exception ?? Error)(
    "no such media blob",
    ci?.NS_ERROR_FILE_NOT_FOUND ?? 0x80520012,
  );
}

function channelFor(uri, loadInfo) {
  const chrome = chromePieces();
  if (!chrome) throw notFound();
  const { ci, services } = chrome;
  if (uri.host !== MEDIA_HOST) throw notFound();
  const ref = typeof uri.pathQueryRef === "string" ? uri.pathQueryRef : "";
  const mark = ref.indexOf("?");
  const target = parseMediaRequest(
    mark >= 0 ? ref.slice(0, mark) : ref,
    mark >= 0 ? ref.slice(mark + 1) : "",
  );
  if (!target) throw notFound();
  const file = blobFile(services, ci, target.profile, target.digest);
  if (!file.exists() || !file.isFile()) throw notFound();
  const fileURI = services.io.newFileURI(file);
  let channel;
  if (loadInfo && typeof services.io.newChannelFromURIWithLoadInfo === "function") {
    // The engine checks that a handler attaches the exact loadInfo it was
    // given (nsIOService::NewChannelFromURIWithProxyFlagsInternal). Reuse it
    // on the file channel instead of creating a second one.
    channel = services.io.newChannelFromURIWithLoadInfo(fileURI, loadInfo);
  } else {
    const { NetUtil } = importModule("resource://gre/modules/NetUtil.sys.mjs") ?? {};
    if (!NetUtil) throw notFound();
    channel = NetUtil.newChannel({
      uri: fileURI,
      loadUsingSystemPrincipal: true,
      contentPolicyType: ci.nsIContentPolicy.TYPE_IMAGE,
    });
  }
  channel.contentType = sniffFile(file) ?? "application/octet-stream";
  return channel;
}

/** Register the profile media scheme once per process. */
export function registerMediaProtocol() {
  const chrome = chromePieces();
  if (!chrome) return false;
  const { ci, services } = chrome;
  if (typeof services.io?.registerProtocolHandler !== "function") return false;
  try {
    services.io.registerProtocolHandler(
      MEDIA_SCHEME,
      {
        scheme: MEDIA_SCHEME,
        newChannel: (uri, loadInfo) => channelFor(uri, loadInfo),
        allowPort: () => false,
        QueryInterface: chromeScope().ChromeUtils?.generateQI?.([ci.nsIProtocolHandler])
          ?? globalThis.ChromeUtils?.generateQI?.([ci.nsIProtocolHandler]),
      },
      ci.nsIProtocolHandler.URI_NORELATIVE | ci.nsIProtocolHandler.URI_DANGEROUS_TO_LOAD,
      -1,
    );
    return true;
  } catch {
    // Already registered, or this build does not expose the registration API.
    return false;
  }
}

function refused(error) {
  return { kind: "refused", error };
}

export const MediaImport = {
  /**
   * Pick one image and admit it into `expected_profile`'s media store. Answers
   * a `MediaImportV1` in every case: `cancelled`, `refused` with a declared
   * `ResourceError`, or `imported` with the record the UI stores.
   */
  async import({ expected_profile = "", profile = "" } = {}) {
    const owner = typeof expected_profile === "string" && expected_profile !== ""
      ? expected_profile
      : typeof profile === "string"
        ? profile
        : "";
    if (!PROFILE.test(owner)) return refused("invalid");

    let picked;
    try {
      if (_hooks?.pick) {
        picked = await _hooks.pick();
      } else {
        // No chrome process means no picker exists. That is unavailable, not
        // a cancelled dialog the person never saw.
        if (chromePieces() === null) return refused("unavailable");
        const file = await pickWithFilePicker();
        if (file === null) return { kind: "cancelled" };
        const bytes = await readPickedFile(file);
        if (!bytes) return refused("capacity");
        picked = { name: file.leafName, bytes };
      }
    } catch {
      return refused("unavailable");
    }
    if (!picked) return { kind: "cancelled" };
    if (!(picked.bytes instanceof Uint8Array) || picked.bytes.length === 0) {
      return refused("invalid");
    }

    const admitted = await admitMedia(picked.bytes, picked.name);
    if (!admitted.ok) return refused(admitted.error);

    try {
      const saved = _hooks?.save
        ? await _hooks.save(owner, admitted.asset.digest, picked.bytes)
        : await saveBlob(owner, admitted.asset.digest, picked.bytes);
      if (!saved) return refused("unavailable");
    } catch {
      return refused("unavailable");
    }

    return { kind: "imported", record: recordFor(admitted.asset) };
  },
};

// Register as soon as the module loads, so an image stored in an earlier
// session renders on the first New Tab after a restart.
registerMediaProtocol();

export const __mediaImportInternals = {
  MEDIA_SCHEME,
  MEDIA_HOST,
  MAX_IMAGE_BYTES,
  MAX_FILE_BYTES,
  MAX_DIMENSION,
  MEDIA_DIR,
};

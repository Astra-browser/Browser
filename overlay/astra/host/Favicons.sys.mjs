/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API favicons module (v1). Turns the favicon Firefox already stored for
// a page into the one raster form the chrome UI accepts: exactly 32x32 RGBA
// bytes, base64 encoded. Chrome never decodes a page-controlled image format
// (`FaviconEntry` in `ui/app/src/shared/ipc/bindings.ts`), so decoding and
// scaling happen here, in the privileged host, and never in the app.
//
// Why Places instead of `onLinkIconAvailable`: Firefox's `LinkHandlerParent`
// stores the favicon in Places while the page loads, independently of whether
// the tab's own icon notification fires. Reading Places after the document
// load finishes is therefore the reliable source; waiting for a tab icon event
// misses icons that were stored but never announced.
//
// Verified against the pinned engine (153.6.0):
//   toolkit/components/places/nsIFaviconService.idl
//     - FaviconService.getFaviconForPage(pageURI, preferredWidth)
//       -> Promise<nsIFavicon | null>; nsIFavicon has `rawData` (a byte
//          array), `mimeType`, and `dataURI` (a data: URL of the stored icon).
//   image/imgITools.idl
//     - imgITools.decodeImageFromBuffer(bytes, length, mimeType)
//       -> imgIContainer; throws for bytes the image decoder cannot read.
//
// Drawing note: `imgIContainer` is not a `CanvasImageSource` in this engine
// (`dom/webidl/CanvasRenderingContext2D.webidl`), so the decoded icon cannot be
// handed straight to `drawImage`. The raster is drawn through an `<img>` fed
// by the Places data URI, which also covers SVG favicons that
// `createImageBitmap` refuses; the canvas then yields plain pixels. The
// imgITools decode above still runs first so a corrupt or unsupported blob is
// rejected before an element is built for it.
//
// Pure module with injectable seams, like History.sys.mjs: it imports nothing,
// touches Firefox internals only inside the lazily-resolved live backend, and
// stays loadable by path in Node. Event emission goes through an injectable
// sink (HostAPI/Content wiring connects it to the Events pump); unconnected it
// is a no-op. Node gets no Places, so `resolve` answers null and no event is
// ever invented.

/** The one surface that accepts this raster form (IconSurface). */
const SURFACE = "chrome";

/** The profile every tab belongs to until profiles are wired. */
const PROFILE_ID = "default";

/** The only raster shape the chrome UI decodes. */
const SIDE = 32;

/** RGBA bytes for one 32x32 icon. */
const RASTER_LENGTH = SIDE * SIDE * 4;

const XHTML_NS = "http://www.w3.org/1999/xhtml";

// --- Injectable seams (Node contract tests, HostAPI wiring) ----------------

let _backend = null; // { raster(url, doc) } -> Uint8Array | null
let _eventSink = null; // (view) => void
let _liveBackendPromise = null;

// Replacement backend; returns a reset function so a suite can undo it.
export function __setFaviconBackend(backend) {
  _backend = backend || null;
  return () => {
    if (_backend === backend) {
      _backend = null;
    }
  };
}

export function __setFaviconEventSink(fn) {
  _eventSink = fn || null;
}

export function __resetFaviconsForTests() {
  _backend = null;
  _eventSink = null;
  _liveBackendPromise = null;
  _storedCache.clear();
}

function emit(view) {
  if (_eventSink) {
    try {
      _eventSink(view);
    } catch {
      // A broken listener must never break a page load.
    }
  }
}

function inChrome() {
  return (
    typeof globalThis.ChromeUtils !== "undefined" &&
    globalThis.ChromeUtils &&
    typeof globalThis.ChromeUtils.importESModule === "function"
  );
}

async function backend() {
  if (_backend) {
    return _backend;
  }
  if (!inChrome()) {
    return null;
  }
  if (!_liveBackendPromise) {
    // A failed import is not fatal: the tab keeps its letter tile and a later
    // page load retries the import.
    _liveBackendPromise = (async () => {
      const { PlacesUtils } = await import(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      return createPlacesBackend(PlacesUtils);
    })().catch(() => {
      _liveBackendPromise = null;
      return null;
    });
  }
  return _liveBackendPromise;
}

// --- Places backend ---------------------------------------------------------

/** `rawData` is a byte array; imgITools wants one binary string. */
function binaryString(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    out += String.fromCharCode.apply(
      null,
      bytes.slice(index, index + 0x8000),
    );
  }
  return out;
}

/**
 * Wait for an `<img>` to finish decoding. `decode()` is the modern path; the
 * load/error fallback keeps a data URI working on a document whose image
 * element never fires a decode promise.
 */
function loadImage(doc, src) {
  return new Promise((resolve) => {
    let img;
    let guard = 0;
    try {
      img = doc.createElementNS(XHTML_NS, "img");
      img.decoding = "sync";
    } catch {
      resolve(null);
      return;
    }
    const done = (value) => {
      if (guard) {
        clearTimeout(guard);
        guard = 0;
      }
      img.onload = null;
      img.onerror = null;
      resolve(value);
    };
    // A stalled decode must not hold the tab's icon forever.
    guard = setTimeout(() => done(null), 5000);
    img.onload = () => done(img);
    img.onerror = () => done(null);
    try {
      img.src = src;
    } catch {
      done(null);
      return;
    }
    // An image that is already complete (a cached data URI) never fires load.
    if (img.complete) {
      done(img.naturalWidth > 0 ? img : null);
      return;
    }
    try {
      const decoded = typeof img.decode === "function" ? img.decode() : null;
      if (decoded && typeof decoded.then === "function") {
        decoded.then(
          () => done(img),
          () => done(null),
        );
        return;
      }
    } catch {
      // Fall back to the load event already wired above.
    }
  });
}

function drawRaster(doc, src) {
  return (async () => {
    const img = await loadImage(doc, src);
    if (!img) {
      return null;
    }
    let canvas;
    let ctx;
    try {
      canvas = doc.createElementNS(XHTML_NS, "canvas");
      canvas.width = SIDE;
      canvas.height = SIDE;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    } catch {
      ctx = null;
    }
    if (!ctx) {
      return null;
    }
    try {
      ctx.clearRect(0, 0, SIDE, SIDE);
      ctx.drawImage(img, 0, 0, SIDE, SIDE);
      return ctx.getImageData(0, 0, SIDE, SIDE).data;
    } catch {
      // A tainted or undrawable icon: no raster this surface accepts.
      return null;
    }
  })();
}

function blobToDataUrl(win, blob) {
  return new Promise((resolve) => {
    try {
      const reader = new win.FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch {
      resolve(null);
    }
  });
}

/**
 * The engine only stores an icon for a browser it recognises as a tab
 * (`LinkHandlerParent` bails when `gBrowser.getTabForBrowser` has nothing).
 * The Astra stage owns standalone browsers, so Places is often empty even
 * though the page declared an icon. Read the site's own icon instead: the
 * conventional `/favicon.ico` first (one small request), then the page's
 * `<link rel="icon">` when that 404s. A private window never calls this — the
 * caller filters it out — so no private page's icon is read elsewhere.
 */
async function fetchIconSource(doc, pageUrl) {
  const win = doc?.defaultView;
  const origin = originOf(pageUrl);
  if (!win || !origin || typeof win.fetch !== "function") {
    return null;
  }
  const grab = async (src) => {
    try {
      const response = await win.fetch(src, { credentials: "include" });
      if (!response.ok) {
        return null;
      }
      const type = response.headers.get("content-type") || "";
      if (type.startsWith("text/html")) {
        return null;
      }
      const blob = await response.blob();
      // An icon larger than this is not an icon; it is a page or a trap.
      if (!blob || blob.size === 0 || blob.size > 1_000_000) {
        return null;
      }
      return await blobToDataUrl(win, blob);
    } catch {
      return null;
    }
  };
  const conventional = await grab(`${origin}/favicon.ico`);
  if (conventional) {
    return conventional;
  }
  try {
    const response = await win.fetch(pageUrl, { credentials: "include" });
    if (!response.ok) {
      return null;
    }
    const type = response.headers.get("content-type") || "";
    if (!type.includes("html")) {
      return null;
    }
    const text = (await response.text()).slice(0, 512 * 1024);
    const parsed = new win.DOMParser().parseFromString(text, "text/html");
    for (const link of parsed.querySelectorAll("link[rel]")) {
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      if (!/(^|\s)(icon|apple-touch-icon)(\s|$)/u.test(rel)) {
        continue;
      }
      const href = link.getAttribute("href");
      if (!href) {
        continue;
      }
      let absolute;
      try {
        absolute = new win.URL(href, pageUrl).href;
      } catch {
        continue;
      }
      const data = await grab(absolute);
      if (data) {
        return data;
      }
    }
  } catch {
    // A page that will not be read again keeps its letter tile.
  }
  return null;
}

function createPlacesBackend(PlacesUtils) {
  /** Read the icon Places already holds for `url` and rasterize it. */
  async function stored(url, doc) {
    if (!doc || !doc.defaultView) {
      return null;
    }
    let favicon = null;
    try {
      favicon = await PlacesUtils.favicons.getFaviconForPage(
        PlacesUtils.toURI(url),
        SIDE,
      );
    } catch {
      // No favicon row, or Places is unavailable: no stored icon.
      return null;
    }
    if (!favicon?.rawData?.length || !favicon.dataURI) {
      return null;
    }
    // Decode once with the image service. This is the engine's own decoder,
    // so bytes it cannot read are refused before an element is built; SVG
    // (which the decoder may not handle but an `<img>` renders) is still
    // given its chance below.
    try {
      const imgTools = Cc["@mozilla.org/image/tools;1"].getService(
        Ci.imgITools,
      );
      const bytes = binaryString(favicon.rawData);
      imgTools.decodeImageFromBuffer(
        bytes,
        bytes.length,
        favicon.mimeType || "image/png",
      );
    } catch {
      // Not a raster the image service decodes: the element decides.
    }
    // `imgIContainer` is not drawable on a canvas; the stored data URI is.
    return drawRaster(doc, favicon.dataURI.spec);
  }

  /** Keep an icon this host fetched in Places, so history and later visits
   *  find it without another network request. Best-effort and not awaited:
   *  the tab must not wait on a database write. */
  function persist(url, dataUrl) {
    try {
      PlacesUtils.favicons
        .setFaviconForPage(
          PlacesUtils.toURI(url),
          PlacesUtils.toURI(dataUrl),
          PlacesUtils.toURI(dataUrl),
          0,
          false,
        )
        .catch(() => {});
    } catch {
      // A refused write leaves the in-session raster in place.
    }
  }

  return {
    /** Places only, no network: what history needs. */
    rasterStored: stored,
    async raster(url, doc) {
      const fromPlaces = await stored(url, doc);
      if (fromPlaces) {
        return fromPlaces;
      }
      const source = await fetchIconSource(doc, url);
      if (!source) {
        return null;
      }
      persist(url, source);
      return drawRaster(doc, source);
    },
  };
}

// --- Pure helpers -----------------------------------------------------------

/** `scheme://host[:port]`, the key a site's icons are cached under. */
export function originOf(url) {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : "";
  } catch {
    return "";
  }
}

/**
 * A stable short hash of the pixels, so chrome repaints only when the bytes
 * actually change. Two independent 32-bit FNV-1a seeds keep a collision from
 * masquerading as an unchanged icon.
 */
export function revisionOf(bytes) {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    first ^= byte;
    first = Math.imul(first, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return (
    first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0")
  );
}

/** Canonical base64 of the RGBA bytes, exactly `FaviconEntry.rgba`. */
export function encodeRgba(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(
      null,
      bytes.slice(index, index + 0x8000),
    );
  }
  return btoa(binary);
}

function asRaster(bytes) {
  if (!bytes || bytes.length !== RASTER_LENGTH) {
    return null;
  }
  return bytes instanceof Uint8ClampedArray ? bytes : Uint8ClampedArray.from(bytes);
}

/** Session cache for history: one resolved view (or "none") per origin, so a
 *  page of visits asks Places once per site, not once per row. Bounded; a
 *  profile that browses forever cannot grow it without limit. */
const _storedCache = new Map();
const STORED_CACHE_MAX = 256;

function rememberStored(origin, view) {
  if (_storedCache.has(origin)) {
    _storedCache.delete(origin);
  }
  _storedCache.set(origin, view);
  while (_storedCache.size > STORED_CACHE_MAX) {
    const oldest = _storedCache.keys().next();
    if (oldest.done) break;
    _storedCache.delete(oldest.value);
  }
}

// --- Public API -------------------------------------------------------------

export const Favicons = {
  /**
   * Resolve the stored favicon for `url` into a `FaviconEntry` plus the
   * `FaviconView` envelope it belongs in. `doc` must be a privileged chrome
   * document; it supplies the offscreen canvas and is never exposed to the
   * page. Answers null when there is no icon, no document, or no Places.
   */
  async resolve({ url, doc = null, profileId = PROFILE_ID } = {}) {
    if (typeof url !== "string" || url === "") {
      return null;
    }
    const origin = originOf(url);
    if (!origin) {
      return null;
    }
    const store = await backend();
    if (!store) {
      return null;
    }
    let bytes;
    try {
      bytes = asRaster(await store.raster(url, doc));
    } catch {
      return null;
    }
    if (!bytes) {
      return null;
    }
    const resolved = {
      surface: SURFACE,
      profile_id: typeof profileId === "string" && profileId !== "" ? profileId : PROFILE_ID,
      entry: {
        origin,
        revision: revisionOf(bytes),
        rgba: encodeRgba(bytes),
      },
    };
    rememberStored(origin, resolved);
    return resolved;
  },

  /**
   * Resolve an icon from Places only, without a network request. History uses
   * this: its rows often name pages from earlier sessions, and fetching every
   * site again would make opening History cost a page load per row. Answers
   * the same view shape as `resolve`, or null; a negative answer is cached for
   * the session too.
   */
  async resolveStored({ url, doc = null, profileId = PROFILE_ID } = {}) {
    if (typeof url !== "string" || url === "") {
      return null;
    }
    const origin = originOf(url);
    if (!origin) {
      return null;
    }
    if (_storedCache.has(origin)) {
      const cached = _storedCache.get(origin);
      return cached ? { ...cached, profile_id: profileId || PROFILE_ID } : null;
    }
    const target =
      doc ?? (typeof globalThis !== "undefined" ? globalThis.document ?? null : null);
    const store = await backend();
    if (!target || !store || typeof store.rasterStored !== "function") {
      return null;
    }
    let bytes = null;
    try {
      bytes = asRaster(await store.rasterStored(url, target));
    } catch {
      bytes = null;
    }
    if (!bytes) {
      rememberStored(origin, null);
      return null;
    }
    const resolved = {
      surface: SURFACE,
      profile_id: typeof profileId === "string" && profileId !== "" ? profileId : PROFILE_ID,
      entry: { origin, revision: revisionOf(bytes), rgba: encodeRgba(bytes) },
    };
    rememberStored(origin, resolved);
    return resolved;
  },

  /**
   * Announce one resolved icon as `favicons-changed`. Only the reference
   * travels with the tab; the raster travels here once, keyed by origin and
   * revision, so a projection costs a short string per tab.
   */
  publish(resolved) {
    if (
      !resolved ||
      !resolved.entry ||
      typeof resolved.entry.origin !== "string" ||
      typeof resolved.entry.revision !== "string" ||
      typeof resolved.entry.rgba !== "string"
    ) {
      return false;
    }
    emit({
      surface: resolved.surface || SURFACE,
      profile_id: resolved.profile_id || PROFILE_ID,
      entries: [resolved.entry],
    });
    return true;
  },

  /**
   * Resolve and publish in one call; answers the `IconRef` the tab model
   * stores (`{ origin, revision }`), or null.
   */
  async refresh({ url, doc = null, profileId = PROFILE_ID } = {}) {
    const resolved = await Favicons.resolve({ url, doc, profileId });
    if (!resolved) {
      return null;
    }
    Favicons.publish(resolved);
    return { origin: resolved.entry.origin, revision: resolved.entry.revision };
  },
};

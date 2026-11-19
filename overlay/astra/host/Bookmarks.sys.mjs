/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Bookmarks module (v1). The Bookmarks panel is a projection over
// `bookmark_call` (`docs/astra/ipc-surface.md`; `BookmarkCall`,
// `BookmarkResponse` and `BookmarkError` in
// `ui/app/src/shared/ipc/bindings.ts`). The tree itself is Places.
//
// Wire mapping:
// - `folder: null` is the top of the panel: the children of Places'
//   "Other Bookmarks" (`unfiledGuid`). `path` is the crumbs from that root
//   down to the shown folder, the shown folder last; the root is never a
//   crumb.
// - Place GUIDs are the `id` strings on the wire. A child of the panel root
//   reports `parent: null` (the root itself is not a place the wire names);
//   every deeper child reports its parent's GUID.
// - Listings put folders before links, preserving Places' order inside each
//   group, because the panel renders `items` in array order.
// - `search` is a case-insensitive substring over title and URL inside the
//   panel root, bounded to `MAX_RESULTS`.
// - Writes use the verified Places bookmarks API:
//   `engine/toolkit/components/places/Bookmarks.sys.mjs`
//   - `insert({ type, parentGuid, title, url?, index })`
//   - `update({ guid, title | parentGuid+index })`
//   - `remove(guid)` (a folder is removed with its contents; this engine's
//     API has no separate `removeTree`)
//   Reads that need every child of a folder (and search) use
//   `PlacesUtils.promiseDBConnection()`: in this engine
//   `bookmarks.fetch({ parentGuid })` returns only the first child.
// - `0xffff_ffff` from the UI means "last" and is clamped to Places'
//   `DEFAULT_INDEX`.
// - Icons are not wired yet: favicons are a separate branch, so `icon` is
//   always null.
//
// Lane isolation: no static imports, so this module can be imported by path
// in Node contract tests and in chrome. The store is injectable
// (`__setBookmarksBackend`); the default is a lazy Places backend in chrome
// and a small in-memory GUID-keyed backend in Node. The module never throws:
// a hostile payload is `invalid`, an unexpected store failure is
// `unavailable`.

import { Favicons, originOf } from "./Favicons.sys.mjs";
import { __activeSpaceId, __spaceOwner } from "./Tabs.sys.mjs";

/** The first space keeps the unfiled root, so existing bookmarks stay put. */
const DEFAULT_SPACE = "space-1";
const SPACE_FOLDER_PREFIX = "Astra · ";
const _spaceRoots = new Map();

function activeSpaceId() {
  try {
    return __activeSpaceId() || DEFAULT_SPACE;
  } catch {
    return DEFAULT_SPACE;
  }
}

/** The panel caps a search at this many characters
 *  (`bookmarks-session.svelte.ts`); a longer query is not one it sent. */
const MAX_QUERY = 512;

/** Longest title or URL a call may carry, so one call stays bounded. */
const MAX_TEXT = 8192;

/** Most search results returned; the panel searches as the person types. */
const MAX_RESULTS = 200;

/** A folder chain deeper than this is not one this host will walk. */
const MAX_DEPTH = 256;

/** The UI's "move to the end" index. */
const APPEND = 0xffff_ffff;

/** A space id on the wire: `space-N`, never a folder or an arbitrary string. */
const SPACE_ID_RE = /^space-\d+$/u;

/** Import copies at most this many entries, so one call stays bounded. */
const MAX_COPY = 5000;

const FOLDER = "folder";
const LINK = "link";

/** Places' append constant (`Bookmarks.DEFAULT_INDEX`). */
const DEFAULT_INDEX = -1;

/** The panel root when Places is not available (the in-memory backend). */
const ROOT_GUID = "unfiled_____";

/** The reply's own error variant: the panel renders `error` as it is. */
function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function isText(value) {
  return typeof value === "string" && value !== "" && value.length <= MAX_TEXT;
}

/** `folder`/`parent`: the top level is `null`, a folder is a non-empty id. */
function isPlace(value) {
  return value === null || isText(value);
}

function isIndex(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isTitle(value) {
  return typeof value === "string" && value.length <= MAX_TEXT;
}

// --- Injectable seams (test + HostAPI wiring) -------------------------------

let _backend = null; // backend | null
let _liveBackendPromise = null;

export function __setBookmarksBackend(backend) {
  _backend = backend;
  return () => {
    if (_backend === backend) {
      _backend = null;
    }
  };
}

export function __resetBookmarksForTests() {
  _backend = null;
  _liveBackendPromise = null;
  _spaceRoots.clear();
}

// --- In-memory backend (Node default) ---------------------------------------

// Mirrors the Places semantics this module relies on: GUID ids, position
// ordering, folder-first projection left to the caller, recursive folder
// removal.
function createMemoryBackend() {
  const rootId = ROOT_GUID;
  const items = new Map();
  items.set(rootId, {
    id: rootId,
    title: "Other Bookmarks",
    url: null,
    kind: FOLDER,
    parent: null,
    index: 0,
  });

  let serial = 0;
  const mint = () => `memory${String(++serial).padStart(6, "0")}`;

  function siblings(parent) {
    return [...items.values()]
      .filter((item) => item.parent === parent)
      .sort((a, b) => a.index - b.index);
  }

  function reindex(parent) {
    let index = 0;
    for (const item of siblings(parent)) {
      item.index = index++;
    }
  }

  function countChildren(id) {
    let count = 0;
    for (const item of items.values()) {
      if (item.parent === id) {
        count += 1;
      }
    }
    return count;
  }

  function copy(item) {
    return {
      ...item,
      childCount: item.kind === FOLDER ? countChildren(item.id) : 0,
    };
  }

  function drop(id) {
    const item = items.get(id);
    if (!item) {
      return;
    }
    if (item.kind === FOLDER) {
      for (const child of siblings(id)) {
        drop(child.id);
      }
    }
    items.delete(id);
  }

  return {
    rootId,
    defaultIndex: DEFAULT_INDEX,

    async get(id) {
      const item = items.get(id);
      return item ? copy(item) : null;
    },

    async children(id) {
      return siblings(id).map(copy);
    },

    async insert({ kind, parent, title, url, index }) {
      const list = siblings(parent);
      const at = index === DEFAULT_INDEX || index > list.length
        ? list.length
        : index;
      for (const sibling of list) {
        if (sibling.index >= at) {
          sibling.index += 1;
        }
      }
      const item = {
        id: mint(),
        title,
        url: kind === LINK ? url : null,
        kind,
        parent,
        index: at,
      };
      items.set(item.id, item);
      reindex(parent);
      return copy(item);
    },

    async update({ id, title, parent, index }) {
      const item = items.get(id);
      if (!item) {
        return null;
      }
      if (typeof title === "string") {
        item.title = title;
      }
      if (parent !== undefined) {
        const previous = item.parent;
        const list = siblings(parent).filter((sibling) => sibling.id !== id);
        const at = index === DEFAULT_INDEX || index > list.length
          ? list.length
          : index;
        list.splice(at, 0, item);
        item.parent = parent;
        for (let position = 0; position < list.length; position += 1) {
          list[position].index = position;
        }
        if (previous !== parent) {
          reindex(previous);
        }
      }
      return copy(item);
    },

    async remove(id) {
      const item = items.get(id);
      if (!item) {
        return false;
      }
      const parent = item.parent;
      drop(id);
      if (parent) {
        reindex(parent);
      }
      return true;
    },

    async search(query, limit) {
      const needle = query.toLowerCase();
      const found = [];
      for (const item of items.values()) {
        if (item.id === rootId) {
          continue;
        }
        const title = (item.title || "").toLowerCase();
        const url = item.kind === LINK && item.url ? item.url.toLowerCase() : "";
        if (title.includes(needle) || url.includes(needle)) {
          found.push(copy(item));
        }
      }
      found.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
          a.id.localeCompare(b.id),
      );
      return found.slice(0, limit);
    },
  };
}

// --- Live backend (chrome) ---------------------------------------------------

// Thin adapter over Places. Resolved lazily so importing this module never
// touches Firefox internals.
async function liveBackend() {
  if (!_liveBackendPromise) {
    _liveBackendPromise = (async () => {
      const { PlacesUtils } = await import(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      const bookmarks = PlacesUtils.bookmarks;
      const TYPE_FOLDER = bookmarks.TYPE_FOLDER;
      const TYPE_BOOKMARK = bookmarks.TYPE_BOOKMARK;
      const rootId = bookmarks.unfiledGuid;
      const defaultIndex = bookmarks.DEFAULT_INDEX;

      function kindOf(type) {
        if (type === TYPE_FOLDER) {
          return FOLDER;
        }
        if (type === TYPE_BOOKMARK) {
          return LINK;
        }
        return null;
      }

      function fromRow(row) {
        const kind = kindOf(row.getResultByName("type"));
        if (!kind) {
          return null;
        }
        return {
          id: row.getResultByName("guid"),
          title: row.getResultByName("title") ?? "",
          url: kind === LINK ? row.getResultByName("url") ?? null : null,
          kind,
          parent: row.getResultByName("parentGuid") || null,
          index: row.getResultByName("position") ?? 0,
          childCount: kind === FOLDER
            ? row.getResultByName("childCount") ?? 0
            : 0,
        };
      }

      async function get(id) {
        if (!PlacesUtils.isValidGuid(id)) {
          return null;
        }
        const item = await bookmarks.fetch({ guid: id });
        if (!item) {
          return null;
        }
        const kind = kindOf(item.type);
        if (!kind) {
          return null;
        }
        return {
          id: item.guid,
          title: item.title || "",
          url: kind === LINK ? (item.url ? item.url.href : null) : null,
          kind,
          parent: item.parentGuid || null,
          index: typeof item.index === "number" ? item.index : 0,
          childCount: kind === FOLDER ? item.childCount ?? 0 : 0,
        };
      }

      const CHILD_SQL = `
        SELECT b.guid AS guid,
               IFNULL(b.title, '') AS title,
               h.url AS url,
               b.type AS type,
               p.guid AS parentGuid,
               b.position AS position,
               (SELECT count(*) FROM moz_bookmarks c WHERE c.parent = b.id)
                 AS childCount
        FROM moz_bookmarks b
        JOIN moz_bookmarks p ON p.id = b.parent
        LEFT JOIN moz_places h ON h.id = b.fk
        WHERE p.guid = :parentGuid
          AND b.type IN (:typeBookmark, :typeFolder)
        ORDER BY b.position ASC
      `;

      // Escapes LIKE metacharacters so a search for "%" is a search for "%".
      function likeNeedle(query) {
        return query.replace(/[\\%_]/g, (char) => `\\${char}`);
      }

      const SEARCH_SQL = `
        WITH RECURSIVE scope(id) AS (
          SELECT id FROM moz_bookmarks WHERE guid = :rootGuid
          UNION ALL
          SELECT b.id FROM moz_bookmarks b JOIN scope s ON b.parent = s.id
        )
        SELECT b.guid AS guid,
               IFNULL(b.title, '') AS title,
               h.url AS url,
               b.type AS type,
               p.guid AS parentGuid,
               b.position AS position,
               (SELECT count(*) FROM moz_bookmarks c WHERE c.parent = b.id)
                 AS childCount
        FROM scope s
        JOIN moz_bookmarks b ON b.id = s.id
        LEFT JOIN moz_bookmarks p ON p.id = b.parent
        LEFT JOIN moz_places h ON h.id = b.fk
        WHERE b.guid <> :rootGuid
          AND b.type IN (:typeBookmark, :typeFolder)
          AND (
            IFNULL(b.title, '') LIKE '%' || :needle || '%' ESCAPE '\\'
            OR IFNULL(h.url, '') LIKE '%' || :needle || '%' ESCAPE '\\'
          )
        ORDER BY b.title COLLATE NOCASE ASC
        LIMIT :limit
      `;

      return {
        rootId,
        defaultIndex,

        get,

        async children(id) {
          const db = await PlacesUtils.promiseDBConnection();
          const rows = await db.executeCached(CHILD_SQL, {
            parentGuid: id,
            typeBookmark: TYPE_BOOKMARK,
            typeFolder: TYPE_FOLDER,
          });
          return rows.map(fromRow).filter(Boolean);
        },

        async insert({ kind, parent, title, url, index }) {
          const info = {
            type: kind === FOLDER ? TYPE_FOLDER : TYPE_BOOKMARK,
            parentGuid: parent,
            title,
            index: index === APPEND ? DEFAULT_INDEX : index,
          };
          if (kind === LINK) {
            info.url = url;
          }
          const item = await bookmarks.insert(info);
          return { id: item.guid };
        },

        async update({ id, title, parent, index }) {
          const info = { guid: id };
          if (typeof title === "string") {
            info.title = title;
          }
          if (parent !== undefined) {
            info.parentGuid = parent;
            info.index = index === APPEND ? DEFAULT_INDEX : index;
          }
          const item = await bookmarks.update(info);
          return { id: item.guid };
        },

        async remove(id) {
          await bookmarks.remove(id);
          return true;
        },

        async search(query, limit) {
          const db = await PlacesUtils.promiseDBConnection();
          const rows = await db.executeCached(SEARCH_SQL, {
            rootGuid: rootId,
            typeBookmark: TYPE_BOOKMARK,
            typeFolder: TYPE_FOLDER,
            needle: likeNeedle(query),
            limit,
          });
          return rows.map(fromRow).filter(Boolean);
        },
      };
    })();
  }
  return _liveBackendPromise;
}

async function backend() {
  if (_backend) {
    return _backend;
  }
  const inChrome =
    typeof globalThis.ChromeUtils !== "undefined" &&
    globalThis.ChromeUtils &&
    typeof globalThis.ChromeUtils.importESModule === "function";
  if (inChrome) {
    return liveBackend();
  }
  _backend = createMemoryBackend();
  return _backend;
}

/** Find or create the bookmarks folder that owns one space. */
async function ensureSpaceRoot(base, space) {
  const cached = _spaceRoots.get(space);
  if (cached) {
    const item = await base.get(cached);
    if (item && item.kind === FOLDER) return cached;
    _spaceRoots.delete(space);
  }
  const title = `${SPACE_FOLDER_PREFIX}${space}`;
  const children = await base.children(base.rootId);
  let folder = children.find((child) => child.kind === FOLDER && child.title === title);
  if (!folder) {
    folder = await base.insert({
      kind: FOLDER,
      parent: base.rootId,
      title,
      url: null,
      index: base.defaultIndex,
    });
  }
  _spaceRoots.set(space, folder.id);
  return folder.id;
}

/** The panel's view of the store for the active space. The default space sees
 *  the unfiled root minus the folders that belong to other spaces; another
 *  space sees only its own folder tree. */
function scopedStore(base, rootId, { hideSpaceFolders = false } = {}) {
  const scoped = Object.create(base);
  Object.defineProperty(scoped, "rootId", { value: rootId, enumerable: true });
  const baseChildren = base.children.bind(base);
  const baseSearch = base.search.bind(base);
  const isSpaceFolder = (item) =>
    item.kind === FOLDER &&
    typeof item.title === "string" &&
    item.title.startsWith(SPACE_FOLDER_PREFIX);
  const insideSpaceFolder = async (item) => {
    let current = item.parent;
    let depth = 0;
    while (current && current !== base.rootId && depth < MAX_DEPTH) {
      const parent = await base.get(current);
      if (!parent) return false;
      if (isSpaceFolder(parent)) return true;
      current = parent.parent;
      depth += 1;
    }
    return false;
  };
  scoped.children = async (id) => {
    const list = await baseChildren(id);
    return hideSpaceFolders && id === base.rootId
      ? list.filter((child) => !isSpaceFolder(child))
      : list;
  };
  scoped.search = async (query, limit) => {
    const found = await baseSearch(query, limit * 4);
    const out = [];
    for (const item of found) {
      if (hideSpaceFolders && (await insideSpaceFolder(item))) continue;
      if (!hideSpaceFolders && !(await insideRoot(scoped, item.id))) continue;
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  };
  return scoped;
}

async function panelStore() {
  const base = await backend();
  const space = activeSpaceId();
  if (space === DEFAULT_SPACE) {
    return scopedStore(base, base.rootId, { hideSpaceFolders: true });
  }
  const root = await ensureSpaceRoot(base, space);
  return scopedStore(base, root);
}

// --- Import into another space ---------------------------------------------
// A person can copy the bookmarks of one space into another space of the same
// profile. This is an explicit copy: the source is never moved or changed, and
// a space of another profile is refused, so the profile boundary stays intact.

function isSpaceId(value) {
  return typeof value === "string" && SPACE_ID_RE.test(value);
}

function isSpaceFolderTitle(title) {
  return typeof title === "string" && title.startsWith(SPACE_FOLDER_PREFIX);
}

/** The folder that owns a space; the default space is the unfiled root. */
async function spaceRoot(base, space, { create = false } = {}) {
  if (space === DEFAULT_SPACE) return base.rootId;
  if (create) return ensureSpaceRoot(base, space);
  const title = `${SPACE_FOLDER_PREFIX}${space}`;
  const children = await base.children(base.rootId);
  return (
    children.find((child) => child.kind === FOLDER && child.title === title)?.id ?? null
  );
}

/** Copy links and folders recursively, never copying another space's root. */
async function copyTree(base, fromRoot, toRoot, copied) {
  const children = await base.children(fromRoot);
  for (const child of children) {
    if (copied >= MAX_COPY) return { copied, truncated: true };
    if (child.kind === FOLDER) {
      if (isSpaceFolderTitle(child.title)) continue;
      const folder = await base.insert({
        kind: FOLDER,
        parent: toRoot,
        title: child.title,
        url: null,
        index: base.defaultIndex,
      });
      if (!folder || !folder.id) return { copied, truncated: true };
      copied += 1;
      const nested = await copyTree(base, child.id, folder.id, copied);
      copied = nested.copied;
      if (nested.truncated) return { copied, truncated: true };
    } else {
      if (typeof child.url !== "string" || child.url === "") continue;
      const link = await base.insert({
        kind: LINK,
        parent: toRoot,
        title: typeof child.title === "string" ? child.title : "",
        url: child.url,
        index: base.defaultIndex,
      });
      if (!link || !link.id) return { copied, truncated: true };
      copied += 1;
    }
  }
  return { copied, truncated: false };
}

async function importSpace(profile, call) {
  const from = call.from;
  const to = isSpaceId(call.to) ? call.to : activeSpaceId();
  if (!isSpaceId(from) || !isSpaceId(to) || from === to) {
    return error(profile, "invalid");
  }
  const fromOwner = __spaceOwner(from);
  const toOwner = __spaceOwner(to);
  // An unknown space and a space of another profile both answer `missing`:
  // this endpoint never confirms that another profile's space exists.
  if (fromOwner === null || toOwner === null || fromOwner !== toOwner) {
    return error(profile, "missing");
  }
  const base = await backend();
  const fromRoot = await spaceRoot(base, from, { create: false });
  // A space with no bookmarks has no folder yet (the root is created lazily on
  // the first save), so a missing source folder means an empty source, not a
  // failed import. Ownership was already checked above.
  if (!fromRoot) return { kind: "imported", count: 0, truncated: false };
  const toRoot = await spaceRoot(base, to, { create: true });
  const { copied, truncated } = await copyTree(base, fromRoot, toRoot, 0);
  return { kind: "imported", count: copied, truncated };
}

// --- Listing projection ------------------------------------------------------

/** Folders first, then links; Places' order inside each group. */
function order(a, b) {
  if (a.kind !== b.kind) {
    return a.kind === FOLDER ? -1 : 1;
  }
  return a.index - b.index;
}

/** Fill each row's icon from the shared favicon pipeline. Stored icons are
 *  published before the reply; a missing one is fetched in the background and
 *  the panel's `forPage(url)` fallback paints it when it arrives. */
async function paintIcons(items) {
  const urls = items.filter((item) => typeof item.url === "string" && item.url).map((item) => item.url);
  if (urls.length === 0) return items;
  const refs = await Favicons.ensureForUrls({ urls });
  for (const item of items) {
    item.icon = item.url ? refs.get(originOf(item.url)) ?? null : null;
  }
  return items;
}

function view(store, item) {
  return {
    id: item.id,
    title: item.title,
    url: item.kind === FOLDER ? null : item.url,
    icon: null,
    children: item.kind === FOLDER ? item.childCount ?? 0 : 0,
    parent: !item.parent || item.parent === store.rootId ? null : item.parent,
  };
}

/** Crumbs from the panel root down to `folderId`, or null when the folder is
 *  not inside the panel's tree. The root itself is not a crumb. */
async function crumbs(store, folderId) {
  const path = [];
  let current = folderId;
  let depth = 0;
  while (current && current !== store.rootId && depth < MAX_DEPTH) {
    const item = await store.get(current);
    if (!item || item.kind !== FOLDER) {
      return null;
    }
    path.unshift({ id: item.id, title: item.title });
    current = item.parent;
    depth += 1;
  }
  return current === store.rootId ? path : null;
}

async function listing(profile, folder) {
  const store = await panelStore();
  const target = folder === null ? store.rootId : folder;
  const item = await store.get(target);
  if (!item || item.kind !== FOLDER) {
    return error(profile, "missing");
  }
  const atRoot = target === store.rootId;
  let path = [];
  if (!atRoot) {
    path = await crumbs(store, target);
    if (!path) {
      return error(profile, "missing");
    }
  }
  const items = (await store.children(target))
    .filter((child) => child && (child.kind === FOLDER || child.kind === LINK))
    .sort(order)
    .map((child) => view(store, child));
  await paintIcons(items);
  return {
    kind: "listing",
    profile,
    folder: atRoot ? null : target,
    path,
    items,
  };
}

/** Resolves the target of a write: the panel root for `null`, an existing
 *  folder inside the panel's tree otherwise. */
async function resolveFolder(store, parent) {
  const id = parent === null ? store.rootId : parent;
  const item = await store.get(id);
  if (!item) {
    return { error: "missing" };
  }
  if (item.kind !== FOLDER) {
    return { error: "invalid" };
  }
  if (id !== store.rootId && !(await crumbs(store, id))) {
    return { error: "missing" };
  }
  return { id };
}

async function isDescendant(store, ancestorId, id) {
  let current = id;
  let depth = 0;
  while (current && depth < MAX_DEPTH) {
    if (current === ancestorId) {
      return true;
    }
    const item = await store.get(current);
    current = item ? item.parent : null;
    depth += 1;
  }
  return false;
}

/** True when `id` is the panel root or lives inside its tree. */
async function insideRoot(store, id) {
  let current = id;
  let depth = 0;
  while (current && current !== store.rootId && depth < MAX_DEPTH) {
    const item = await store.get(current);
    current = item ? item.parent : null;
    depth += 1;
  }
  return current === store.rootId;
}

function saved(profile, id = null) {
  return { kind: "saved", profile, id };
}

// --- Calls -------------------------------------------------------------------

async function addFolder(profile, call) {
  const store = await panelStore();
  const target = await resolveFolder(store, call.parent);
  if (target.error) {
    return error(profile, target.error);
  }
  const created = await store.insert({
    kind: FOLDER,
    parent: target.id,
    title: call.title,
    url: null,
    index: store.defaultIndex,
  });
  return created && created.id ? saved(profile, created.id) : error(profile, "unavailable");
}

async function addLink(profile, call) {
  let parsed;
  try {
    parsed = new URL(call.url.trim());
  } catch {
    return error(profile, "invalid");
  }
  // A bookmark is an address the person expects to open. This build has no
  // bookmarklet runner and opens an unknown scheme as a search, so storing
  // `javascript:`/`data:` would put a row in the list that cannot do what it
  // says (and a javascript: URL is a script payload, not a page). A local file
  // is a real address and stays allowed.
  const allowed = new Set(["http:", "https:", "file:"]);
  if (!allowed.has(parsed.protocol)) {
    return error(profile, "invalid");
  }
  const store = await panelStore();
  const target = await resolveFolder(store, call.parent);
  if (target.error) {
    return error(profile, target.error);
  }
  const created = await store.insert({
    kind: LINK,
    parent: target.id,
    title: call.title,
    url: call.url.trim(),
    index: store.defaultIndex,
  });
  return created && created.id ? saved(profile, created.id) : error(profile, "unavailable");
}

async function rename(profile, call) {
  const store = await panelStore();
  const item = await store.get(call.id);
  if (!item) {
    return error(profile, "missing");
  }
  if (item.id === store.rootId) {
    return error(profile, "invalid");
  }
  if (!(await insideRoot(store, item.id))) {
    return error(profile, "missing");
  }
  await store.update({ id: call.id, title: call.title });
  return saved(profile);
}

async function move(profile, call) {
  const store = await panelStore();
  const item = await store.get(call.id);
  if (!item) {
    return error(profile, "missing");
  }
  if (item.id === store.rootId) {
    return error(profile, "invalid");
  }
  if (!(await insideRoot(store, item.id))) {
    return error(profile, "missing");
  }
  const target = await resolveFolder(store, call.parent);
  if (target.error) {
    return error(profile, target.error);
  }
  if (
    item.kind === FOLDER &&
    (target.id === item.id || (await isDescendant(store, item.id, target.id)))
  ) {
    return error(profile, "cycle");
  }
  const index = call.index === APPEND ? store.defaultIndex : call.index;
  await store.update({ id: call.id, parent: target.id, index });
  return saved(profile);
}

async function remove(profile, call) {
  const store = await panelStore();
  const item = await store.get(call.id);
  if (!item) {
    return error(profile, "missing");
  }
  if (item.id === store.rootId) {
    return error(profile, "invalid");
  }
  if (!(await insideRoot(store, item.id))) {
    return error(profile, "missing");
  }
  await store.remove(call.id);
  return saved(profile);
}

async function reveal(profile, id) {
  const store = await panelStore();
  const item = await store.get(id);
  if (!item || !item.parent) {
    return error(profile, "missing");
  }
  if (item.parent !== store.rootId && !(await crumbs(store, item.parent))) {
    return error(profile, "missing");
  }
  return listing(profile, item.parent === store.rootId ? null : item.parent);
}

async function search(profile, query) {
  const store = await panelStore();
  const items = (await store.search(query, MAX_RESULTS))
    .filter((item) => item && (item.kind === FOLDER || item.kind === LINK))
    .map((item) => view(store, item));
  await paintIcons(items);
  return { kind: "results", profile, items };
}

async function answer(profile, call) {
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
      return isPlace(call.folder)
        ? listing(profile, call.folder)
        : error(profile, "invalid");

    case "reveal":
      return isText(call.id)
        ? reveal(profile, call.id)
        : error(profile, "invalid");

    case "search":
      if (
        !isText(call.query) ||
        call.query.length > MAX_QUERY ||
        call.query.trim() === ""
      ) {
        return error(profile, "invalid");
      }
      return search(profile, call.query);

    case "add_folder":
      return isPlace(call.parent) && isText(call.title)
        ? addFolder(profile, call)
        : error(profile, "invalid");

    case "add_link":
      // An empty title is allowed on the wire (the page's site stands in), so
      // only the type and bounds are checked here.
      return isPlace(call.parent) && isTitle(call.title) && isText(call.url)
        ? addLink(profile, call)
        : error(profile, "invalid");

    case "rename":
      return isText(call.id) && isTitle(call.title)
        ? rename(profile, call)
        : error(profile, "invalid");

    case "move":
      // `index` is a position among the new siblings; the panel sends
      // 0xffff_ffff to mean "last", which is still a safe integer.
      return isText(call.id) && isPlace(call.parent) && isIndex(call.index)
        ? move(profile, call)
        : error(profile, "invalid");

    case "remove":
      return isText(call.id)
        ? remove(profile, call)
        : error(profile, "invalid");

    case "import_space":
      return isSpaceId(call.from)
        ? importSpace(profile, call)
        : error(profile, "invalid");

    default:
      return error(profile, "invalid");
  }
}

export const Bookmarks = {
  /**
   * Answer one `bookmark_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `BookmarkResponse` variant plus the echoed `profile`.
   */
  async call(args = {}) {
    let asked = "";
    let call = null;
    try {
      const scope = args === null || typeof args !== "object" ? {} : args;
      call = scope.call;
      asked = isText(scope.profile)
        ? scope.profile
        : isText(scope.expected_profile)
          ? scope.expected_profile
          : "";
    } catch {
      // A payload whose properties throw cannot name a profile or a call.
      return error("", "invalid");
    }
    if (!asked) {
      return error("", "invalid");
    }
    try {
      return await answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down. `runtime`
      // is not one of `BookmarkError`, so the refusal stays in the reply's own
      // vocabulary: the tree is not reachable, which is what `unavailable`
      // says.
      return error(asked, "unavailable");
    }
  },
};

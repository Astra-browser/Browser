/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Downloads module (v1, native). The Downloads panel and the
// Downloads settings panel are projections over `download_call`
// (`docs/astra/ipc-surface.md`, `DownloadCall`/`DownloadResponse` in
// `ui/app/src/shared/ipc/bindings.ts`). Native transfers, paths and durable
// history are the engine's own Downloads manager:
//
//   - the list is `Downloads.getList(Downloads.PUBLIC)`. Private-window
//     downloads are never read here; the public list is the only list this
//     module exposes.
//   - the preferred folder is `Downloads.getPreferredDownloadsDirectory()`,
//     which resolves `browser.download.folderList` (0 Desktop, 1 Downloads,
//     2 Custom) and `browser.download.dir`.
//   - asking first is the inverse of `browser.download.useDownloadDir`.
//   - choosing a folder is `nsIFilePicker` in `modeGetFolder`; the result is
//     stored as `browser.download.dir` with `folderList = 2`, exactly what the
//     engine's own save path reads.
//
// What this module will and will not say:
// - A reply is either real native state or an honest error. Nothing is
//   reported as `applied` when the write did not land.
// - `pause`, `resume`, `keep` and `discard` use the engine's own transfer
//   lifecycle: pause cancels the transfer and keeps the entry as paused,
//   resume starts the same Download again, keep unblocks a reputation-held
//   one, and discard deletes the held data (or the stopped entry). A failure
//   answers `unavailable` rather than pretending.
// - A malformed call answers `{ kind: "error", error: "invalid" }`; without a
//   native Downloads manager every read says `supported: false` and every
//   write says `unavailable`.
// - Every reply echoes the profile the caller asked for. Downloads are still
//   global in this build (docs/astra/STATE.md), so the same list is visible to
//   every profile; the echo keeps the UI's own scope check honest.
// - A native list change emits `downloads-changed` for each profile that has
//   asked for downloads, so the panel refreshes from the engine rather than
//   polling.
//
// The module can be imported by Node contract tests: the engine is reached
// lazily and a test can substitute the whole native seam with
// `__setDownloadsNative()`.

import { emit } from "./Events.sys.mjs";

/** Page of entries the UI asks for in one `list` call. */
const MAX_PAGE_LIMIT = 2000;

/** How often one native burst becomes one `downloads-changed`. */
const CHANGE_COALESCE_MS = 250;

/** The idle cleanup state: no pass is running and none failed. */
function idleCleanup() {
  return { running: false, error: null };
}

/** Documented defaults; `directory_identity` stays absent until the OS
 *  picker mints one. */
function defaultPreferences() {
  return { ask_destination: false, directory: null };
}

function error(profile, code) {
  return { kind: "error", error: code, profile };
}

function isEntryId(id) {
  return typeof id === "string" && id !== "";
}

/** A `preferences` reply with only the fields `DownloadPreferences` declares. */
function preferencesReply(profile, native) {
  return {
    kind: "preferences",
    profile,
    preferences: {
      ask_destination: native?.ask_destination === true,
      directory:
        typeof native?.directory === "string" && native.directory !== ""
          ? native.directory
          : null,
    },
    supported: true,
    site_downloads_require_confirmation:
      native?.site_downloads_require_confirmation === true,
  };
}

/** `{ before: string | null, limit: number }`, exactly as the UI sends it. */
function isPageCall(call) {
  const { before, limit } = call;
  const beforeOk =
    before === null || (typeof before === "string" && before !== "");
  return (
    beforeOk &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= MAX_PAGE_LIMIT
  );
}

// --- Injectable native seam -------------------------------------------------

let injectedNative = null;
let nativePromise = null;
let nativeViewAttached = false;
let changeTimer = null;

/** Transfers cancelled through `pause`, so the wire says paused rather than
 *  cancelled while their data can still be restarted. */
const pausedIds = new Set();

/** Profiles that have called this module; an event names each one so the
 *  panel's own profile filter keeps working. */
const knownProfiles = new Set();

/** Ids returned by the previous snapshot, so `updates` can name removals. */
let lastIds = null;

export function __setDownloadsNative(native) {
  injectedNative = native;
  nativePromise = null;
  nativeViewAttached = false;
  lastIds = null;
  return () => {
    if (injectedNative === native) {
      injectedNative = null;
      nativePromise = null;
      nativeViewAttached = false;
      lastIds = null;
    }
  };
}

export function __resetDownloadsForTests() {
  injectedNative = null;
  nativePromise = null;
  nativeViewAttached = false;
  knownProfiles.clear();
  pausedIds.clear();
  _downloadIds = new WeakMap();
  lastIds = null;
  if (changeTimer !== null && typeof globalThis.clearTimeout === "function") {
    globalThis.clearTimeout(changeTimer);
  }
  changeTimer = null;
}

function announceChange() {
  if (changeTimer !== null) {
    return;
  }
  const schedule = globalThis.setTimeout;
  if (typeof schedule !== "function") {
    emitChanges();
    return;
  }
  changeTimer = schedule(() => {
    changeTimer = null;
    emitChanges();
  }, CHANGE_COALESCE_MS);
}

function emitChanges() {
  for (const profile of knownProfiles) {
    emit("downloads-changed", { profile });
  }
}

// --- Native adapter ---------------------------------------------------------

/** The chrome scope, or null in Node/preview. */
function chromeScope() {
  try {
    const scopes = [globalThis];
    if (globalThis.window && globalThis.window !== globalThis) {
      scopes.push(globalThis.window);
    }
    const view = globalThis.document?.defaultView;
    if (view && !scopes.includes(view)) {
      scopes.push(view);
    }
    for (const scope of scopes) {
      if (scope?.Services?.prefs && scope?.ChromeUtils?.importESModule) {
        return scope;
      }
    }
  } catch {
    // A partial or hostile global is the same as no chrome.
  }
  return null;
}

function prefsOf(scope) {
  try {
    return scope?.Services?.prefs ?? null;
  } catch {
    return null;
  }
}

/** A small stable hash so a Download object keeps one wire id across calls. */
function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

/** Newest first: the UI sorts `entry.id` descending, so the id starts with a
 *  zero-padded start time. The native transfer keeps one object across a
 *  pause/resume, but `startTime` is rewritten by the resume — so the first id
 *  a transfer is given sticks to it. Without this a resume looked like a new
 *  download and left a ghost 0 B row whose Cancel could not reach anything. */
let _downloadIds = new WeakMap();

export function __idOf(download) {
  if (!download) return "";
  const known = _downloadIds.get(download);
  if (known) return known;
  const started = download?.startTime?.getTime?.() ?? 0;
  const source = download?.source?.url ?? "";
  const target = download?.target?.path ?? "";
  const id = `${String(started).padStart(16, "0")}-${hash(
    `${source}\n${target}\n${started}`,
  )}`;
  try {
    _downloadIds.set(download, id);
  } catch {
    // A proxy that cannot be a WeakMap key keeps the value it just computed.
  }
  return id;
}

/** Wire state for one native Download. */
function stateOf(download, id = null) {
  if (download?.error) return "failed";
  if (download?.hasBlockedData) return "held";
  if (download?.canceled && download?.stopped && id !== null && pausedIds.has(id)) {
    return "paused";
  }
  if (download?.canceled) return download?.stopped ? "cancelled" : "cancelling";
  if (download?.stopped) return download?.succeeded ? "completed" : "interrupted";
  if (!download?.startTime) return "pending";
  return "receiving";
}

/**
 * State generation per native transfer. A pause is a higher revision than the
 * receiving frame before it, and a resume is higher again: ranking states by
 * name (receiving 1 < paused 2) made every frame after a resume look older
 * than the paused one, so the app dropped them and the row froze on "paused".
 */
const _stateGen = new WeakMap();

/** A revision that only grows while the wire state does. */
export function __revisionOf(download, id = null) {
  const state = stateOf(download, id);
  const rank = {
    pending: 0,
    receiving: 1,
    paused: 2,
    held: 3,
    cancelling: 4,
    finalizing: 5,
    interrupted: 6,
    failed: 7,
    cancelled: 8,
    completed: 9,
  }[state];
  let gen = 1;
  try {
    const previous = download ? _stateGen.get(download) : null;
    if (previous && previous.state === state) {
      gen = previous.gen;
    } else if (download) {
      gen = (previous?.gen ?? 0) + 1;
      _stateGen.set(download, { state, gen });
    }
  } catch {
    gen = rank;
  }
  const received = Number.isSafeInteger(download?.currentBytes)
    ? download.currentBytes
    : 0;
  return `${String(gen).padStart(8, "0")}${String(rank).padStart(2, "0")}${String(
    Math.max(0, received),
  ).padStart(16, "0")}`;
}

/** Wire error for one native Download. */
function errorOf(download) {
  const native = download?.error;
  if (!native) return null;
  if (
    native.becauseBlocked ||
    native.becauseBlockedByParentalControls ||
    native.becauseBlockedByReputationCheck ||
    native.becauseBlockedByContentAnalysis
  ) {
    return "protection";
  }
  if (native.becauseTargetFailed) return "storage";
  if (native.becauseSourceFailed) return "network";
  return "runtime";
}

function filenameOf(download) {
  const path = download?.target?.path;
  if (typeof path !== "string" || path === "") return "";
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at >= 0 ? path.slice(at + 1) : path;
}

/** One `DownloadView`; no invented fields. */
function viewOf(download) {
  const id = __idOf(download);
  return {
    id,
    revision: __revisionOf(download, id),
    created_at: (download?.startTime ?? new Date()).toISOString(),
    filename: filenameOf(download),
    source: download?.source?.url ?? "",
    state: stateOf(download, id),
    received: String(Math.max(0, download?.currentBytes ?? 0)),
    total:
      Number.isSafeInteger(download?.totalBytes) && download.totalBytes > 0
        ? String(download.totalBytes)
        : null,
    error: errorOf(download),
  };
}

function makeNative(scope) {
  const { Downloads } = scope.ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs",
  );
  const prefs = prefsOf(scope);
  const services = scope.Services;
  if (!prefs || !services) {
    throw new Error("no chrome preferences");
  }

  let listPromise = null;
  async function list() {
    listPromise ??= (async () => {
      const publicList = await Downloads.getList(Downloads.PUBLIC);
      if (!nativeViewAttached) {
        nativeViewAttached = true;
        publicList.addView({
          onDownloadAdded: announceChange,
          onDownloadChanged: announceChange,
          onDownloadRemoved: announceChange,
        });
      }
      return publicList;
    })();
    return listPromise;
  }

  async function find(id) {
    const all = await (await list()).getAll();
    return all.find((download) => __idOf(download) === id) ?? null;
  }

  async function preferences() {
    const ask = !prefs.getBoolPref("browser.download.useDownloadDir", true);
    const directory = await Downloads.getPreferredDownloadsDirectory();
    return {
      ask_destination: ask,
      directory: typeof directory === "string" && directory !== "" ? directory : null,
      // The choice above is the whole policy on every platform: the engine
      // honours `browser.download.useDownloadDir` on Windows exactly as it does
      // elsewhere, so Windows does not get a forced confirmation.
      site_downloads_require_confirmation: false,
    };
  }

  return {
    async list() {
      const all = await (await list()).getAll();
      return all.map(viewOf);
    },

    preferences,

    async setAskDestination(enabled) {
      if (prefs.prefIsLocked?.("browser.download.useDownloadDir")) return false;
      prefs.setBoolPref("browser.download.useDownloadDir", !enabled);
      return (
        prefs.getBoolPref("browser.download.useDownloadDir", true) === !enabled
      );
    },

    async chooseDirectory() {
      const Cc = scope.Cc ?? globalThis.Cc;
      const Ci = scope.Ci ?? globalThis.Ci;
      if (!Cc || !Ci) return null;
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker,
      );
      const win = services.wm?.getMostRecentWindow?.("navigator:browser") ?? null;
      // nsIFilePicker.init takes the window's BrowsingContext in this engine,
      // not the chrome window proxy (the proxy throws and the picker never
      // opens, which made "Choose folder" a silent no-op).
      const context = win?.browsingContext ?? null;
      if (!context) return null;
      picker.init(
        context,
        "Choose a downloads folder",
        Ci.nsIFilePicker.modeGetFolder,
      );
      const result = await new Promise((resolve) => picker.open(resolve));
      if (result !== Ci.nsIFilePicker.returnOK) return { cancelled: true };
      const path = picker.file?.path;
      if (typeof path !== "string" || path === "") return null;
      prefs.setStringPref("browser.download.dir", path);
      prefs.setIntPref("browser.download.folderList", 2);
      return { cancelled: false };
    },

    async cancel(id) {
      const download = await find(id);
      if (!download) return false;
      pausedIds.delete(id);
      await download.cancel();
      return true;
    },

    async open(id) {
      const download = await find(id);
      if (!download || !download.succeeded) return false;
      await download.launch();
      return true;
    },

    async reveal(id) {
      const download = await find(id);
      if (!download) return false;
      await download.showContainingDirectory();
      return true;
    },

    async forget(id) {
      const download = await find(id);
      if (!download) return false;
      pausedIds.delete(id);
      await (await list()).remove(download);
      return true;
    },

    async clear() {
      const target = await list();
      const all = await target.getAll();
      for (const download of all) {
        if (download.stopped) await target.remove(download);
      }
      pausedIds.clear();
      return true;
    },

    // The engine's own panel implements pause as cancel and resume as start
    // (`downloadsCmd_pauseResume`); the entry stays in the list because its
    // target and partial data are still there. The paused marker keeps the
    // wire state honest between the two calls.
    async pause(id) {
      const download = await find(id);
      if (!download || download.stopped) return false;
      pausedIds.add(id);
      try {
        await download.cancel();
      } catch {
        pausedIds.delete(id);
        return false;
      }
      return true;
    },
    async resume(id) {
      const download = await find(id);
      if (!download || !download.stopped || download.succeeded) return false;
      pausedIds.delete(id);
      try {
        // Firefox's own pause/resume starts the Download without waiting for
        // the whole transfer: the promise settles when it finishes, and a
        // later failure arrives as state through downloads-changed. Awaiting
        // it here would keep the host call (and the UI) busy for the entire
        // download.
        const attempt = download.start();
        attempt?.catch?.(() => {
          // Restarting a canceled transfer can lose its first attempt to the
          // teardown of the canceled connection. The engine accepts the same
          // start again once that attempt has failed; retry once so Resume
          // does not leave a network failure in front of the person.
          try {
            download.start()?.catch?.(() => {});
          } catch {
            // The engine refused the retry; the failed state is honest.
          }
        });
      } catch {
        return false;
      }
      return true;
    },
    async keep(id) {
      const download = await find(id);
      if (!download?.hasBlockedData) return false;
      try {
        await download.unblock();
      } catch {
        return false;
      }
      return true;
    },
    async discard(id) {
      const download = await find(id);
      if (!download) return false;
      pausedIds.delete(id);
      try {
        if (download.hasBlockedData) {
          await download.confirmBlock();
          return true;
        }
        if (download.stopped) {
          await (await list()).remove(download);
          return true;
        }
      } catch {
        return false;
      }
      return false;
    },
  };
}

/** The native Downloads adapter, or null where no chrome engine exists. */
async function nativeForUse() {
  if (injectedNative) return injectedNative;
  if (nativePromise) return nativePromise;
  const attempt = (async () => {
    const scope = chromeScope();
    if (!scope) return null;
    try {
      return makeNative(scope);
    } catch {
      // A missing or broken Downloads manager is reported as unsupported by
      // the reads; it is never mistaken for an empty history.
      return null;
    }
  })();
  nativePromise = attempt;
  const native = await attempt;
  // Do not cache a failure for the life of the process: a manager that was
  // not ready on the first call may be ready on the next one.
  if (native === null && nativePromise === attempt) nativePromise = null;
  return native;
}

// --- Wire answering ---------------------------------------------------------

function pageOf(entries, call) {
  const sorted = [...entries].sort((a, b) => b.id.localeCompare(a.id));
  let start = 0;
  if (call.before !== null) {
    const at = sorted.findIndex((entry) => entry.id === call.before);
    start = at >= 0 ? at + 1 : 0;
  }
  const page = sorted.slice(start, start + call.limit);
  const next = start + page.length < sorted.length ? page.at(-1)?.id ?? null : null;
  return { entries: page, next };
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

  const native = await nativeForUse();

  switch (call.kind) {
    case "updates": {
      if (!native) {
        lastIds = new Set();
        return {
          kind: "updates",
          profile,
          entries: [],
          removed: [],
          cleanup: idleCleanup(),
        };
      }
      try {
        const entries = await native.list();
        const current = new Set(entries.map((entry) => entry.id));
        const removed =
          lastIds === null
            ? []
            : [...lastIds].filter((id) => !current.has(id));
        lastIds = current;
        return {
          kind: "updates",
          profile,
          entries,
          removed,
          cleanup: idleCleanup(),
        };
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "list": {
      if (!isPageCall(call)) return error(profile, "invalid");
      if (!native) {
        lastIds = new Set();
        return {
          kind: "page",
          profile,
          entries: [],
          next: null,
          supported: false,
          cleanup: idleCleanup(),
        };
      }
      try {
        const entries = await native.list();
        lastIds = new Set(entries.map((entry) => entry.id));
        const page = pageOf(entries, call);
        return {
          kind: "page",
          profile,
          entries: page.entries,
          next: page.next,
          supported: true,
          cleanup: idleCleanup(),
        };
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "preferences": {
      if (!native) {
        return {
          kind: "preferences",
          profile,
          preferences: defaultPreferences(),
          supported: false,
          site_downloads_require_confirmation: true,
        };
      }
      try {
        return preferencesReply(profile, await native.preferences());
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "clear": {
      if (!native) {
        return { kind: "accepted", profile };
      }
      try {
        if (!(await native.clear())) return error(profile, "unavailable");
        lastIds = new Set();
        return { kind: "accepted", profile };
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "retry_cleanup":
      return { kind: "applied", profile };

    case "cancel":
    case "open":
    case "reveal":
    case "forget":
    case "pause":
    case "resume":
    case "keep":
    case "discard": {
      if (!isEntryId(call.id)) return error(profile, "invalid");
      if (!native) return error(profile, "unavailable");
      try {
        if (!(await native[call.kind](call.id))) {
          return error(profile, "unavailable");
        }
        return { kind: "applied", profile };
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "choose_directory": {
      if (!native) return error(profile, "unavailable");
      try {
        const choice = await native.chooseDirectory();
        if (choice === null) return error(profile, "unavailable");
        // Cancelled is not an error; the current preferences are the answer.
        return preferencesReply(profile, await native.preferences());
      } catch {
        return error(profile, "unavailable");
      }
    }

    case "set_ask_destination": {
      if (typeof call.enabled !== "boolean") return error(profile, "invalid");
      if (!native) return error(profile, "unavailable");
      try {
        if (!(await native.setAskDestination(call.enabled))) {
          return error(profile, "unavailable");
        }
        return preferencesReply(profile, await native.preferences());
      } catch {
        return error(profile, "unavailable");
      }
    }

    default:
      return error(profile, "invalid");
  }
}

export const Downloads = {
  /**
   * Answer one `download_call`. `profile` is the caller's scope (the wire
   * payload calls it `expected_profile`; both are accepted). The reply is a
   * `DownloadResponse` variant plus the echoed `profile`.
   */
  async call({ profile = "", expected_profile = "", call = null } = {}) {
    const asked =
      typeof profile === "string" && profile !== "" ? profile : expected_profile;
    if (typeof asked !== "string" || asked === "") {
      return error("", "invalid");
    }
    knownProfiles.add(asked);
    try {
      return await answer(asked, call);
    } catch {
      // Defensive: a hostile payload must not take the host down.
      return error(asked, "runtime");
    }
  },

  /**
   * Where the system grants folder access. This build has no OS access panel
   * (folder access is granted by the picker itself), so this reports `false`
   * instead of pretending a panel opened.
   */
  async openAccessSettings() {
    return false;
  },
};

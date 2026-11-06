/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Profiles module (v1, native). The Profiles page is a projection
// over `profiles_get` and the `profiles_*` commands (`ProfilesView`,
// `ProfileEntryView` in `ui/app/src/shared/ipc/bindings.ts`).
//
// Native ownership:
//   - profile records and directories are the engine's own profile services.
//     When the profile group has selectable profiles initialised, that is
//     `SelectableProfileService`; otherwise the running install's
//     `nsIToolkitProfileService` roster is the truth.
//   - the currently running profile is the profile directory this process is
//     using (`ProfD`), not necessarily `toolkitProfileService.currentProfile`:
//     the Astra dev build starts with `-profile`, which can leave
//     `currentProfile` null. The running directory is therefore always
//     reported, matched to a roster entry when one exists and otherwise named
//     by its directory leaf.
//   - profile avatars are the engine's standard avatar names when selectable
//     profiles are available. Astra's own tint, symbol and revision (which the
//     engine does not store) live under `astra.profiles.avatar.<hash>`; for an
//     unmanaged toolkit profile, which has no native avatar at all, that
//     presentation is the only avatar owner. It is never mistaken for a
//     profile record or for a native avatar that landed.
//   - a picked photo is staged by the engine in the Tauri build and served by
//     its media handler. This build has no such media route, so
//     `profile_avatar_pick` answers `unsupported` instead of returning a token
//     that would render as a broken image.
//
// Switching profiles cannot replace the running process's profile directory
// in place, so `profiles_switch` is an in-window environment transition: each
// profile browses in an Astra space backed by a Firefox container, and the
// window selects that space. Cookies, sign-ins, localStorage/IndexedDB and the
// HTTP cache are isolated per profile; tabs are kept per space and restored on
// return. Preferences, extensions and the Places history database are shared
// by the one profile directory this process runs — an honest limit, recorded
// in docs/astra/STATE.md.
//
// The module can be imported by Node contract tests: the engine is reached
// lazily and `__setProfilesBackend()` replaces the whole native seam.

import { addEventListener, emit } from "./Events.sys.mjs";
import { refuse } from "./Operations.sys.mjs";
import { Tabs, __spacesState } from "./Tabs.sys.mjs";

// A profile is a browsing environment, and this engine cannot move a running
// process to another profile directory. The in-window switch therefore gives
// each profile an Astra space, and a space is a Firefox container: cookies,
// sign-ins, localStorage/IndexedDB and the HTTP cache are partitioned per
// `userContextId`, tabs are kept per space, and switching selects the space's
// last tab instead of opening a window. Preferences, extensions and the Places
// history database stay shared by the one profile directory this process runs;
// that limit is recorded in docs/astra/STATE.md.
const SPACE_MAP_PREF = "astra.profiles.spaces";
let _spaceMap = new Map();
let _spaceListener = null;

/** Avatar names Astra maps onto the engine's standard profile avatars; the
 *  index is the `symbol` field of `ProfileAvatarView`. */
const NATIVE_AVATARS = [
  "briefcase",
  "folder",
  "heart",
  "leaf",
  "lightbulb",
  "palette",
  "musical-note",
  "canvas",
  "book",
  "diamond",
  "heart-rate",
  "video-game-controller",
  "plane",
  "sparkle-single",
  "star",
  "hammer",
];

/** The engine's neutral avatar for a profile that shows initials in Astra. */
const INITIALS_AVATAR = "default-favicon";

const SYMBOL_BY_AVATAR = new Map(
  NATIVE_AVATARS.map((name, index) => [name, index]),
);

const STYLES = new Set(["initials", "symbol", "photo"]);
const KIND_DEFAULT = "default";
const KIND_NAMED = "named";

const MAX_NAME = 80;
const MAX_COLOR = 9;
const MAX_REVISION = 0xffffffff;

const ok = () => ({ operation_id: null, accepted: true });
const no = () => ({ operation_id: null, accepted: false });

/** A stable pref-key hash; profile paths are long and may contain characters
 *  a pref name should not carry. */
function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(36);
}

function isName(value) {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim().length <= MAX_NAME
  );
}

function isColor(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_COLOR;
}

function isAvatar(input) {
  return (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    STYLES.has(input.style) &&
    isColor(input.color) &&
    Number.isInteger(input.symbol) &&
    input.symbol >= 0 &&
    input.symbol < NATIVE_AVATARS.length
  );
}

function sanitizeMeta(value) {
  const meta =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  const symbol =
    Number.isInteger(meta.symbol) &&
    meta.symbol >= 0 &&
    meta.symbol < NATIVE_AVATARS.length
      ? meta.symbol
      : 0;
  return {
    style: meta.style === "symbol" ? "symbol" : "initials",
    color: isColor(meta.color) ? meta.color : 0,
    symbol,
    revision:
      Number.isInteger(meta.revision) &&
      meta.revision >= 0 &&
      meta.revision <= MAX_REVISION
        ? meta.revision
        : 0,
  };
}

function avatarView(profile, meta) {
  const native = typeof profile.avatar === "string" ? profile.avatar : null;
  if (native !== null) {
    const symbol = SYMBOL_BY_AVATAR.get(native);
    if (symbol === undefined) {
      // A custom photo or an avatar Astra has no map for cannot be drawn:
      // there is no media route for the photo, and showing an unrelated Astra
      // symbol would be a lie. Initials are the honest fallback.
      return {
        style: "initials",
        color: meta.color,
        symbol: 0,
        revision: meta.revision,
      };
    }
    return {
      style: "symbol",
      color: meta.color,
      symbol,
      revision: meta.revision,
    };
  }
  // A roster with no native avatar owner (an unmanaged toolkit profile) still
  // honours the person's symbol choice in Astra's own durable profile state.
  return {
    style: meta.style,
    color: meta.color,
    symbol: meta.symbol,
    revision: meta.revision,
  };
}

// --- Injectable native seam -------------------------------------------------

let injectedBackend = null;
let nativePromise = null;

export function __setProfilesBackend(backend) {
  injectedBackend = backend;
  nativePromise = null;
  return () => {
    if (injectedBackend === backend) {
      injectedBackend = null;
      nativePromise = null;
    }
  };
}

export function __resetProfilesForTests() {
  injectedBackend = null;
  nativePromise = null;
  _spaceMap = new Map();
  _spaceListener?.();
  _spaceListener = null;
}

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

// --- Profile ↔ space binding ----------------------------------------------
// The binding survives a restart in the profile pref store; Node contract
// tests get the in-memory fallback. A stale binding (the space snapshot was
// replaced) is ignored and the profile gets a fresh space.

function readSpaceMap() {
  const scope = chromeScope();
  if (!scope) return new Map(_spaceMap);
  try {
    const raw = scope.Services.prefs.getStringPref(SPACE_MAP_PREF, "");
    if (raw === "") return new Map(_spaceMap);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return new Map(_spaceMap);
    }
    const map = new Map();
    for (const [profile, space] of Object.entries(parsed)) {
      if (typeof profile === "string" && typeof space === "string") map.set(profile, space);
    }
    return map;
  } catch {
    return new Map(_spaceMap);
  }
}

function writeSpaceMap(map) {
  _spaceMap = new Map(map);
  const scope = chromeScope();
  if (!scope) return;
  try {
    scope.Services.prefs.setStringPref(
      SPACE_MAP_PREF,
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    // The in-memory map still serves this run.
  }
}

function bindProfileSpace(profileId, spaceId) {
  const map = readSpaceMap();
  map.set(profileId, spaceId);
  writeSpaceMap(map);
}

function unbindProfileSpace(profileId) {
  const map = readSpaceMap();
  if (!map.delete(profileId)) return;
  writeSpaceMap(map);
}

function spaceForProfileSpace(profileId) {
  const map = readSpaceMap();
  return map.get(profileId) ?? null;
}

function profileForSpace(spaceId) {
  for (const [profile, space] of readSpaceMap()) {
    if (space === spaceId) return profile;
  }
  return null;
}

function hasSpace(spaceId) {
  return __spacesState().spaces.some((space) => space.id === spaceId);
}

/** The space a profile browses in, created on first use. The running profile
 *  uses the window's first space (the default environment) instead of minting
 *  a second one for an identity it already owns. */
async function spaceForProfile(profile, { running = false } = {}) {
  const bound = spaceForProfileSpace(profile.id);
  if (bound !== null && hasSpace(bound)) return bound;
  if (running) {
    const spaces = __spacesState().spaces;
    const home = spaces.find((space) => space.id === "space-1") ?? spaces[0];
    if (home) {
      bindProfileSpace(profile.id, home.id);
      return home.id;
    }
  }
  const existing = __spacesState().spaces.find((space) => space.name === profile.name);
  if (existing) {
    bindProfileSpace(profile.id, existing.id);
    return existing.id;
  }
  const before = new Set(__spacesState().spaces.map((space) => space.id));
  await Tabs.createSpace({ request_id: "profile-space", name: profile.name });
  const created = __spacesState().spaces.find((space) => !before.has(space.id));
  if (!created) return null;
  bindProfileSpace(profile.id, created.id);
  return created.id;
}

/** The roster's `current` follows the active space's profile. */
function withActiveProfile(view) {
  if (view === null) return null;
  const profile = profileForSpace(__spacesState().active_space_id);
  if (profile === null || !view.profiles.some((entry) => entry.id === profile)) return view;
  return { ...view, current: profile };
}

/** The rail names the active profile, so a plain space switch has to refresh
 *  the roster too. One listener for the process; reset removes it. */
function listenForSpaceSwitches() {
  if (_spaceListener !== null) return;
  _spaceListener = addEventListener((event) => {
    if (event.type !== "space.switched") return;
    void (async () => {
      const native = await nativeForUse();
      if (native) await announce(native);
    })();
  });
}

function profilePath(profile) {
  try {
    return profile?.rootDir?.path ?? profile?.path ?? null;
  } catch {
    return null;
  }
}

function enumerateToolkitProfiles(profileService, Ci) {
  const out = [];
  try {
    const enumerator = profileService.profiles;
    while (enumerator.hasMoreElements()) {
      const next = enumerator.getNext();
      out.push(next.QueryInterface(Ci.nsIToolkitProfile));
    }
  } catch {
    // A closed or outdated enumerator leaves the roster partial; the running
    // directory is still added below.
  }
  return out;
}

function makeNative(scope) {
  const { Services, ChromeUtils, Ci, Cc } = scope;
  const prefs = Services.prefs;
  const profileService = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService,
  );
  const profileDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
  const runningPath = profileDir.path;

  let selectable = null;
  try {
    selectable = ChromeUtils.importESModule(
      "resource:///modules/profiles/SelectableProfileService.sys.mjs",
    ).SelectableProfileService;
  } catch {
    selectable = null;
  }

  const selectableReady = () => selectable?.initialized === true;
  const metaKey = (id) => `astra.profiles.avatar.${hash(id)}`;

  function readMeta(id) {
    try {
      const raw = prefs.getStringPref(metaKey(id), "");
      return raw === "" ? sanitizeMeta(null) : sanitizeMeta(JSON.parse(raw));
    } catch {
      return sanitizeMeta(null);
    }
  }

  function writeMeta(id, meta) {
    try {
      prefs.setStringPref(metaKey(id), JSON.stringify(sanitizeMeta(meta)));
      return true;
    } catch {
      return false;
    }
  }

  function toolkitByName(name) {
    try {
      return profileService.getProfileByName(name) ?? null;
    } catch {
      return null;
    }
  }

  function toolkitById(id) {
    return enumerateToolkitProfiles(profileService, Ci).find(
      (profile) => profilePath(profile) === id,
    ) ?? null;
  }

  function defaultPath() {
    try {
      return profilePath(profileService.defaultProfile);
    } catch {
      return null;
    }
  }

  async function selectableById(id) {
    if (!selectableReady()) return null;
    try {
      const profiles = await selectable.getAllProfiles();
      return profiles.find((profile) => profile.path === id) ?? null;
    } catch {
      return null;
    }
  }

  async function snapshot() {
    const entries = [];
    if (selectableReady()) {
      try {
        const profiles = await selectable.getAllProfiles();
        for (const profile of profiles) {
          entries.push({
            id: profile.path,
            name: profile.name,
            avatar: typeof profile.avatar === "string" ? profile.avatar : null,
          });
        }
      } catch {
        // Fall back to the toolkit roster below.
        entries.length = 0;
      }
    }
    if (entries.length === 0) {
      for (const profile of enumerateToolkitProfiles(profileService, Ci)) {
        const id = profilePath(profile);
        if (id === null) continue;
        entries.push({
          id,
          name: profile.name,
          avatar: null,
        });
      }
    }
    if (!entries.some((entry) => entry.id === runningPath)) {
      entries.unshift({
        id: runningPath,
        name: profileDir.leafName || "Profile",
        avatar: null,
      });
    }
    // `ProfD` is the directory this process is actually browsing in, so it is
    // the only honest answer even when the profile services name another
    // profile as current. The dev build's `-profile` is exactly that case.
    const fallback = defaultPath();
    entries.sort((left, right) => {
      if (left.id === runningPath) return -1;
      if (right.id === runningPath) return 1;
      return left.name.localeCompare(right.name);
    });
    return {
      current: runningPath,
      default: fallback,
      private: false,
      supportsAvatar: selectableReady(),
      profiles: entries,
    };
  }

  return {
    snapshot,

    async launch(id) {
      // The profile is already in front; focus is the only useful action.
      if (id === runningPath) return true;
      if (selectableReady()) {
        try {
          const profile = await selectableById(id);
          if (profile) {
            selectable.launchInstance(profile);
            return true;
          }
        } catch {
          // Fall through to the toolkit launcher.
        }
      }
      const profile = toolkitById(id);
      if (!profile) return false;
      try {
        const executable = Services.dirsvc.get("XREExeF", Ci.nsIFile);
        const process = Cc["@mozilla.org/process/util;1"].createInstance(
          Ci.nsIProcess,
        );
        process.init(executable);
        const args = ["-profile", profile.rootDir.path, "-no-remote"];
        process.run(false, args, args.length);
        return true;
      } catch {
        return false;
      }
    },
    readMeta,
    writeMeta,

    async create(name) {
      if (selectableReady()) {
        try {
          const profiles = await selectable.getAllProfiles();
          if (profiles.some((profile) => profile.name === name)) return null;
          const profile = await selectable.createNewProfile(false, null, "astra");
          await profile.setNameAsync(name);
          return profile.path;
        } catch {
          return null;
        }
      }
      if (toolkitByName(name)) return null;
      let profile = null;
      try {
        profile = profileService.createProfile(null, name, "astra");
      } catch {
        return null;
      }
      try {
        await profileService.asyncFlush();
      } catch {
        try {
          profile.remove(false);
        } catch {
          // The in-memory record is still the best effort; the caller is told
          // the write did not land.
        }
        return null;
      }
      return profilePath(profile);
    },

    async rename(id, name) {
      if (selectableReady()) {
        const profile = await selectableById(id);
        if (!profile) return false;
        try {
          const profiles = await selectable.getAllProfiles();
          if (profiles.some((other) => other.id !== profile.id && other.name === name)) {
            return false;
          }
          await profile.setNameAsync(name);
          return true;
        } catch {
          return false;
        }
      }
      const existing = toolkitByName(name);
      if (existing && profilePath(existing) !== id) return false;
      let profile = toolkitById(id);
      if (!profile && id === runningPath) {
        // The dev build starts with `-profile`, which can leave this directory
        // out of profiles.ini. Naming it registers the directory natively so
        // the name survives the next launch instead of being UI-only.
        try {
          profile = profileService.createProfile(profileDir, name, "astra");
          await profileService.asyncFlush();
          return true;
        } catch {
          return false;
        }
      }
      if (!profile) return false;
      const previous = profile.name;
      try {
        profile.name = name;
        await profileService.asyncFlush();
        return true;
      } catch {
        try {
          profile.name = previous;
        } catch {
          // A partially applied rename is reported as failed either way.
        }
        return false;
      }
    },

    async remove(id) {
      if (id === runningPath) return false;
      if (selectableReady()) {
        const profile = await selectableById(id);
        if (!profile) return false;
        try {
          await selectable.deleteProfile(profile);
          return true;
        } catch {
          return false;
        }
      }
      const profile = toolkitById(id);
      if (!profile) return false;
      try {
        profile.remove(true);
        await profileService.asyncFlush();
        return true;
      } catch {
        return false;
      }
    },

    async setAvatarName(id, name) {
      if (!selectableReady()) return false;
      const profile = await selectableById(id);
      if (!profile) return false;
      try {
        await profile.setAvatar(name);
        return true;
      } catch {
        return false;
      }
    },

    async pickAvatar() {
      // No media route serves a staged profile photo in this build.
      return { kind: "unsupported" };
    },
  };
}

async function nativeForUse() {
  if (injectedBackend) return injectedBackend;
  if (nativePromise) return nativePromise;
  const attempt = (async () => {
    const scope = chromeScope();
    if (!scope) return null;
    try {
      return makeNative(scope);
    } catch {
      return null;
    }
  })();
  nativePromise = attempt;
  const native = await attempt;
  // A profile service that was not ready on the first call may be ready on
  // the next one; a failure is not cached for the process lifetime.
  if (native === null && nativePromise === attempt) nativePromise = null;
  return native;
}

// --- Projection -------------------------------------------------------------

async function readView(native) {
  const snapshot = await native.snapshot();
  if (!snapshot || !Array.isArray(snapshot.profiles)) return null;
  const current = typeof snapshot.current === "string" ? snapshot.current : null;
  const defaultId =
    typeof snapshot.default === "string" ? snapshot.default : null;
  const profiles = [];
  for (const entry of snapshot.profiles) {
    if (entry === null || typeof entry !== "object") continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id === "") continue;
    const name = typeof entry.name === "string" && entry.name !== ""
      ? entry.name
      : "Profile";
    let meta;
    try {
      meta = sanitizeMeta(await native.readMeta(id));
    } catch {
      meta = sanitizeMeta(null);
    }
    profiles.push({
      id,
      name,
      kind: id === defaultId ? KIND_DEFAULT : KIND_NAMED,
      avatar: avatarView(entry, meta),
    });
  }
  // The running directory is always one of the entries the native adapter
  // builds, so a null current means "the roster is empty", never "unknown".
  return {
    current: current ?? profiles[0]?.id ?? null,
    private: snapshot.private === true,
    profiles,
  };
}

async function currentView(native) {
  try {
    return await readView(native);
  } catch {
    return null;
  }
}

async function announce(native) {
  const view = await currentView(native);
  if (view !== null) emit("profiles-changed", withActiveProfile(view));
}

async function avatarFor(native, id, avatar) {
  const snapshot = await native.snapshot();
  const supportsAvatar = snapshot?.supportsAvatar === true;
  const previous = sanitizeMeta(await native.readMeta(id));
  const meta = {
    style: avatar.style === "symbol" ? "symbol" : "initials",
    color: avatar.color,
    symbol: avatar.symbol,
    revision: Math.min(MAX_REVISION, previous.revision + 1),
  };
  if (supportsAvatar) {
    const name =
      avatar.style === "initials"
        ? INITIALS_AVATAR
        : NATIVE_AVATARS[avatar.symbol];
    if (typeof name !== "string") return false;
    if (typeof native.setAvatarName !== "function") return false;
    if (!(await native.setAvatarName(id, name))) return false;
  }
  return (await native.writeMeta(id, meta)) === true;
}

export const Profiles = {
  /** `ProfilesView | null`; null means the engine answered nothing usable. */
  async get() {
    listenForSpaceSwitches();
    const native = await nativeForUse();
    if (!native) return null;
    return withActiveProfile(await currentView(native));
  },

  /** Create a profile. With `and_switch`, the window moves into the new
   *  profile's space after it is stored — same window, same process. */
  async create({ name = "", avatar = null, and_switch = false } = {}) {
    if (!isName(name) || !isAvatar(avatar)) return no();
    if (avatar.style === "photo") return no();
    const native = await nativeForUse();
    if (!native) return no();
    let id = null;
    try {
      id = await native.create(name.trim());
    } catch {
      id = null;
    }
    if (typeof id !== "string" || id === "") return no();
    try {
      await avatarFor(native, id, avatar);
    } catch {
      // The profile exists; the avatar falls back to native initials.
    }
    await announce(native);
    if (and_switch === true) {
      // The profile is stored; the window moves into its space. No second
      // process or window is created.
      const space = await spaceForProfile({ id, name: name.trim() });
      if (space === null) return refuse("native_dispatch_rejected");
      const applied = await Tabs.switchSpace({
        request_id: "profile-switch",
        space,
      });
      if (applied?.accepted !== true) return refuse("native_dispatch_rejected");
      await announce(native);
      return ok();
    }
    return ok();
  },

  async rename({ profile = "", name = "" } = {}) {
    if (typeof profile !== "string" || profile === "" || !isName(name)) {
      return no();
    }
    const native = await nativeForUse();
    if (!native) return no();
    let renamed = false;
    try {
      renamed = (await native.rename(profile, name.trim())) === true;
    } catch {
      renamed = false;
    }
    if (!renamed) return no();
    // The profile's space is the visible half of the same identity.
    const space = spaceForProfileSpace(profile);
    if (space !== null && hasSpace(space)) {
      await Tabs.updateSpace({
        request_id: "profile-rename",
        space,
        name: name.trim(),
      });
    }
    await announce(native);
    return ok();
  },

  async remove({ profile = "" } = {}) {
    if (typeof profile !== "string" || profile === "") return no();
    const native = await nativeForUse();
    if (!native) return no();
    let removed = false;
    try {
      removed = (await native.remove(profile)) === true;
    } catch {
      removed = false;
    }
    if (!removed) return no();
    // The space leaves with the profile: its tabs close and `space.deleted`
    // lets the content binding drop the container and its site data. A window
    // with one space keeps it (the model refuses to remove the last one).
    const space = spaceForProfileSpace(profile);
    unbindProfileSpace(profile);
    if (space !== null && hasSpace(space)) {
      await Tabs.deleteSpace({ request_id: "profile-remove", space });
    }
    await announce(native);
    return ok();
  },

  async setAvatar({ profile = "", avatar = null } = {}) {
    if (typeof profile !== "string" || profile === "" || !isAvatar(avatar)) {
      return no();
    }
    // A photo token would need the Tauri media server; there is none here.
    if (avatar.style === "photo") return no();
    const native = await nativeForUse();
    if (!native) return no();
    let applied = false;
    try {
      const snapshot = await native.snapshot();
      if (!snapshot?.profiles?.some((entry) => entry?.id === profile)) {
        return no();
      }
      applied = await avatarFor(native, profile, avatar);
    } catch {
      applied = false;
    }
    if (!applied) return no();
    await announce(native);
    return ok();
  },

  /** The native picker and staging route are not present in this build. */
  async avatarPick() {
    const native = await nativeForUse();
    if (!native || typeof native.pickAvatar !== "function") {
      return { kind: "unsupported" };
    }
    try {
      const picked = await native.pickAvatar();
      if (
        picked?.kind === "picked" ||
        picked?.kind === "cancelled" ||
        picked?.kind === "unsupported" ||
        picked?.kind === "unavailable"
      ) {
        return picked;
      }
    } catch {
      return { kind: "unavailable" };
    }
    return { kind: "unsupported" };
  },

  /**
   * In-window switch. The running process cannot change profile directory, so
   * the chosen profile's browsing environment is an Astra space: selecting it
   * swaps the tabs and the container (cookies, storage, cache) in the window
   * that is already open. The profile's tabs are left as they were, so
   * switching back restores that session.
   */
  async switch({ profile = "" } = {}) {
    if (typeof profile !== "string" || profile === "") return no();
    const native = await nativeForUse();
    if (!native) return no();
    const view = await currentView(native);
    const entry = view?.profiles.find((candidate) => candidate.id === profile) ?? null;
    // A roster entry that vanished is refused, never claimed applied.
    if (entry === null) return refuse("native_dispatch_rejected");
    const space = await spaceForProfile(entry, { running: profile === view.current });
    if (space === null) return refuse("native_dispatch_rejected");
    const applied = await Tabs.switchSpace({
      request_id: "profile-switch",
      space,
    });
    if (applied?.accepted !== true) return refuse("native_dispatch_rejected");
    await announce(native);
    return ok();
  },
};

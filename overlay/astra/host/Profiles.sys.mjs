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
// Switching profiles is a relaunch-level operation. In-place switching would
// have to replace the profile of the running process; the engine's only safe
// path (`SelectableProfileService.launchInstance`) starts a *different*
// process and does not move this window. `profiles_switch` therefore answers
// an honest `unsupported_command` refusal with a disposition; it never moves
// or closes the running profile.
//
// The module can be imported by Node contract tests: the engine is reached
// lazily and `__setProfilesBackend()` replaces the whole native seam.

import { emit } from "./Events.sys.mjs";
import { refuse } from "./Operations.sys.mjs";

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
  if (view !== null) emit("profiles-changed", view);
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
    const native = await nativeForUse();
    if (!native) return null;
    return currentView(native);
  },

  /**
   * Create a profile. `and_switch` is a relaunch-level request this build
   * cannot honour, so it is refused *before* anything is created — no
   * half-applied "created but not switched" answer.
   */
  async create({ name = "", avatar = null, and_switch = false } = {}) {
    if (and_switch === true) return refuse("unsupported_command");
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
   * Switching is a relaunch-level operation. No native path moves the running
   * window to another profile without replacing the process; the safe launch
   * path opens a different process and is not a switch. Answer the refusal
   * with a disposition reason the UI can name.
   */
  async switch() {
    return refuse("unsupported_command");
  },
};

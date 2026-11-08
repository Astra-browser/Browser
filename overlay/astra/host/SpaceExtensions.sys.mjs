/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Per-space extension sets.
//
// WebExtensions are installed at profile scope: one AddonManager, one install,
// one set of extension processes. A space cannot own a second copy. What a
// space can own is an *assignment*: which installed extensions are enabled
// while that space is in front. Switching spaces applies the assignment with
// `addon.enable()` / `addon.disable()`; nothing is uninstalled and extension
// data stays with the profile.
//
// This is an honest profile-scope feature, not process isolation. The Settings
// copy and `NATIVE_SURFACES.md` say so.
//
// The assignment map lives under `astra.extensions.spaces.v1`; a space with no
// entry inherits the extensions that were enabled at the moment it was first
// addressed. Themes and system/builtin add-ons are never toggled.

import { addEventListener } from "./Events.sys.mjs";
import {
  HOST_API_VERSION,
  __activeProfileId,
  __activeSpaceId,
  __spacesState,
} from "./Tabs.sys.mjs";
import { __nativeBinding } from "./SplitView.sys.mjs";

export const ASSIGN_PREF = "astra.extensions.spaces.v1";
export const BASELINE_PREF = "astra.extensions.user-disabled.v1";
export const MAX_ASSIGNED = 500;

let _listener = null;

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function services() {
  try {
    return globalThis.Services ?? null;
  } catch {
    return null;
  }
}

async function addonManager() {
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    await AddonManager.readyPromise;
    return AddonManager;
  } catch {
    return null;
  }
}

function privateWindow(window_id = "") {
  try {
    const win =
      __nativeBinding(window_id)?.win ??
      services()?.wm?.getMostRecentWindow("navigator:browser") ??
      null;
    const CU = globalThis.ChromeUtils;
    if (win && CU) {
      const { PrivateBrowsingUtils } = CU.importESModule(
        "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
      );
      return PrivateBrowsingUtils.isWindowPrivate(win) === true;
    }
    return win?.document?.documentElement?.getAttribute("privatebrowsingmode") === "temporary";
  } catch {
    return false;
  }
}

/** Add-ons the person disabled themselves are never re-enabled by a space. */
function baselineDisabled() {
  try {
    const parsed = JSON.parse(services()?.prefs?.getStringPref(BASELINE_PREF, "[]") ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberBaseline(ids) {
  const current = baselineDisabled();
  let changed = false;
  for (const id of ids) {
    if (!current.has(id)) {
      current.add(id);
      changed = true;
    }
  }
  if (changed) {
    try {
      services()?.prefs?.setStringPref(BASELINE_PREF, JSON.stringify([...current]));
    } catch {
      // No profile prefs.
    }
  }
}

function perSpaceEnabled() {
  try {
    const prefs = services()?.prefs;
    if (!prefs) return true;
    const raw = prefs.getStringPref("astra.settings.extensions.per-space", "");
    if (raw === "true") return true;
    if (raw === "false") return false;
    return prefs.getBoolPref("astra.settings.extensions.per-space", true);
  } catch {
    return true;
  }
}

function ownedSpace(spaceId) {
  const id = typeof spaceId === "string" && spaceId !== "" ? spaceId : __activeSpaceId();
  const space = (__spacesState()?.spaces ?? []).find((row) => row.id === id);
  if (!space || space.profile_id !== __activeProfileId()) return null;
  return id;
}

function readAssignments() {
  try {
    const parsed = JSON.parse(services()?.prefs?.getStringPref(ASSIGN_PREF, "{}") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = {};
      for (const [space, ids] of Object.entries(parsed)) {
        if (!Array.isArray(ids)) continue;
        out[space] = ids.filter((id) => typeof id === "string").slice(0, MAX_ASSIGNED);
      }
      return out;
    }
  } catch {
    // A corrupt row starts empty.
  }
  return {};
}

function writeAssignments(map) {
  try {
    // Another window has its own cache; merge before writing so the last
    // switch does not erase a set recorded elsewhere.
    const existing = JSON.parse(services()?.prefs?.getStringPref(ASSIGN_PREF, "{}") ?? "{}");
    const merged = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
    for (const [space, ids] of Object.entries(map)) merged[space] = ids;
    services()?.prefs?.setStringPref(ASSIGN_PREF, JSON.stringify(merged));
    return true;
  } catch {
    return false;
  }
}

/** Only a real, user-installed extension is part of a space set. */
export function assignable(addon) {
  return (
    !!addon &&
    addon.type === "extension" &&
    addon.isSystem !== true &&
    addon.isBuiltin !== true &&
    addon.hidden !== true
  );
}

async function allExtensions(manager) {
  const list = await manager.getAddonsByTypes(["extension"]);
  return (Array.isArray(list) ? list : []).filter(assignable);
}

function initialSet(addons) {
  return addons.filter((addon) => addon.userDisabled !== true && addon.isActive === true).map((addon) => addon.id);
}

async function applySpace(spaceId, { force = false, window_id = "" } = {}) {
  if (privateWindow(window_id)) return { applied: false, reason: "private_context" };
  if (perSpaceEnabled() === false) return { applied: false, reason: "disabled" };
  const space = ownedSpace(spaceId);
  if (!space) return { applied: false, reason: "space_not_owned" };
  const manager = await addonManager();
  if (!manager) return { applied: false, reason: "unavailable" };
  const assignments = readAssignments();
  let assigned = assignments[space];
  if (!Array.isArray(assigned)) {
    const all = await allExtensions(manager);
    // Capture any add-on the person disabled before this space existed; a
    // space never overrides that explicit choice.
    rememberBaseline(all.filter((addon) => addon.userDisabled === true).map((addon) => addon.id));
    assigned = initialSet(all);
    assignments[space] = assigned;
    writeAssignments(assignments);
  }
  const wanted = new Set(assigned);
  const baseline = baselineDisabled();
  const all = await allExtensions(manager);
  let changed = 0;
  for (const addon of all) {
    const enable = wanted.has(addon.id) && !baseline.has(addon.id);
    const currently = addon.userDisabled !== true;
    if (enable === currently) continue;
    try {
      if (enable) await addon.enable();
      else await addon.disable();
      changed += 1;
    } catch {
      // An add-on that refuses a state change keeps its current state; the
      // list reports the truth on the next read.
    }
  }
  void force;
  return { applied: true, space, changed };
}

function listenToSpaces() {
  if (_listener) return;
  _listener = addEventListener((event) => {
    if (event.type !== "space.switched") return;
    const space = event.data?.space;
    if (typeof space !== "string" || space === "") return;
    // A space with no set yet follows `extensions.new-space` once.
    const assignments = readAssignments();
    if (!Object.prototype.hasOwnProperty.call(assignments, space)) {
      try {
        const mode = services()?.prefs?.getStringPref(
          "astra.settings.extensions.new-space",
          "all",
        );
        const previous = event.data?.previous;
        if (mode === "none") assignments[space] = [];
        else if (mode === "current" && Array.isArray(assignments[previous])) {
          assignments[space] = [...assignments[previous]];
        }
        if (mode === "none" || mode === "current") writeAssignments(assignments);
      } catch {
        // Keep "all" as the default.
      }
    }
    void applySpace(space, { force: true });
  });
}

export const SpaceExtensions = {
  /** The installed extensions and whether this space enables each one. */
  async list({ request_id = "", space_id = "", window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window changes no extension set");
    }
    const space = ownedSpace(space_id);
    if (!space) return err(request_id, "space_not_owned", "that space is not in this profile");
    const manager = await addonManager();
    if (!manager) return ok(request_id, { space_id: space, extensions: [], per_space: true });
    const assignments = readAssignments();
    const hasAssignment = Object.prototype.hasOwnProperty.call(assignments, space);
    const assigned = new Set(hasAssignment ? assignments[space] : []);
    const all = await allExtensions(manager);
    const extensions = all.map((addon) => ({
      id: addon.id,
      name: String(addon.name ?? addon.id),
      version: String(addon.version ?? ""),
      icon: typeof addon.iconURL === "string" ? addon.iconURL : null,
      enabled: addon.userDisabled !== true,
      assigned: hasAssignment ? assigned.has(addon.id) : addon.userDisabled !== true,
      can_toggle: addon.isActive !== undefined,
    }));
    return ok(request_id, {
      space_id: space,
      per_space: perSpaceEnabled(),
      extensions,
    });
  },

  /** Turn one extension on or off for one space, then apply it if in front. */
  async assign({ request_id = "", space_id = "", id = "", enabled = true, window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window changes no extension set");
    }
    const space = ownedSpace(space_id);
    if (!space) return err(request_id, "space_not_owned", "that space is not in this profile");
    if (typeof id !== "string" || id === "") return err(request_id, "invalid", "an extension id is required");
    const manager = await addonManager();
    if (!manager) return err(request_id, "unavailable", "the extension manager is not reachable");
    const addon = await manager.getAddonByID(id);
    if (!addon || !assignable(addon)) return err(request_id, "no_such_extension", "unknown extension");
    if (enabled && baselineDisabled().has(id)) {
      return err(request_id, "user_disabled", "the person disabled this extension themselves");
    }
    const assignments = readAssignments();
    const set = new Set(assignments[space] ?? initialSet(await allExtensions(manager)));
    if (enabled) set.add(id);
    else set.delete(id);
    assignments[space] = [...set].slice(0, MAX_ASSIGNED);
    if (!writeAssignments(assignments)) {
      return err(request_id, "store_failed", "the assignment could not be saved");
    }
    if (space === __activeSpaceId()) {
      try {
        if (enabled) await addon.enable();
        else await addon.disable();
      } catch {
        return err(request_id, "apply_failed", "the engine refused the state change");
      }
    }
    return ok(request_id, { space_id: space, id, enabled: enabled === true, assigned: [...set] });
  },

  /** Copy one space's set to another space in the same profile. */
  async copy({ request_id = "", from_space = "", to_space = "", window_id = "" } = {}) {
    if (privateWindow(window_id)) {
      return err(request_id, "private_context", "a private window changes no extension set");
    }
    const from = ownedSpace(from_space);
    const to = ownedSpace(to_space);
    if (!from || !to) return err(request_id, "space_not_owned", "both spaces must be in this profile");
    const manager = await addonManager();
    const all = manager ? await allExtensions(manager) : [];
    const assignments = readAssignments();
    const source = Array.isArray(assignments[from]) ? assignments[from] : initialSet(all);
    assignments[to] = [...source].slice(0, MAX_ASSIGNED);
    if (!writeAssignments(assignments)) {
      return err(request_id, "store_failed", "the assignment could not be saved");
    }
    if (to === __activeSpaceId()) await applySpace(to, { force: true, window_id });
    return ok(request_id, { from_space: from, to_space: to, assigned: [...source] });
  },

  /** Apply a space's set now (the switch hook does this automatically). */
  async apply({ request_id = "", space_id = "", window_id = "" } = {}) {
    const result = await applySpace(space_id, { force: true, window_id });
    if (!result.applied) {
      const code = result.reason === "disabled" ? "disabled" : result.reason;
      return err(request_id, code, "the extension set was not applied");
    }
    return ok(request_id, result);
  },
};

// The switch hook must exist before Settings is ever opened: the feature is
// "each space applies its own set", not "once the panel was visited".
listenToSpaces();

export function __resetSpaceExtensionsForTests() {
  _listener?.();
  _listener = null;
}

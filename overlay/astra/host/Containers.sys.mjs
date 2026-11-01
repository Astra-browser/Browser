/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Containers module (v1). Isolated storage contexts for Astra
// spaces, profiles, and agent sessions (spike S-02, plan D-12/U-07).
//
// Split of responsibilities (plan §5.4):
// - `astra-core` (`crates/astra-core/src/spaces.rs`) owns the organisation:
//   spaces, order, and the `container_ref` (`cookieStoreId`) mapping per
//   space. It never touches engine internals.
// - This module owns the *live* side: creating/deleting contextual
//   identities, binding tabs to them, and dropping their site data.
//
// Engine grounding (verified against the pinned ESR source, read-only):
// - `ContextualIdentityService.create(name, icon, color)` mints an identity
//   with a numeric `userContextId`
//   (`engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs`).
// - `remove(userContextId)` calls
//   `Services.clearData.deleteDataFromOriginAttributesPattern({ userContextId })`
//   before erasing the identity — cookies, localStorage, IndexedDB and the
//   HTTP cache are keyed on `originAttributes.userContextId`, so deleting an
//   identity wipes exactly that space's site data and nothing else.
// - Tabs join a container via the `userContextId` open option
//   (`loadTabs(..., { userContextId })` → `tab.setAttribute("usercontextid", …)`
//   in `engine/browser/components/tabbrowser/content/tabbrowser.js`).
// - The WebExtension shape this mirrors is
//   `browser.contextualIdentities.{create,get,query,update,remove,move}`
//   with `cookieStoreId` ids of the form `firefox-container-N` (see the
//   `ext-contextualIdentities` xpcshell tests); MDN confirms each identity
//   gets a cookie store "not shared with other tabs".
// - Canonical container colors/icons are engine-validated
//   (`CONTAINER_COLORS` / `CONTAINER_ICONS` in `ContextualIdentityService`);
//   this model accepts any non-empty strings and lets the live service
//   reject unknown values.
//
// Live binding (shell, not this file): replace the in-memory `_identities`
// map with `ContextualIdentityService` calls, `cookieStoreId` parsing with
// `getContainerForCookieStoreId`, and `_jars` with the real partitioned
// storage (no code change on the consumer side — same method names and
// envelope). The stub `_jars` exist so the contract test can prove the
// isolation property (cookies/localStorage not shared across spaces) without
// a built binary; live, the engine enforces the same property through
// originAttributes.
//
// Mapping (S-02 decision):
// - one Astra space ↔ one contextual identity; `container_ref` on the space
//   is the `cookieStoreId`. Deleting a space deletes the identity (data
//   wiped by the engine).
// - one Astra profile ↔ one Firefox profile directory (containers alone do
//   not separate prefs/extensions/history/logins); see
//   `profile_dir_name` in core.
// - agent sessions use ephemeral identities: `createEphemeral` + `remove`
//   with `forgetData: true` on teardown.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";

export { HOST_API_VERSION };

// cookieStoreId shape minted by the engine: `firefox-container-N`.
const STORE_ID_RE = /^firefox-container-(\d+)$/;

const _identities = new Map(); // cookieStoreId -> record
const _tabBindings = new Map(); // astra_tab_id -> cookieStoreId
const _jars = new Map(); // userContextId -> { cookies: Map, local: Map }
let _nextUserContextId = 1;

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function userContextIdOf(cookieStoreId) {
  const m = STORE_ID_RE.exec(cookieStoreId ?? "");
  return m ? Number(m[1]) : null;
}

function jarFor(userContextId) {
  let jar = _jars.get(userContextId);
  if (!jar) {
    jar = { cookies: new Map(), local: new Map() };
    _jars.set(userContextId, jar);
  }
  return jar;
}

function snapshot(rec) {
  return { ...rec };
}

export const Containers = {
  // Create an isolated context. `ephemeral: true` marks agent-session
  // identities the caller must `remove` (data wiped) on teardown.
  async create({ request_id = "", name = "", color = "blue", icon = "circle", ephemeral = false } = {}) {
    if (typeof name !== "string" || name.trim() === "") {
      return err(request_id, "invalid_name", "name must be a non-empty string");
    }
    if (typeof color !== "string" || color.trim() === "") {
      return err(request_id, "invalid_color", "color must be a non-empty string");
    }
    if (typeof icon !== "string" || icon.trim() === "") {
      return err(request_id, "invalid_icon", "icon must be a non-empty string");
    }
    const userContextId = _nextUserContextId++;
    const cookieStoreId = `firefox-container-${userContextId}`;
    const rec = {
      cookieStoreId,
      userContextId,
      name,
      color,
      icon,
      ephemeral: ephemeral === true,
    };
    _identities.set(cookieStoreId, rec);
    jarFor(userContextId);
    emit("container.created", { cookieStoreId, name, ephemeral: rec.ephemeral });
    return ok(request_id, { container: snapshot(rec) });
  },

  async get({ request_id = "", cookieStoreId = "" } = {}) {
    const rec = _identities.get(cookieStoreId);
    if (!rec) {
      return err(request_id, "no_such_container", `unknown container ${cookieStoreId}`);
    }
    return ok(request_id, { container: snapshot(rec) });
  },

  async list({ request_id = "" } = {}) {
    return ok(request_id, {
      containers: [..._identities.values()].map(snapshot),
    });
  },

  // Rename / re-theme an identity. Storage stays partitioned under the same
  // userContextId (the engine `update()` likewise keeps the id).
  async update({ request_id = "", cookieStoreId = "", name, color, icon } = {}) {
    const rec = _identities.get(cookieStoreId);
    if (!rec) {
      return err(request_id, "no_such_container", `unknown container ${cookieStoreId}`);
    }
    for (const [key, value] of [["name", name], ["color", color], ["icon", icon]]) {
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string" || value.trim() === "") {
        return err(request_id, "invalid_value", `${key} must be a non-empty string`);
      }
      rec[key] = value;
    }
    emit("container.updated", { cookieStoreId });
    return ok(request_id, { container: snapshot(rec) });
  },

  // Delete an identity. Mirrors the engine: `forgetData: true` (default)
  // wipes that container's cookies/storage via the originAttributes pattern
  // and unbinds its tabs; `false` keeps the jars (rename-then-recreate flow).
  async remove({ request_id = "", cookieStoreId = "", forgetData = true } = {}) {
    const rec = _identities.get(cookieStoreId);
    if (!rec) {
      return err(request_id, "no_such_container", `unknown container ${cookieStoreId}`);
    }
    _identities.delete(cookieStoreId);
    if (forgetData !== false) {
      _jars.delete(rec.userContextId);
    }
    const unbound = [];
    for (const [tabId, bound] of _tabBindings) {
      if (bound === cookieStoreId) {
        _tabBindings.delete(tabId);
        unbound.push(tabId);
      }
    }
    emit("container.removed", { cookieStoreId, forgetData: forgetData !== false, unbound_tabs: unbound });
    return ok(request_id, { removed: true, forgetData: forgetData !== false, unbound_tabs: unbound });
  },

  // Bind a tab to a container: new loads for the tab open with that
  // container's `userContextId` (live: `addTab`/`loadTabs` option). Binding
  // is sticky until rebound or the container is removed.
  async bindTab({ request_id = "", astra_tab_id = "", cookieStoreId = "" } = {}) {
    if (typeof astra_tab_id !== "string" || astra_tab_id === "") {
      return err(request_id, "invalid_tab", "astra_tab_id must be a non-empty string");
    }
    if (!_identities.has(cookieStoreId)) {
      return err(request_id, "no_such_container", `unknown container ${cookieStoreId}`);
    }
    _tabBindings.set(astra_tab_id, cookieStoreId);
    emit("container.tab_bound", { astra_tab_id, cookieStoreId });
    return ok(request_id, { astra_tab_id, cookieStoreId });
  },

  async containerForTab({ request_id = "", astra_tab_id = "" } = {}) {
    const cookieStoreId = _tabBindings.get(astra_tab_id) ?? null;
    return ok(request_id, { astra_tab_id, cookieStoreId });
  },

  // Drop one container's site data without deleting the identity (live:
  // `Services.clearData.deleteDataFromOriginAttributesPattern`).
  async clearData({ request_id = "", cookieStoreId = "" } = {}) {
    const rec = _identities.get(cookieStoreId);
    if (!rec) {
      return err(request_id, "no_such_container", `unknown container ${cookieStoreId}`);
    }
    _jars.set(rec.userContextId, { cookies: new Map(), local: new Map() });
    emit("container.data_cleared", { cookieStoreId });
    return ok(request_id, { cookieStoreId, cleared: true });
  },

  // --- Stub-level storage ingress (isolation proof without a binary). ---
  // Live, cookies/localStorage are partitioned by the engine on
  // originAttributes; here each container owns a `_jars` partition keyed by
  // its userContextId, so the contract test exercises the same property:
  // writes through one container are invisible from any other.

  async setCookie({ request_id = "", astra_tab_id = "", name = "", value = "" } = {}) {
    const cookieStoreId = _tabBindings.get(astra_tab_id);
    if (!cookieStoreId) {
      return err(request_id, "tab_not_bound", `tab ${astra_tab_id} is not bound to a container`);
    }
    if (typeof name !== "string" || name === "") {
      return err(request_id, "invalid_cookie", "cookie name must be a non-empty string");
    }
    const rec = _identities.get(cookieStoreId);
    jarFor(rec.userContextId).cookies.set(name, String(value));
    return ok(request_id, { astra_tab_id, cookieStoreId, name });
  },

  async getCookies({ request_id = "", astra_tab_id = "" } = {}) {
    const cookieStoreId = _tabBindings.get(astra_tab_id);
    if (!cookieStoreId) {
      return err(request_id, "tab_not_bound", `tab ${astra_tab_id} is not bound to a container`);
    }
    const rec = _identities.get(cookieStoreId);
    const jar = _jars.get(rec.userContextId);
    return ok(request_id, {
      astra_tab_id,
      cookieStoreId,
      cookies: jar ? Object.fromEntries(jar.cookies) : {},
    });
  },

  async setLocalItem({ request_id = "", astra_tab_id = "", key = "", value = "" } = {}) {
    const cookieStoreId = _tabBindings.get(astra_tab_id);
    if (!cookieStoreId) {
      return err(request_id, "tab_not_bound", `tab ${astra_tab_id} is not bound to a container`);
    }
    if (typeof key !== "string" || key === "") {
      return err(request_id, "invalid_key", "key must be a non-empty string");
    }
    const rec = _identities.get(cookieStoreId);
    jarFor(rec.userContextId).local.set(key, String(value));
    return ok(request_id, { astra_tab_id, cookieStoreId, key });
  },

  async getLocalItem({ request_id = "", astra_tab_id = "", key = "" } = {}) {
    const cookieStoreId = _tabBindings.get(astra_tab_id);
    if (!cookieStoreId) {
      return err(request_id, "tab_not_bound", `tab ${astra_tab_id} is not bound to a container`);
    }
    const rec = _identities.get(cookieStoreId);
    const jar = _jars.get(rec.userContextId);
    const value = jar ? (jar.local.has(key) ? jar.local.get(key) : null) : null;
    return ok(request_id, { astra_tab_id, cookieStoreId, key, value });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetContainersForTests() {
  _identities.clear();
  _tabBindings.clear();
  _jars.clear();
  _nextUserContextId = 1;
}

// Test-only introspection: numeric id behind a cookieStoreId (the value the
// live tab binding passes as `userContextId`).
export function __userContextIdFor(cookieStoreId) {
  return userContextIdOf(cookieStoreId);
}

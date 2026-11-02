/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Settings module (v1, P3-T20). The ported product UI reads its
// preferences with `setting_get` (payload is the raw stored value or null)
// and writes them with `setting_set` (payload is an OperationAdmission).
// Durable settings belong to astra-core (plan §5.4); until the sidecar is
// wired into the shell, this module keeps the window's session values so
// the UI can read back what it wrote instead of silently reverting.
//
// Pure logic, no Firefox internals.

import { emit } from "./Events.sys.mjs";

export const HOST_API_VERSION = 1;

const _values = new Map();

function admission(accepted) {
  return { operation_id: null, accepted };
}

export const Settings = {
  // Returns the value itself (string | null), not an envelope: the UI reads
  // the payload directly (`settingGet` is typed `string | null`).
  async get({ key = "" } = {}) {
    if (typeof key !== "string" || key === "") {
      return null;
    }
    return _values.has(key) ? _values.get(key) : null;
  },

  async set({ request_id = "", key = "", value = null } = {}) {
    if (typeof key !== "string" || key === "") {
      return admission(false);
    }
    if (typeof value !== "string") {
      return admission(false);
    }
    _values.set(key, value);
    // The app also listens for preference pushes from chrome (`ui-command`);
    // announce the change so every surface agrees without a re-read.
    emit("ui-command", `preference.${key}=${value}`);
    return admission(true);
  },

  /** The stored value, read synchronously. Modules that decide what a typed
   *  field means (Search) cannot await a promise mid-parse. */
  current(key) {
    return typeof key === "string" && _values.has(key) ? _values.get(key) : null;
  },

  // Diagnostics/tests: the whole session map.
  async all() {
    return Object.fromEntries(_values);
  },
};

export function __settingsSnapshot() {
  return Object.fromEntries(_values);
}

// Test-only reset so contract tests start from a clean slate.
export function __resetSettingsForTests() {
  _values.clear();
}

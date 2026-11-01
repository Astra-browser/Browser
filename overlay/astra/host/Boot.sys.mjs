/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Boot module (v1). Startup/shutdown handshake between the chrome
// shell (and `astra-core` sidecar via BootSidecar, P1-T09) and the Host
// API: version negotiation, default-window setup, and the opening
// `event_seq` so the core can resync from event 1. Pure logic, no Firefox
// internals.
//
// Negotiation rule: the caller may pass `min_host_api_version`; when it
// exceeds `HOST_API_VERSION` the handshake fails fast with
// `incompatible_host` instead of a half-working session (plan §6.4).

import { emit, eventSeq } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";
import { __ensureDefaultWindow } from "./Windows.sys.mjs";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

export const Boot = {
  async handshake({ request_id = "boot-0", core_version = 0, min_host_api_version = 1 } = {}) {
    if (
      typeof min_host_api_version === "number" &&
      min_host_api_version > HOST_API_VERSION
    ) {
      return err(
        request_id,
        "incompatible_host",
        `core requires host API ${min_host_api_version}, host is ${HOST_API_VERSION}`,
      );
    }
    const window_id = __ensureDefaultWindow();
    const result = ok(request_id, {
      core_version,
      event_seq: eventSeq(),
      window_id,
    });
    emit("boot.ready", { host_api_version: HOST_API_VERSION, window_id });
    return result;
  },

  async status({ request_id = "boot-status" } = {}) {
    return ok(request_id, {
      ready: true,
      event_seq: eventSeq(),
      window_id: __ensureDefaultWindow(),
    });
  },

  async shutdown({ request_id = "boot-shutdown", reason = "quit" } = {}) {
    emit("boot.shutdown", { reason });
    return ok(request_id, { shutdown: true });
  },
};

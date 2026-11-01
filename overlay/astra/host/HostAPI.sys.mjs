/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API stub (P1-T05). The versioned seam from plan §6.4: everything Astra
// owns talks to Firefox internals only through this module tree. Full modules
// (Windows, Tabs, Navigation, Panes, …) with JSON schemas land in P2-T06;
// this stub proves the `resource://astra/` registration resolves and fixes
// the v1 protocol shape: every call echoes `request_id`, every event carries
// a monotonic `event_seq` (§5.4). No Firefox internals are imported here.

export const HOST_API_VERSION = 1;

let _eventSeq = 0;
const _listeners = new Set();

export function addEventListener(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function emit(type, data = {}) {
  const event = { event_seq: ++_eventSeq, type, data };
  for (const fn of _listeners) {
    try {
      fn(event);
    } catch {
      // Listener errors must never break the host event pump.
    }
  }
  return event;
}

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

export const Boot = {
  async handshake({ request_id = "boot-0", core_version = 0 } = {}) {
    const result = ok(request_id, { core_version, event_seq: _eventSeq });
    emit("boot.ready", { host_api_version: HOST_API_VERSION });
    return result;
  },
};

export const Tabs = {
  // Stub store: real tab objects are owned by the Firefox host (D-05, P2-T06).
  _tabs: new Map(),

  async create({ request_id = "", url = "about:blank" } = {}) {
    const astra_tab_id = `tab-${this._tabs.size + 1}`;
    this._tabs.set(astra_tab_id, { astra_tab_id, url });
    emit("tab.created", { astra_tab_id, url });
    return ok(request_id, { astra_tab_id });
  },

  async close({ request_id = "", astra_tab_id = "" } = {}) {
    const existed = this._tabs.delete(astra_tab_id);
    if (existed) {
      emit("tab.closed", { astra_tab_id });
    }
    return ok(request_id, { closed: existed });
  },

  async list({ request_id = "" } = {}) {
    return ok(request_id, { tabs: [...this._tabs.values()] });
  },
};

export const Navigation = {
  async loadURL({ request_id = "", astra_tab_id = "", url = "" } = {}) {
    emit("nav.committed", { astra_tab_id, url });
    return ok(request_id, { astra_tab_id, url });
  },

  async goBack({ request_id = "", astra_tab_id = "" } = {}) {
    return ok(request_id, { astra_tab_id, went_back: true });
  },

  async goForward({ request_id = "", astra_tab_id = "" } = {}) {
    return ok(request_id, { astra_tab_id, went_forward: true });
  },
};

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetForTests() {
  Tabs._tabs.clear();
  _eventSeq = 0;
  _listeners.clear();
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API entry point. The versioned seam from plan §6.4: everything Astra
// owns talks to Firefox internals only through this module tree. P1-T05
// proved the `resource://astra/` registration resolves; P1-T10 splits the
// stub into per-domain modules (Tabs, Navigation, Panes) over a shared
// event pump (Events), all pure logic with no Firefox internals so Node
// contract tests can import them by path. Full live bindings (real
// `gBrowser` tabs) land in P2-T06; the protocol shape here is authoritative.

import { addEventListener, emit, eventSeq } from "./Events.sys.mjs";
import { HOST_API_VERSION, Tabs, __resetTabsForTests } from "./Tabs.sys.mjs";
import { Navigation } from "./Navigation.sys.mjs";
import { Panes, __resetPanesForTests } from "./Panes.sys.mjs";
import { __resetEventsForTests } from "./Events.sys.mjs";

export { HOST_API_VERSION, Tabs, Navigation, Panes, addEventListener, emit, eventSeq };

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

export const Boot = {
  async handshake({ request_id = "boot-0", core_version = 0 } = {}) {
    const result = ok(request_id, { core_version, event_seq: eventSeq() });
    emit("boot.ready", { host_api_version: HOST_API_VERSION });
    return result;
  },
};

// Test-only reset so contract tests (P1-T11/P2-T06) start from a clean slate.
export function __resetForTests() {
  __resetTabsForTests();
  __resetPanesForTests();
  __resetEventsForTests();
}

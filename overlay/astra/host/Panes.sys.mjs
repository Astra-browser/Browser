/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Panes module (P1-T10 stub). Panes are Astra-side surfaces (side
// panel, helpers) that host content next to the tab strip; the full
// implementation (visibility, rects, generation guards) lands in P2-T06.
// This stub fixes the v1 protocol shape: calls echo `request_id`, visibility
// changes emit `pane.shown` / `pane.hidden` with `event_seq`. Pure logic.

import { emit } from "./Events.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";

const _panes = new Map(); // pane_id -> { pane_id, visible }

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

export const Panes = {
  async show({ request_id = "", pane_id = "assistant" } = {}) {
    _panes.set(pane_id, { pane_id, visible: true });
    emit("pane.shown", { pane_id });
    return ok(request_id, { pane_id, visible: true });
  },

  async hide({ request_id = "", pane_id = "assistant" } = {}) {
    _panes.set(pane_id, { pane_id, visible: false });
    emit("pane.hidden", { pane_id });
    return ok(request_id, { pane_id, visible: false });
  },

  async list({ request_id = "" } = {}) {
    return ok(request_id, { panes: [..._panes.values()] });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetPanesForTests() {
  _panes.clear();
}

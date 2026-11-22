/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Panes module (v1). Panes are Astra-side surfaces (side panel,
// Work canvas, helpers) that host content next to the tab strip.
// Each pane binds to a UI `slot` (a named mount point in the shell layout)
// and optionally to a tab; `rect` carries the last measured geometry and
// `generation` guards stale async updates (attach/detach bump it; slow
// producers must pass the generation they acted on and treat a mismatch
// as stale). Visibility changes emit `pane.shown` / `pane.hidden`
// (v1 protocol, P1-T10); bindings emit `pane.attached` / `pane.detached` /
// `pane.rect-changed`. Pure logic, no Firefox internals.

import { HOST_API_VERSION, err, ok } from "./Envelope.sys.mjs";
import { emit } from "./Events.sys.mjs";

const _panes = new Map(); // pane_id -> { pane_id, visible, slot, rect, astra_tab_id, generation }

function snapshot(pane_id) {
  const pane = _panes.get(pane_id);
  return pane ? { ...pane, rect: pane.rect ? { ...pane.rect } : null } : null;
}

function validRect(rect) {
  return (
    rect &&
    typeof rect === "object" &&
    ["x", "y", "width", "height"].every((k) => typeof rect[k] === "number" && Number.isFinite(rect[k])) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

export const Panes = {
  async show({ request_id = "", pane_id = "assistant" } = {}) {
    const prev = _panes.get(pane_id);
    _panes.set(pane_id, {
      pane_id,
      visible: true,
      slot: prev?.slot ?? null,
      rect: prev?.rect ?? null,
      astra_tab_id: prev?.astra_tab_id ?? null,
      generation: prev?.generation ?? 0,
    });
    emit("pane.shown", { pane_id });
    return ok(request_id, { pane_id, visible: true });
  },

  async hide({ request_id = "", pane_id = "assistant" } = {}) {
    const prev = _panes.get(pane_id);
    _panes.set(pane_id, {
      pane_id,
      visible: false,
      slot: prev?.slot ?? null,
      rect: prev?.rect ?? null,
      astra_tab_id: prev?.astra_tab_id ?? null,
      generation: prev?.generation ?? 0,
    });
    emit("pane.hidden", { pane_id });
    return ok(request_id, { pane_id, visible: false });
  },

  // Bind a pane to a shell slot (and optionally mirror a tab's content).
  async attach({ request_id = "", pane_id = "assistant", slot = "", astra_tab_id = null } = {}) {
    if (typeof slot !== "string" || slot === "") {
      return err(request_id, "invalid_slot", "slot must be a non-empty string");
    }
    const prev = _panes.get(pane_id);
    const generation = (prev?.generation ?? 0) + 1;
    _panes.set(pane_id, {
      pane_id,
      visible: prev?.visible ?? false,
      slot,
      rect: prev?.rect ?? null,
      astra_tab_id: astra_tab_id ?? prev?.astra_tab_id ?? null,
      generation,
    });
    emit("pane.attached", { pane_id, slot, generation });
    return ok(request_id, { pane_id, slot, generation });
  },

  async detach({ request_id = "", pane_id = "assistant" } = {}) {
    const prev = _panes.get(pane_id);
    if (!prev) {
      return err(request_id, "no_such_pane", `unknown pane ${pane_id}`);
    }
    const generation = prev.generation + 1;
    _panes.set(pane_id, { ...prev, slot: null, astra_tab_id: null, generation });
    emit("pane.detached", { pane_id, generation });
    return ok(request_id, { pane_id, detached: true, generation });
  },

  async setRect({ request_id = "", pane_id = "assistant", rect = null } = {}) {
    const prev = _panes.get(pane_id);
    if (!prev) {
      return err(request_id, "no_such_pane", `unknown pane ${pane_id}`);
    }
    if (!validRect(rect)) {
      return err(request_id, "invalid_rect", "rect must be { x, y, width, height } finite numbers");
    }
    _panes.set(pane_id, { ...prev, rect: { ...rect } });
    emit("pane.rect-changed", { pane_id, rect: { ...rect } });
    return ok(request_id, { pane_id, rect: { ...rect } });
  },

  // Generation guard: slow producers pass the generation they acted on;
  // `stale: true` means a newer attach/detach superseded it — drop the work.
  async check({ request_id = "", pane_id = "assistant", generation = 0 } = {}) {
    const prev = _panes.get(pane_id);
    if (!prev) {
      return err(request_id, "no_such_pane", `unknown pane ${pane_id}`);
    }
    return ok(request_id, {
      pane_id,
      generation: prev.generation,
      stale: prev.generation !== generation,
    });
  },

  async get({ request_id = "", pane_id = "assistant" } = {}) {
    const snap = snapshot(pane_id);
    if (!snap) {
      return err(request_id, "no_such_pane", `unknown pane ${pane_id}`);
    }
    return ok(request_id, { pane: snap });
  },

  async list({ request_id = "" } = {}) {
    return ok(request_id, { panes: [..._panes.keys()].map((id) => snapshot(id)) });
  },
};

// Test-only reset so contract tests start from a clean slate.
export function __resetPanesForTests() {
  _panes.clear();
}

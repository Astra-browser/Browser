/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Helpers module (v1, P6-T05). Parallel sub-agents: one isolated
// container per helper plus one visible source pane showing the helper's
// live page.
//
// Split of responsibilities (AGENTS_DESIGN.md §4):
// - `astra-agents` (`crates/astra-agents/src/helpers.rs`) owns budgets,
//   step/token accounting, and the cancel cascade.
// - This module owns the *live* side: the helper→container mapping and the
//   helper→pane placement. It uses the EXISTING `Panes` and `Containers`
//   modules read-only (same method names, same envelopes) — no changes to
//   either module, no fork of their logic.
//
// Mapping:
// - one helper ↔ one ephemeral container (`Containers.create` with
//   `ephemeral: true`, named `helper-<helper_id>`); cancel removes it
//   (`forgetData: true`) so no orphan tab survives.
// - one helper ↔ one source pane (`helper-pane-<helper_id>`, attached to
//   the `work.helper` slot via `Panes.attach`, shown via `Panes.show`).
// - cancelling a helper detaches + hides its pane, then removes its
//   container. Cancelling the parent cascades to every live helper.
//
// Pure logic over the two modules' public surfaces, so Node contract tests
// import by path (`node --check` for syntax; behavioural tests stub
// `Containers`/`Panes` through the injectable seams below).

import { emit as defaultEmit } from "./Events.sys.mjs";
import { Panes as defaultPanes } from "./Panes.sys.mjs";
import { Containers as defaultContainers } from "./Containers.sys.mjs";
import { HOST_API_VERSION } from "./Tabs.sys.mjs";

// --- Injectable seams ------------------------------------------------------
// The live shell uses the real modules; tests inject doubles with the same
// method names. Seams are module-local so `Panes`/`Containers` themselves
// stay untouched (read-only use).
let _panes = defaultPanes;
let _containers = defaultContainers;
let _emitSink = (type, data) => defaultEmit(type, data);

export function setPanesModule(panes) {
  _panes = panes;
}

export function setContainersModule(containers) {
  _containers = containers;
}

export function setEventSink(fn) {
  _emitSink = fn;
}

// helper_id -> { helper_id, parent_run_id, cookieStoreId, pane_id, live }
const _helpers = new Map();

// Slot in the shell layout where helper source panes mount.
const HELPER_SLOT = "work.helper";

function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

function paneIdFor(helper_id) {
  return `helper-pane-${helper_id}`;
}

function failed(res) {
  return Boolean(res && res.error);
}

export const Helpers = {
  // Spawn a helper surface: mint its ephemeral container, then attach + show
  // its source pane. Budgets and the run record live in `astra-agents`;
  // this call only wires the live page.
  async spawn({ request_id = "", helper_id = "", parent_run_id = "", goal = "" } = {}) {
    if (typeof helper_id !== "string" || helper_id === "") {
      return err(request_id, "invalid_helper", "helper_id must be a non-empty string");
    }
    if (typeof parent_run_id !== "string" || parent_run_id === "") {
      return err(request_id, "invalid_parent", "parent_run_id must be a non-empty string");
    }
    const existing = _helpers.get(helper_id);
    if (existing && existing.live) {
      return err(request_id, "already_spawned", `helper ${helper_id} is already live`);
    }
    const created = await _containers.create({
      request_id,
      name: `helper-${helper_id}`,
      ephemeral: true,
    });
    if (failed(created)) {
      return err(request_id, created.error.code, created.error.message);
    }
    const cookieStoreId = created.container.cookieStoreId;
    const pane_id = paneIdFor(helper_id);
    const attached = await _panes.attach({ request_id, pane_id, slot: HELPER_SLOT });
    if (failed(attached)) {
      // No pane, no helper: roll the container back so spawn never orphans.
      await _containers.remove({ request_id, cookieStoreId, forgetData: true });
      return err(request_id, attached.error.code, attached.error.message);
    }
    await _panes.show({ request_id, pane_id });
    _helpers.set(helper_id, {
      helper_id,
      parent_run_id,
      cookieStoreId,
      pane_id,
      pane_generation: attached.generation ?? 0,
      live: true,
    });
    _emitSink("helper.spawned", { helper_id, parent_run_id, cookieStoreId, pane_id });
    return ok(request_id, {
      helper_id,
      parent_run_id,
      goal,
      cookieStoreId,
      pane_id,
      pane_generation: attached.generation ?? 0,
    });
  },

  // Cancel one helper: detach + hide its pane, then remove its container
  // (data wiped). Pane teardown precedes container removal so a slow pane
  // update can never re-anchor to a dead container. Cancelling an unknown
  // or already-cancelled helper is an error, never a silent no-op.
  async cancel({ request_id = "", helper_id = "", forgetData = true } = {}) {
    const helper = _helpers.get(helper_id);
    if (!helper || !helper.live) {
      return err(request_id, "no_such_helper", `unknown or stopped helper ${helper_id}`);
    }
    helper.live = false;
    await _panes.detach({ request_id, pane_id: helper.pane_id });
    await _panes.hide({ request_id, pane_id: helper.pane_id });
    const removed = await _containers.remove({
      request_id,
      cookieStoreId: helper.cookieStoreId,
      forgetData,
    });
    if (failed(removed)) {
      return err(request_id, removed.error.code, removed.error.message);
    }
    _emitSink("helper.cancelled", {
      helper_id,
      parent_run_id: helper.parent_run_id,
      cookieStoreId: helper.cookieStoreId,
      pane_id: helper.pane_id,
    });
    return ok(request_id, {
      helper_id,
      cancelled: true,
      pane_id: helper.pane_id,
      cookieStoreId: helper.cookieStoreId,
      unbound_tabs: removed.unbound_tabs ?? [],
    });
  },

  // Cascade cancel: stop every live helper of one parent run (parent cancel
  // or shutdown). Returns the cancelled helper ids in spawn order.
  async cancelAll({ request_id = "", parent_run_id = "" } = {}) {
    const live = [..._helpers.values()].filter(
      (h) => h.live && (parent_run_id === "" || h.parent_run_id === parent_run_id),
    );
    const cancelled = [];
    for (const helper of live) {
      const res = await Helpers.cancel({ request_id, helper_id: helper.helper_id });
      if (!failed(res)) {
        cancelled.push(helper.helper_id);
      }
    }
    return ok(request_id, { parent_run_id, cancelled });
  },

  async get({ request_id = "", helper_id = "" } = {}) {
    const helper = _helpers.get(helper_id);
    if (!helper) {
      return err(request_id, "no_such_helper", `unknown helper ${helper_id}`);
    }
    return ok(request_id, { helper: { ...helper } });
  },

  async list({ request_id = "", parent_run_id = "" } = {}) {
    const helpers = [..._helpers.values()]
      .filter((h) => parent_run_id === "" || h.parent_run_id === parent_run_id)
      .map((h) => ({ ...h }));
    return ok(request_id, { helpers });
  },
};

// Test-only reset so contract tests start from a clean slate. Resets this
// module's map; the underlying Panes/Containers resets are theirs to call.
export function __resetHelpersForTests() {
  _helpers.clear();
  _panes = defaultPanes;
  _containers = defaultContainers;
  _emitSink = (type, data) => defaultEmit(type, data);
}

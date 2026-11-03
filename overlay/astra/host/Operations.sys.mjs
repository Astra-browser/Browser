/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API Operations module (P6b). The app admits a privileged mutation with
// a command, then observes its terminal disposition through this bounded,
// process-local ledger instead of guessing from a projection.
//
// Contract (bindings.ts):
//   OperationAdmission  { operation_id, accepted }
//   OperationStatus     { state: "unknown" | "pending" | "processed",
//                         disposition? }
//   OperationDisposition { operation_id, outcome, reason }
//
// The ledger is deliberately small and in-memory: it is an actor-side
// settlement channel, not durable state. Once the app acknowledges a
// disposition the entry is dropped, so an acknowledgement is idempotent and a
// lost one only republishes the same immutable record.
//
// Pure logic, no Firefox internals: the chrome host and Node contract tests
// import the same module.

import { emit } from "./Events.sys.mjs";

/** Terminal classifications the actor can establish right now. */
export const OUTCOMES = new Set([
  "applied",
  "no_op",
  "rejected",
  "native_admission_failed",
  "deferred",
]);

/** Reasons the app maps onto user-visible copy (bindings.ts). */
export const REASONS = new Set([
  "mutation_applied",
  "state_unchanged",
  "invalid_scope",
  "no_focused_window",
  "item_limit_reached",
  "invalid_input",
  "history_unavailable",
  "layout_unavailable",
  "unsupported_command",
  "native_dispatch_rejected",
  "native_work_pending",
  "discard_completion_pending",
  "store_work_pending",
  "store_admission_rejected",
  "store_conflict",
  "store_outcome_unknown",
  "store_reconciliation_failed",
]);

/** The app keeps a 256-entry presentation window; the ledger stays the same
 *  size so a busy actor cannot grow without bound. */
const MAX_RESULTS = 256;
const OPERATION_ID = /^[0-9a-f]{16}$/u;

const _dispositions = new Map(); // operation_id -> disposition
const _unacknowledged = new Set();
let _minted = 0;

/** 16 lowercase hex characters, monotonic prefix, never reused in a process. */
function mintOperationId() {
  _minted += 1;
  const counter = _minted.toString(16).padStart(8, "0").slice(-8);
  const salt = Math.floor(Math.random() * 0x100000000)
    .toString(16)
    .padStart(8, "0")
    .slice(-8);
  const id = `${counter}${salt}`;
  return OPERATION_ID.test(id) ? id : "0000000000000000";
}

function prune() {
  while (_dispositions.size > MAX_RESULTS) {
    const oldest = _dispositions.keys().next().value;
    if (oldest === undefined) return;
    _dispositions.delete(oldest);
    _unacknowledged.delete(oldest);
  }
}

function record(outcome, reason) {
  if (!OUTCOMES.has(outcome) || !REASONS.has(reason)) {
    // Fail closed: an unclassifiable result is never reported as applied.
    outcome = "rejected";
    reason = "invalid_input";
  }
  const disposition = {
    operation_id: mintOperationId(),
    outcome,
    reason,
  };
  _dispositions.set(disposition.operation_id, disposition);
  _unacknowledged.add(disposition.operation_id);
  prune();
  // The ledger publishes the terminal record once; the app reconciles the
  // same immutable object if it missed the event.
  emit("operation-processed", disposition);
  return disposition;
}

/**
 * Admit one mutation that has already produced a terminal result.
 *
 * `accepted` answers "did the actor take this command?"; the disposition
 * answers "what happened". A refused command is still admitted so the app can
 * show the reason instead of a generic failure.
 */
export function admit({ outcome = "applied", reason = "mutation_applied" } = {}) {
  const disposition = record(outcome, reason);
  return { operation_id: disposition.operation_id, accepted: true };
}

/** Refuse a command before it reaches the engine, with a classified reason. */
export function refuse(reason = "invalid_input") {
  const disposition = record("rejected", reason);
  return { operation_id: disposition.operation_id, accepted: true };
}

export const Operations = {
  admit,
  refuse,

  /** One immutable terminal record, or `unknown` when it was evicted. */
  async status({ operation_id = "" } = {}) {
    if (!OPERATION_ID.test(operation_id)) {
      return { state: "unknown" };
    }
    const disposition = _dispositions.get(operation_id);
    if (!disposition) {
      return { state: "unknown" };
    }
    return { state: "processed", disposition };
  },

  /** Every terminal record the app has not acknowledged yet. */
  async reconcile() {
    const out = [];
    for (const id of _unacknowledged) {
      const disposition = _dispositions.get(id);
      if (disposition) out.push(disposition);
    }
    return out;
  },

  /** Drop one retained record. False means it was already acknowledged. */
  async acknowledge({ operation_id = "" } = {}) {
    if (!OPERATION_ID.test(operation_id)) {
      return false;
    }
    const had = _unacknowledged.delete(operation_id);
    _dispositions.delete(operation_id);
    return had;
  },
};

/** Test-only: the ledger is process state, not a durable store. */
export function __resetOperationsForTests() {
  _dispositions.clear();
  _unacknowledged.clear();
  _minted = 0;
}

/** Test/diagnostic view of retained size. */
export function retainedCount() {
  return _dispositions.size;
}

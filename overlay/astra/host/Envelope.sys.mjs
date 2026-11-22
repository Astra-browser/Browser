/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One owner for the Host API reply envelope (P7-T03, Appendix C).
//
// Every host module answers a call with one of two shapes:
//
//   ok(request_id, data)   -> { request_id, host_api_version, ...data }
//   err(request_id, code, m) -> { request_id, host_api_version, error: { code, message } }
//
// The field set and order are the wire. `tests/contract/envelope_model.mjs`
// compares the bytes, so adding, renaming or reordering a field fails there
// before a UI caller sees a different envelope. No field may be added without
// a caller that reads it (SCOPE rule 5).
//
// This module imports nothing. A host module may therefore use it from chrome
// and from a Node test that imports the module by file path, without pulling
// another lane's dependencies in (History relies on that).
//
// TWO ADMISSIONS, TWO QUESTIONS. `accepted` answers a different question in
// each domain; the shapes must not be merged:
//
//   operationAccepted(operation_id) -> { operation_id, accepted: true }
//     "Was the operation taken up?" Yes. Operations.refuse records the
//     operation, then reports it as rejected; the operation itself exists and
//     has an id the app can reconcile.
//   commandNotAdmitted(reason) -> { operation_id: null, accepted: false, reason }
//     "Was the command admitted?" No. Commands.refusal answers before any
//     dispatch, so there is no operation to point at.
//
// Do not add a third envelope here for a surface with no reply shape.

export const HOST_API_VERSION = 1;

/** The success envelope: one request id, the protocol version, the payload. */
export function ok(request_id, data = {}) {
  return { request_id, host_api_version: HOST_API_VERSION, ...data };
}

/** The failure envelope: one request id, the version, a classified error. */
export function err(request_id, code, message) {
  return { request_id, host_api_version: HOST_API_VERSION, error: { code, message } };
}

/**
 * The success envelope for an operation that was admitted before it settled.
 * Tabs answers these; `operation_id: null` means the engine observes the
 * result through the ledger rather than by id.
 */
export function admitted(request_id, data = {}) {
  return {
    request_id,
    host_api_version: HOST_API_VERSION,
    operation_id: null,
    accepted: true,
    ...data,
  };
}

/** A rejected operation that was still accepted (see Operations.refuse). */
export function operationAccepted(operation_id) {
  return { operation_id, accepted: true };
}

/** A command that was never admitted (see Commands.refusal). */
export function commandNotAdmitted(reason) {
  return { operation_id: null, accepted: false, reason };
}

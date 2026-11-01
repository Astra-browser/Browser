/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API event pump (P1-T10). Every event carries a monotonic `event_seq`
// (§5.4, Appendix C) so the core can detect gaps and resync. Pure logic, no
// Firefox internals: importable both as a chrome ES module
// (`resource://astra/host/Events.sys.mjs`) and from Node contract tests.

let _eventSeq = 0;
const _listeners = new Set();

export function addEventListener(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function emit(type, data = {}) {
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

export function eventSeq() {
  return _eventSeq;
}

// Test-only reset so contract tests start from a clean slate.
export function __resetEventsForTests() {
  _eventSeq = 0;
  _listeners.clear();
}

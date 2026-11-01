/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Host API event pump (v1). Every event carries a monotonic `event_seq`
// (§5.4, Appendix C) so the core can detect gaps and resync via
// `eventsSince(seq)`. Pure logic, no Firefox internals: importable both as
// a chrome ES module (`resource://astra/host/Events.sys.mjs`) and from
// Node contract tests.
//
// Event catalogue (see schemas/events.json):
//   boot.ready, boot.shutdown
//   window.created, window.focused, window.closed, window.fullscreen-changed
//   tab.created, tab.updated, tab.moved, tab.closed,
//   tab.pinned, tab.unpinned, tab.discarded, tab.restored
//   nav.committed, nav.started, nav.stopped, nav.zoom-changed,
//   nav.find-result, nav.print-requested, nav.reader-changed
//   pane.shown, pane.hidden, pane.attached, pane.detached, pane.rect-changed
//   content.title-changed, content.location-changed

let _eventSeq = 0;
const _listeners = new Set();

// Bounded ring buffer so a resyncing core can replay what it missed.
const BUFFER_CAP = 500;
const _buffer = [];

export function addEventListener(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function emit(type, data = {}) {
  const event = { event_seq: ++_eventSeq, type, data };
  _buffer.push(event);
  if (_buffer.length > BUFFER_CAP) {
    _buffer.shift();
  }
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

// Gap resync (§5.4): returns buffered events with `event_seq` greater than
// `seq`, oldest first. Events evicted from the ring report `gap: true` so
// the core knows to fall back to a full snapshot (Tabs.list/Windows.list).
export function eventsSince(seq) {
  const events = _buffer.filter((e) => e.event_seq > seq);
  // If the oldest buffered event is newer than seq+1, events were evicted
  // and the core must fall back to a full snapshot.
  const gap =
    events.length > 0
      ? _buffer[0].event_seq > seq + 1
      : _buffer.length > 0 && seq < _eventSeq;
  return { events, gap, event_seq: _eventSeq };
}

// Introspection for contract tests and diagnostics.
export function bufferedCount() {
  return _buffer.length;
}

// Test-only reset so contract tests start from a clean slate.
export function __resetEventsForTests() {
  _eventSeq = 0;
  _listeners.clear();
  _buffer.length = 0;
}

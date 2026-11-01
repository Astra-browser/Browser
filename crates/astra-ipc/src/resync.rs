/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Crash recovery via `event_seq` gap detection (§5.4).
//!
//! The host emits a session-monotonic `event_seq` on every event envelope.
//! The core tracks the sequence with [`SeqTracker`]: any jump means frames
//! were lost to a crash (either side), and the core must resync by asking
//! the peer to replay from the first missing sequence number. [`EventRecorder`]
//! is the peer-side bounded replay buffer that makes that possible.

use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};

/// Envelope name of the resync request (`kind = req`,
/// payload `{ "from_seq": <u64> }`). The response is a `res` with the same
/// `id` and payload `{ "events": [<Envelope>, ...] }`.
pub const RESYNC_REQUEST_NAME: &str = "astra:transport/resync";

/// Verdict after feeding one envelope to [`SeqTracker::feed`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResyncAction {
    /// In-order (or a non-event envelope, which carries no sequence).
    Ok,
    /// A gap: `expected` is the first missing sequence number, `got` is the
    /// sequence number just received. The caller should send
    /// [`resync_request`] with `expected`, then replay the missed range.
    Gap { expected: u64, got: u64 },
    /// Duplicate or stale delivery; safe to ignore.
    Duplicate,
}

/// Tracks the peer's `event_seq` and reports gaps (§5.4).
#[derive(Debug, Default)]
pub struct SeqTracker {
    next_expected: Option<u64>,
}

impl SeqTracker {
    /// Create a tracker with no history (first event sets the baseline).
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a tracker that resumes after reconnect: the first event with
    /// `seq < next` is a harmless duplicate, `seq == next` continues
    /// cleanly, and `seq > next` is a [`ResyncAction::Gap`].
    pub fn resume_from(next_seq: u64) -> Self {
        Self {
            next_expected: Some(next_seq),
        }
    }

    /// Feed one envelope; only `kind = evt` envelopes carrying `seq`
    /// advance the tracker.
    pub fn feed(&mut self, env: &Envelope) -> ResyncAction {
        if env.kind != Kind::Evt {
            return ResyncAction::Ok;
        }
        let Some(seq) = env.seq else {
            return ResyncAction::Ok;
        };
        match self.next_expected {
            None => {
                self.next_expected = Some(seq.saturating_add(1));
                ResyncAction::Ok
            }
            Some(next) => {
                if seq < next {
                    ResyncAction::Duplicate
                } else if seq == next {
                    self.next_expected = Some(next.saturating_add(1));
                    ResyncAction::Ok
                } else {
                    self.next_expected = Some(seq.saturating_add(1));
                    ResyncAction::Gap {
                        expected: next,
                        got: seq,
                    }
                }
            }
        }
    }

    /// Next sequence number the tracker wants to see.
    pub fn next_expected(&self) -> Option<u64> {
        self.next_expected
    }
}

/// Build a resync request: replay events starting at `from_seq`.
pub fn resync_request(id: &str, from_seq: u64) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        kind: Kind::Req,
        name: RESYNC_REQUEST_NAME.to_string(),
        seq: None,
        payload: serde_json::json!({ "from_seq": from_seq }),
        error: None,
    }
}

/// Parse the `from_seq` out of a resync request payload.
pub fn parse_resync_request(env: &Envelope) -> Option<u64> {
    if env.kind != Kind::Req || env.name != RESYNC_REQUEST_NAME {
        return None;
    }
    env.payload.get("from_seq")?.as_u64()
}

/// Build the resync response carrying the replayed `events`.
pub fn resync_response(request_id: &str, events: &[Envelope]) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: request_id.to_string(),
        kind: Kind::Res,
        name: RESYNC_REQUEST_NAME.to_string(),
        seq: None,
        payload: serde_json::json!({ "events": events }),
        error: None,
    }
}

/// Parse replayed events out of a resync response payload.
pub fn parse_resync_response(env: &Envelope, request_id: &str) -> Option<Vec<Envelope>> {
    if env.kind != Kind::Res || env.name != RESYNC_REQUEST_NAME || env.id != request_id {
        return None;
    }
    let events = env.payload.get("events")?.as_array()?;
    events
        .iter()
        .map(|v| serde_json::from_value(v.clone()).ok())
        .collect()
}

/// Bounded peer-side replay buffer: remembers the last `capacity` sequenced
/// events so a reconnecting core can be caught up with
/// [`EventRecorder::replay_since`].
#[derive(Debug, Default)]
pub struct EventRecorder {
    capacity: usize,
    events: std::collections::VecDeque<Envelope>,
}

impl EventRecorder {
    /// Create a buffer holding at most `capacity` events (minimum 1).
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            events: std::collections::VecDeque::new(),
        }
    }

    /// Record a sequenced event envelope; non-sequenced envelopes are ignored.
    pub fn push(&mut self, env: Envelope) {
        if env.kind != Kind::Evt || env.seq.is_none() {
            return;
        }
        if self.events.len() >= self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(env);
    }

    /// All buffered events with `seq >= from_seq`, in order.
    pub fn replay_since(&self, from_seq: u64) -> Vec<Envelope> {
        self.events
            .iter()
            .filter(|e| e.seq.unwrap_or(0) >= from_seq)
            .cloned()
            .collect()
    }

    /// Highest buffered sequence number, if any.
    pub fn high_water(&self) -> Option<u64> {
        self.events.back().and_then(|e| e.seq)
    }

    /// Number of buffered events.
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Whether the buffer holds no events.
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evt(seq: u64) -> Envelope {
        Envelope {
            v: PROTOCOL_VERSION,
            id: format!("e-{seq}"),
            kind: Kind::Evt,
            name: "tabs.created".to_string(),
            seq: Some(seq),
            payload: serde_json::json!({}),
            error: None,
        }
    }

    #[test]
    fn in_order_passes() {
        let mut t = SeqTracker::new();
        for seq in [7, 8, 9] {
            assert_eq!(t.feed(&evt(seq)), ResyncAction::Ok);
        }
    }

    #[test]
    fn gap_detected_with_expected() {
        let mut t = SeqTracker::new();
        assert_eq!(t.feed(&evt(4)), ResyncAction::Ok);
        assert_eq!(
            t.feed(&evt(7)),
            ResyncAction::Gap {
                expected: 5,
                got: 7
            }
        );
        // Tracker resynchronizes on the new high-water mark.
        assert_eq!(t.feed(&evt(8)), ResyncAction::Ok);
    }

    #[test]
    fn duplicates_ignored() {
        let mut t = SeqTracker::resume_from(10);
        assert_eq!(t.feed(&evt(8)), ResyncAction::Duplicate);
        assert_eq!(t.feed(&evt(10)), ResyncAction::Ok);
    }

    #[test]
    fn non_events_do_not_advance() {
        let mut t = SeqTracker::resume_from(3);
        let req = Envelope {
            v: PROTOCOL_VERSION,
            id: "r".to_string(),
            kind: Kind::Req,
            name: "tabs_navigate".to_string(),
            seq: None,
            payload: serde_json::json!({}),
            error: None,
        };
        assert_eq!(t.feed(&req), ResyncAction::Ok);
        assert_eq!(t.next_expected(), Some(3));
    }

    #[test]
    fn resync_envelopes_round_trip() {
        let req = resync_request("rs-1", 42);
        assert_eq!(parse_resync_request(&req), Some(42));
        let events = vec![evt(42), evt(43)];
        let res = resync_response("rs-1", &events);
        assert_eq!(parse_resync_response(&res, "rs-1").unwrap(), events);
        assert!(parse_resync_response(&res, "other").is_none());
    }

    #[test]
    fn recorder_replays_range_and_evicts() {
        let mut rec = EventRecorder::new(3);
        for seq in 1..=5 {
            rec.push(evt(seq));
        }
        assert_eq!(rec.len(), 3);
        let replayed = rec.replay_since(4);
        assert_eq!(
            replayed.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![Some(4), Some(5)]
        );
        assert_eq!(rec.high_water(), Some(5));
    }
}

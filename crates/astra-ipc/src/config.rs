/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Transport tuning knobs (P2-T03 owns them; the codec defaults live in
//! `astra-proto`).

use std::time::Duration;

/// Tuning for [`crate::Transport`].
#[derive(Debug, Clone)]
pub struct TransportConfig {
    /// Largest accepted frame body in bytes. Must be `<=`
    /// [`astra_proto::MAX_FRAME_BYTES`]; larger values are clamped.
    pub max_frame_bytes: usize,
    /// Bound of the outbound queue. [`crate::Transport::send`] waits when
    /// full (backpressure); [`crate::Transport::try_send`] fails fast.
    pub outbound_capacity: usize,
    /// Bound of the inbound queue. The read pump waits when full, which
    /// propagates backpressure to the peer's socket/pipe buffer.
    pub inbound_capacity: usize,
    /// Interval between heartbeat events (`astra:transport/heartbeat`).
    pub heartbeat_interval: Duration,
    /// Silence after which the peer is reported dead via
    /// [`crate::TransportEvent::PeerTimeout`].
    pub heartbeat_timeout: Duration,
    /// Budget for TCP connect and for each side of the token handshake.
    pub handshake_timeout: Duration,
    /// Scratch read size per `read()` call on the pump.
    pub read_chunk_bytes: usize,
}

impl Default for TransportConfig {
    fn default() -> Self {
        Self {
            max_frame_bytes: astra_proto::MAX_FRAME_BYTES,
            outbound_capacity: 128,
            inbound_capacity: 128,
            heartbeat_interval: Duration::from_secs(5),
            heartbeat_timeout: Duration::from_secs(15),
            handshake_timeout: Duration::from_secs(10),
            read_chunk_bytes: 8 * 1024,
        }
    }
}

impl TransportConfig {
    /// Clamp `max_frame_bytes` to the codec hard limit.
    pub fn normalized(mut self) -> Self {
        self.max_frame_bytes = self.max_frame_bytes.clamp(1, astra_proto::MAX_FRAME_BYTES);
        self.outbound_capacity = self.outbound_capacity.max(1);
        self.inbound_capacity = self.inbound_capacity.max(1);
        self.read_chunk_bytes = self.read_chunk_bytes.max(1);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_to_codec_limit() {
        let cfg = TransportConfig {
            max_frame_bytes: usize::MAX,
            ..TransportConfig::default()
        }
        .normalized();
        assert_eq!(cfg.max_frame_bytes, astra_proto::MAX_FRAME_BYTES);
    }
}

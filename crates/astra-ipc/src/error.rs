/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Transport error taxonomy.

/// Alias for transport fallible results.
pub type TransportResult<T> = Result<T, TransportError>;

/// Every failure mode the transport surfaces.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// Frame length prefix exceeds the configured maximum (DoS guard).
    #[error("frame of {0} bytes exceeds limit of {1} bytes")]
    FrameTooLarge(usize, usize),
    /// Outbound queue full on a non-blocking send.
    #[error("outbound queue full (backpressure)")]
    Backpressure,
    /// Peer silent for longer than `heartbeat_timeout`.
    #[error("peer silent for {0:?}")]
    PeerTimeout(std::time::Duration),
    /// Auth handshake rejected (wrong or missing token).
    #[error("handshake rejected: {0}")]
    AuthRejected(String),
    /// Protocol-level envelope error from `astra-proto`.
    #[error("protocol {code}: {message}")]
    Protocol { code: String, message: String },
    /// Underlying I/O failure (includes EOF / peer shutdown).
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// JSON serialization of an outbound envelope failed.
    #[error("encode: {0}")]
    Encode(#[from] serde_json::Error),
    /// The transport was closed while the operation was pending.
    #[error("transport closed")]
    Closed,
}

impl From<astra_proto::ProtoError> for TransportError {
    fn from(err: astra_proto::ProtoError) -> Self {
        Self::Protocol {
            code: err.code,
            message: err.message,
        }
    }
}

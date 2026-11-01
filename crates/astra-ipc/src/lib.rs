/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-ipc` (P2-T03): transport for the core/browser IPC link.
//!
//! The wire format is owned by `astra-proto` (plan Appendix C): 4-byte
//! big-endian length + UTF-8 JSON [`Envelope`][astra_proto::Envelope]. This
//! crate never reimplements framing; the read pump accumulates bytes and
//! delegates to [`astra_proto::decode_frame`], and the write pump delegates
//! to [`astra_proto::encode_frame`].
//!
//! What this crate adds on top of the codec:
//! * [`Transport`]: an async read/write pump over any
//!   `AsyncRead + AsyncWrite` stream (child stdio pipes per D-31, or loopback
//!   TCP via [`loopback`] for tests and as the documented fallback).
//! * Backpressure: bounded outbound/inbound queues ([`TransportConfig`]).
//!   [`Transport::send`] waits when full; [`Transport::try_send`] fails fast
//!   with [`TransportError::Backpressure`].
//! * Heartbeats: a periodic `astra:transport/heartbeat` event plus a
//!   silence watchdog that surfaces [`TransportEvent::PeerTimeout`].
//! * Auth: stdio relies on OS pipe identity (no secret, per U-01); loopback
//!   TCP requires a per-launch token handshake ([`auth`]).
//! * Crash recovery both directions: [`SeqTracker`] detects `event_seq` gaps
//!   (§5.4) and [`EventRecorder`] replays missed events after reconnect.
//!
//! Transport-internal envelope names live under `astra:transport/` so they
//! can never collide with the registered command/event surface.

pub mod auth;
pub mod config;
pub mod error;
pub mod loopback;
pub mod resync;
pub mod transport;

pub use auth::{generate_token, handshake_envelope, verify_handshake, AUTH_HANDSHAKE_NAME};
pub use config::TransportConfig;
pub use error::{TransportError, TransportResult};
pub use resync::{EventRecorder, ResyncAction, SeqTracker, RESYNC_REQUEST_NAME};
pub use transport::{Transport, TransportEvent};

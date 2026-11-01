# `astra-ipc` (P2-T03)

Transport for the Astra core/browser IPC link.

- Wire format: Appendix C frames (4-byte big-endian length + UTF-8 JSON),
  owned by `astra-proto`. This crate reuses `encode_frame` / `decode_frame`
  and never duplicates framing.
- `Transport`: async read/write pump over any `AsyncRead + AsyncWrite`
  stream — child stdio pipes (primary, D-31) via `spawn_split`, loopback TCP
  (tests + documented fallback) via `loopback::{accept, connect}`.
- Backpressure: bounded outbound/inbound queues (`TransportConfig`).
  `send` waits when full; `try_send` fails fast with `Backpressure`.
- Heartbeats: periodic `astra:transport/heartbeat` events plus a silence
  watchdog surfacing `TransportEvent::PeerTimeout`.
- Auth: stdio relies on OS pipe identity (no secret, U-01); loopback TCP
  requires a per-launch token handshake (`auth`, plan §5.5).
- Crash recovery both directions (§5.4): `SeqTracker` detects `event_seq`
  gaps, `EventRecorder` replays missed events, resync envelope builders
  open every reconnect.

Tests: unit tests per module plus `tests/chaos.rs` — kill core/browser at
random (but seeded, reproducible) points over loopback, kill/ respawn a real
child (`cat`) over stdio pipes, and a split-halves stdio-shape check.

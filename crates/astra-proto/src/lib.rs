/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-proto` (P2-T02): versioned JSON protocol for the core/browser IPC.
//!
//! Wire format (plan Appendix C): each frame is a 4-byte big-endian length
//! followed by UTF-8 JSON. The JSON body is an [`Envelope`] with `v`
//! (protocol version), `id`, `kind` (`req` / `res` / `evt`), `name`,
//! `seq` (events only), `payload`, and optional `error`.
//!
//! Semantics, enforced here and mirrored in `gen/astra-proto.ts`:
//! * unknown fields are **ignored** (serde's default: no
//!   `deny_unknown_fields`), so either side can add fields freely;
//! * an unknown protocol version **fails fast** via [`check_version`];
//! * command/event names are the generated [`CommandName`] / [`EventChannel`]
//!   registries in [`generated`] (270 commands + 35 events from
//!   `docs/astra/ipc-surface.md` via `schemas/*.json`).

pub mod generated;

pub use generated::CommandName;
pub use generated::{EventChannel, COMMANDS, COMMAND_COUNT, EVENTS, EVENT_COUNT};

use serde::{Deserialize, Serialize};

/// Protocol version. Bump only with a migration plan; mismatches fail fast.
pub const PROTOCOL_VERSION: u32 = 1;

/// Maximum accepted frame body, in bytes (DoS guard, P2-T03 owns tuning).
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Envelope direction / role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Req,
    Res,
    Evt,
}

/// Machine-readable protocol error carried on `res` envelopes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtoError {
    pub code: String,
    pub message: String,
}

/// Appendix C envelope. Unknown JSON fields are ignored on receipt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    pub id: String,
    pub kind: Kind,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtoError>,
}

/// Fail-fast version gate: accept only [`PROTOCOL_VERSION`].
pub fn check_version(env: &Envelope) -> Result<(), ProtoError> {
    if env.v != PROTOCOL_VERSION {
        return Err(ProtoError {
            code: "version_mismatch".to_string(),
            message: format!(
                "unsupported protocol version {} (want {})",
                env.v, PROTOCOL_VERSION
            ),
        });
    }
    Ok(())
}

/// Parse one envelope from a JSON body string, applying the version gate.
/// Unknown fields are ignored; wrong versions or malformed bodies error.
pub fn parse_envelope(text: &str) -> Result<Envelope, ProtoError> {
    let env: Envelope = serde_json::from_str(text).map_err(|e| ProtoError {
        code: "bad_envelope".to_string(),
        message: e.to_string(),
    })?;
    check_version(&env)?;
    Ok(env)
}

/// Encode one frame: 4-byte big-endian length + UTF-8 JSON body.
pub fn encode_frame(env: &Envelope) -> Vec<u8> {
    let body = serde_json::to_vec(env).expect("envelope serializes");
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// Decode one frame from the front of `buf`, advancing it past the frame.
/// Returns `Ok(None)` when fewer than a full frame is buffered.
pub fn decode_frame(buf: &mut Vec<u8>) -> Result<Option<Envelope>, ProtoError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(ProtoError {
            code: "frame_too_large".to_string(),
            message: format!("frame of {len} bytes exceeds {MAX_FRAME_BYTES}"),
        });
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let body = buf[4..4 + len].to_vec();
    buf.drain(..4 + len);
    let text = String::from_utf8(body).map_err(|e| ProtoError {
        code: "bad_encoding".to_string(),
        message: e.to_string(),
    })?;
    parse_envelope(&text).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> Envelope {
        Envelope {
            v: PROTOCOL_VERSION,
            id: "req-1".to_string(),
            kind: Kind::Req,
            name: "tabs_navigate".to_string(),
            seq: None,
            payload: serde_json::json!({"id": "tab-1", "input": "https://example.invalid/"}),
            error: None,
        }
    }

    #[test]
    fn frame_round_trip() {
        let env = req();
        let frame = encode_frame(&env);
        let mut buf = frame.clone();
        let back = decode_frame(&mut buf).unwrap().unwrap();
        assert_eq!(back, env);
        assert!(buf.is_empty());
        // Partial frame buffers without consuming.
        let mut partial = frame[..frame.len() - 1].to_vec();
        assert!(decode_frame(&mut partial).unwrap().is_none());
        assert_eq!(partial.len(), frame.len() - 1);
    }

    #[test]
    fn frame_too_large_fails_fast() {
        let mut buf = vec![0xFF, 0xFF, 0xFF, 0xFF];
        let err = decode_frame(&mut buf).unwrap_err();
        assert_eq!(err.code, "frame_too_large");
    }

    #[test]
    fn unknown_fields_ignored() {
        let text = r#"{"v":1,"id":"a","kind":"req","name":"tabs_navigate",
            "payload":{},"future_field":"x","nested":{"a":[1]}}"#;
        let env = parse_envelope(text).unwrap();
        assert_eq!(env.name, "tabs_navigate");
    }

    #[test]
    fn version_mismatch_fails_fast() {
        let text = r#"{"v":999,"id":"a","kind":"req","name":"tabs_navigate","payload":{}}"#;
        let err = parse_envelope(text).unwrap_err();
        assert_eq!(err.code, "version_mismatch");
    }

    #[test]
    fn malformed_body_errors() {
        let err = parse_envelope("{not json").unwrap_err();
        assert_eq!(err.code, "bad_envelope");
    }

    #[test]
    fn registry_counts_match_surface() {
        assert_eq!(COMMANDS.len(), COMMAND_COUNT);
        assert_eq!(EVENTS.len(), EVENT_COUNT);
        assert_eq!(COMMAND_COUNT, 270);
        assert_eq!(EVENT_COUNT, 35);
        assert!(COMMANDS.contains(&"tabs_navigate"));
        assert!(EVENTS.contains(&"tab-changed"));
        // Renamed channels carry the new prefix, never the old one.
        assert!(EVENTS.contains(&"astra:account-changed"));
        assert!(!EVENTS.iter().any(|e| e.starts_with("prev:")));
        assert_eq!(
            CommandName::from_name("tabs_navigate"),
            Some(CommandName::TabsNavigate)
        );
        assert_eq!(CommandName::from_name("nope"), None);
    }
}

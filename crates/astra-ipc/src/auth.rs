/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Loopback auth (P2-T03): stdio relies on OS pipe identity and needs no
//! secret (U-01); loopback TCP — the documented D-31 fallback — requires a
//! per-launch token handshake as the first frame in each direction.

use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};

/// Envelope name of the token handshake (`kind = req`).
pub const AUTH_HANDSHAKE_NAME: &str = "astra:transport/auth";

/// Generate a fresh 256-bit hex token from OS randomness.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_ok() {
        return hex_encode(&bytes);
    }
    // Fallback only (should not happen on supported targets): mix
    // time, process id, and a counter so two launches never share a token.
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut mixed = [0u8; 32];
    let mut x: u128 = t ^ ((std::process::id() as u128) << 64) ^ (n as u128);
    // xorshift128 mixing.
    for chunk in mixed.chunks_mut(8) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        chunk.copy_from_slice(&(x as u64).to_le_bytes());
    }
    hex_encode(&mixed)
}

/// Build the handshake envelope carrying `token`.
pub fn handshake_envelope(id: &str, token: &str) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        kind: Kind::Req,
        name: AUTH_HANDSHAKE_NAME.to_string(),
        seq: None,
        payload: serde_json::json!({ "token": token }),
        error: None,
    }
}

/// Verify a received handshake against the expected token.
/// Uses constant-time comparison so tokens cannot be probed byte-by-byte.
pub fn verify_handshake(env: &Envelope, expected: &str) -> Result<(), crate::TransportError> {
    if env.kind != Kind::Req || env.name != AUTH_HANDSHAKE_NAME {
        return Err(crate::TransportError::AuthRejected(format!(
            "expected handshake '{}', got '{}'",
            AUTH_HANDSHAKE_NAME, env.name
        )));
    }
    let got = env
        .payload
        .get("token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if constant_time_eq(got.as_bytes(), expected.as_bytes()) {
        Ok(())
    } else {
        Err(crate::TransportError::AuthRejected(
            "token mismatch".to_string(),
        ))
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0 && !a.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_round_trip() {
        let token = generate_token();
        assert_eq!(token.len(), 64);
        let env = handshake_envelope("hs-1", &token);
        verify_handshake(&env, &token).unwrap();
    }

    #[test]
    fn tokens_unique() {
        assert_ne!(generate_token(), generate_token());
    }

    #[test]
    fn wrong_token_rejected() {
        let env = handshake_envelope("hs-1", "wrong");
        let err = verify_handshake(&env, &generate_token()).unwrap_err();
        assert!(matches!(err, crate::TransportError::AuthRejected(_)));
    }

    #[test]
    fn non_handshake_envelope_rejected() {
        let env = Envelope {
            v: PROTOCOL_VERSION,
            id: "x".to_string(),
            kind: Kind::Evt,
            name: "tabs.created".to_string(),
            seq: Some(1),
            payload: serde_json::json!({}),
            error: None,
        };
        assert!(verify_handshake(&env, "anything").is_err());
    }
}

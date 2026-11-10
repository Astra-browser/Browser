// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! HMAC-SHA256 (RFC 2104) for the vault KDF.
//!
//! NSS's PKCS#11 HMAC imports a key and creates a context per call, which made
//! a 600k-iteration PBKDF2 take ~1.8 s. The pure `sha2` compression function
//! is constant-time for a fixed-length message and runs the same derivation in
//! a few hundred milliseconds; the AEAD/MAC primitives of the seal itself stay
//! on NSS.

use sha2::{Digest, Sha256};

const BLOCK: usize = 64;

pub(crate) fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    let out = outer.finalize();
    let mut result = [0u8; 32];
    result.copy_from_slice(&out);
    result
}

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

use crate::vault::VaultError;
use crate::{MAX_PIN_LEN, MIN_PIN_LEN};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// The leftmost 16 bytes of `SHA-256(PIN)`.
///
/// This is exactly the value CTAP2 puts in `pinHashEnc`, which is why the
/// WebAuthn PIN path and the Settings path derive the same vault key without
/// either one handling the plaintext PIN more than once.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct PinHash([u8; 16]);

impl PinHash {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        if bytes.len() != 16 {
            return Err(VaultError::Invalid);
        }
        let mut out = [0u8; 16];
        out.copy_from_slice(bytes);
        Ok(Self(out))
    }

    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

impl std::fmt::Debug for PinHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PinHash(<redacted>)")
    }
}

/// Validate the PIN policy and return the CTAP2 PIN hash.
pub fn hash_pin(pin: &str) -> Result<PinHash, VaultError> {
    let len = pin.as_bytes().len();
    if !(MIN_PIN_LEN..=MAX_PIN_LEN).contains(&len) {
        return Err(VaultError::PinPolicy);
    }
    Ok(pin_hash_unchecked(pin))
}

pub(crate) fn pin_hash_unchecked(pin: &str) -> PinHash {
    let digest = Sha256::digest(pin.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    PinHash(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctap2_pin_hash_is_left_half_of_sha256() {
        // The first 16 bytes of SHA-256("123456").
        assert_eq!(
            hash_pin("123456").unwrap().as_bytes(),
            &[0x8d, 0x96, 0x9e, 0xef, 0x6e, 0xca, 0xd3, 0xc2, 0x9a, 0x3a, 0x62, 0x92, 0x80, 0xe6, 0x86, 0xcf]
        );
    }

    #[test]
    fn policy_rejects_short_and_absurd_pins() {
        assert_eq!(hash_pin("12345").unwrap_err(), VaultError::PinPolicy);
        assert_eq!(hash_pin(&"1".repeat(64)).unwrap_err(), VaultError::PinPolicy);
    }
}

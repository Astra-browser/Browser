// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Authenticated encryption for the vault.
//!
//! AES-256-CBC (NSS) with a random IV, then HMAC-SHA256 over
//! `version || iv || ciphertext` (encrypt-then-MAC). The MAC is checked in
//! constant time before any decryption, so a tampered blob never reaches the
//! CBC parser. Subkeys are derived from one 32-byte key with HMAC under
//! distinct labels.

use crate::ct;
use crate::vault::VaultError;

pub(crate) const IV_LEN: usize = 16;
pub(crate) const TAG_LEN: usize = 32;
pub(crate) const KEY_LEN: usize = 32;

const FORMAT_VERSION: u8 = 1;
const LABEL_ENC: &[u8] = b"astra-passkeys/seal/enc/v1";
const LABEL_MAC: &[u8] = b"astra-passkeys/seal/mac/v1";

/// Cryptographic primitives the vault needs. The browser build uses NSS;
/// unit tests substitute a portable implementation so the vault state machine
/// can be exercised without a running NSS.
pub trait Seal: Send + Sync {
    fn random(&self, len: usize) -> Result<Vec<u8>, VaultError>;
    fn hmac_sha256(&self, key: &[u8], data: &[u8]) -> Result<Vec<u8>, VaultError>;
    fn aes_cbc_encrypt(
        &self,
        key: &[u8],
        iv: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, VaultError>;
    fn aes_cbc_decrypt(
        &self,
        key: &[u8],
        iv: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, VaultError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed {
    pub iv: [u8; IV_LEN],
    pub ciphertext: Vec<u8>,
    pub tag: [u8; TAG_LEN],
}

fn subkeys(seal: &dyn Seal, key: &[u8]) -> Result<([u8; KEY_LEN], [u8; KEY_LEN]), VaultError> {
    if key.len() != KEY_LEN {
        return Err(VaultError::Crypto);
    }
    let enc = seal.hmac_sha256(key, LABEL_ENC)?;
    let mac = seal.hmac_sha256(key, LABEL_MAC)?;
    let mut enc_key = [0u8; KEY_LEN];
    let mut mac_key = [0u8; KEY_LEN];
    enc_key.copy_from_slice(&enc[..KEY_LEN]);
    mac_key.copy_from_slice(&mac[..KEY_LEN]);
    Ok((enc_key, mac_key))
}

fn mac_input(iv: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + iv.len() + ciphertext.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(iv);
    out.extend_from_slice(ciphertext);
    out
}

fn pkcs7_pad(data: &[u8]) -> Vec<u8> {
    let pad = IV_LEN - (data.len() % IV_LEN);
    let mut out = Vec::with_capacity(data.len() + pad);
    out.extend_from_slice(data);
    out.extend(std::iter::repeat(pad as u8).take(pad));
    out
}

fn pkcs7_unpad(mut data: Vec<u8>) -> Result<Vec<u8>, VaultError> {
    let Some(&pad) = data.last() else {
        return Err(VaultError::Crypto);
    };
    let pad = pad as usize;
    if pad == 0 || pad > IV_LEN || pad > data.len() {
        return Err(VaultError::Crypto);
    }
    let keep = data.len() - pad;
    if !data[keep..].iter().all(|b| *b == pad as u8) {
        return Err(VaultError::Crypto);
    }
    data.truncate(keep);
    Ok(data)
}

impl Sealed {
    pub fn seal(seal: &dyn Seal, key: &[u8], plaintext: &[u8]) -> Result<Self, VaultError> {
        let (enc_key, mac_key) = subkeys(seal, key)?;
        let iv_vec = seal.random(IV_LEN)?;
        let mut iv = [0u8; IV_LEN];
        iv.copy_from_slice(&iv_vec);
        let padded = pkcs7_pad(plaintext);
        let ciphertext = seal.aes_cbc_encrypt(&enc_key, &iv, &padded)?;
        let tag_vec = seal.hmac_sha256(&mac_key, &mac_input(&iv, &ciphertext))?;
        let mut tag = [0u8; TAG_LEN];
        tag.copy_from_slice(&tag_vec[..TAG_LEN]);
        Ok(Self {
            iv,
            ciphertext,
            tag,
        })
    }

    pub fn open(&self, seal: &dyn Seal, key: &[u8]) -> Result<Vec<u8>, VaultError> {
        let (enc_key, mac_key) = subkeys(seal, key)?;
        let expected = seal.hmac_sha256(&mac_key, &mac_input(&self.iv, &self.ciphertext))?;
        if !ct::eq(&expected[..TAG_LEN], &self.tag) {
            return Err(VaultError::AuthFailed);
        }
        let padded = seal.aes_cbc_decrypt(&enc_key, &self.iv, &self.ciphertext)?;
        pkcs7_unpad(padded)
    }
}

#[cfg(test)]
pub(crate) struct TestSeal;

#[cfg(test)]
impl Seal for TestSeal {
    fn random(&self, len: usize) -> Result<Vec<u8>, VaultError> {
        use rand::RngCore;
        let mut out = vec![0u8; len];
        rand::thread_rng().fill_bytes(&mut out);
        Ok(out)
    }

    fn hmac_sha256(&self, key: &[u8], data: &[u8]) -> Result<Vec<u8>, VaultError> {
        use sha2::{Digest, Sha256};
        const BLOCK: usize = 64;
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
        let mut outer = Sha256::new();
        outer.update(opad);
        outer.update(inner.finalize());
        Ok(outer.finalize().to_vec())
    }

    // Reversible stand-in for AES: XOR with an HMAC-SHA256 keystream. Only the
    // seal framing (padding, MAC-before-decrypt, truncation) is under test.
    fn aes_cbc_encrypt(
        &self,
        key: &[u8],
        iv: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, VaultError> {
        let mut out = Vec::with_capacity(data.len());
        let mut counter = 0u32;
        while out.len() < data.len() {
            let mut block_input = Vec::with_capacity(iv.len() + 4);
            block_input.extend_from_slice(iv);
            block_input.extend_from_slice(&counter.to_be_bytes());
            let block = self.hmac_sha256(key, &block_input)?;
            out.extend_from_slice(&block);
            counter += 1;
        }
        Ok(out
            .iter()
            .zip(data.iter())
            .map(|(k, d)| k ^ d)
            .collect())
    }

    fn aes_cbc_decrypt(
        &self,
        key: &[u8],
        iv: &[u8],
        data: &[u8],
    ) -> Result<Vec<u8>, VaultError> {
        self.aes_cbc_encrypt(key, iv, data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper_rejection() {
        let seal = TestSeal;
        let key = [7u8; KEY_LEN];
        let sealed = Sealed::seal(&seal, &key, b"hello passkey").unwrap();
        assert_eq!(sealed.open(&seal, &key).unwrap(), b"hello passkey");

        let mut broken = sealed.clone();
        broken.ciphertext[0] ^= 1;
        assert_eq!(broken.open(&seal, &key), Err(VaultError::AuthFailed));

        let mut broken = sealed;
        broken.tag[0] ^= 1;
        assert_eq!(broken.open(&seal, &key), Err(VaultError::AuthFailed));
    }

    #[test]
    fn wrong_key_is_an_auth_failure_not_a_panic() {
        let seal = TestSeal;
        let sealed = Sealed::seal(&seal, &[1u8; KEY_LEN], b"secret").unwrap();
        assert_eq!(
            sealed.open(&seal, &[2u8; KEY_LEN]),
            Err(VaultError::AuthFailed)
        );
    }
}

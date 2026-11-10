// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! PBKDF2-HMAC-SHA256 (RFC 8018). The HMAC is injected so the browser build
//! uses NSS and the unit tests use a portable implementation.

use crate::vault::VaultError;

pub(crate) type Hmac<'a> =
    &'a dyn Fn(&[u8], &[u8]) -> Result<Vec<u8>, VaultError>;

const DIGEST: usize = 32;

pub(crate) fn pbkdf2(
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    out_len: usize,
    hmac: Hmac<'_>,
) -> Result<Vec<u8>, VaultError> {
    if iterations == 0 || out_len == 0 || out_len > 4096 {
        return Err(VaultError::Crypto);
    }
    let mut out = Vec::with_capacity(out_len);
    let blocks = out_len.div_ceil(DIGEST);
    for block in 1..=blocks {
        let mut input = Vec::with_capacity(salt.len() + 4);
        input.extend_from_slice(salt);
        input.extend_from_slice(&(block as u32).to_be_bytes());
        let mut u = hmac(password, &input)?;
        let mut t = u.clone();
        for _ in 1..iterations {
            u = hmac(password, &u)?;
            for (a, b) in t.iter_mut().zip(u.iter()) {
                *a ^= b;
            }
        }
        out.extend_from_slice(&t);
    }
    out.truncate(out_len);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultError;
    use sha2::{Digest, Sha256};

    fn test_hmac(key: &[u8], data: &[u8]) -> Result<Vec<u8>, VaultError> {
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

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn rfc6070_sha256_vectors() {
        assert_eq!(
            hex(&pbkdf2(b"password", b"salt", 1, 32, &test_hmac).unwrap()),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex(&pbkdf2(b"password", b"salt", 2, 32, &test_hmac).unwrap()),
            "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"
        );
        assert_eq!(
            hex(&pbkdf2(b"password", b"salt", 4096, 32, &test_hmac).unwrap()),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    #[test]
    fn derives_more_than_one_block() {
        let out = pbkdf2(b"password", b"salt", 1, 48, &test_hmac).unwrap();
        assert_eq!(out.len(), 48);
        assert_eq!(
            hex(&out[..32]),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! CRX3 container parsing and signature verification.
//!
//! Layout (Chromium `components/crx_file/crx3.proto`):
//!
//! ```text
//! "Cr24" | u32le version=3 | u32le header_len | CrxFileHeader | ZIP
//! ```
//!
//! `CrxFileHeader` is a protobuf message:
//! - field 2  repeated AsymmetricKeyProof sha256_with_rsa
//! - field 3  repeated AsymmetricKeyProof sha256_with_ecdsa
//! - field 10000 bytes signed_header_data
//!
//! `AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }`
//! `SignedData { bytes crx_id = 1; }` (`crx_id` is the first 16 bytes of
//! SHA-256 over the DER SubjectPublicKeyInfo of the publisher key).
//!
//! The signature covers:
//!
//! ```text
//! "CRX3 SignedData\0" | u32le len(signed_header_data) | signed_header_data | zip
//! ```
//!
//! The ZIP digest is therefore covered by the signature; a package whose ZIP
//! was altered after signing cannot verify.

use ring::digest;
use ring::signature::{UnparsedPublicKey, RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY};

use crate::types::SignatureStatus;

const MAGIC: &[u8; 4] = b"Cr24";
const SIGNATURE_CONTEXT: &[u8] = b"CRX3 SignedData\x00";
const MAX_HEADER: usize = 1 << 20;
const MAX_PACKAGE: usize = 96 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CrxError {
    #[error("not a CRX container")]
    NotCrx,
    #[error("CRX is larger than the {MAX_PACKAGE}-byte limit")]
    TooLarge,
    #[error("CRX header is malformed: {0}")]
    Header(String),
    #[error("CRX version {0} is not supported")]
    Version(u32),
    #[error("CRX3 has no RSA proof")]
    NoRsaProof,
    #[error("CRX signature did not verify")]
    BadSignature,
    #[error("CRX public key is not a DER RSA key")]
    BadPublicKey,
    #[error("CRX signed data is malformed")]
    BadSignedData,
    #[error("CRX publisher id does not match the signing key")]
    IdMismatch,
}

/// A parsed container. `package` borrows the original bytes so a 90 MB CRX is
/// not copied; the caller owns the buffer.
#[derive(Debug)]
pub struct Crx<'a> {
    pub zip: &'a [u8],
    /// DER SubjectPublicKeyInfo of the verified publisher key.
    pub public_key: Vec<u8>,
    /// 16-byte Chrome publisher id.
    pub id_bytes: [u8; 16],
    pub header_len: usize,
}

impl<'a> Crx<'a> {
    pub fn is_crx(bytes: &[u8]) -> bool {
        bytes.len() >= 4 && &bytes[..4] == MAGIC
    }

    /// Parse and verify. Any failure is a refusal: an unverified CRX is never
    /// reported as signed.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, CrxError> {
        if !Self::is_crx(bytes) {
            return Err(CrxError::NotCrx);
        }
        if bytes.len() > MAX_PACKAGE {
            return Err(CrxError::TooLarge);
        }
        if bytes.len() < 12 {
            return Err(CrxError::Header("truncated prefix".into()));
        }
        let version = u32::from_le_bytes(bytes[4..8].try_into().expect("4 bytes"));
        match version {
            3 => Self::parse_v3(bytes),
            2 => Err(CrxError::Version(2)),
            other => Err(CrxError::Version(other)),
        }
    }

    fn parse_v3(bytes: &'a [u8]) -> Result<Self, CrxError> {
        let header_len = u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes")) as usize;
        if header_len == 0 || header_len > MAX_HEADER || 12 + header_len > bytes.len() {
            return Err(CrxError::Header("bad header length".into()));
        }
        let header = &bytes[12..12 + header_len];
        let zip = &bytes[12 + header_len..];
        if zip.is_empty() {
            return Err(CrxError::Header("no ZIP payload".into()));
        }

        let parsed = parse_header(header)?;
        let signed_header_data = parsed
            .signed_header_data
            .ok_or_else(|| CrxError::Header("no signed_header_data".into()))?;
        let expected_id = parse_signed_data(&signed_header_data)?;

        let mut message =
            Vec::with_capacity(SIGNATURE_CONTEXT.len() + 4 + signed_header_data.len() + zip.len());
        message.extend_from_slice(SIGNATURE_CONTEXT);
        message.extend_from_slice(&(signed_header_data.len() as u32).to_le_bytes());
        message.extend_from_slice(&signed_header_data);
        message.extend_from_slice(zip);

        let mut verified: Option<(Vec<u8>, [u8; 16])> = None;
        for proof in &parsed.rsa_proofs {
            let Some(pkcs1) = spki_to_pkcs1(&proof.public_key) else {
                continue;
            };
            // Chrome still serves legacy 1024-bit publisher keys (for example
            // Tampermonkey). Verification-only; Astra never signs with this.
            let key =
                UnparsedPublicKey::new(&RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY, pkcs1);
            if key.verify(&message, &proof.signature).is_err() {
                continue;
            }
            let id = publisher_id(&proof.public_key);
            // The signed header names the publisher. A proof from another key
            // (a CRX3 "secondary" proof) is not the package identity.
            if let Some(expected) = expected_id {
                if expected != id {
                    continue;
                }
            }
            verified = Some((proof.public_key.clone(), id));
            break;
        }

        let (public_key, id_bytes) = verified.ok_or(CrxError::BadSignature)?;
        Ok(Self {
            zip,
            public_key,
            id_bytes,
            header_len,
        })
    }

    /// Chrome's 32-character id: each nibble of the first 16 SHA-256 bytes
    /// mapped from 0..=15 to 'a'..='p'.
    pub fn extension_id(&self) -> String {
        chrome_id(&self.id_bytes)
    }

    pub fn signature_status(&self) -> SignatureStatus {
        SignatureStatus::Verified
    }
}

#[derive(Debug, Default)]
struct Header {
    rsa_proofs: Vec<Proof>,
    signed_header_data: Option<Vec<u8>>,
}

#[derive(Debug)]
struct Proof {
    public_key: Vec<u8>,
    signature: Vec<u8>,
}

fn parse_header(mut buf: &[u8]) -> Result<Header, CrxError> {
    let mut out = Header::default();
    while !buf.is_empty() {
        let (key, wire, rest) = read_key(buf)?;
        buf = rest;
        match (key, wire) {
            (2, 2) => {
                let (len, rest) = read_varint(buf)?;
                let len = usize::try_from(len).map_err(|_| CrxError::Header("length".into()))?;
                if len > rest.len() {
                    return Err(CrxError::Header("proof overruns header".into()));
                }
                let (body, rest) = rest.split_at(len);
                if let Some(proof) = parse_proof(body)? {
                    out.rsa_proofs.push(proof);
                }
                buf = rest;
            }
            (3, 2) => {
                // ECDSA proofs are parsed for shape but not accepted: Chrome's
                // published extensions use RSA. Skipping is explicit, not a
                // silent pass.
                let (len, rest) = read_varint(buf)?;
                let len = usize::try_from(len).map_err(|_| CrxError::Header("length".into()))?;
                if len > rest.len() {
                    return Err(CrxError::Header("proof overruns header".into()));
                }
                buf = &rest[len..];
            }
            (10000, 2) => {
                let (len, rest) = read_varint(buf)?;
                let len = usize::try_from(len).map_err(|_| CrxError::Header("length".into()))?;
                if len > rest.len() {
                    return Err(CrxError::Header("signed data overruns header".into()));
                }
                out.signed_header_data = Some(rest[..len].to_vec());
                buf = &rest[len..];
            }
            (_, 0) => {
                let (_, rest) = read_varint(buf)?;
                buf = rest;
            }
            (_, 1) => {
                if buf.len() < 8 {
                    return Err(CrxError::Header("fixed64 overrun".into()));
                }
                buf = &buf[8..];
            }
            (_, 2) => {
                let (len, rest) = read_varint(buf)?;
                let len = usize::try_from(len).map_err(|_| CrxError::Header("length".into()))?;
                if len > rest.len() {
                    return Err(CrxError::Header("field overruns header".into()));
                }
                buf = &rest[len..];
            }
            (_, 5) => {
                if buf.len() < 4 {
                    return Err(CrxError::Header("fixed32 overrun".into()));
                }
                buf = &buf[4..];
            }
            (_, other) => {
                return Err(CrxError::Header(format!("wire type {other}")));
            }
        }
    }
    Ok(out)
}

fn parse_proof(body: &[u8]) -> Result<Option<Proof>, CrxError> {
    let mut public_key = Vec::new();
    let mut signature = Vec::new();
    let mut buf = body;
    while !buf.is_empty() {
        let (key, wire, rest) = read_key(buf)?;
        buf = rest;
        if wire != 2 {
            return Err(CrxError::Header("proof field must be bytes".into()));
        }
        let (len, rest) = read_varint(buf)?;
        let len = usize::try_from(len).map_err(|_| CrxError::Header("length".into()))?;
        if len > rest.len() {
            return Err(CrxError::Header("proof field overruns".into()));
        }
        let (value, rest) = rest.split_at(len);
        buf = rest;
        match key {
            1 => public_key = value.to_vec(),
            2 => signature = value.to_vec(),
            _ => {}
        }
    }
    if public_key.is_empty() || signature.is_empty() {
        return Ok(None);
    }
    Ok(Some(Proof {
        public_key,
        signature,
    }))
}

fn parse_signed_data(body: &[u8]) -> Result<Option<[u8; 16]>, CrxError> {
    let mut buf = body;
    let mut crx_id = None;
    while !buf.is_empty() {
        let (key, wire, rest) = read_key(buf)?;
        buf = rest;
        if wire == 2 {
            let (len, rest) = read_varint(buf)?;
            let len = usize::try_from(len).map_err(|_| CrxError::BadSignedData)?;
            if len > rest.len() {
                return Err(CrxError::BadSignedData);
            }
            if key == 1 {
                if len != 16 {
                    return Err(CrxError::BadSignedData);
                }
                let mut id = [0u8; 16];
                id.copy_from_slice(&rest[..16]);
                crx_id = Some(id);
            }
            buf = &rest[len..];
        } else if wire == 0 {
            let (_, rest) = read_varint(buf)?;
            buf = rest;
        } else {
            return Err(CrxError::BadSignedData);
        }
    }
    Ok(crx_id)
}

fn read_key(mut buf: &[u8]) -> Result<(u32, u8, &[u8]), CrxError> {
    let (key, rest) = read_varint(buf)?;
    buf = rest;
    let wire = (key & 7) as u8;
    let field = (key >> 3) as u32;
    if field == 0 {
        return Err(CrxError::Header("field 0".into()));
    }
    Ok((field, wire, buf))
}

fn read_varint(buf: &[u8]) -> Result<(u64, &[u8]), CrxError> {
    let mut value = 0u64;
    for (i, byte) in buf.iter().take(10).enumerate() {
        value |= ((byte & 0x7f) as u64) << (7 * i);
        if byte & 0x80 == 0 {
            return Ok((value, &buf[i + 1..]));
        }
    }
    Err(CrxError::Header("varint".into()))
}

/// Extract the PKCS#1 `RSAPublicKey` DER from a SubjectPublicKeyInfo.
fn spki_to_pkcs1(spki: &[u8]) -> Option<&[u8]> {
    // SubjectPublicKeyInfo ::= SEQUENCE { algorithm AlgorithmIdentifier,
    //                                     subjectPublicKey BIT STRING }
    let (tag, body, _) = der_item(spki)?;
    if tag != 0x30 {
        return None;
    }
    let (alg_tag, alg_body, rest) = der_item(body)?;
    if alg_tag != 0x30 || alg_body.is_empty() {
        return None;
    }
    let (bits_tag, bits_body, _) = der_item(rest)?;
    if bits_tag != 0x03 || bits_body.len() < 2 || bits_body[0] != 0 {
        return None;
    }
    Some(&bits_body[1..])
}

/// One DER TLV: `(tag, body, remaining bytes after this item)`.
fn der_item(buf: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    if buf.len() < 2 {
        return None;
    }
    let tag = buf[0];
    let first = buf[1];
    let (len, offset) = if first & 0x80 == 0 {
        (first as usize, 2)
    } else {
        let n = (first & 0x7f) as usize;
        if n == 0 || n > 4 || buf.len() < 2 + n {
            return None;
        }
        let mut len = 0usize;
        for b in &buf[2..2 + n] {
            len = (len << 8) | *b as usize;
        }
        (len, 2 + n)
    };
    if len > buf.len().saturating_sub(offset) {
        return None;
    }
    let end = offset + len;
    Some((tag, &buf[offset..end], &buf[end..]))
}

fn publisher_id(public_key: &[u8]) -> [u8; 16] {
    let digest = digest::digest(&digest::SHA256, public_key);
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest.as_ref()[..16]);
    id
}

pub fn chrome_id(id_bytes: &[u8; 16]) -> String {
    let mut out = String::with_capacity(32);
    for byte in id_bytes {
        let hi = (byte >> 4) & 0x0f;
        let lo = byte & 0x0f;
        out.push((b'a' + hi) as char);
        out.push((b'a' + lo) as char);
    }
    out
}

/// Decode a standard base64 manifest `key` so an unpacked directory can keep
/// the identity its author declared.
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0u32;
    for ch in input.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => continue,
            b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chrome_id_maps_nibbles_to_a_p() {
        assert_eq!(chrome_id(&[0x00; 16]), "a".repeat(32));
        assert_eq!(chrome_id(&[0xff; 16]), "p".repeat(32));
        let mut id = [0u8; 16];
        id[0] = 0x01;
        id[1] = 0x23;
        assert!(chrome_id(&id).starts_with("abcd"));
    }

    #[test]
    fn base64_decodes_the_manifest_key_alphabet() {
        assert_eq!(decode_base64("YQ=="), Some(b"a".to_vec()));
        assert_eq!(decode_base64("YWJj"), Some(b"abc".to_vec()));
        assert_eq!(decode_base64("!!!!"), None);
    }

    #[test]
    fn rejects_a_non_crx() {
        assert_eq!(Crx::parse(b"PK\x03\x04").unwrap_err(), CrxError::NotCrx);
        assert_eq!(
            Crx::parse(b"Cr24").unwrap_err(),
            CrxError::Header("truncated prefix".into())
        );
    }

    #[test]
    fn rejects_crx2_explicitly() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"Cr24");
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 16]);
        assert_eq!(Crx::parse(&bytes).unwrap_err(), CrxError::Version(2));
    }

    #[test]
    fn a_tampered_zip_does_not_verify() {
        let bytes = crate::tests::fixture_crx();
        let crx = Crx::parse(&bytes).expect("fixture verifies");
        assert_eq!(crx.extension_id(), crate::tests::FIXTURE_ID);
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(matches!(Crx::parse(&tampered), Err(CrxError::BadSignature)));
    }
}

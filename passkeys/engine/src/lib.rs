// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Astra platform passkeys.
//!
//! A PIN-gated, encrypted credential vault for the in-tree WebAuthn
//! authenticator (`dom/webauthn/authrs_bridge`). The vault is the only place a
//! platform passkey private key lives; the authenticator asks this crate for
//! the key only while the vault is unlocked, and only for the RP that the
//! browser already validated.
//!
//! Trust boundaries:
//! - The vault file is the storage root. It is encrypted with AES-256-CBC and
//!   authenticated with HMAC-SHA256 (encrypt-then-MAC) using NSS primitives.
//! - The vault key is wrapped twice: under a PIN-derived key (always) and,
//!   optionally, under a random device key for the system-authentication
//!   unlock path.
//! - The PIN is never stored. The PIN wrapper is verified by unwrapping it:
//!   a wrong PIN fails the MAC, so the failure is indistinguishable from a
//!   corrupt file and cannot be used as an oracle by the caller.
//! - WebAuthn user verification transmits only the CTAP2 PIN hash
//!   (`SHA-256(PIN)[..16]`). The same 16 bytes derive the PIN wrapper key, so
//!   the protocol path and the settings path unlock the same vault without
//!   ever handling the PIN twice.

mod ct;
mod hmac;
mod pbkdf2;
mod pin;
mod seal;
mod system;
mod vault;

pub use pin::{hash_pin, PinHash};
pub use seal::{Seal, Sealed};
pub use system::{system_auth_available, verify_system_auth};
pub use vault::{
    CredentialSummary, NewCredential, StoredCredential, Vault, VaultError, VaultStatus,
};

/// The stable AAGUID every Astra platform passkey reports.
pub const AAGUID: [u8; 16] = [
    0x5a, 0x11, 0xd4, 0x1e, 0x7e, 0x6b, 0x4f, 0x0a, 0x9c, 0x2d, 0x8f, 0x33, 0x71, 0x0c, 0x6b, 0x9d,
];

pub(crate) const MIN_PIN_LEN: usize = 6;
pub const MIN_PIN_LENGTH_HINT: u8 = 6;
pub(crate) const MAX_PIN_LEN: usize = 63;
pub(crate) const DEFAULT_PIN_ITERATIONS: u32 = 600_000;
pub(crate) const DEVICE_KEY_ITERATIONS: u32 = 20_000;
pub(crate) const MAX_PIN_FAILURES: u32 = 5;
pub(crate) const LOCKOUT_BASE_SECS: u64 = 30;
pub(crate) const LOCKOUT_MAX_SECS: u64 = 300;

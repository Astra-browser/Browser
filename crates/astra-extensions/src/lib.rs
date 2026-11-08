/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Astra extension platform.
//!
//! Two layers live here:
//!
//! * [`gallery`] / [`manager`] — the curated AMO gallery and the pure
//!   install-state model (P4-T04). Unchanged.
//! * [`crx`], [`package`], [`manifest`], [`compat`], [`security`] and
//!   [`pipeline`] — the Chrome package intake. The engine (Gecko 153) owns
//!   installation, permission enforcement, process isolation, background
//!   execution and content-script injection through `AddonManager`. This
//!   crate owns what the engine does not do for a Chrome package:
//!
//!   - parse and verify a CRX3 container (signature over the signed header and
//!     the ZIP, extension id from the signing key);
//!   - unpack with bounded, traversal-safe extraction;
//!   - adapt Chrome-only manifest shapes to the shapes Gecko implements;
//!   - report exactly which APIs the package calls and whether this engine
//!     implements them;
//!   - scan for behaviour that can be malicious and return evidence, never a
//!     "malware" verdict;
//!   - write the adapted package as a deterministic XPI for `AddonManager`.
//!
//! The crate is pure: no chrome, no network, no profile access. `astra-core`
//! exposes it to the Host API over the sidecar protocol; the Host API performs
//! the `AddonManager` install, and only that path can install.

pub mod compat;
pub mod crx;
pub mod gallery;
pub mod manager;
pub mod manifest;
pub mod package;
pub mod pipeline;
pub mod security;
pub mod types;

pub use crx::{Crx, CrxError};
pub use gallery::{
    installable, load_gallery, validate, FirefoxMapping, GalleryDoc, GalleryEntry, MappingStatus,
};
pub use manager::{
    AccessMode, Decision, ExtensionManager, ExtensionRecord, ManagerError, PendingPermission,
};
pub use manifest::{Adaptation, ManifestKind, ParsedManifest};
pub use package::PackageError;
pub use pipeline::{inspect, stage, ExtensionsError};
pub use security::scan as scan_security;
pub use types::*;

#[cfg(test)]
mod tests;

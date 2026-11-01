/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-extensions` (P4-T04): the extension manager model plus the curated
//! gallery that maps the base snapshot's Chrome Web Store catalog to
//! Firefox/AMO equivalents (parity exception X-01).
//!
//! * [`gallery`] — machine-readable [`gallery.json`](../gallery.json) loader:
//!   one [`GalleryEntry`][gallery::GalleryEntry] per catalog id with its
//!   Firefox [`mapping`][gallery::FirefoxMapping] (`equivalent` /
//!   `alternative` / `none` + reason).
//! * [`manager`] — pure install-state model: install / enable / disable /
//!   uninstall / site access, plus a permission-prompt queue fed by the Host
//!   API `Dialogs` `permission.requested` events (P3-T09). The manager only
//!   **consumes** those event payloads and returns decisions for the caller
//!   to forward via `Dialogs.decidePermission`; it never resolves a dialog
//!   itself (read-only usage of the Dialogs module).

pub mod gallery;
pub mod manager;

pub use gallery::{
    installable, load_gallery, validate, FirefoxMapping, GalleryDoc, GalleryEntry, MappingStatus,
};
pub use manager::{
    AccessMode, Decision, ExtensionManager, ExtensionRecord, ManagerError, PendingPermission,
};

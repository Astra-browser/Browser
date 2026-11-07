/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Embedded EasyList/EasyPrivacy seed (CC BY-SA 3.0, see `blocker/seed/NOTICE`).
//!
//! The `.gz` assets are the unmodified upstream subscription texts; only the
//! storage representation (deterministic gzip) differs from upstream.

use crate::lists::ListSource;
use flate2::read::GzDecoder;
use std::io::Read;
use thiserror::Error;

/// Upstream version stamp of the embedded EasyList seed.
pub const SEED_EASYLIST_VERSION: &str = "202610281352";
/// Upstream version stamp of the embedded EasyPrivacy seed.
pub const SEED_EASYPRIVACY_VERSION: &str = "202610281345";

const EASYLIST_GZ: &[u8] = include_bytes!("../../../blocker/seed/easylist.txt.gz");
const EASYPRIVACY_GZ: &[u8] = include_bytes!("../../../blocker/seed/easyprivacy.txt.gz");

/// Seed load failures.
#[derive(Debug, Error)]
pub enum SeedError {
    /// A seed asset failed to decompress or is not valid filter text.
    #[error("seed '{0}' is corrupt: {1}")]
    Corrupt(&'static str, String),
}

/// Decompresses the embedded seed pair into [`ListSource`]s.
pub fn seed_lists() -> Result<Vec<ListSource>, SeedError> {
    Ok(vec![
        ListSource::new("easylist", gunzip("easylist", EASYLIST_GZ)?)
            .with_version(SEED_EASYLIST_VERSION),
        ListSource::new("easyprivacy", gunzip("easyprivacy", EASYPRIVACY_GZ)?)
            .with_version(SEED_EASYPRIVACY_VERSION),
    ])
}

fn gunzip(name: &'static str, bytes: &[u8]) -> Result<String, SeedError> {
    let mut text = String::new();
    GzDecoder::new(bytes)
        .read_to_string(&mut text)
        .map_err(|error| SeedError::Corrupt(name, error.to_string()))?;
    if text
        .lines()
        .next()
        .is_none_or(|line| line.trim().is_empty())
    {
        return Err(SeedError::Corrupt(name, "empty after decompression".into()));
    }
    Ok(text)
}

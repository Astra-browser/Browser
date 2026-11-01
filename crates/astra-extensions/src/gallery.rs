/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Curated gallery (P4-T04): the base catalog's Chrome Web Store ids mapped
//! to Firefox/AMO listings. Single source of truth is `gallery.json` next
//! to this crate; the UI keeps a mirrored copy with a drift test.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// How the Chrome original relates to Firefox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MappingStatus {
    /// Same (or same-vendor / same-function) extension on AMO.
    Equivalent,
    /// No same-vendor build; nearest substitute named in `slug`.
    Alternative,
    /// No Firefox equivalent; `note` carries the reason.
    None,
}

/// The Firefox side of one gallery entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirefoxMapping {
    pub status: MappingStatus,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub amo_url: Option<String>,
    pub note: String,
}

/// One mapped catalog entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GalleryEntry {
    pub chrome_store_id: String,
    pub name: String,
    pub category: String,
    pub firefox: FirefoxMapping,
}

/// Whole `gallery.json` document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GalleryDoc {
    pub version: u32,
    pub source: String,
    pub verified_on: String,
    pub verification: String,
    pub amo_base: String,
    pub entries: Vec<GalleryEntry>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GalleryError {
    #[error("gallery.json failed to parse: {0}")]
    Parse(String),
    #[error("gallery entry invalid: {0}")]
    Invalid(String),
}

/// Load and validate the bundled gallery.
pub fn load_gallery() -> Result<GalleryDoc, GalleryError> {
    let doc: GalleryDoc = serde_json::from_str(include_str!("../gallery.json"))
        .map_err(|e| GalleryError::Parse(e.to_string()))?;
    validate(&doc)?;
    Ok(doc)
}

/// Validate invariants shared with the UI drift test.
pub fn validate(doc: &GalleryDoc) -> Result<(), GalleryError> {
    if doc.entries.is_empty() {
        return Err(GalleryError::Invalid("no entries".to_string()));
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &doc.entries {
        if entry.chrome_store_id.len() != 32
            || !entry
                .chrome_store_id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return Err(GalleryError::Invalid(format!(
                "bad chrome id for {}",
                entry.name
            )));
        }
        if !ids.insert(entry.chrome_store_id.clone()) {
            return Err(GalleryError::Invalid(format!(
                "duplicate chrome id {}",
                entry.chrome_store_id
            )));
        }
        if entry.name.is_empty() || entry.category.is_empty() {
            return Err(GalleryError::Invalid(format!(
                "empty name/category for {}",
                entry.chrome_store_id
            )));
        }
        match entry.firefox.status {
            MappingStatus::Equivalent | MappingStatus::Alternative => {
                let slug = entry.firefox.slug.as_deref().unwrap_or("");
                let url = entry.firefox.amo_url.as_deref().unwrap_or("");
                if slug.is_empty() || url.is_empty() {
                    return Err(GalleryError::Invalid(format!(
                        "{} needs slug + amo_url",
                        entry.name
                    )));
                }
                let expected = format!("{}/", doc.amo_base.trim_end_matches('/'));
                if !url.starts_with(&expected) || !url.contains(slug) {
                    return Err(GalleryError::Invalid(format!(
                        "{} amo_url does not match slug",
                        entry.name
                    )));
                }
            }
            MappingStatus::None => {
                if entry.firefox.slug.is_some() || entry.firefox.amo_url.is_some() {
                    return Err(GalleryError::Invalid(format!(
                        "{} is none but has slug/url",
                        entry.name
                    )));
                }
            }
        }
        if entry.firefox.note.is_empty() {
            return Err(GalleryError::Invalid(format!(
                "{} needs a mapping note",
                entry.name
            )));
        }
    }
    Ok(())
}

/// Is this entry installable on Firefox (equivalent or alternative)?
pub fn installable(entry: &GalleryEntry) -> bool {
    matches!(
        entry.firefox.status,
        MappingStatus::Equivalent | MappingStatus::Alternative
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_loads_and_covers_the_whole_base_catalog() {
        let doc = load_gallery().expect("gallery.json must load");
        assert_eq!(doc.version, 1);
        // Code wins over the README's stale "20 verified" claim: every one
        // of the 45 catalog.ts entries is mapped.
        assert_eq!(doc.entries.len(), 45);
    }

    #[test]
    fn gallery_status_mix_matches_research() {
        let doc = load_gallery().expect("gallery.json must load");
        let equiv = doc
            .entries
            .iter()
            .filter(|e| e.firefox.status == MappingStatus::Equivalent)
            .count();
        let alt = doc
            .entries
            .iter()
            .filter(|e| e.firefox.status == MappingStatus::Alternative)
            .count();
        let none = doc
            .entries
            .iter()
            .filter(|e| e.firefox.status == MappingStatus::None)
            .count();
        assert_eq!((equiv, alt, none), (36, 8, 1));
        assert!(installable(&doc.entries[0]));
        let docs_offline = doc
            .entries
            .iter()
            .find(|e| e.name == "Google Docs Offline")
            .unwrap();
        assert_eq!(docs_offline.firefox.status, MappingStatus::None);
        assert!(!installable(docs_offline));
    }

    #[test]
    fn gallery_rejects_bad_docs() {
        let mut doc = load_gallery().expect("gallery.json must load");
        doc.entries[0].chrome_store_id = "xyz".to_string();
        assert!(validate(&doc).is_err());
        let mut doc = load_gallery().expect("gallery.json must load");
        let dup = doc.entries[0].chrome_store_id.clone();
        doc.entries[1].chrome_store_id = dup;
        assert!(validate(&doc).is_err());
    }
}

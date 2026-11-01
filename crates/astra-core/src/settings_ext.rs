/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Settings registry completion: defaults snapshot, validation helpers, and
//! migration of persisted maps that may contain unknown or invalid entries.
//!
//! The canonical registry lives in [`crate::settings`]; this module only adds
//! the completion layer on top of it (P2-T10) without touching P2-T01 code.

use crate::settings::{validate, SettingsError, KNOWN_SETTINGS};
use std::collections::{BTreeMap, HashMap};
use thiserror::Error;

/// Outcome of migrating one persisted settings map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrationReport {
    /// Merged map: every known key present, valid values kept, the rest reset
    /// to defaults.
    pub merged: BTreeMap<String, String>,
    /// Keys that are not in the registry and were dropped.
    pub dropped_unknown: Vec<String>,
    /// Known keys whose persisted value failed validation and was reset.
    pub reset_invalid: Vec<String>,
}

/// Errors from the settings completion layer.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SettingsExtError {
    #[error("unknown setting key: {0}")]
    UnknownKey(String),
    #[error(transparent)]
    Invalid(#[from] SettingsError),
}

/// Snapshot of every known key mapped to its registry default.
pub fn defaults() -> BTreeMap<String, String> {
    KNOWN_SETTINGS
        .iter()
        .map(|def| (def.key.to_owned(), def.default.to_owned()))
        .collect()
}

/// Fill `partial` with defaults for every missing known key.
///
/// Unknown keys are preserved untouched; use [`migrate`] to drop them.
pub fn apply_defaults(partial: &HashMap<String, String>) -> BTreeMap<String, String> {
    let mut merged = defaults();
    for def in KNOWN_SETTINGS {
        if let Some(value) = partial.get(def.key) {
            merged.insert(def.key.to_owned(), value.clone());
        }
    }
    // Preserve unknown keys verbatim (caller decides what to do with them).
    for (key, value) in partial {
        if !KNOWN_SETTINGS.iter().any(|def| def.key == key) {
            merged.insert(key.clone(), value.clone());
        }
    }
    merged
}

/// Validate every entry of `values` against the registry.
///
/// Returns the first error encountered.
pub fn validate_all(values: &HashMap<String, String>) -> Result<(), SettingsExtError> {
    // Sort keys for deterministic error reporting.
    let mut keys: Vec<&String> = values.keys().collect();
    keys.sort();
    for key in keys {
        let value = &values[key];
        if KNOWN_SETTINGS.iter().all(|def| def.key != key) {
            return Err(SettingsExtError::UnknownKey(key.clone()));
        }
        validate(key, value)?;
    }
    Ok(())
}

/// Migrate a persisted map: drop unknown keys, reset invalid values to
/// defaults, and fill in missing keys with defaults.
pub fn migrate(raw: &HashMap<String, String>) -> MigrationReport {
    let mut merged = defaults();
    let mut dropped_unknown = Vec::new();
    let mut reset_invalid = Vec::new();

    let mut keys: Vec<&String> = raw.keys().collect();
    keys.sort();
    for key in keys {
        let value = &raw[key];
        if KNOWN_SETTINGS.iter().all(|def| def.key != key) {
            dropped_unknown.push(key.clone());
            continue;
        }
        match validate(key, value) {
            Ok(()) => {
                merged.insert(key.clone(), value.clone());
            }
            Err(_) => {
                reset_invalid.push(key.clone());
                // `merged` already holds the registry default for this key.
            }
        }
    }

    MigrationReport {
        merged,
        dropped_unknown,
        reset_invalid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_raw() -> HashMap<String, String> {
        HashMap::from([
            ("appearance.theme".to_owned(), "dark".to_owned()),
            ("sidebar.width".to_owned(), "9999".to_owned()), // out of range
            ("legacy.renamed".to_owned(), "1".to_owned()),   // unknown
        ])
    }

    #[test]
    fn defaults_cover_every_registry_key() {
        let d = defaults();
        assert_eq!(d.len(), KNOWN_SETTINGS.len());
        for def in KNOWN_SETTINGS {
            assert_eq!(d.get(def.key), Some(&def.default.to_owned()));
        }
    }

    #[test]
    fn apply_defaults_fills_missing_and_keeps_unknown() {
        let partial = HashMap::from([("appearance.theme".to_owned(), "dark".to_owned())]);
        let merged = apply_defaults(&partial);
        assert_eq!(merged.get("appearance.theme"), Some(&"dark".to_owned()));
        // Missing keys fall back to defaults.
        assert_eq!(
            merged.get("sidebar.width"),
            Some(&"280".to_owned()),
            "missing key must resolve to its registry default"
        );
        assert_eq!(merged.len(), KNOWN_SETTINGS.len());
    }

    #[test]
    fn validate_all_accepts_known_valid_map() {
        let values = HashMap::from([
            ("appearance.theme".to_owned(), "dark".to_owned()),
            ("sidebar.hidden".to_owned(), "true".to_owned()),
            ("sidebar.width".to_owned(), "200".to_owned()),
            ("history.retention_days".to_owned(), "0".to_owned()),
        ]);
        assert!(validate_all(&values).is_ok());
    }

    #[test]
    fn validate_all_rejects_unknown_key() {
        let values = HashMap::from([("nope".to_owned(), "x".to_owned())]);
        assert_eq!(
            validate_all(&values),
            Err(SettingsExtError::UnknownKey("nope".to_owned()))
        );
    }

    #[test]
    fn validate_all_rejects_bad_value() {
        let values = HashMap::from([("sidebar.hidden".to_owned(), "yes".to_owned())]);
        assert!(matches!(
            validate_all(&values),
            Err(SettingsExtError::Invalid(_))
        ));
    }

    #[test]
    fn validate_edge_cases() {
        // Integer boundaries: min/max accepted, neighbours rejected.
        assert!(validate("sidebar.width", "200").is_ok());
        assert!(validate("sidebar.width", "480").is_ok());
        assert!(validate("sidebar.width", "199").is_err());
        assert!(validate("sidebar.width", "481").is_err());
        assert!(validate("sidebar.width", "").is_err());
        assert!(validate("sidebar.width", " 280").is_err());
        assert!(validate("history.retention_days", "0").is_ok());
        // Bool is strict lowercase.
        assert!(validate("sidebar.hidden", "True").is_err());
        assert!(validate("sidebar.hidden", "1").is_err());
        // Choice is exact.
        assert!(validate("appearance.theme", "Dark").is_err());
        assert!(validate("appearance.theme", "").is_err());
        // Text length cap (search.engine allows 64).
        assert!(validate("search.engine", &"e".repeat(64)).is_ok());
        assert!(validate("search.engine", &"e".repeat(65)).is_err());
    }

    #[test]
    fn migrate_drops_unknown_and_resets_invalid() {
        let report = migrate(&sample_raw());
        // Valid value kept.
        assert_eq!(
            report.merged.get("appearance.theme"),
            Some(&"dark".to_owned())
        );
        // Invalid value reset to default.
        assert_eq!(report.merged.get("sidebar.width"), Some(&"280".to_owned()));
        assert_eq!(report.reset_invalid, vec!["sidebar.width".to_owned()]);
        // Unknown key dropped and reported.
        assert!(!report.merged.contains_key("legacy.renamed"));
        assert_eq!(report.dropped_unknown, vec!["legacy.renamed".to_owned()]);
        // Every known key present after migration.
        assert_eq!(report.merged.len(), KNOWN_SETTINGS.len());
    }

    #[test]
    fn migrate_empty_map_yields_pure_defaults() {
        let report = migrate(&HashMap::new());
        assert_eq!(report.merged, defaults());
        assert!(report.dropped_unknown.is_empty());
        assert!(report.reset_invalid.is_empty());
    }
}

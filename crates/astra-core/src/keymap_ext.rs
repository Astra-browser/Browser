/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Keymap store: JSON import/export plus conflict reporting.
//!
//! Built on top of [`crate::keymap`] (P2-T01, untouched by P2-T10): export
//! serialises the live bindings, import validates an external payload and
//! reports conflicts before the caller applies anything.

use crate::keymap::{Keymap, KeymapEntry};
use std::collections::BTreeMap;
use thiserror::Error;

/// One accelerator claimed by more than one command.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyConflict {
    pub accelerator: String,
    /// Command ids claiming this accelerator, sorted.
    pub holders: Vec<String>,
}

/// Full conflict scan over a set of bindings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictReport {
    pub conflicts: Vec<KeyConflict>,
}

impl ConflictReport {
    pub fn has_conflicts(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// Report of a successful keymap import.
#[derive(Clone, Debug)]
pub struct KeymapImport {
    pub keymap: Keymap,
    /// Conflicts found *within* the imported payload (first holder wins).
    pub conflicts: ConflictReport,
}

/// Errors when importing a keymap payload.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum KeymapStoreError {
    #[error("invalid keymap JSON: {0}")]
    InvalidJson(String),
    #[error("unknown command id: {0}")]
    UnknownId(String),
    #[error("invalid accelerator {0:?}: must be 1..=64 chars of [A-Za-z0-9+]")]
    InvalidAccelerator(String),
}

/// Scan `entries` for accelerators claimed by several commands.
pub fn find_conflicts(entries: &[KeymapEntry]) -> ConflictReport {
    let mut by_accelerator: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for entry in entries {
        if let Some(acc) = entry.accelerator.as_deref() {
            by_accelerator.entry(acc).or_default().push(&entry.id);
        }
    }
    let conflicts = by_accelerator
        .into_iter()
        .filter_map(|(accelerator, mut holders)| {
            holders.sort_unstable();
            if holders.len() > 1 {
                Some(KeyConflict {
                    accelerator: accelerator.to_owned(),
                    holders: holders.into_iter().map(str::to_owned).collect(),
                })
            } else {
                None
            }
        })
        .collect();
    ConflictReport { conflicts }
}

/// Scan the live bindings of `keymap` for conflicts.
pub fn conflicts_in(keymap: &Keymap) -> ConflictReport {
    find_conflicts(&keymap.entries())
}

fn check_accelerator(accelerator: &str) -> Result<(), KeymapStoreError> {
    let ok = !accelerator.is_empty()
        && accelerator.len() <= 64
        && accelerator
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+');
    if ok {
        Ok(())
    } else {
        Err(KeymapStoreError::InvalidAccelerator(accelerator.to_owned()))
    }
}

/// Serialise the live bindings of `keymap` to pretty JSON.
pub fn export_keymap(keymap: &Keymap) -> String {
    serde_json::to_string_pretty(&keymap.entries()).unwrap_or_else(|_| "[]".to_owned())
}

/// Parse and validate a JSON keymap payload.
///
/// Unknown command ids and malformed accelerators are errors; duplicate
/// accelerators inside the payload are reported (first holder wins) rather
/// than rejected, so the caller can surface them in UI.
pub fn import_keymap(json: &str) -> Result<KeymapImport, KeymapStoreError> {
    let entries: Vec<KeymapEntry> =
        serde_json::from_str(json).map_err(|e| KeymapStoreError::InvalidJson(e.to_string()))?;

    let known: Vec<String> = Keymap::new().entries().into_iter().map(|e| e.id).collect();
    for entry in &entries {
        if !known.contains(&entry.id) {
            return Err(KeymapStoreError::UnknownId(entry.id.clone()));
        }
        if let Some(acc) = entry.accelerator.as_deref() {
            check_accelerator(acc)?;
        }
    }

    let conflicts = find_conflicts(&entries);

    // First holder wins; later duplicates are left unbound.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut keymap = Keymap::new();
    // Reset everything to unbound first via known ids, then apply payload.
    for entry in keymap.entries() {
        let _ = keymap.bind(&entry.id, None, false);
    }
    for entry in &entries {
        match entry.accelerator.as_deref() {
            Some(acc) if seen.insert(acc.to_owned()) => {
                let _ = keymap.bind(&entry.id, Some(acc), true);
            }
            Some(_) => {
                let _ = keymap.bind(&entry.id, None, false);
            }
            None => {
                let _ = keymap.bind(&entry.id, None, false);
            }
        }
    }

    Ok(KeymapImport { keymap, conflicts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_is_json_round_trip_stable() {
        let keymap = Keymap::new();
        let json = export_keymap(&keymap);
        let parsed: Vec<KeymapEntry> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, keymap.entries());
    }

    #[test]
    fn export_reflects_rebinding() {
        let mut keymap = Keymap::new();
        keymap
            .bind("sidebar.toggle", Some("CmdOrCtrl+B"), false)
            .unwrap();
        let json = export_keymap(&keymap);
        assert!(
            json.contains("CmdOrCtrl+B"),
            "export must carry live bindings"
        );
    }

    #[test]
    fn import_round_trip_preserves_bindings() {
        let mut keymap = Keymap::new();
        keymap
            .bind("sidebar.toggle", Some("CmdOrCtrl+B"), false)
            .unwrap();
        let json = export_keymap(&keymap);
        let imported = import_keymap(&json).unwrap();
        assert!(!imported.conflicts.has_conflicts());
        assert_eq!(imported.keymap.entries(), keymap.entries());
    }

    #[test]
    fn import_reports_conflicts_first_holder_wins() {
        let json = serde_json::to_string(&vec![
            KeymapEntry {
                id: "tabs.open".to_owned(),
                accelerator: Some("CmdOrCtrl+T".to_owned()),
            },
            KeymapEntry {
                id: "sidebar.toggle".to_owned(),
                accelerator: Some("CmdOrCtrl+T".to_owned()),
            },
        ])
        .unwrap();
        let imported = import_keymap(&json).unwrap();
        assert!(imported.conflicts.has_conflicts());
        assert_eq!(imported.conflicts.conflicts.len(), 1);
        let conflict = &imported.conflicts.conflicts[0];
        assert_eq!(conflict.accelerator, "CmdOrCtrl+T");
        assert_eq!(conflict.holders, vec!["sidebar.toggle", "tabs.open"]);
        // First holder keeps the accelerator; the loser is unbound.
        let by_id: BTreeMap<_, _> = imported
            .keymap
            .entries()
            .into_iter()
            .map(|e| (e.id, e.accelerator))
            .collect();
        assert_eq!(
            by_id.get("tabs.open"),
            Some(&Some("CmdOrCtrl+T".to_owned()))
        );
        assert_eq!(by_id.get("sidebar.toggle"), Some(&None));
    }

    #[test]
    fn import_rejects_unknown_id_bad_accelerator_and_bad_json() {
        let bad_id = serde_json::to_string(&vec![KeymapEntry {
            id: "nope".to_owned(),
            accelerator: Some("A".to_owned()),
        }])
        .unwrap();
        assert!(
            matches!(
                import_keymap(&bad_id),
                Err(KeymapStoreError::UnknownId(ref id)) if id == "nope"
            ),
            "unknown id must be rejected"
        );

        let bad_acc = serde_json::to_string(&vec![KeymapEntry {
            id: "tabs.open".to_owned(),
            accelerator: Some("ctrl+t!!".to_owned()),
        }])
        .unwrap();
        assert!(
            matches!(
                import_keymap(&bad_acc),
                Err(KeymapStoreError::InvalidAccelerator(ref acc)) if acc == "ctrl+t!!"
            ),
            "bad accelerator must be rejected"
        );

        assert!(matches!(
            import_keymap("{not json"),
            Err(KeymapStoreError::InvalidJson(_))
        ));
    }

    #[test]
    fn find_conflicts_detects_shared_accelerator() {
        let entries = vec![
            KeymapEntry {
                id: "a".to_owned(),
                accelerator: Some("X".to_owned()),
            },
            KeymapEntry {
                id: "b".to_owned(),
                accelerator: Some("X".to_owned()),
            },
            KeymapEntry {
                id: "c".to_owned(),
                accelerator: Some("Y".to_owned()),
            },
            KeymapEntry {
                id: "d".to_owned(),
                accelerator: None,
            },
        ];
        let report = find_conflicts(&entries);
        assert!(report.has_conflicts());
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(
            report.conflicts[0],
            KeyConflict {
                accelerator: "X".to_owned(),
                holders: vec!["a".to_owned(), "b".to_owned()],
            }
        );
    }

    #[test]
    fn default_keymap_has_no_conflicts() {
        assert!(!conflicts_in(&Keymap::new()).has_conflicts());
    }
}

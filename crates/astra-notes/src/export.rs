/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Notes export/import: folder `.md` files plus the index metadata bundle
//! (P5-T05).
//!
//! The folder is the truth, the `notes_index` table the searchable mirror —
//! so an export carries both: every note's body plus the index row
//! describing it (`rel`, `title`, `hash`, `mtime`). Import writes the files
//! back and re-indexes, and a re-export is identical when the bodies match.
//!
//! Versioning mirrors the `astra-core` session/layout precedent: the bundle
//! carries `schema_version` ([`astra_store::SCHEMA_VERSION`]) and imports
//! reject anything else with [`NotesError::VersionMismatch`][crate::NotesError].

use serde::{Deserialize, Serialize};

use crate::{NoteLibrary, NotesError};

/// Export format version. Tied to the store schema so a database migration
/// and an export payload can never disagree silently.
pub use astra_store::SCHEMA_VERSION as NOTES_EXPORT_VERSION;

/// One note in an export bundle: the file body plus its index metadata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteExport {
    /// Path relative to the notes root, with `/` separators.
    pub rel: String,
    /// First Markdown heading, or the file stem.
    pub title: String,
    /// Hex SHA-256 of the body at export time.
    pub hash: String,
    /// File mtime (Unix seconds) at export time; informational only —
    /// import restores bodies, and the filesystem stamps fresh mtimes.
    pub mtime: i64,
    /// The full `.md` file body.
    pub body: String,
}

/// Versioned JSON bundle: every indexed note that still has a file on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotesBundle {
    pub schema_version: u32,
    pub notes: Vec<NoteExport>,
}

impl NoteLibrary {
    /// Capture every indexed note (path order) with its live body.
    /// Notes vanished from disk since the last sync are skipped — they are
    /// already reported as [`NoteEvent::Removed`][crate::NoteEvent] by
    /// [`NoteLibrary::sync_index`].
    pub fn export_bundle(&self, store: &astra_store::Store) -> Result<NotesBundle, NotesError> {
        let mut notes = Vec::new();
        for row in self.list(store)? {
            let doc = self.read(&row.path)?;
            notes.push(NoteExport {
                rel: row.path,
                title: row.title,
                hash: row.hash,
                mtime: row.mtime,
                body: doc.body,
            });
        }
        Ok(NotesBundle {
            schema_version: astra_store::SCHEMA_VERSION,
            notes,
        })
    }

    /// Serialise [`NoteLibrary::export_bundle`] to pretty JSON.
    pub fn export_json(&self, store: &astra_store::Store) -> Result<String, NotesError> {
        let bundle = self.export_bundle(store)?;
        serde_json::to_string_pretty(&bundle).map_err(|e| NotesError::Json(e.to_string()))
    }

    /// Parse and merge a JSON bundle (see [`NoteLibrary::import_bundle`]).
    pub fn import_json(&self, store: &astra_store::Store, json: &str) -> Result<usize, NotesError> {
        let bundle: NotesBundle =
            serde_json::from_str(json).map_err(|e| NotesError::Json(e.to_string()))?;
        self.import_bundle(store, &bundle)
    }

    /// Merge a bundle: version-checked, then every note written to disk and
    /// indexed (overwriting same-path files, creating parents as needed).
    /// Returns the number of notes imported.
    pub fn import_bundle(
        &self,
        store: &astra_store::Store,
        bundle: &NotesBundle,
    ) -> Result<usize, NotesError> {
        if bundle.schema_version != astra_store::SCHEMA_VERSION {
            return Err(NotesError::VersionMismatch(
                bundle.schema_version,
                astra_store::SCHEMA_VERSION,
            ));
        }
        let count = bundle.notes.len();
        for note in &bundle.notes {
            self.write_imported(store, note)?;
        }
        Ok(count)
    }

    /// Write one imported note: validate the path, create parents, write
    /// the body, and upsert the index with the freshly computed hash.
    fn write_imported(
        &self,
        store: &astra_store::Store,
        note: &NoteExport,
    ) -> Result<(), NotesError> {
        if note.body.len() as u64 > crate::MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                path: note.rel.clone(),
                bytes: note.body.len() as u64,
            });
        }
        // `create` refuses existing files and `save` needs a baseline; an
        // import owns the destination, so resolve + write directly.
        let (normalized, path) = self.resolve(&note.rel)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, &note.body)?;
        let meta = self.stat(&normalized, &path)?;
        store.note_upsert(&meta.rel, &meta.hash, meta.mtime, &meta.title)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> astra_store::Store {
        let store = astra_store::Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        store
    }

    fn lib_helper() -> (tempfile::TempDir, NoteLibrary) {
        let dir = tempfile::tempdir().unwrap();
        let lib = NoteLibrary::open(dir.path()).unwrap();
        (dir, lib)
    }

    #[test]
    fn json_round_trip_preserves_bodies_and_index() {
        let (_dir, lib) = lib_helper();
        let store = test_store();
        lib.create(&store, "ideas/plan.md", "# Plan\n\nShip it.\n")
            .unwrap();
        lib.create(&store, "log.md", "- milk\n- eggs\n").unwrap();

        let json = lib.export_json(&store).unwrap();
        let bundle: NotesBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(bundle.schema_version, astra_store::SCHEMA_VERSION);
        assert_eq!(bundle.notes.len(), 2);
        assert!(bundle
            .notes
            .iter()
            .any(|n| n.rel == "ideas/plan.md" && n.title == "Plan"));
        assert!(bundle
            .notes
            .iter()
            .any(|n| n.rel == "log.md" && n.body == "- milk\n- eggs\n"));

        let (dir2, fresh_lib) = lib_helper();
        let fresh_store = test_store();
        let count = fresh_lib.import_json(&fresh_store, &json).unwrap();
        assert_eq!(count, 2);
        // Bodies and index match, and a re-export is identical (modulo
        // filesystem mtimes, which imports cannot preserve — they are
        // informational in the bundle).
        for note in &bundle.notes {
            let doc = fresh_lib.read(&note.rel).unwrap();
            assert_eq!(doc.body, note.body);
        }
        let mut reimported: NotesBundle =
            serde_json::from_str(&fresh_lib.export_json(&fresh_store).unwrap()).unwrap();
        for note in &mut reimported.notes {
            note.mtime = 0;
        }
        let mut expected = bundle.clone();
        for note in &mut expected.notes {
            note.mtime = 0;
        }
        assert_eq!(reimported, expected);
        assert!(dir2.path().join("ideas/plan.md").is_file());

        // Re-importing converges instead of duplicating.
        assert_eq!(fresh_lib.import_json(&fresh_store, &json).unwrap(), 2);
    }

    #[test]
    fn import_overwrites_and_reindexes_changed_notes() {
        let (_dir, lib) = lib_helper();
        let store = test_store();
        lib.create(&store, "race.md", "# Mine\n").unwrap();
        let json = lib.export_json(&store).unwrap();

        let (_dir2, fresh_lib) = lib_helper();
        let fresh_store = test_store();
        fresh_lib
            .create(&fresh_store, "race.md", "# Stale\n")
            .unwrap();
        fresh_lib.import_json(&fresh_store, &json).unwrap();
        assert_eq!(fresh_lib.read("race.md").unwrap().body, "# Mine\n");
        assert_eq!(fresh_store.note_list().unwrap().len(), 1);
    }

    #[test]
    fn old_versions_and_bad_json_fail_loudly() {
        let (_dir, lib) = lib_helper();
        let store = test_store();
        lib.create(&store, "a.md", "# A\n").unwrap();
        let mut bundle = lib.export_bundle(&store).unwrap();
        bundle.schema_version = astra_store::SCHEMA_VERSION - 1;
        assert!(matches!(
            lib.import_bundle(&store, &bundle),
            Err(NotesError::VersionMismatch(_, _))
        ));
        let bad = serde_json::json!({
            "schema_version": astra_store::SCHEMA_VERSION + 99,
            "notes": [],
        })
        .to_string();
        assert!(matches!(
            lib.import_json(&store, &bad),
            Err(NotesError::VersionMismatch(_, _))
        ));
        assert!(matches!(
            lib.import_json(&store, "{not json"),
            Err(NotesError::Json(_))
        ));
        // A path escaping the root is rejected, not written.
        let evil = NotesBundle {
            schema_version: astra_store::SCHEMA_VERSION,
            notes: vec![NoteExport {
                rel: "../evil.md".to_owned(),
                title: "evil".to_owned(),
                hash: String::new(),
                mtime: 0,
                body: "pwned".to_owned(),
            }],
        };
        assert!(matches!(
            lib.import_bundle(&store, &evil),
            Err(NotesError::OutsideRoot(_))
        ));
    }
}

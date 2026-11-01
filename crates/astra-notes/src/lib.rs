/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-notes`: notes as Markdown files the user owns (P5-T03).
//!
//! A note is a `.md` file inside a user-chosen folder. The folder is the
//! truth; the [`astra-store`] `notes_index` table (owned by `P2-T04`, used
//! here, never reschema'd) is the searchable mirror. A background watcher
//! keeps the two in sync so external editors appear live in the app.
//!
//! The UI comes later (`editor beside page`): this crate exposes the model
//! and the events only — [`NoteLibrary`] for synchronous reads/writes,
//! [`NoteWatcher`] for live [`NoteEvent`]s, and [`SaveOutcome`] for the
//! conflict policy (last-writer-wins with a conflict copy).

#![forbid(unsafe_code)]

mod markdown;
mod watch;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use astra_store::StoreError;
pub use markdown::{extract_title, MAX_TITLE_CHARS};
pub use watch::{NoteWatcher, WatcherMode, POLL_INTERVAL};

/// Notes larger than this are refused: notes are hand-written text, and an
/// unbounded read on every rescan would let one hostile file stall sync.
pub const MAX_NOTE_BYTES: u64 = 8 * 1024 * 1024;

/// Errors from the notes domain.
#[derive(Debug, thiserror::Error)]
pub enum NotesError {
    /// Filesystem failure outside the store.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    /// `astra-store` failure (open, migrate, upsert, list).
    #[error("store error: {0}")]
    Store(#[from] StoreError),
    /// The path does not name a Markdown note.
    #[error("not a markdown note: {0}")]
    NotMarkdown(String),
    /// The path escapes the notes folder.
    #[error("path escapes the notes folder: {0}")]
    OutsideRoot(String),
    /// A note already exists at this path.
    #[error("note already exists: {0}")]
    AlreadyExists(String),
    /// The file is larger than [`MAX_NOTE_BYTES`].
    #[error("note too large ({bytes} bytes): {path}")]
    TooLarge { path: String, bytes: u64 },
    /// The file is not valid UTF-8 text.
    #[error("note is not valid UTF-8: {0}")]
    NotUtf8(String),
}

/// Live view of one note: where it is plus what the index knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteMeta {
    /// Path relative to the notes root, with `/` separators.
    pub rel: String,
    /// First Markdown heading, or the file stem.
    pub title: String,
    /// Hex SHA-256 of the file bytes.
    pub hash: String,
    /// File mtime, Unix seconds.
    pub mtime: i64,
    /// File size in bytes.
    pub size: u64,
}

/// What the editor saw when it opened the note; the baseline a later
/// [`NoteLibrary::save`] checks before overwriting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteBaseline {
    pub hash: String,
    pub mtime: i64,
}

/// An open note for the beside-page editor: live metadata plus body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoteDocument {
    pub meta: NoteMeta,
    pub body: String,
}

impl NoteDocument {
    /// The baseline a subsequent `save` must present to overwrite cleanly.
    pub fn baseline(&self) -> NoteBaseline {
        NoteBaseline {
            hash: self.meta.hash.clone(),
            mtime: self.meta.mtime,
        }
    }
}

/// What happened on disk or in the index, in path order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoteEvent {
    /// A new `.md` file appeared; it is indexed now.
    Created(NoteMeta),
    /// An existing file changed; the index caught up.
    Updated(NoteMeta),
    /// An indexed path no longer has a file. The `notes_index` row is left
    /// alone: tombstoning needs a store API owned outside this lane, so
    /// removal is reported here and filtered out of [`NoteLibrary::list`].
    Removed { rel: String },
}

/// The result of saving an open note.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveOutcome {
    /// Nobody else touched the file; the save landed cleanly.
    Saved(NoteMeta),
    /// The file moved under the editor (last-writer-wins): the new body is
    /// the file now, and the displaced on-disk version is preserved in a
    /// conflict copy next to it, indexed like any other note.
    ConflictSaved { saved: NoteMeta, copy_rel: String },
}

/// Notes living in one folder, indexed in `astra-store`.
///
/// The library holds no store handle: every method that touches the index
/// takes `&astra_store::Store`, so sync, UI and test threads can share one
/// `Store` without lifetime gymnastics.
#[derive(Clone, Debug)]
pub struct NoteLibrary {
    root: PathBuf,
}

impl NoteLibrary {
    /// Open (creating) the notes folder. The root is canonicalized so later
    /// `starts_with` checks cannot be fooled by `..` or symlinked prefixes.
    pub fn open(root: impl AsRef<Path>) -> Result<Self, NotesError> {
        let root = root.as_ref();
        std::fs::create_dir_all(root)?;
        let root = root.canonicalize()?;
        Ok(Self { root })
    }

    /// The folder notes live in.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Validate `rel` and resolve it inside the root. Accepts `/`-separated
    /// relative paths ending in `.md` (case-insensitive); rejects absolutes,
    /// `.`/`..`, empty segments and anything that would leave the root.
    fn resolve(&self, rel: &str) -> Result<(String, PathBuf), NotesError> {
        if rel.is_empty() {
            return Err(NotesError::OutsideRoot("<empty>".to_owned()));
        }
        if rel.contains('\\') {
            // A separator on Windows and a valid filename elsewhere: reject
            // everywhere so a note created on Linux cannot escape on Windows.
            return Err(NotesError::OutsideRoot(rel.to_owned()));
        }
        let mut parts = Vec::new();
        for component in Path::new(rel).components() {
            match component {
                Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
                _ => return Err(NotesError::OutsideRoot(rel.to_owned())),
            }
        }
        if parts.is_empty() {
            return Err(NotesError::OutsideRoot(rel.to_owned()));
        }
        let normalized = parts.join("/");
        if !normalized.to_ascii_lowercase().ends_with(".md") {
            return Err(NotesError::NotMarkdown(rel.to_owned()));
        }
        let path = self.root.join(normalized.clone());
        if !path.starts_with(&self.root) {
            return Err(NotesError::OutsideRoot(rel.to_owned()));
        }
        Ok((normalized, path))
    }

    /// The live metadata of the file at `path`, named `rel`.
    fn stat(&self, rel: &str, path: &Path) -> Result<NoteMeta, NotesError> {
        let bytes = std::fs::read(path)?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                path: rel.to_owned(),
                bytes: bytes.len() as u64,
            });
        }
        let mtime = path
            .metadata()?
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let body = std::str::from_utf8(&bytes).map_err(|_| NotesError::NotUtf8(rel.to_owned()))?;
        Ok(NoteMeta {
            rel: rel.to_owned(),
            title: extract_title(body, &stem),
            hash: hash_bytes(&bytes),
            mtime,
            size: bytes.len() as u64,
        })
    }

    /// Every `.md` file under the root, sorted by relative path.
    pub fn scan(&self) -> Result<Vec<NoteMeta>, NotesError> {
        let mut metas = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir)?;
            for entry in entries {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_dir() {
                    stack.push(entry.path());
                } else if kind.is_file() {
                    let path = entry.path();
                    let is_md = path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
                    if !is_md {
                        continue;
                    }
                    let rel = path
                        .strip_prefix(&self.root)
                        .map_err(|_| NotesError::OutsideRoot(path.display().to_string()))?
                        .iter()
                        .map(|s| s.to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/");
                    metas.push(self.stat(&rel, &path)?);
                }
            }
        }
        metas.sort_by(|a, b| a.rel.cmp(&b.rel));
        Ok(metas)
    }

    /// Reconcile the folder with the `notes_index` table.
    ///
    /// New files are indexed (`Created`), changed files re-indexed
    /// (`Updated`), indexed paths with no file left report `Removed` (their
    /// rows are kept; see [`NoteEvent::Removed`]). Returns the events in
    /// path order, so watchers, pollers and tests all converge through this
    /// one function with identical behaviour — only latency differs.
    #[tracing::instrument(skip(self, store))]
    pub fn sync_index(&self, store: &astra_store::Store) -> Result<Vec<NoteEvent>, NotesError> {
        let live = self.scan()?;
        let indexed = store.note_list()?;
        let live_by_path: BTreeMap<&str, &NoteMeta> =
            live.iter().map(|meta| (meta.rel.as_str(), meta)).collect();
        let live_set: BTreeSet<&str> = live_by_path.keys().copied().collect();

        let mut events = Vec::new();
        for meta in &live {
            let changed = indexed
                .iter()
                .find(|row| row.path == meta.rel)
                .is_none_or(|row| row.hash != meta.hash);
            if changed {
                let known = indexed.iter().any(|row| row.path == meta.rel);
                store.note_upsert(&meta.rel, &meta.hash, meta.mtime, &meta.title)?;
                events.push(if known {
                    NoteEvent::Updated((*meta).clone())
                } else {
                    NoteEvent::Created((*meta).clone())
                });
            }
        }
        for row in &indexed {
            if !live_set.contains(row.path.as_str()) {
                events.push(NoteEvent::Removed {
                    rel: row.path.clone(),
                });
            }
        }
        Ok(events)
    }

    /// Indexed notes that still have a file on disk, in path order. This is
    /// the list the beside-page editor shows: unindexed drafts (mid-write)
    /// and deleted-but-not-tombstoned rows are both hidden here until the
    /// next [`NoteLibrary::sync_index`] converges them.
    pub fn list(
        &self,
        store: &astra_store::Store,
    ) -> Result<Vec<astra_store::NoteRow>, NotesError> {
        let mut rows = store.note_list()?;
        rows.retain(|row| {
            Path::new(&row.path)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
                && self.root.join(row.path.clone()).is_file()
        });
        Ok(rows)
    }

    /// Open a note for the beside-page editor: metadata plus full body.
    pub fn read(&self, rel: &str) -> Result<NoteDocument, NotesError> {
        let (normalized, path) = self.resolve(rel)?;
        let bytes = std::fs::read(&path)?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                path: normalized.clone(),
                bytes: bytes.len() as u64,
            });
        }
        let body = std::str::from_utf8(&bytes)
            .map_err(|_| NotesError::NotUtf8(normalized.clone()))?
            .to_owned();
        let meta = self.stat(&normalized, &path)?;
        Ok(NoteDocument { meta, body })
    }

    /// Create a note with `body`. Parent folders are created; an existing
    /// file is an error (open it and `save` instead, so conflicts surface).
    #[tracing::instrument(skip(self, store, body))]
    pub fn create(
        &self,
        store: &astra_store::Store,
        rel: &str,
        body: &str,
    ) -> Result<NoteMeta, NotesError> {
        let (normalized, path) = self.resolve(rel)?;
        if path.exists() {
            return Err(NotesError::AlreadyExists(normalized));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if body.len() as u64 > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                path: normalized,
                bytes: body.len() as u64,
            });
        }
        std::fs::write(&path, body)?;
        let meta = self.stat(&normalized, &path)?;
        store.note_upsert(&meta.rel, &meta.hash, meta.mtime, &meta.title)?;
        Ok(meta)
    }

    /// Save the editor body for `rel`.
    ///
    /// Conflict policy is last-writer-wins with a conflict copy: when the
    /// file on disk no longer matches `baseline` (an external edit landed
    /// while the editor was open), the displaced on-disk version is first
    /// preserved next to the note as `<stem>.conflict-<unix-ts>.md` and
    /// indexed, then the new body wins. Nothing is ever silently lost.
    #[tracing::instrument(skip(self, store, body))]
    pub fn save(
        &self,
        store: &astra_store::Store,
        rel: &str,
        baseline: &NoteBaseline,
        body: &str,
    ) -> Result<SaveOutcome, NotesError> {
        let (normalized, path) = self.resolve(rel)?;
        if body.len() as u64 > MAX_NOTE_BYTES {
            return Err(NotesError::TooLarge {
                path: normalized,
                bytes: body.len() as u64,
            });
        }
        let current = std::fs::read(&path).ok();
        let conflicted = current
            .as_ref()
            .is_some_and(|bytes| hash_bytes(bytes) != baseline.hash);
        if conflicted {
            let displaced = current.unwrap_or_default();
            let copy_rel = self.unique_conflict_rel(&normalized)?;
            let copy_path = self.root.join(copy_rel.clone());
            std::fs::write(&copy_path, &displaced)?;
            let copy_meta = self.stat(&copy_rel, &copy_path)?;
            store.note_upsert(
                &copy_meta.rel,
                &copy_meta.hash,
                copy_meta.mtime,
                &copy_meta.title,
            )?;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, body)?;
        let meta = self.stat(&normalized, &path)?;
        store.note_upsert(&meta.rel, &meta.hash, meta.mtime, &meta.title)?;
        if conflicted {
            let copy_rel = self.latest_conflict_rel(&normalized)?;
            Ok(SaveOutcome::ConflictSaved {
                saved: meta,
                copy_rel,
            })
        } else {
            Ok(SaveOutcome::Saved(meta))
        }
    }

    /// Delete the file. The index row is kept (see [`NoteEvent::Removed`]);
    /// returns whether a file was there at all.
    pub fn remove(&self, rel: &str) -> Result<bool, NotesError> {
        let (_, path) = self.resolve(rel)?;
        if !path.is_file() {
            return Ok(false);
        }
        std::fs::remove_file(&path)?;
        Ok(true)
    }

    /// A free conflict-copy path next to `rel`: `<stem>.conflict-<ts>.md`,
    /// uniquified with `-<n>` while it exists. Timestamp first (human
    /// sortable), counter second (same-second saves).
    fn unique_conflict_rel(&self, rel: &str) -> Result<String, NotesError> {
        let (stem, parent) = match rel.rfind('/') {
            Some(i) => (&rel[..i], format!("{}/", &rel[..i])),
            None => (rel, String::new()),
        };
        let stem = stem
            .strip_suffix(".md")
            .or_else(|| stem.strip_suffix(".MD"))
            .unwrap_or(stem);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        for n in 0..1000 {
            let candidate = if n == 0 {
                format!("{parent}{stem}.conflict-{now}.md")
            } else {
                format!("{parent}{stem}.conflict-{now}-{n}.md")
            };
            if !self.root.join(candidate.clone()).exists() {
                return Ok(candidate);
            }
        }
        Err(NotesError::OutsideRoot(format!(
            "no free conflict name for {rel}"
        )))
    }

    /// The conflict copy `save` just wrote: the newest matching sibling.
    fn latest_conflict_rel(&self, rel: &str) -> Result<String, NotesError> {
        let dir = match rel.rfind('/') {
            Some(i) => self.root.join(&rel[..i]),
            None => self.root.clone(),
        };
        let stem = Path::new(rel)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let prefix = format!("{stem}.conflict-");
        let mut newest: Option<String> = None;
        let entries = std::fs::read_dir(&dir)?;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && name.ends_with(".md") {
                let rel = match rel.rfind('/') {
                    Some(i) => format!("{}/{name}", &rel[..i]),
                    None => name.clone(),
                };
                if newest.as_ref().is_none_or(|best| rel > *best) {
                    newest = Some(rel);
                }
            }
        }
        newest.ok_or_else(|| NotesError::OutsideRoot(format!("conflict copy vanished for {rel}")))
    }
}

/// Hex SHA-256 of file bytes: the identity `sync_index` compares.
fn hash_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> astra_store::Store {
        let store = astra_store::Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        store
    }

    fn library() -> (tempfile::TempDir, NoteLibrary) {
        let dir = tempfile::tempdir().unwrap();
        let library = NoteLibrary::open(dir.path()).unwrap();
        (dir, library)
    }

    #[test]
    fn bad_paths_never_leave_the_root() {
        let (_dir, library) = library();
        for rel in [
            "",
            "/etc/passwd",
            "../escape.md",
            "a/../../b.md",
            "note.txt",
            "..\\win.md",
        ] {
            assert!(library.resolve(rel).is_err(), "{rel}");
        }
        // `.` segments normalize away and stay inside the root.
        let (normalized, _) = library.resolve("a/./b.md").unwrap();
        assert_eq!(normalized, "a/b.md");
        assert!(library.resolve("ok/sub-note.md").is_ok());
        assert!(library.resolve("UPPER.MD").is_ok());
    }

    #[test]
    fn create_read_and_index_round_trip() {
        let (_dir, library) = library();
        let store = test_store();
        let meta = library
            .create(&store, "ideas/plan.md", "# Plan\n\nShip it.\n")
            .unwrap();
        assert_eq!(meta.rel, "ideas/plan.md");
        assert_eq!(meta.title, "Plan");

        let doc = library.read("ideas/plan.md").unwrap();
        assert_eq!(doc.body, "# Plan\n\nShip it.\n");
        assert_eq!(doc.baseline().hash, meta.hash);

        // Round-trip through the store index: what the editor wrote is what
        // the index holds, and the live list shows it.
        let rows = store.note_list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "ideas/plan.md");
        assert_eq!(rows[0].hash, meta.hash);
        assert_eq!(rows[0].title, "Plan");
        let listed = library.list(&store).unwrap();
        assert_eq!(listed.len(), 1);

        // Second sync with no changes reports nothing.
        assert!(library.sync_index(&store).unwrap().is_empty());

        // Creating twice is an error, not a silent overwrite.
        assert!(matches!(
            library.create(&store, "ideas/plan.md", "# Other\n"),
            Err(NotesError::AlreadyExists(_))
        ));
    }

    #[test]
    fn external_edits_resync_title_and_hash() {
        let (dir, library) = library();
        let store = test_store();
        library.create(&store, "log.md", "# Day one\n").unwrap();
        assert!(library.sync_index(&store).unwrap().is_empty());

        // An external editor rewrites the file behind our back.
        std::fs::write(dir.path().join("log.md"), "# Day two\n\nMore.\n").unwrap();
        let events = library.sync_index(&store).unwrap();
        assert_eq!(events.len(), 1);
        let meta = match &events[0] {
            NoteEvent::Updated(meta) => meta,
            other => panic!("expected Updated, got {other:?}"),
        };
        assert_eq!(meta.title, "Day two");

        let rows = store.note_list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hash, meta.hash);
        assert_eq!(rows[0].title, "Day two");
    }

    #[test]
    fn external_delete_reports_removed_and_hides_from_list() {
        let (dir, library) = library();
        let store = test_store();
        library.create(&store, "gone.md", "# Gone\n").unwrap();
        std::fs::remove_file(dir.path().join("gone.md")).unwrap();

        let events = library.sync_index(&store).unwrap();
        assert_eq!(
            events,
            vec![NoteEvent::Removed {
                rel: "gone.md".to_owned()
            }]
        );
        assert!(library.list(&store).unwrap().is_empty());
    }

    #[test]
    fn clean_save_lands_without_conflict_copy() {
        let (_dir, library) = library();
        let store = test_store();
        library.create(&store, "edit.md", "# Draft\n").unwrap();
        let doc = library.read("edit.md").unwrap();

        let outcome = library
            .save(&store, "edit.md", &doc.baseline(), "# Draft\n\nDone.\n")
            .unwrap();
        let meta = match outcome {
            SaveOutcome::Saved(meta) => meta,
            SaveOutcome::ConflictSaved { .. } => panic!("unexpected conflict"),
        };
        assert_eq!(meta.title, "Draft");
        assert_eq!(library.read("edit.md").unwrap().body, "# Draft\n\nDone.\n");
        // No conflict copy beside the note.
        assert_eq!(library.scan().unwrap().len(), 1);
    }

    #[test]
    fn conflicting_save_is_last_writer_wins_with_conflict_copy() {
        let (dir, library) = library();
        let store = test_store();
        library.create(&store, "race.md", "# Mine\n").unwrap();
        let stale = library.read("race.md").unwrap();

        // External edit lands while the editor is open.
        std::fs::write(dir.path().join("race.md"), "# Theirs\n\nExternal.\n").unwrap();

        let outcome = library
            .save(&store, "race.md", &stale.baseline(), "# Mine\n\nEdited.\n")
            .unwrap();
        let (saved, copy_rel) = match outcome {
            SaveOutcome::ConflictSaved { saved, copy_rel } => (saved, copy_rel),
            SaveOutcome::Saved(_) => panic!("expected a conflict"),
        };
        // Last writer wins: the editor body is the file now.
        assert_eq!(library.read("race.md").unwrap().body, "# Mine\n\nEdited.\n");
        // The displaced version is preserved verbatim in the conflict copy.
        let copy_body = std::fs::read_to_string(dir.path().join(&copy_rel)).unwrap();
        assert_eq!(copy_body, "# Theirs\n\nExternal.\n");
        assert!(copy_rel.starts_with("race.conflict-") && copy_rel.ends_with(".md"));

        // Both the winner and the copy are indexed.
        let mut paths: Vec<String> = store
            .note_list()
            .unwrap()
            .into_iter()
            .map(|row| row.path)
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "race.conflict-".to_owned() + &copy_rel["race.conflict-".len()..],
                "race.md".to_owned()
            ]
        );
        assert_eq!(saved.hash, hash_bytes(b"# Mine\n\nEdited.\n"));

        // Converged: the next sync is quiet.
        assert!(library.sync_index(&store).unwrap().is_empty());
    }

    #[test]
    fn notes_without_headings_take_the_stem_as_title() {
        let (_dir, library) = library();
        let store = test_store();
        let meta = library
            .create(&store, "shopping.md", "- milk\n- eggs\n")
            .unwrap();
        assert_eq!(meta.title, "shopping");
        assert_eq!(store.note_list().unwrap()[0].title, "shopping");
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Private windows: NOTHING persisted by core (P4-T07).
//!
//! Private tabs are excluded from history writes, session snapshots,
//! the favicon cache, and time tracking. This module is the single
//! private-mode guard consulted at every core write path:
//!
//! - history: gate [`PrivateScope::history_allowed`] before
//!   `history_add` / `history_add_in_space` (store) — see `history.rs`.
//! - sessions: [`SessionSnapshot::capture`][crate::session::SessionSnapshot]
//!   already drops private windows/tabs; gate `session_save` on
//!   [`PrivateScope::session_allowed`] so a fully-private window never
//!   writes a snapshot row at all.
//! - favicons: gate `favicon_upsert` on [`PrivateScope::favicon_allowed`].
//! - time: gate `time_start` / `time_end` on [`PrivateScope::time_allowed`].
//!
//! The guard is pure (no store dependency): callers check the scope and
//! skip the write. [`WriteDecision`] records the allow/skip outcome so
//! call sites stay one line: `if scope.check("history").persist() { … }`.

use std::collections::HashSet;

/// Browsing scope for one write decision: public persists, private never
/// persists. Optionally carries the set of private window ids so
/// per-window checks (`is_private_window`) work alongside the global flag.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PrivateScope {
    is_private: bool,
    private_window_ids: HashSet<String>,
}

impl PrivateScope {
    /// Public scope: every write path persists.
    pub fn public() -> Self {
        Self {
            is_private: false,
            private_window_ids: HashSet::new(),
        }
    }

    /// Fully private scope: no write path persists.
    pub fn private() -> Self {
        Self {
            is_private: true,
            private_window_ids: HashSet::new(),
        }
    }

    /// Scope with a known set of private window ids. `is_private` covers
    /// the active window; the set covers snapshot filtering across windows.
    pub fn with_private_windows(is_private: bool, private_window_ids: HashSet<String>) -> Self {
        Self {
            is_private,
            private_window_ids,
        }
    }

    /// Whether this scope is private.
    pub fn is_private(&self) -> bool {
        self.is_private
    }

    /// Private window ids known to this scope (for snapshot filtering).
    pub fn private_window_ids(&self) -> &HashSet<String> {
        &self.private_window_ids
    }

    /// Whether `window_id` is a known private window.
    pub fn is_private_window(&self, window_id: &str) -> bool {
        self.private_window_ids.contains(window_id)
    }

    /// Master switch: false in private mode, true in public mode.
    pub fn should_persist(&self) -> bool {
        !self.is_private
    }

    /// History writes allowed? (`history_add` / `history_add_in_space`.)
    pub fn history_allowed(&self) -> bool {
        self.should_persist()
    }

    /// Session snapshot writes allowed? (`session_save`.)
    pub fn session_allowed(&self) -> bool {
        self.should_persist()
    }

    /// Favicon cache writes allowed? (`favicon_upsert`.)
    pub fn favicon_allowed(&self) -> bool {
        self.should_persist()
    }

    /// Time tracking writes allowed? (`time_start` / `time_end`.)
    pub fn time_allowed(&self) -> bool {
        self.should_persist()
    }

    /// One-line guard for a named write path (`"history"`, `"session"`,
    /// `"favicon"`, `"time"`). Unknown names fall back to the master
    /// switch so new paths default to private-safe.
    pub fn check(&self, _action: &str) -> WriteDecision {
        if self.should_persist() {
            WriteDecision::Allow
        } else {
            WriteDecision::SkipPrivate
        }
    }

    /// Run `write` only in public scope; returns `None` (write skipped)
    /// in private scope. Keeps call sites to one expression:
    /// `scope.gate("history", || store.history_add(…))`.
    pub fn gate<T>(&self, action: &str, write: impl FnOnce() -> T) -> Option<T> {
        if self.check(action).persist() {
            Some(write())
        } else {
            None
        }
    }
}

/// Outcome of a [`PrivateScope::check`]: persist the write, or skip it
/// because the scope is private.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteDecision {
    /// Public scope: perform the write.
    Allow,
    /// Private scope: skip the write; nothing may hit disk.
    SkipPrivate,
}

impl WriteDecision {
    /// Whether the caller should perform the write.
    pub fn persist(&self) -> bool {
        matches!(self, WriteDecision::Allow)
    }
}

/// Post-capture safety net: true when `snapshot` holds no tab or window
/// from a private window id. Use in tests and pre-save asserts alongside
/// [`PrivateScope::session_allowed`].
pub fn snapshot_contains_private(
    snapshot: &crate::session::SessionSnapshot,
    scope: &PrivateScope,
) -> bool {
    snapshot
        .windows
        .iter()
        .any(|w| scope.is_private_window(&w.window_id))
        || snapshot
            .tabs
            .iter()
            .any(|t| scope.is_private_window(&t.window_id))
}

/// Forensic helper: scan a serialized snapshot for leaked private markers
/// (URLs, titles). Returns every marker found; empty means clean.
pub fn forensic_scan_snapshot_json(snapshot_json: &str, private_markers: &[&str]) -> Vec<String> {
    private_markers
        .iter()
        .filter(|m| snapshot_json.contains(**m))
        .map(|m| (*m).to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{
        SessionSnapshot, SpaceSnapshot, TabSnapshot, WindowSnapshot, SESSION_NAME_LAST,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn public_scope_allows_all_paths() {
        let scope = PrivateScope::public();
        assert!(scope.should_persist());
        assert!(scope.history_allowed());
        assert!(scope.session_allowed());
        assert!(scope.favicon_allowed());
        assert!(scope.time_allowed());
        for action in ["history", "session", "favicon", "time", "future-path"] {
            assert!(scope.check(action).persist(), "{action} must persist");
        }
        assert_eq!(scope.gate("history", || 42), Some(42));
    }

    #[test]
    fn private_scope_blocks_all_paths() {
        let scope = PrivateScope::private();
        assert!(scope.is_private());
        assert!(!scope.should_persist());
        assert!(!scope.history_allowed());
        assert!(!scope.session_allowed());
        assert!(!scope.favicon_allowed());
        assert!(!scope.time_allowed());
        for action in ["history", "session", "favicon", "time", "future-path"] {
            assert!(!scope.check(action).persist(), "{action} must skip");
            assert_eq!(scope.check(action), WriteDecision::SkipPrivate);
        }
        let mut called = false;
        assert_eq!(
            scope.gate("history", || {
                called = true;
                42
            }),
            None
        );
        assert!(!called, "gated write must not run in private scope");
    }

    #[test]
    fn per_window_ids_detect_private_windows() {
        let mut ids = HashSet::new();
        ids.insert("win-private".to_owned());
        let scope = PrivateScope::with_private_windows(false, ids);
        assert!(!scope.is_private());
        assert!(scope.should_persist());
        assert!(scope.is_private_window("win-private"));
        assert!(!scope.is_private_window("win-1"));
    }

    #[test]
    fn snapshot_safety_net_catches_private_leaks() {
        let mut private = HashSet::new();
        private.insert("win-2".to_owned());
        let scope = PrivateScope::with_private_windows(false, private);
        // Clean snapshot from capture(): no private rows survive.
        let clean = SessionSnapshot::capture(
            SESSION_NAME_LAST,
            1,
            vec![SpaceSnapshot {
                uuid: "s".to_owned(),
                name: "S".to_owned(),
                position: 0,
                container_ref: None,
            }],
            vec![],
            vec![WindowSnapshot {
                window_id: "win-1".to_owned(),
                focused: true,
                title: String::new(),
            }],
            vec![TabSnapshot {
                astra_tab_id: "t1".to_owned(),
                space_uuid: None,
                folder_uuid: None,
                url: "https://public.example/".to_owned(),
                title: String::new(),
                pinned: false,
                position: 0,
                scroll: None,
                zoom: None,
                muted: false,
                discarded: false,
                window_id: "win-1".to_owned(),
                history: vec![],
                history_index: None,
            }],
            None,
            scope.private_window_ids(),
        );
        assert!(!snapshot_contains_private(&clean, &scope));
        // Hand-built snapshot smuggling a private tab is detected.
        let mut leaked = clean;
        leaked.tabs.push(TabSnapshot {
            astra_tab_id: "t-evil".to_owned(),
            space_uuid: None,
            folder_uuid: None,
            url: "https://secret.example/".to_owned(),
            title: String::new(),
            pinned: false,
            position: 9,
            scroll: None,
            zoom: None,
            muted: false,
            discarded: false,
            window_id: "win-2".to_owned(),
            history: vec![],
            history_index: None,
        });
        assert!(snapshot_contains_private(&leaked, &scope));
        let json = leaked.to_json().unwrap();
        assert_eq!(
            forensic_scan_snapshot_json(&json, &["secret.example"]),
            vec!["secret.example".to_owned()]
        );
        assert!(forensic_scan_snapshot_json(&json, &["absent.example"]).is_empty());
    }

    /// Forensic acceptance: drive history/session/favicon/time writes
    /// through the guard in private mode, then open the profile DB file
    /// directly and assert zero private rows; public mode persists.
    #[test]
    fn forensic_private_writes_leave_no_rows() {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("astra-p4t07-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("astra.db");

        let private_url = "https://private-forensic.example/secret";
        let public_url = "https://public-forensic.example/page";

        {
            let store = astra_store::Store::open(&db_path).unwrap();
            store.migrate().unwrap();

            // Private scope: every write is gated away.
            let scope = PrivateScope::private();
            scope.gate("history", || {
                store.history_add(private_url, "Secret", 100).unwrap()
            });
            scope.gate("session", || {
                store.session_save("last", private_url).unwrap()
            });
            scope.gate("favicon", || {
                store
                    .favicon_upsert(private_url, Some("https://x/i.png"), Some(&[9, 9]))
                    .unwrap()
            });
            let timed: Option<()> = scope.gate("time", || {
                store
                    .time_start(private_url, "private-forensic.example", "S", 50)
                    .unwrap();
            });
            assert!(timed.is_none());

            // Public scope: the same paths persist.
            let open = PrivateScope::public();
            open.gate("history", || {
                store.history_add(public_url, "Page", 200).unwrap()
            });
            open.gate("session", || {
                store.session_save("last", "{\"tabs\":[]}").unwrap()
            });
            open.gate("favicon", || {
                store
                    .favicon_upsert(public_url, Some("https://x/p.png"), Some(&[1]))
                    .unwrap()
            });
            open.gate("time", || {
                let row = store
                    .time_start(public_url, "public-forensic.example", "P", 60)
                    .unwrap();
                store.time_end(row.id, 120).unwrap();
            });
        }

        // Reopen the SQLite file directly (fresh handle, like a forensic
        // examiner) and assert zero private rows via the public API.
        let examiner = astra_store::Store::open(&db_path).unwrap();
        assert!(examiner
            .history_recent(100)
            .unwrap()
            .iter()
            .all(|r| r.url != private_url));
        assert!(examiner
            .history_search("private-forensic", 100)
            .unwrap()
            .is_empty());
        let session = examiner.session_load("last").unwrap().unwrap();
        assert!(!session.snapshot.contains("private-forensic"));
        assert!(examiner.favicon_get(private_url).unwrap().is_none());
        assert_eq!(
            examiner.time_for_host("private-forensic.example").unwrap(),
            0
        );
        // Public rows survived.
        assert!(examiner
            .history_recent(100)
            .unwrap()
            .iter()
            .any(|r| r.url == public_url));
        assert_eq!(
            examiner.time_for_host("public-forensic.example").unwrap(),
            60
        );

        // Raw-bytes sweep: the private marker must not appear anywhere in
        // the database file (WAL checkpointed on close by Store::open
        // semantics is not guaranteed, so check both files).
        let mut blobs: Vec<u8> = std::fs::read(&db_path).unwrap();
        for suffix in ["-wal", "-shm"] {
            let sidecar = db_path.with_extension(format!("db{suffix}"));
            if sidecar.exists() {
                blobs.extend(std::fs::read(&sidecar).unwrap());
            }
        }
        let text = String::from_utf8_lossy(&blobs);
        assert!(
            !text.contains("private-forensic"),
            "private URL leaked into profile DB bytes"
        );
        assert!(text.contains("public-forensic"), "public row must persist");

        // Profile dir holds only the core DB (no sidecar leakage files).
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|f| f == "astra.db"));
        assert!(
            names.iter().all(|f| !f.contains("private")),
            "no private-named files in profile dir: {names:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-store`: SQLite persistence skeleton (P2-T01).
//!
//! Opens file or in-memory databases with `rusqlite` (bundled SQLite),
//! applies idempotent migrations, and exposes the settings/history/
//! bookmark tables that `astra-core` domains persist through. The full
//! migration history port lands in P2-T04.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;
use thiserror::Error;

/// Current schema version applied by [`Store::migrate`].
pub const SCHEMA_VERSION: u32 = 1;

const MIGRATION_V1: &str = "
CREATE TABLE IF NOT EXISTS settings_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL,
    visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_visited_at ON history (visited_at DESC);
CREATE TABLE IF NOT EXISTS bookmarks (
    id         INTEGER PRIMARY KEY,
    url        TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
";

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("store poisoned: lock held by panicked thread")]
    Poisoned,
}

fn lock_err() -> StoreError {
    StoreError::Poisoned
}

/// One stored history visit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryRow {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub visited_at: i64,
}

/// One stored bookmark.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BookmarkRow {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub created_at: i64,
}

/// SQLite-backed store. `Send`; share across threads via reference.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    fn new(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Open (or create) a file-backed database.
    #[tracing::instrument(skip(path))]
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Ok(Self::new(Connection::open(path.as_ref())?))
    }

    /// Open a private in-memory database (tests, ephemeral profiles).
    pub fn open_in_memory() -> Result<Self, StoreError> {
        Ok(Self::new(Connection::open_in_memory()?))
    }

    /// Apply pending migrations idempotently; returns the schema version.
    #[tracing::instrument(skip(self))]
    pub fn migrate(&self) -> Result<u32, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute_batch(MIGRATION_V1)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(SCHEMA_VERSION)
    }

    /// Schema version recorded in the database file.
    pub fn user_version(&self) -> Result<u32, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    #[tracing::instrument(skip(self))]
    pub fn setting_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare("SELECT value FROM settings_kv WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    #[tracing::instrument(skip(self))]
    pub fn setting_set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO settings_kv (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn history_add(
        &self,
        url: &str,
        title: &str,
        visited_at: i64,
    ) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO history (url, title, visited_at) VALUES (?1, ?2, ?3)",
            params![url, title, visited_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn history_recent(&self, limit: u32) -> Result<Vec<HistoryRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, url, title, visited_at FROM history
             ORDER BY visited_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(HistoryRow {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                visited_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    #[tracing::instrument(skip(self))]
    pub fn bookmark_add(
        &self,
        url: &str,
        title: &str,
        created_at: i64,
    ) -> Result<i64, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO bookmarks (url, title, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (url) DO UPDATE SET title = excluded.title",
            params![url, title, created_at],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn bookmark_list(&self) -> Result<Vec<BookmarkRow>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, url, title, created_at FROM bookmarks ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(BookmarkRow {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Store {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.migrate().unwrap(), SCHEMA_VERSION);
        store
    }

    #[test]
    fn migrate_is_idempotent_and_records_version() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.migrate().unwrap(), 1);
        assert_eq!(store.migrate().unwrap(), 1);
        assert_eq!(store.user_version().unwrap(), SCHEMA_VERSION);
    }

    #[test]
    fn settings_kv_round_trip() {
        let store = migrated();
        assert_eq!(store.setting_get("theme").unwrap(), None);
        store.setting_set("theme", "dark").unwrap();
        assert_eq!(
            store.setting_get("theme").unwrap(),
            Some("dark".to_owned())
        );
        store.setting_set("theme", "light").unwrap();
        assert_eq!(
            store.setting_get("theme").unwrap(),
            Some("light".to_owned())
        );
    }

    #[test]
    fn history_orders_most_recent_first() {
        let store = migrated();
        store.history_add("https://a.example", "A", 10).unwrap();
        store.history_add("https://b.example", "B", 30).unwrap();
        store.history_add("https://c.example", "C", 20).unwrap();
        let recent = store.history_recent(2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].url, "https://b.example");
        assert_eq!(recent[1].url, "https://c.example");
    }

    #[test]
    fn bookmarks_upsert_by_url() {
        let store = migrated();
        store.bookmark_add("https://a.example", "A", 1).unwrap();
        store.bookmark_add("https://a.example", "A2", 2).unwrap();
        let all = store.bookmark_list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "A2");
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of this file was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Memory + history recall (P6-T08).
//!
//! The `memory_items` table itself is created by the v4 migration in the
//! crate root (non-destructive, like every migration: `migrate()` only ever
//! adds). This module layers versioned, non-destructive behaviour on top:
//!
//! - [`MEMORY_SCHEMA_VERSION`], tracked in `schema_meta` under
//!   [`MEMORY_SCHEMA_KEY`], gates idempotent DDL applied by
//!   [`Store::ensure_memory_schema`] (extra indexes only — never table
//!   rewrites, never data loss). Bumping the constant plus a new
//!   `IF NOT EXISTS` block is the whole upgrade path.
//! - CRUD ([`Store::memory_create`], [`Store::memory_get`],
//!   [`Store::memory_list`], [`Store::memory_update`],
//!   [`Store::memory_delete`]) with hard deletion: `memory_delete` issues a
//!   real `DELETE`, so the row is unreadable through every API *and* through
//!   raw SQL afterwards. See the deletion section below.
//! - Ranked recall: [`Store::memory_search`] (LIKE-based, ranked in Rust so
//!   the on-disk format stays plain rows — no FTS shadow tables, which
//!   would leak into `export_json` table dumps) and
//!   [`Store::history_search_ranked`] over the existing `history` table.
//!
//! ## Deletion semantics
//!
//! `memory_delete(uuid)` runs `DELETE FROM memory_items WHERE uuid = ?`.
//! There is no tombstone: the `deleted_at` column from v4 is left for the
//! legacy [`Store::memory_put`]/[`Store::memory_recall`] path and is never
//! set by this module. Consequences, all covered by
//! `memory_delete_actually_removes_data`:
//!
//! - API: `memory_get`, `memory_list`, and `memory_search` no longer return
//!   the row (every read filters on physical presence — there is no flag
//!   left to misread).
//! - Raw SQL: `SELECT COUNT(*) FROM memory_items WHERE uuid = ?` is 0.
//! - Index: the v5 indexes (`idx_memory_items_scope_updated`,
//!   `idx_memory_items_updated`) are plain B-tree indexes maintained by
//!   SQLite itself, so the deleted entry's index records disappear in the
//!   same statement — no separate invalidation step exists or is needed.
//! - File bytes: SQLite keeps freed pages on the freelist, so a forensic
//!   byte sweep may still see the content until the pages are reused.
//!   [`Store::memory_vacuum`] runs `VACUUM` (rebuilds the file, drops the
//!   freelist) for callers that need the bytes gone now, e.g. right after a
//!   user-initiated delete. Auto-vacuuming on every delete is deliberately
//!   avoided: `VACUUM` rewrites the whole file and would stall the UI.
//!
//! ## Private scope
//!
//! Memory writes must respect the private-scope guard owned by `astra-core`
//! (`PrivateScope`, P4-T07/P5-T04): private windows persist nothing. The
//! store cannot depend on `astra-core` (it would be circular — core
//! dev-depends on the store), so the contract is split:
//!
//! - Callers (the agent hook in `astra-agents`, the `memory_ext` facade in
//!   `astra-core`) gate writes with `PrivateScope::check("memory")` and
//!   never call [`Store::memory_create`] in private scope.
//! - As defence in depth, [`Store::memory_create`] itself rejects the
//!   literal scope `"private"` — a private row can never be persisted even
//!   if a caller forgets the gate.

use rusqlite::params;

use crate::{is_safe_ident, lock_err, new_uuid, now_utc, Store, StoreError};

/// Version of the memory-layer DDL applied by [`Store::ensure_memory_schema`].
/// Bump when adding new idempotent index DDL; old databases pick it up on
/// next startup with their rows intact.
pub const MEMORY_SCHEMA_VERSION: u32 = 1;

/// `schema_meta` key tracking [`MEMORY_SCHEMA_VERSION`].
pub const MEMORY_SCHEMA_KEY: &str = "memory_schema_version";

/// Scopes accepted by [`Store::memory_create`]. `"private"` is rejected
/// (see module docs); anything else non-empty persists.
pub const MEMORY_SCOPES: &[&str] = &["global", "site", "ephemeral"];

/// Maximum memory content length enforced at the store layer, mirroring the
/// agent layer's cap so oversized writes fail loudly at both boundaries.
pub const MAX_MEMORY_CONTENT_CHARS: usize = 16_000;

/// One memory row with timestamps (the root [`crate::MemoryItemRow`] omits
/// them; this record is the full CRUD shape for the P6-T08 API).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MemoryRecord {
    pub id: i64,
    pub uuid: String,
    pub scope: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One ranked memory hit from [`Store::memory_search`].
#[derive(Clone, Debug, PartialEq)]
pub struct MemoryHit {
    pub record: MemoryRecord,
    /// Higher is more relevant. See [`Store::memory_search`] for the formula.
    pub rank: f64,
}

/// One ranked history hit from [`Store::history_search_ranked`].
#[derive(Clone, Debug, PartialEq)]
pub struct RankedHistory {
    pub id: i64,
    pub uuid: String,
    pub url: String,
    pub title: String,
    pub visit_time: i64,
    /// Higher is more relevant. See [`Store::history_search_ranked`].
    pub rank: f64,
}

fn decode_record(row: &rusqlite::Row) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: row.get(0)?,
        uuid: row.get(1)?,
        scope: row.get(2)?,
        content: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// Escape `%`, `_`, and the escape character itself for a `LIKE` pattern.
fn escape_like(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for ch in query.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Count non-overlapping case-insensitive occurrences of `needle` in `haystack`.
fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let hay = haystack.to_lowercase();
    let ndl = needle.to_lowercase();
    let mut count = 0;
    let mut from = 0;
    while let Some(pos) = hay[from..].find(&ndl) {
        count += 1;
        from += pos + ndl.len();
    }
    count
}

impl Store {
    /// Apply pending memory-layer DDL idempotently and record
    /// [`MEMORY_SCHEMA_VERSION`] in `schema_meta`. Safe on every startup;
    /// already-current databases are a no-op. Never touches row data.
    pub fn ensure_memory_schema(&self) -> Result<u32, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_items_scope_updated
             ON memory_items (scope, updated_at DESC)",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_items_updated
             ON memory_items (updated_at DESC)",
            [],
        )?;
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![MEMORY_SCHEMA_KEY, MEMORY_SCHEMA_VERSION.to_string()],
        )?;
        Ok(MEMORY_SCHEMA_VERSION)
    }

    /// Recorded memory-layer schema version, if [`Store::ensure_memory_schema`]
    /// has ever run on this database.
    pub fn memory_schema_version(&self) -> Result<Option<String>, StoreError> {
        self.schema_meta_get(MEMORY_SCHEMA_KEY)
    }

    fn validate_memory_write(scope: &str, content: &str) -> Result<(), StoreError> {
        if scope == "private" {
            return Err(StoreError::Import(
                "memory scope \"private\" is never persisted (private-scope exclusion)".to_owned(),
            ));
        }
        if scope.trim().is_empty() {
            return Err(StoreError::Import(
                "memory scope must not be empty".to_owned(),
            ));
        }
        if content.trim().is_empty() {
            return Err(StoreError::Import(
                "memory content must not be empty".to_owned(),
            ));
        }
        if content.chars().count() > MAX_MEMORY_CONTENT_CHARS {
            return Err(StoreError::Import(format!(
                "memory content exceeds {MAX_MEMORY_CONTENT_CHARS} chars"
            )));
        }
        Ok(())
    }

    /// Persist one memory row. Rejects the `"private"` scope and empty /
    /// oversized content loudly; callers must additionally gate on
    /// `PrivateScope::check("memory")` so private-window content never
    /// reaches this function (see module docs).
    pub fn memory_create(&self, scope: &str, content: &str) -> Result<MemoryRecord, StoreError> {
        Self::validate_memory_write(scope, content)?;
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        let uuid = new_uuid();
        conn.execute(
            "INSERT INTO memory_items (uuid, scope, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![uuid, scope, content, now],
        )?;
        Ok(MemoryRecord {
            id: conn.last_insert_rowid(),
            uuid,
            scope: scope.to_owned(),
            content: content.to_owned(),
            created_at: now,
            updated_at: now,
        })
    }

    /// Fetch one memory row by UUID. Returns `None` when no live row
    /// exists — including after [`Store::memory_delete`], which removes the
    /// row physically rather than tombstoning it.
    pub fn memory_get(&self, uuid: &str) -> Result<Option<MemoryRecord>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, scope, content, created_at, updated_at FROM memory_items
             WHERE uuid = ?1 AND deleted_at IS NULL",
        )?;
        let mut rows = stmt.query(params![uuid])?;
        match rows.next()? {
            Some(row) => Ok(Some(decode_record(row)?)),
            None => Ok(None),
        }
    }

    /// List memory rows, newest first. `scope` filters to one scope;
    /// `None` lists every non-private scope (private rows cannot exist —
    /// writes reject that scope — so no extra filter is needed).
    pub fn memory_list(
        &self,
        scope: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MemoryRecord>, StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, scope, content, created_at, updated_at FROM memory_items
             WHERE deleted_at IS NULL AND (?1 IS NULL OR scope = ?1)
             ORDER BY updated_at DESC, id DESC LIMIT ?2",
        )?;
        let collected = stmt
            .query_map(params![scope, limit], decode_record)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from);
        collected
    }

    /// Replace a row's content and bump `updated_at`. Returns `None` when
    /// the UUID names no live row. Validation matches
    /// [`Store::memory_create`].
    pub fn memory_update(
        &self,
        uuid: &str,
        content: &str,
    ) -> Result<Option<MemoryRecord>, StoreError> {
        let current = self.memory_get(uuid)?;
        let Some(current) = current else {
            return Ok(None);
        };
        Self::validate_memory_write(&current.scope, content)?;
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let now = now_utc();
        conn.execute(
            "UPDATE memory_items SET content = ?1, updated_at = ?2
             WHERE uuid = ?3 AND deleted_at IS NULL",
            params![content, now, uuid],
        )?;
        Ok(Some(MemoryRecord {
            content: content.to_owned(),
            updated_at: now,
            ..current
        }))
    }

    /// Hard-delete one memory row by UUID. Returns `true` when a row was
    /// removed. The `DELETE` is physical: afterwards the content is
    /// unreachable via this API and via raw SQL (see module docs for the
    /// freelist / [`Store::memory_vacuum`] caveat on file bytes).
    pub fn memory_delete(&self, uuid: &str) -> Result<bool, StoreError> {
        if !is_safe_ident(&uuid.replace('-', "")) {
            // UUIDs are bound as parameters, so this is only a cheap
            // fail-fast for garbage input, not injection protection.
            return Ok(false);
        }
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let removed = conn.execute("DELETE FROM memory_items WHERE uuid = ?1", params![uuid])?;
        Ok(removed > 0)
    }

    /// Ranked full-text-ish search over memory content.
    ///
    /// Candidate selection is `LIKE '%escaped%'` (wildcards in the query
    /// are escaped, so a literal `%` never becomes a wildcard). Ranking
    /// happens in Rust, newest-timestamp tiebreak:
    ///
    /// ```text
    /// rank = 10 * occurrences(query in content, case-insensitive)
    ///      +  2 * occurrences(query in scope)
    ///      +  recency, where recency = row.updated_at as f64 scaled by 1e-12
    /// ```
    ///
    /// The recency term only ever breaks ties between rows with equal
    /// text scores (epoch seconds are ~1e9, so the term is ~1e-3). LIKE
    /// keeps the on-disk format as plain rows with no FTS shadow tables,
    /// which keeps `export_json` dumps stable.
    pub fn memory_search(
        &self,
        query: &str,
        scope: Option<&str>,
        limit: u32,
    ) -> Result<Vec<MemoryHit>, StoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(query));
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, scope, content, created_at, updated_at FROM memory_items
             WHERE deleted_at IS NULL AND (?1 IS NULL OR scope = ?1)
               AND content LIKE ?2 ESCAPE '\\'
             ORDER BY updated_at DESC, id DESC LIMIT ?3",
        )?;
        let mut hits: Vec<MemoryHit> = stmt
            .query_map(params![scope, like, limit * 4], decode_record)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)?
            .into_iter()
            .map(|record| {
                let rank = 10.0 * count_occurrences(&record.content, query) as f64
                    + 2.0 * count_occurrences(&record.scope, query) as f64
                    + (record.updated_at as f64) / 1e12;
                MemoryHit { record, rank }
            })
            .collect();
        hits.sort_by(|a, b| {
            b.rank
                .partial_cmp(&a.rank)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit as usize);
        Ok(hits)
    }

    /// Ranked history search for agent recall. History is read-only from
    /// the agent's side — recalling a visit never deletes or mutates it —
    /// and private-window visits are never in the index (callers gate
    /// `history_add` on `PrivateScope`, P4-T07).
    ///
    /// Ranking, documented to match: title matches outrank URL-only
    /// matches, then visit recency decides:
    ///
    /// ```text
    /// rank = 10 * occurrences(query in title, case-insensitive)
    ///      +  3 * occurrences(query in url, case-insensitive)
    ///      +  recency, where recency = visit_time scaled by 1e-12 (tiebreak only)
    /// ```
    pub fn history_search_ranked(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<RankedHistory>, StoreError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let like = format!("%{}%", escape_like(query));
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn.prepare(
            "SELECT id, uuid, url, title, visit_time FROM history
             WHERE deleted_at IS NULL AND (url LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\')
             ORDER BY visit_time DESC LIMIT ?2",
        )?;
        let mut hits: Vec<RankedHistory> = stmt
            .query_map(params![like, limit * 4], |row| {
                Ok(RankedHistory {
                    id: row.get(0)?,
                    uuid: row.get(1)?,
                    url: row.get(2)?,
                    title: row.get(3)?,
                    visit_time: row.get(4)?,
                    rank: 0.0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StoreError::from)?
            .into_iter()
            .map(|mut hit| {
                hit.rank = 10.0 * count_occurrences(&hit.title, query) as f64
                    + 3.0 * count_occurrences(&hit.url, query) as f64
                    + (hit.visit_time as f64) / 1e12;
                hit
            })
            .collect();
        hits.sort_by(|a, b| {
            b.rank
                .partial_cmp(&a.rank)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(limit as usize);
        Ok(hits)
    }

    /// Rebuild the database file, dropping freelist pages. Call after
    /// user-initiated [`Store::memory_delete`] when the freed bytes must
    /// leave the file now rather than on page reuse. Deliberately manual:
    /// `VACUUM` rewrites the whole file and must not run per-delete.
    pub fn memory_vacuum(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute("VACUUM", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated() -> Store {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.migrate().unwrap(), crate::SCHEMA_VERSION);
        assert_eq!(store.ensure_memory_schema().unwrap(), MEMORY_SCHEMA_VERSION);
        store
    }

    #[test]
    fn ensure_memory_schema_is_idempotent_and_versioned() {
        let store = migrated();
        assert_eq!(store.ensure_memory_schema().unwrap(), MEMORY_SCHEMA_VERSION);
        assert_eq!(
            store.memory_schema_version().unwrap(),
            Some(MEMORY_SCHEMA_VERSION.to_string())
        );
    }

    #[test]
    fn memory_crud_round_trip() {
        let store = migrated();
        let row = store.memory_create("global", "prefers dark mode").unwrap();
        assert!(!row.uuid.is_empty());

        let fetched = store.memory_get(&row.uuid).unwrap().unwrap();
        assert_eq!(fetched, row);

        // Legacy v4 rows coexist with the new API (non-destructive layering).
        let legacy = store.memory_put("global", "legacy fact").unwrap();
        assert!(store.memory_get(&legacy.uuid).unwrap().is_some());

        let listed = store.memory_list(None, 10).unwrap();
        assert_eq!(listed.len(), 2);
        let scoped = store.memory_list(Some("site"), 10).unwrap();
        assert!(scoped.is_empty());

        let updated = store
            .memory_update(&row.uuid, "prefers light mode")
            .unwrap()
            .unwrap();
        assert_eq!(updated.content, "prefers light mode");
        assert_eq!(
            store.memory_get(&row.uuid).unwrap().unwrap().content,
            "prefers light mode"
        );

        assert!(store
            .memory_update("does-not-exist", "x")
            .unwrap()
            .is_none());
        assert!(!store.memory_delete("does-not-exist").unwrap());
    }

    #[test]
    fn memory_writes_reject_private_scope_and_bad_content() {
        let store = migrated();
        // Defence in depth: even if a caller forgets the PrivateScope gate,
        // the private scope can never persist.
        assert!(store
            .memory_create("private", "secret")
            .unwrap_err()
            .to_string()
            .contains("private"));
        assert!(store.memory_create("", "x").is_err());
        assert!(store.memory_create("global", "   ").is_err());
        let oversized = "x".repeat(MAX_MEMORY_CONTENT_CHARS + 1);
        assert!(store.memory_create("global", &oversized).is_err());
        assert_eq!(store.memory_list(None, 10).unwrap().len(), 0);
    }

    #[test]
    fn memory_search_ranks_occurrences_before_recency() {
        let store = migrated();
        store
            .memory_create("global", "keyboards are great")
            .unwrap();
        store
            .memory_create("global", "keyboards keyboards keyboards forever")
            .unwrap();
        let hits = store.memory_search("keyboards", None, 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].rank > hits[1].rank);
        assert!(hits[0].record.content.contains("forever"));
        // Scope filter + limit + empty query.
        assert_eq!(
            store
                .memory_search("keyboards", Some("site"), 10)
                .unwrap()
                .len(),
            0
        );
        assert_eq!(store.memory_search("keyboards", None, 1).unwrap().len(), 1);
        assert!(store.memory_search("   ", None, 10).unwrap().is_empty());
        // Literal wildcards never become wildcards.
        store
            .memory_create("global", "100% coverage_score")
            .unwrap();
        assert_eq!(store.memory_search("100%", None, 10).unwrap().len(), 1);
        assert_eq!(store.memory_search("%", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn memory_delete_actually_removes_data() {
        let store = migrated();
        let row = store.memory_create("global", "wipe me: hunter2").unwrap();
        assert!(store.memory_delete(&row.uuid).unwrap());

        // Via the API: every read path is blind to the row.
        assert!(store.memory_get(&row.uuid).unwrap().is_none());
        assert!(store.memory_list(None, 10).unwrap().is_empty());
        assert!(store.memory_search("hunter2", None, 10).unwrap().is_empty());

        // Via raw SQL: no row, no tombstone, nothing to resurrect.
        {
            let conn = store.conn.lock().unwrap();
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_items WHERE uuid = ?1",
                    params![row.uuid],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))
                .unwrap();
            assert_eq!(total, 0);
        }

        // VACUUM keeps the database healthy and drops the freelist pages
        // holding the deleted bytes; the index needs no invalidation
        // (SQLite maintains it in the same DELETE statement).
        store.memory_vacuum().unwrap();
        {
            let conn = store.conn.lock().unwrap();
            let freelist: i64 = conn
                .pragma_query_value(None, "freelist_count", |r| r.get(0))
                .unwrap();
            assert_eq!(freelist, 0);
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_items WHERE uuid = ?1",
                    params![row.uuid],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
    }

    #[test]
    fn history_search_ranked_prefers_title_then_recency() {
        let store = migrated();
        store
            .history_add("https://docs.example/keyboards", "Unrelated", 10)
            .unwrap();
        store
            .history_add("https://other.example/x", "Best keyboards guide", 20)
            .unwrap();
        store
            .history_add("https://shop.example/y", "Older keyboards guide", 5)
            .unwrap();
        let hits = store.history_search_ranked("keyboards", 10).unwrap();
        assert_eq!(hits.len(), 3);
        // Title matches (weight 10) outrank the URL-only match (weight 3);
        // among title matches the newer visit wins the recency tiebreak.
        assert_eq!(hits[0].title, "Best keyboards guide");
        assert_eq!(hits[1].title, "Older keyboards guide");
        assert_eq!(hits[2].title, "Unrelated");
        assert!(hits[0].rank > hits[1].rank && hits[1].rank > hits[2].rank);
        assert_eq!(
            store.history_search_ranked("keyboards", 1).unwrap().len(),
            1
        );
        assert!(store.history_search_ranked("  ", 10).unwrap().is_empty());
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Memory and history-search stubs (store wiring in P6-T08).
//!
//! Memory is user-visible state the agent may recall: [`MemoryItem`] is the
//! versioned record (persisted in the `astra-store` `memory_items` table;
//! deletion there actually removes the row — tested in P6-T08).
//! [`MemoryHook`] lets the loop file run outcomes back into memory, and
//! [`HistoryQuery`] is the shape the loop uses to search browsing history
//! through the store's `history_search` API.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Memory-item format version. Bump on any breaking shape change and keep
/// [`MemoryError::VersionMismatch`] so old rows fail loudly, never silently.
pub const MEMORY_VERSION: u32 = 1;

/// Maximum memory content length accepted by [`MemoryItem::validate`].
pub const MAX_MEMORY_CHARS: usize = 16_000;

/// Scope of one memory item.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    /// Applies everywhere (preferences, durable facts).
    Global,
    /// Applies to one site or host.
    Site,
    /// Applies to one run only (scratch notes).
    Ephemeral,
}

/// Versioned memory record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryItem {
    pub version: u32,
    pub item_id: String,
    pub scope: MemoryScope,
    pub content: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum MemoryError {
    #[error("unsupported memory version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid memory item: {0}")]
    Invalid(String),
    #[error("memory JSON error: {0}")]
    Json(String),
    #[error("memory store error: {0}")]
    Store(String),
}

impl MemoryItem {
    /// New memory item.
    pub fn new(
        item_id: impl Into<String>,
        scope: MemoryScope,
        content: impl Into<String>,
        created_at: i64,
    ) -> Self {
        Self {
            version: MEMORY_VERSION,
            item_id: item_id.into(),
            scope,
            content: content.into(),
            created_at,
            site: None,
        }
    }

    /// Pin a site-scoped item to one host.
    pub fn for_site(mut self, site: impl Into<String>) -> Self {
        self.scope = MemoryScope::Site;
        self.site = Some(site.into());
        self
    }

    /// Serialize to the string stored in the `memory_items` row.
    pub fn to_json(&self) -> Result<String, MemoryError> {
        serde_json::to_string(self).map_err(|e| MemoryError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, MemoryError> {
        let item: Self =
            serde_json::from_str(json).map_err(|e| MemoryError::Json(e.to_string()))?;
        item.validate()?;
        Ok(item)
    }

    /// Structural validation: version, non-empty id/content, site scope
    /// names a site.
    pub fn validate(&self) -> Result<(), MemoryError> {
        if self.version != MEMORY_VERSION {
            return Err(MemoryError::VersionMismatch(self.version, MEMORY_VERSION));
        }
        if self.item_id.is_empty() {
            return Err(MemoryError::Invalid("item_id must not be empty".to_owned()));
        }
        if self.content.trim().is_empty() {
            return Err(MemoryError::Invalid("content must not be empty".to_owned()));
        }
        if self.content.chars().count() > MAX_MEMORY_CHARS {
            return Err(MemoryError::Invalid(format!(
                "content exceeds {MAX_MEMORY_CHARS} chars"
            )));
        }
        if self.scope == MemoryScope::Site && self.site.as_deref().unwrap_or("").is_empty() {
            return Err(MemoryError::Invalid(
                "site-scoped memory must name a site".to_owned(),
            ));
        }
        Ok(())
    }
}

/// One history-search request from the loop to the store. Free-text query
/// plus a result cap; the store answers with its `history_search` rows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryQuery {
    pub query: String,
    #[serde(default = "default_history_limit")]
    pub limit: u32,
}

fn default_history_limit() -> u32 {
    20
}

impl HistoryQuery {
    /// New query with the default result cap.
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            limit: default_history_limit(),
        }
    }

    /// Structural validation: non-empty query, sane cap.
    pub fn validate(&self) -> Result<(), MemoryError> {
        if self.query.trim().is_empty() {
            return Err(MemoryError::Invalid(
                "history query must not be empty".to_owned(),
            ));
        }
        if self.limit == 0 || self.limit > 100 {
            return Err(MemoryError::Invalid(
                "history limit must be 1..=100".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Hook the loop calls at run boundaries so outcomes can be filed back
/// into memory (P6-T08 decides what is worth keeping; the user can always
/// view, edit, and delete what was kept).
pub trait MemoryHook {
    /// File the finished run's summary into memory. No-op by default.
    fn on_run_end(&mut self, _run_id: &str, _summary: &str) {}

    /// Recall items relevant to `hint`. Empty by default (no memory yet).
    fn recall(&self, _hint: &str) -> Vec<MemoryItem> {
        Vec::new()
    }
}

/// No-op hook for loops that file nothing.
#[derive(Clone, Debug, Default)]
pub struct NullMemoryHook;

impl MemoryHook for NullMemoryHook {}

/// Storage backend behind [`StoreMemoryHook`]. Mirrors the `astra-store`
/// memory API (`memory_create` / `memory_get` / `memory_list` /
/// `memory_update` / `memory_delete` / `memory_search`, plus ranked history
/// search) without taking a dependency on the store crate: the real
/// adapter lives at the wiring layer, tests use [`InMemoryMemoryStore`].
/// Read-only with respect to the store crate itself — this trait only
/// *calls* the store API, it never modifies store code.
pub trait MemoryStore {
    /// Persist one memory item.
    fn memory_save(&mut self, item: MemoryItem) -> Result<MemoryItem, MemoryError>;
    /// Fetch one item by id. `None` when no live row exists.
    fn memory_load(&self, item_id: &str) -> Result<Option<MemoryItem>, MemoryError>;
    /// List items, newest first. `scope` filters; `None` lists all scopes.
    fn memory_list(
        &self,
        scope: Option<MemoryScope>,
        limit: u32,
    ) -> Result<Vec<MemoryItem>, MemoryError>;
    /// Ranked content search (empty on blank queries).
    fn memory_search(&self, query: &str, limit: u32) -> Result<Vec<MemoryItem>, MemoryError>;
    /// Replace an item's content. `None` when the id names no live row.
    fn memory_update(
        &mut self,
        item_id: &str,
        content: &str,
    ) -> Result<Option<MemoryItem>, MemoryError>;
    /// Hard-delete an item. `true` when a row was removed; the content is
    /// then unreadable (store P6-T08 acceptance: write → delete → assert
    /// unreadable via raw SQL and via API).
    fn memory_delete(&mut self, item_id: &str) -> Result<bool, MemoryError>;
    /// Ranked history recall for a validated [`HistoryQuery`]. Read-only:
    /// recalling a visit never deletes or mutates it.
    fn history_recall(&self, query: &HistoryQuery) -> Result<Vec<HistoryHit>, MemoryError>;
}

/// One ranked history hit recalled through [`MemoryStore::history_recall`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HistoryHit {
    pub url: String,
    pub title: String,
    pub rank: f64,
}

impl HistoryHit {
    /// New hit. Rank is store-computed (title matches outrank URL-only
    /// matches, then recency); higher is more relevant.
    pub fn new(url: impl Into<String>, title: impl Into<String>, rank: f64) -> Self {
        Self {
            url: url.into(),
            title: title.into(),
            rank,
        }
    }
}

/// Keep-policy + user-controls hook backed by a [`MemoryStore`].
///
/// - Filing (`on_run_end`): keeps a trimmed summary only when it is
///   non-empty, fits [`MAX_MEMORY_CHARS`], and persistence is enabled
///   (the private-scope gate: private windows persist nothing, so the
///   wiring layer constructs this hook with `persist = false` there and
///   nothing is ever filed). Overlong summaries are filed truncated to the
///   cap rather than dropped.
/// - Recall: blank hints recall nothing; otherwise delegates to the
///   store's ranked search.
/// - User controls: [`StoreMemoryHook::list`], `search_memories`,
///   `update_memory`, and `delete_memory` expose view/edit/delete over the
///   same trait; deletion reports whether a row was actually removed.
pub struct StoreMemoryHook<S: MemoryStore> {
    store: S,
    persist: bool,
    scope: MemoryScope,
}

impl<S: MemoryStore> StoreMemoryHook<S> {
    /// New hook. `persist = false` in private scope (nothing filed, recall
    /// stays empty); `scope` is the scope filed summaries get (default
    /// [`MemoryScope::Global`] via [`StoreMemoryHook::persisting`]).
    pub fn new(store: S, persist: bool, scope: MemoryScope) -> Self {
        Self {
            store,
            persist,
            scope,
        }
    }

    /// Persisting hook filing [`MemoryScope::Global`] summaries.
    pub fn persisting(store: S) -> Self {
        Self::new(store, true, MemoryScope::Global)
    }

    /// Non-persisting hook for private scope: files and recalls nothing.
    pub fn private(store: S) -> Self {
        Self::new(store, false, MemoryScope::Global)
    }

    /// Whether this hook files and recalls (false in private scope).
    pub fn can_persist(&self) -> bool {
        self.persist
    }

    /// User control: list memories, newest first.
    pub fn list(
        &self,
        scope: Option<MemoryScope>,
        limit: u32,
    ) -> Result<Vec<MemoryItem>, MemoryError> {
        if !self.persist {
            return Ok(Vec::new());
        }
        self.store.memory_list(scope, limit)
    }

    /// User control: ranked memory search.
    pub fn search_memories(&self, query: &str, limit: u32) -> Result<Vec<MemoryItem>, MemoryError> {
        if !self.persist || query.trim().is_empty() {
            return Ok(Vec::new());
        }
        self.store.memory_search(query, limit)
    }

    /// User control: edit a memory's content.
    pub fn update_memory(
        &mut self,
        item_id: &str,
        content: &str,
    ) -> Result<Option<MemoryItem>, MemoryError> {
        if !self.persist {
            return Ok(None);
        }
        if content.trim().is_empty() {
            return Err(MemoryError::Invalid("content must not be empty".to_owned()));
        }
        self.store.memory_update(item_id, content)
    }

    /// User control: delete a memory. Returns `true` only when a row was
    /// actually removed.
    pub fn delete_memory(&mut self, item_id: &str) -> Result<bool, MemoryError> {
        if !self.persist {
            return Ok(false);
        }
        self.store.memory_delete(item_id)
    }

    /// Agent read path: ranked history recall through the store.
    pub fn recall_history(&self, query: &HistoryQuery) -> Result<Vec<HistoryHit>, MemoryError> {
        query.validate()?;
        if !self.persist {
            return Ok(Vec::new());
        }
        self.store.history_recall(query)
    }

    /// Boring accessor for wiring layers that own the store.
    pub fn store(&self) -> &S {
        &self.store
    }
}

/// Keep-policy shared by `on_run_end`: what is worth keeping. `None`
/// means "file nothing" (empty summary); otherwise the content to file
/// (truncated to [`MAX_MEMORY_CHARS`] so it always validates).
pub fn filing_content(summary: &str) -> Option<String> {
    let trimmed = summary.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_MEMORY_CHARS).collect())
}

impl<S: MemoryStore> MemoryHook for StoreMemoryHook<S> {
    fn on_run_end(&mut self, run_id: &str, summary: &str) {
        if !self.persist {
            return;
        }
        let Some(content) = filing_content(summary) else {
            return;
        };
        let item = MemoryItem::new(run_id, self.scope, content, 0);
        // Filing is best-effort: a store failure must never fail the run.
        if item.validate().is_ok() {
            let _ = self.store.memory_save(item);
        }
    }

    fn recall(&self, hint: &str) -> Vec<MemoryItem> {
        if !self.persist || hint.trim().is_empty() {
            return Vec::new();
        }
        self.store.memory_search(hint, 20).unwrap_or_default()
    }
}

/// In-memory [`MemoryStore`] for tests and wiring examples. Eviction-free;
/// deletion removes the entry so `memory_load` afterwards is `None`.
#[derive(Clone, Debug, Default)]
pub struct InMemoryMemoryStore {
    items: Vec<MemoryItem>,
    history: Vec<HistoryHit>,
}

impl InMemoryMemoryStore {
    /// New empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed history hits (test/wiring helper).
    pub fn with_history(mut self, history: Vec<HistoryHit>) -> Self {
        self.history = history;
        self
    }
}

impl MemoryStore for InMemoryMemoryStore {
    fn memory_save(&mut self, item: MemoryItem) -> Result<MemoryItem, MemoryError> {
        item.validate()?;
        if let Some(slot) = self.items.iter_mut().find(|i| i.item_id == item.item_id) {
            *slot = item.clone();
        } else {
            self.items.push(item.clone());
        }
        Ok(item)
    }

    fn memory_load(&self, item_id: &str) -> Result<Option<MemoryItem>, MemoryError> {
        Ok(self.items.iter().find(|i| i.item_id == item_id).cloned())
    }

    fn memory_list(
        &self,
        scope: Option<MemoryScope>,
        limit: u32,
    ) -> Result<Vec<MemoryItem>, MemoryError> {
        let mut out: Vec<MemoryItem> = self
            .items
            .iter()
            .filter(|i| scope.is_none_or(|s| i.scope == s))
            .cloned()
            .collect();
        out.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        out.truncate(limit as usize);
        Ok(out)
    }

    fn memory_search(&self, query: &str, limit: u32) -> Result<Vec<MemoryItem>, MemoryError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let needle = query.to_lowercase();
        let mut out: Vec<MemoryItem> = self
            .items
            .iter()
            .filter(|i| i.content.to_lowercase().contains(&needle))
            .cloned()
            .collect();
        out.sort_by_key(|i| std::cmp::Reverse(i.created_at));
        out.truncate(limit as usize);
        Ok(out)
    }

    fn memory_update(
        &mut self,
        item_id: &str,
        content: &str,
    ) -> Result<Option<MemoryItem>, MemoryError> {
        let Some(slot) = self.items.iter_mut().find(|i| i.item_id == item_id) else {
            return Ok(None);
        };
        slot.content = content.to_owned();
        slot.validate()?;
        Ok(Some(slot.clone()))
    }

    fn memory_delete(&mut self, item_id: &str) -> Result<bool, MemoryError> {
        let before = self.items.len();
        self.items.retain(|i| i.item_id != item_id);
        Ok(self.items.len() < before)
    }

    fn history_recall(&self, query: &HistoryQuery) -> Result<Vec<HistoryHit>, MemoryError> {
        query.validate()?;
        let needle = query.query.to_lowercase();
        let mut out: Vec<HistoryHit> = self
            .history
            .iter()
            .filter(|h| {
                h.url.to_lowercase().contains(&needle) || h.title.to_lowercase().contains(&needle)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            b.rank
                .partial_cmp(&a.rank)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.truncate(query.limit as usize);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_item_json_round_trip() {
        let item = MemoryItem::new("m1", MemoryScope::Site, "prefers dark mode", 42)
            .for_site("example.com");
        assert!(item.validate().is_ok());
        assert_eq!(
            MemoryItem::from_json(&item.to_json().unwrap()).unwrap(),
            item
        );
    }

    #[test]
    fn memory_version_mismatch_fails_loudly() {
        let mut item = MemoryItem::new("m1", MemoryScope::Global, "fact", 1);
        item.version = 999;
        assert_eq!(
            item.validate(),
            Err(MemoryError::VersionMismatch(999, MEMORY_VERSION))
        );
        assert!(MemoryItem::from_json(&item.to_json().unwrap()).is_err());
        assert!(matches!(
            MemoryItem::from_json("{not json"),
            Err(MemoryError::Json(_))
        ));
    }

    #[test]
    fn memory_validation_rejects_broken_shapes() {
        assert!(MemoryItem::new("", MemoryScope::Global, "fact", 1)
            .validate()
            .is_err());
        assert!(MemoryItem::new("m", MemoryScope::Global, "  ", 1)
            .validate()
            .is_err());
        assert!(MemoryItem::new("m", MemoryScope::Site, "fact", 1)
            .validate()
            .is_err());
        assert!(HistoryQuery::new("  ").validate().is_err());
        assert!(HistoryQuery::new("x").validate().is_ok());
        let mut q = HistoryQuery::new("x");
        q.limit = 0;
        assert!(q.validate().is_err());
    }

    #[test]
    fn null_hook_files_nothing_and_recalls_nothing() {
        let mut hook = NullMemoryHook;
        hook.on_run_end("run-1", "done");
        assert!(hook.recall("anything").is_empty());
    }

    fn filed_item(content: &str) -> MemoryItem {
        MemoryItem::new("run-1", MemoryScope::Global, content, 7)
    }

    #[test]
    fn filing_policy_skips_empty_and_truncates_overlong() {
        assert_eq!(filing_content("   "), None);
        assert_eq!(filing_content(""), None);
        assert_eq!(filing_content("  kept  ").as_deref(), Some("kept"));
        let long = "x".repeat(MAX_MEMORY_CHARS + 100);
        let filed = filing_content(&long).unwrap();
        assert_eq!(filed.chars().count(), MAX_MEMORY_CHARS);
        assert!(MemoryItem::new("r", MemoryScope::Global, filed, 0)
            .validate()
            .is_ok());
    }

    #[test]
    fn store_hook_files_recall_lists_updates_deletes() {
        let mut hook = StoreMemoryHook::persisting(InMemoryMemoryStore::new());
        assert!(hook.can_persist());

        // Empty summaries file nothing.
        hook.on_run_end("run-1", "   ");
        assert!(hook.list(None, 10).unwrap().is_empty());

        hook.on_run_end("run-1", "user prefers dark mode");
        let all = hook.list(None, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "user prefers dark mode");

        // Recall surfaces filed content; blank hints recall nothing.
        assert_eq!(hook.recall("dark mode").len(), 1);
        assert!(hook.recall("   ").is_empty());
        assert_eq!(hook.search_memories("dark", 10).unwrap().len(), 1);

        // Edit + delete user controls.
        let updated = hook
            .update_memory("run-1", "user prefers light mode")
            .unwrap()
            .unwrap();
        assert_eq!(updated.content, "user prefers light mode");
        assert!(hook.update_memory("run-1", "  ").is_err());
        assert!(hook.update_memory("missing", "x").unwrap().is_none());
        assert!(hook.delete_memory("run-1").unwrap());
        assert!(!hook.delete_memory("run-1").unwrap());
        assert!(hook.list(None, 10).unwrap().is_empty());
    }

    #[test]
    fn private_hook_files_lists_recalls_nothing() {
        let mut hook = StoreMemoryHook::private(InMemoryMemoryStore::new());
        assert!(!hook.can_persist());
        hook.on_run_end("run-1", "secret session notes");
        assert!(hook.list(None, 10).unwrap().is_empty());
        assert!(hook.recall("secret").is_empty());
        assert!(hook.search_memories("secret", 10).unwrap().is_empty());
        assert!(!hook.delete_memory("run-1").unwrap());
        assert!(hook.update_memory("run-1", "x").unwrap().is_none());
        assert!(hook
            .recall_history(&HistoryQuery::new("secret"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn history_recall_validates_and_stays_read_only() {
        let history = vec![
            HistoryHit::new("https://a.example/kb", "Keyboards", 3.0),
            HistoryHit::new("https://b.example/other", "Other", 1.0),
        ];
        let hook = StoreMemoryHook::persisting(InMemoryMemoryStore::new().with_history(history));
        assert!(hook.recall_history(&HistoryQuery::new("  ")).is_err());
        let hits = hook
            .recall_history(&HistoryQuery::new("keyboards"))
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://a.example/kb");
        // Recalling never deletes: the visit is still there afterwards.
        let again = hook
            .recall_history(&HistoryQuery::new("keyboards"))
            .unwrap();
        assert_eq!(again, hits);
    }

    #[test]
    fn in_memory_store_save_load_delete_round_trip() {
        let mut store = InMemoryMemoryStore::new();
        store.memory_save(filed_item("fact")).unwrap();
        assert!(store.memory_load("run-1").unwrap().is_some());
        assert!(store.memory_load("missing").unwrap().is_none());
        assert!(store
            .memory_save(filed_item("fact"))
            .unwrap()
            .validate()
            .is_ok());
        assert!(store.memory_delete("run-1").unwrap());
        assert!(store.memory_load("run-1").unwrap().is_none());
        assert!(!store.memory_delete("run-1").unwrap());
        assert!(store
            .memory_save(MemoryItem::new("", MemoryScope::Global, "x", 0))
            .is_err());
    }
}

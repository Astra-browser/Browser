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
}

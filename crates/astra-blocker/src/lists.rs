/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! List sources, validation, and engine preparation for `astra-blocker`.
//!
//! Both official sources form one candidate: the engine is rebuilt only after
//! every source passes validation. Failed candidates leave the working engine
//! installed, mirroring the base snapshot's update semantics.

use adblock::lists::ParseOptions;
use adblock::{Engine, FilterSet};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Hard cap per list text (bounded streaming, mirrors the base snapshot).
pub const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;

/// An update candidate whose surviving rule total shrank by more than this
/// fraction of the previous total is rejected as suspicious shrinkage.
pub const SHRINK_REJECT_RATIO: f64 = 0.5;

/// One filter-list source (official subscription or local override).
#[derive(Debug, Clone)]
pub struct ListSource {
    /// Stable id, e.g. `easylist` or `easyprivacy`.
    pub id: String,
    /// Raw subscription text (ABP filter syntax).
    pub text: String,
    /// Upstream version stamp when known (e.g. `202610281352`).
    pub version: Option<String>,
}

impl ListSource {
    /// Builds a source; empty ids are rejected at prepare time.
    pub fn new(id: &str, text: String) -> Self {
        Self {
            id: id.to_string(),
            text,
            version: None,
        }
    }

    /// Attaches an upstream version stamp.
    pub fn with_version(mut self, version: &str) -> Self {
        self.version = Some(version.to_string());
        self
    }

    /// SHA-256 of the raw text, hex-encoded.
    pub fn sha256_hex(&self) -> String {
        hex_of(&Sha256::digest(self.text.as_bytes()))
    }
}

/// Per-list outcome recorded when a candidate becomes active.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AddedListInfo {
    /// Source id.
    pub id: String,
    /// Upstream version stamp when known.
    pub version: Option<String>,
    /// SHA-256 of the raw text, hex-encoded.
    pub sha256_hex: String,
    /// Raw byte length.
    pub bytes: usize,
    /// Approximate rule count (non-comment, non-empty lines).
    pub rules: usize,
}

/// Report returned by a successful [`crate::Blocker::update_lists`].
#[derive(Debug, Clone)]
pub struct UpdateReport {
    /// Per-list metadata of the now-active candidate.
    pub lists: Vec<AddedListInfo>,
    /// Total rules across all lists.
    pub total_rules: usize,
}

/// Reasons a list update candidate can be rejected.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ListUpdateError {
    /// No sources were supplied.
    #[error("no list sources supplied")]
    Empty,
    /// A source id is missing or duplicated.
    #[error("invalid source id: {0}")]
    BadId(String),
    /// A source exceeds [`MAX_LIST_BYTES`] or is empty.
    #[error("source '{0}' has invalid length {1}")]
    BadLength(String, usize),
    /// The candidate's rule total collapsed versus the active engine.
    #[error("suspicious shrinkage: {0} rules vs {1} active")]
    Shrinkage(usize, usize),
}

pub(crate) struct PreparedEngine {
    pub(crate) engine: Engine,
    pub(crate) rule_count: usize,
    pub(crate) lists: Vec<AddedListInfo>,
}

/// Validates `sources` and builds the replacement engine. The caller's active
/// engine is untouched on any error.
pub(crate) fn prepare_engine(
    sources: &[ListSource],
    previous_total: usize,
) -> Result<PreparedEngine, ListUpdateError> {
    if sources.is_empty() {
        return Err(ListUpdateError::Empty);
    }
    let mut seen = std::collections::HashSet::new();
    for source in sources {
        if source.id.trim().is_empty() || !seen.insert(source.id.clone()) {
            return Err(ListUpdateError::BadId(source.id.clone()));
        }
        if source.text.is_empty() || source.text.len() > MAX_LIST_BYTES {
            return Err(ListUpdateError::BadLength(
                source.id.clone(),
                source.text.len(),
            ));
        }
    }

    let mut set = FilterSet::new(false);
    let mut lists = Vec::with_capacity(sources.len());
    let mut total = 0usize;
    for source in sources {
        let rules = count_rules(&source.text);
        set.add_filter_list(source.text.clone(), ParseOptions::default());
        total += rules;
        lists.push(AddedListInfo {
            id: source.id.clone(),
            version: source.version.clone(),
            sha256_hex: source.sha256_hex(),
            bytes: source.text.len(),
            rules,
        });
    }

    if previous_total > 0 {
        let floor = (previous_total as f64 * (1.0 - SHRINK_REJECT_RATIO)) as usize;
        if total < floor {
            return Err(ListUpdateError::Shrinkage(total, previous_total));
        }
    }

    let engine = Engine::new_with_filter_set(set);
    Ok(PreparedEngine {
        engine,
        rule_count: total,
        lists,
    })
}

/// Counts candidate rule lines: non-empty lines that are not comments
/// (`!`) or metadata (`[Adblock ...]` headers).
pub(crate) fn count_rules(text: &str) -> usize {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('!') && !line.starts_with('['))
        .count()
}

pub(crate) fn hex_of(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_only_rule_lines() {
        let text = "[Adblock Plus 2.0]\n! comment\n\n||ads.invalid^\n";
        assert_eq!(count_rules(text), 1);
    }
}

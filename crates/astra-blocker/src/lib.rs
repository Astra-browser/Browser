/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-blocker`: adblock-rust wrapper with EasyList/EasyPrivacy seed lists.
//!
//! The engine owns compiled network/cosmetic rules, a global on/off switch,
//! per-site (per-host) toggles, and the list-update mechanism. Seed lists are
//! the unmodified EasyList/EasyPrivacy subscription texts (CC BY-SA 3.0, see
//! `seed/v1/NOTICE`); only the storage representation (gzip) differs.
//!
//! Out of scope (matches the base snapshot): scriptlets, procedural-action
//! execution, redirect-resource replacement, and response mutation. Cosmetic
//! support is limited to reporting the selectors the page should hide.

mod lists;
mod seed;

pub use lists::{
    AddedListInfo, ListSource, ListUpdateError, UpdateReport, MAX_LIST_BYTES, SHRINK_REJECT_RATIO,
};
pub use seed::{seed_lists, SeedError, SEED_EASYLIST_VERSION, SEED_EASYPRIVACY_VERSION};

use adblock::lists::ParseOptions;
use adblock::request::Request;
use adblock::{Engine, FilterSet};
use std::collections::HashSet;
use thiserror::Error;

/// A network request to check against the compiled rules.
#[derive(Debug, Clone)]
pub struct NetworkRequest {
    /// URL of the requested resource.
    pub url: String,
    /// URL of the document that initiated the request.
    pub source_url: String,
    /// adblock request type (`script`, `image`, `xmlhttprequest`, `document`, …).
    pub request_type: String,
}

impl NetworkRequest {
    /// Builds a request; empty URLs are rejected at check time, not here.
    pub fn new(url: &str, source_url: &str, request_type: &str) -> Self {
        Self {
            url: url.to_string(),
            source_url: source_url.to_string(),
            request_type: request_type.to_string(),
        }
    }
}

/// Verdict for a single network request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Request may proceed.
    Allow,
    /// Request must be cancelled before it leaves.
    Block,
}

/// Errors from [`Blocker`] operations.
#[derive(Debug, Error)]
pub enum BlockerError {
    /// A list update failed validation; the previous engine is untouched.
    #[error("list update rejected: {0}")]
    Update(#[from] ListUpdateError),
    /// The embedded seed lists could not be loaded.
    #[error("seed load failed: {0}")]
    Seed(#[from] SeedError),
    /// Cached compiled bytes could not be restored.
    #[error("snapshot restore failed: {0}")]
    Snapshot(String),
}

/// Per-site (per-host) on/off state. Serializable so `astra-core` can persist it.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SiteControls {
    /// Lower-cased hosts where protection is paused.
    disabled_hosts: HashSet<String>,
}

impl SiteControls {
    /// Pauses (`false`) or resumes (`true`) protection for a host.
    pub fn set_site_enabled(&mut self, host: &str, enabled: bool) {
        let key = normalize_host(host);
        if enabled {
            self.disabled_hosts.remove(&key);
        } else if !key.is_empty() {
            self.disabled_hosts.insert(key);
        }
    }

    /// Returns false when protection is paused for this host.
    pub fn is_site_enabled(&self, host: &str) -> bool {
        !self.disabled_hosts.contains(&normalize_host(host))
    }

    /// Hosts currently paused.
    pub fn disabled_sites(&self) -> Vec<String> {
        let mut out: Vec<String> = self.disabled_hosts.iter().cloned().collect();
        out.sort();
        out
    }
}

/// Lower-cases and trims a host for toggle comparisons.
pub fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_lowercase()
}

/// Extracts the host from a URL for per-site checks. Returns `""` when the
/// URL has no parseable host.
pub fn host_of_url(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .split('@')
        .next_back()
        .unwrap_or("");
    let host = authority.split(':').next().unwrap_or("");
    normalize_host(host)
}

/// The blocker engine: compiled rules plus global and per-site switches.
pub struct Blocker {
    engine: Engine,
    /// Compiled rule count of the active engine (informational).
    rule_count: usize,
    enabled: bool,
    sites: SiteControls,
    /// Metadata of the lists backing the active engine.
    active: Vec<AddedListInfo>,
}

impl Default for Blocker {
    fn default() -> Self {
        Self {
            engine: Engine::new_with_filter_set(FilterSet::new(false)),
            rule_count: 0,
            enabled: true,
            sites: SiteControls::default(),
            active: Vec::new(),
        }
    }
}

impl Blocker {
    /// Empty engine, protection on, no per-site pauses.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds an engine from filter-list texts, replacing any previous rules.
    pub fn from_lists(sources: &[ListSource]) -> Result<Self, BlockerError> {
        let mut blocker = Self::new();
        blocker.update_lists(sources)?;
        Ok(blocker)
    }

    /// Builds an engine from the embedded EasyList/EasyPrivacy seed.
    pub fn from_seed() -> Result<Self, BlockerError> {
        let sources = seed_lists()?;
        Self::from_lists(&sources)
    }

    /// Global kill switch (Privacy settings live profile toggle).
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// Returns the global switch state.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Pauses or resumes protection for one site (host).
    pub fn set_site_enabled(&mut self, host: &str, enabled: bool) {
        self.sites.set_site_enabled(host, enabled);
    }

    /// Returns false when protection is paused for this host.
    pub fn is_site_enabled(&self, host: &str) -> bool {
        self.sites.is_site_enabled(host)
    }

    /// Replaces the site controls wholesale (restore after persistence).
    pub fn set_site_controls(&mut self, sites: SiteControls) {
        self.sites = sites;
    }

    /// Returns the current site controls.
    pub fn site_controls(&self) -> &SiteControls {
        &self.sites
    }

    /// Metadata of the lists backing the active engine.
    pub fn active_lists(&self) -> &[AddedListInfo] {
        &self.active
    }

    /// Compiled rule count of the active engine.
    pub fn rule_count(&self) -> usize {
        self.rule_count
    }

    /// Validates `sources` and, only on success, swaps in a rebuilt engine.
    ///
    /// Failed candidates leave the working engine installed.
    pub fn update_lists(&mut self, sources: &[ListSource]) -> Result<UpdateReport, BlockerError> {
        let pending = lists::prepare_engine(sources, self.rule_count)?;
        self.engine = pending.engine;
        self.rule_count = pending.rule_count;
        self.active = pending.lists;
        Ok(UpdateReport {
            lists: self.active.clone(),
            total_rules: self.rule_count,
        })
    }

    /// Checks one request. Returns [`Verdict::Allow`] when protection is off
    /// globally, paused for the source host, or the request cannot be parsed.
    pub fn check(&self, request: &NetworkRequest) -> Verdict {
        if !self.enabled {
            return Verdict::Allow;
        }
        if !self.is_site_enabled(&host_of_url(&request.source_url)) {
            return Verdict::Allow;
        }
        let Ok(parsed) = Request::new(
            &request.url,
            &request.source_url,
            &request.request_type,
            "get",
        ) else {
            return Verdict::Allow;
        };
        if self.engine.check_network_request(&parsed).should_block() {
            Verdict::Block
        } else {
            Verdict::Allow
        }
    }

    /// Convenience wrapper over [`Blocker::check`].
    pub fn should_block(&self, url: &str, source_url: &str, request_type: &str) -> bool {
        self.check(&NetworkRequest::new(url, source_url, request_type)) == Verdict::Block
    }

    /// CSS selectors the page at `url` should hide (`display: none`).
    ///
    /// Merges the URL-specific selectors with the generic class/id rules that
    /// match the observed `classes`/`ids` (the caller collects these from the
    /// page, e.g. via a `MutationObserver`, and calls again as more appear).
    /// Hostname exceptions suppress matching generic selectors; a
    /// `$generichide` exception suppresses all generic lookup.
    ///
    /// Empty when protection is off/paused for the host or the URL is invalid.
    pub fn cosmetic_selectors(&self, url: &str, classes: &[&str], ids: &[&str]) -> Vec<String> {
        if !self.enabled || !self.is_site_enabled(&host_of_url(url)) {
            return Vec::new();
        }
        let resources = self.engine.url_cosmetic_resources(url);
        let mut out: Vec<String> = resources
            .hide_selectors
            .iter()
            .filter(|selector| !resources.exceptions.contains(*selector))
            .cloned()
            .collect();
        if !resources.generichide {
            out.extend(
                self.engine
                    .hidden_class_id_selectors(classes, ids, &resources.exceptions),
            );
        }
        out.sort();
        out.dedup();
        out
    }

    /// Serializes the compiled engine for fast reload (opaque cache format).
    pub fn serialize(&self) -> Vec<u8> {
        self.engine.serialize()
    }

    /// Restores a snapshot produced by [`Blocker::serialize`]. Rule metadata
    /// (`active_lists`, `rule_count`) is unchanged; callers should rebuild via
    /// [`Blocker::update_lists`] when the adblock crate version changes.
    pub fn restore_snapshot(&mut self, bytes: &[u8]) -> Result<(), BlockerError> {
        self.engine
            .deserialize(bytes)
            .map_err(|error| BlockerError::Snapshot(error.to_string()))
    }
}

/// Builds a single-list [`FilterSet`] (helper for tests and tooling).
pub fn filter_set_for(text: &str) -> FilterSet {
    let mut set = FilterSet::new(false);
    set.add_filter_list(text.to_string(), ParseOptions::default());
    set
}

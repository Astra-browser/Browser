/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tab strip: the pure shell-side model of open tabs (`tabs_*`, `tab_*`).
//!
//! Ordering, activation, and pinning live here; the engine owns loading and
//! rendering and is driven through [`BrowserHost`][astra_host_trait::BrowserHost].

use astra_host_trait::TabId;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Shell-side entry for one open tab.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabEntry {
    pub id: TabId,
    pub url: String,
    pub title: String,
    pub essential: bool,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum TabStripError {
    #[error("unknown tab {0}")]
    UnknownTab(TabId),
}

/// Ordered tab list with a single active tab.
#[derive(Clone, Debug, Default)]
pub struct TabStrip {
    tabs: Vec<TabEntry>,
    active: Option<TabId>,
    next: u64,
}

impl TabStrip {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn tabs(&self) -> &[TabEntry] {
        &self.tabs
    }

    pub fn active(&self) -> Option<&TabId> {
        self.active.as_ref()
    }

    /// Open a tab and activate it.
    pub fn open(&mut self, url: impl Into<String>) -> TabId {
        self.next += 1;
        let id = TabId::new(format!("core-tab-{}", self.next));
        self.tabs.push(TabEntry {
            id: id.clone(),
            url: url.into(),
            title: String::new(),
            essential: false,
        });
        self.active = Some(id.clone());
        id
    }

    /// Close a tab; activates a neighbour when the active tab closes.
    pub fn close(&mut self, id: &TabId) -> Result<(), TabStripError> {
        let pos = self
            .tabs
            .iter()
            .position(|t| &t.id == id)
            .ok_or_else(|| TabStripError::UnknownTab(id.clone()))?;
        self.tabs.remove(pos);
        if self.active.as_ref() == Some(id) {
            self.active = self
                .tabs
                .get(pos.min(self.tabs.len().saturating_sub(1)))
                .map(|t| t.id.clone());
        }
        Ok(())
    }

    pub fn activate(&mut self, id: &TabId) -> Result<(), TabStripError> {
        if !self.tabs.iter().any(|t| &t.id == id) {
            return Err(TabStripError::UnknownTab(id.clone()));
        }
        self.active = Some(id.clone());
        Ok(())
    }

    /// Move `id` before `before` (`None` appends at the end).
    pub fn move_tab(&mut self, id: &TabId, before: Option<&TabId>) -> Result<(), TabStripError> {
        let pos = self
            .tabs
            .iter()
            .position(|t| &t.id == id)
            .ok_or_else(|| TabStripError::UnknownTab(id.clone()))?;
        let entry = self.tabs.remove(pos);
        let dest = match before {
            Some(target) => self
                .tabs
                .iter()
                .position(|t| &t.id == target)
                .ok_or_else(|| TabStripError::UnknownTab(target.clone()))?,
            None => self.tabs.len(),
        };
        self.tabs.insert(dest, entry);
        Ok(())
    }

    pub fn set_essential(&mut self, id: &TabId, essential: bool) -> Result<(), TabStripError> {
        self.tabs
            .iter_mut()
            .find(|t| &t.id == id)
            .map(|t| t.essential = essential)
            .ok_or_else(|| TabStripError::UnknownTab(id.clone()))
    }

    pub fn essentials(&self) -> Vec<&TabEntry> {
        self.tabs.iter().filter(|t| t.essential).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_activates_latest() {
        let mut strip = TabStrip::new();
        let a = strip.open("https://a.example");
        let b = strip.open("https://b.example");
        assert_eq!(strip.active(), Some(&b));
        assert_eq!(strip.tabs().len(), 2);
        assert_eq!(strip.tabs()[0].id, a);
    }

    #[test]
    fn close_active_falls_back_to_neighbour() {
        let mut strip = TabStrip::new();
        let a = strip.open("https://a.example");
        let b = strip.open("https://b.example");
        strip.close(&b).unwrap();
        assert_eq!(strip.active(), Some(&a));
        strip.close(&a).unwrap();
        assert_eq!(strip.active(), None);
        assert!(strip.tabs().is_empty());
    }

    #[test]
    fn move_tab_reorders() {
        let mut strip = TabStrip::new();
        let a = strip.open("https://a.example");
        let b = strip.open("https://b.example");
        strip.move_tab(&b, Some(&a)).unwrap();
        assert_eq!(strip.tabs()[0].id, b);
        assert_eq!(strip.tabs()[1].id, a);
        assert_eq!(
            strip.move_tab(&a, Some(&TabId::new("missing"))),
            Err(TabStripError::UnknownTab(TabId::new("missing")))
        );
    }

    #[test]
    fn essentials_filter() {
        let mut strip = TabStrip::new();
        let a = strip.open("https://a.example");
        strip.open("https://b.example");
        strip.set_essential(&a, true).unwrap();
        let essential: Vec<TabId> = strip
            .essentials()
            .into_iter()
            .map(|t| t.id.clone())
            .collect();
        assert_eq!(essential, vec![a]);
    }
}

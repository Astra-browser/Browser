/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Extension manager model (P4-T04): install state (enable/disable,
//! pin, site access) plus a permission-prompt queue.
//!
//! The queue is fed by Host API `Dialogs` `permission.requested` event
//! payloads (P3-T09) — read-only usage: the manager records the pending
//! prompt and returns a [`Decision`] for the caller to forward through
//! `Dialogs.decidePermission`. It never resolves a dialog itself.

use std::collections::{HashMap, VecDeque};
use thiserror::Error;

/// Site-access scope for an installed extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessMode {
    All,
    /// Ask on each use ("click").
    Click,
    /// Listed sites only.
    Sites(Vec<String>),
}

/// One installed extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtensionRecord {
    /// Gallery key: the Chrome store id for catalog entries, AMO slug otherwise.
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub pinned: bool,
    pub access: AccessMode,
}

/// A permission prompt waiting on the user. Mirrors the `permission.requested`
/// Dialogs event payload plus the gallery identity of the requester.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingPermission {
    pub dialog_id: String,
    pub extension_id: String,
    pub permission: String,
    pub url: String,
}

/// Decision the caller forwards to `Dialogs.decidePermission`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub dialog_id: String,
    pub grant: bool,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ManagerError {
    #[error("unknown extension {0}")]
    Unknown(String),
    #[error("already installed {0}")]
    AlreadyInstalled(String),
    #[error("unknown dialog {0}")]
    UnknownDialog(String),
    #[error("dialog {0} already resolved")]
    AlreadyResolved(String),
}

#[derive(Debug, Default)]
pub struct ExtensionManager {
    installed: HashMap<String, ExtensionRecord>,
    pending: VecDeque<PendingPermission>,
    resolved_dialogs: std::collections::HashSet<String>,
}

impl ExtensionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an install (post-review confirm). Disabled by default until
    /// the user enables it, mirroring the host install flow.
    pub fn install(&mut self, id: &str, name: &str) -> Result<(), ManagerError> {
        if self.installed.contains_key(id) {
            return Err(ManagerError::AlreadyInstalled(id.to_string()));
        }
        self.installed.insert(
            id.to_string(),
            ExtensionRecord {
                id: id.to_string(),
                name: name.to_string(),
                enabled: false,
                pinned: false,
                access: AccessMode::All,
            },
        );
        Ok(())
    }

    pub fn uninstall(&mut self, id: &str) -> Result<(), ManagerError> {
        self.installed
            .remove(id)
            .ok_or_else(|| ManagerError::Unknown(id.to_string()))?;
        self.pending.retain(|p| p.extension_id != id);
        Ok(())
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), ManagerError> {
        let record = self
            .installed
            .get_mut(id)
            .ok_or_else(|| ManagerError::Unknown(id.to_string()))?;
        record.enabled = enabled;
        Ok(())
    }

    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<(), ManagerError> {
        let record = self
            .installed
            .get_mut(id)
            .ok_or_else(|| ManagerError::Unknown(id.to_string()))?;
        record.pinned = pinned;
        Ok(())
    }

    pub fn set_access(&mut self, id: &str, access: AccessMode) -> Result<(), ManagerError> {
        let record = self
            .installed
            .get_mut(id)
            .ok_or_else(|| ManagerError::Unknown(id.to_string()))?;
        record.access = access;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&ExtensionRecord> {
        self.installed.get(id)
    }

    pub fn list(&self) -> Vec<&ExtensionRecord> {
        let mut out: Vec<&ExtensionRecord> = self.installed.values().collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Queue a `permission.requested` Dialogs event for the user to answer.
    /// Unknown (not installed) requesters are still queued — the UI shows
    /// them as external — but callers can check with [`Self::is_known`].
    pub fn queue_permission(&mut self, prompt: PendingPermission) {
        if self.resolved_dialogs.contains(&prompt.dialog_id) {
            return;
        }
        if self.pending.iter().any(|p| p.dialog_id == prompt.dialog_id) {
            return;
        }
        self.pending.push_back(prompt);
    }

    pub fn is_known(&self, id: &str) -> bool {
        self.installed.contains_key(id)
    }

    pub fn pending(&self) -> &VecDeque<PendingPermission> {
        &self.pending
    }

    /// Answer the oldest (or a specific) pending prompt. Returns the
    /// [`Decision`] to forward via `Dialogs.decidePermission`.
    pub fn answer_permission(
        &mut self,
        dialog_id: &str,
        grant: bool,
    ) -> Result<Decision, ManagerError> {
        let pos = self.pending.iter().position(|p| p.dialog_id == dialog_id);
        match pos {
            Some(i) => {
                let prompt = self.pending.remove(i).expect("position checked");
                self.resolved_dialogs.insert(prompt.dialog_id.clone());
                Ok(Decision {
                    dialog_id: prompt.dialog_id,
                    grant,
                })
            }
            None if self.resolved_dialogs.contains(dialog_id) => {
                Err(ManagerError::AlreadyResolved(dialog_id.to_string()))
            }
            None => Err(ManagerError::UnknownDialog(dialog_id.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager_with_one() -> ExtensionManager {
        let mut m = ExtensionManager::new();
        m.install("darkreader", "Dark Reader").unwrap();
        m
    }

    #[test]
    fn install_enable_disable_uninstall_round_trip() {
        let mut m = ExtensionManager::new();
        assert_eq!(m.install("darkreader", "Dark Reader"), Ok(()));
        assert_eq!(
            m.install("darkreader", "Dark Reader"),
            Err(ManagerError::AlreadyInstalled("darkreader".into()))
        );
        assert!(!m.get("darkreader").unwrap().enabled);
        m.set_enabled("darkreader", true).unwrap();
        assert!(m.get("darkreader").unwrap().enabled);
        m.set_enabled("darkreader", false).unwrap();
        assert!(!m.get("darkreader").unwrap().enabled);
        m.uninstall("darkreader").unwrap();
        assert!(m.get("darkreader").is_none());
        assert_eq!(
            m.uninstall("darkreader"),
            Err(ManagerError::Unknown("darkreader".into()))
        );
    }

    #[test]
    fn unknown_ids_fail_closed() {
        let mut m = ExtensionManager::new();
        assert_eq!(
            m.set_enabled("nope", true),
            Err(ManagerError::Unknown("nope".into()))
        );
        assert_eq!(
            m.set_pinned("nope", true),
            Err(ManagerError::Unknown("nope".into()))
        );
        assert_eq!(
            m.set_access("nope", AccessMode::Click),
            Err(ManagerError::Unknown("nope".into()))
        );
    }

    #[test]
    fn pin_and_site_access_round_trip() {
        let mut m = manager_with_one();
        m.set_pinned("darkreader", true).unwrap();
        assert!(m.get("darkreader").unwrap().pinned);
        m.set_access("darkreader", AccessMode::Sites(vec!["example.com".into()]))
            .unwrap();
        assert_eq!(
            m.get("darkreader").unwrap().access,
            AccessMode::Sites(vec!["example.com".into()])
        );
        let names: Vec<&str> = m.list().iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["Dark Reader"]);
    }

    #[test]
    fn permission_queue_answers_once_like_dialogs() {
        let mut m = manager_with_one();
        m.queue_permission(PendingPermission {
            dialog_id: "dlg-1".into(),
            extension_id: "darkreader".into(),
            permission: "tabs".into(),
            url: "https://example.com".into(),
        });
        // Duplicate queueing is idempotent.
        m.queue_permission(PendingPermission {
            dialog_id: "dlg-1".into(),
            extension_id: "darkreader".into(),
            permission: "tabs".into(),
            url: "https://example.com".into(),
        });
        assert_eq!(m.pending().len(), 1);
        let decision = m.answer_permission("dlg-1", true).unwrap();
        assert_eq!(
            decision,
            Decision {
                dialog_id: "dlg-1".into(),
                grant: true
            }
        );
        assert!(m.pending().is_empty());
        assert_eq!(
            m.answer_permission("dlg-1", true),
            Err(ManagerError::AlreadyResolved("dlg-1".into()))
        );
        assert_eq!(
            m.answer_permission("dlg-9", true),
            Err(ManagerError::UnknownDialog("dlg-9".into()))
        );
    }

    #[test]
    fn uninstall_drops_pending_prompts() {
        let mut m = manager_with_one();
        m.queue_permission(PendingPermission {
            dialog_id: "dlg-2".into(),
            extension_id: "darkreader".into(),
            permission: "storage".into(),
            url: "https://example.com".into(),
        });
        m.uninstall("darkreader").unwrap();
        assert!(m.pending().is_empty());
    }
}

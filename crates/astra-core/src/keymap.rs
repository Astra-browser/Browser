/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Keymap: shortcut bindings with conflict detection (`keymap_*`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

/// A single shortcut binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeymapEntry {
    pub id: String,
    pub accelerator: Option<String>,
}

/// Outcome of a `bind` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeymapOutcome {
    /// Bound; `replaced` names the accelerator this binding replaced, if any.
    Bound { replaced: Option<String> },
    /// Unbound and now has no accelerator.
    Unbound,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum KeymapError {
    #[error("unknown command id: {0}")]
    UnknownId(String),
    #[error("accelerator {0:?} already bound to {1:?}")]
    Conflict(String, String),
    #[error("invalid accelerator {0:?}: must be 1..=64 chars of [A-Za-z0-9+]")]
    InvalidAccelerator(String),
}

fn default_bindings() -> HashMap<String, Option<String>> {
    [
        ("tabs.open", Some("CmdOrCtrl+T")),
        ("tabs.close", Some("CmdOrCtrl+W")),
        ("tabs.reload", Some("CmdOrCtrl+R")),
        ("launcher.open", Some("CmdOrCtrl+K")),
        ("sidebar.toggle", None),
    ]
    .into_iter()
    .map(|(id, acc)| (id.to_owned(), acc.map(str::to_owned)))
    .collect()
}

/// In-memory shortcut map.
#[derive(Clone, Debug)]
pub struct Keymap {
    bindings: HashMap<String, Option<String>>,
}

impl Keymap {
    pub fn new() -> Self {
        Self {
            bindings: default_bindings(),
        }
    }

    pub fn entries(&self) -> Vec<KeymapEntry> {
        let mut entries: Vec<KeymapEntry> = self
            .bindings
            .iter()
            .map(|(id, accelerator)| KeymapEntry {
                id: id.clone(),
                accelerator: accelerator.clone(),
            })
            .collect();
        entries.sort_by(|a, b| a.id.cmp(&b.id));
        entries
    }

    fn check_accelerator(accelerator: &str) -> Result<(), KeymapError> {
        let ok = !accelerator.is_empty()
            && accelerator.len() <= 64
            && accelerator
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+');
        if ok {
            Ok(())
        } else {
            Err(KeymapError::InvalidAccelerator(accelerator.to_owned()))
        }
    }

    /// Bind `id` to `accelerator` (`None` unbinds).
    ///
    /// Without `replace`, binding an accelerator already used by another
    /// command fails with [`KeymapError::Conflict`].
    pub fn bind(
        &mut self,
        id: &str,
        accelerator: Option<&str>,
        replace: bool,
    ) -> Result<KeymapOutcome, KeymapError> {
        if !self.bindings.contains_key(id) {
            return Err(KeymapError::UnknownId(id.to_owned()));
        }
        let accelerator = match accelerator {
            Some(acc) => {
                Self::check_accelerator(acc)?;
                Some(acc.to_owned())
            }
            None => None,
        };
        if let Some(ref acc) = accelerator {
            if let Some(holder) = self
                .bindings
                .iter()
                .find(|(other, bound)| *other != id && bound.as_ref() == Some(acc))
                .map(|(other, _)| other.clone())
            {
                if !replace {
                    return Err(KeymapError::Conflict(acc.clone(), holder));
                }
                self.bindings.insert(holder, None);
            }
        }
        let replaced = self.bindings.insert(id.to_owned(), accelerator);
        match self.bindings.get(id) {
            Some(None) | None => Ok(KeymapOutcome::Unbound),
            Some(Some(_)) => Ok(KeymapOutcome::Bound {
                replaced: replaced.flatten(),
            }),
        }
    }

    /// Reset one binding (`Some`) or the whole map (`None`) to defaults.
    pub fn reset(&mut self, id: Option<&str>) {
        match id {
            Some(id) => {
                if let Some(default) = default_bindings().remove(id) {
                    self.bindings.insert(id.to_owned(), default);
                }
            }
            None => self.bindings = default_bindings(),
        }
    }
}

impl Default for Keymap {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_sorted_and_complete() {
        let ids: Vec<String> = Keymap::new().entries().into_iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            vec![
                "launcher.open",
                "sidebar.toggle",
                "tabs.close",
                "tabs.open",
                "tabs.reload"
            ]
        );
    }

    #[test]
    fn bind_conflict_without_replace() {
        let mut map = Keymap::new();
        let err = map.bind("sidebar.toggle", Some("CmdOrCtrl+T"), false);
        assert_eq!(
            err,
            Err(KeymapError::Conflict(
                "CmdOrCtrl+T".to_owned(),
                "tabs.open".to_owned()
            ))
        );
    }

    #[test]
    fn bind_with_replace_steals_accelerator() {
        let mut map = Keymap::new();
        let outcome = map
            .bind("sidebar.toggle", Some("CmdOrCtrl+T"), true)
            .unwrap();
        assert_eq!(outcome, KeymapOutcome::Bound { replaced: None });
        let stolen = map
            .entries()
            .into_iter()
            .find(|e| e.id == "tabs.open")
            .unwrap();
        assert_eq!(stolen.accelerator, None);
    }

    #[test]
    fn unbind_and_reset() {
        let mut map = Keymap::new();
        assert_eq!(
            map.bind("tabs.close", None, false).unwrap(),
            KeymapOutcome::Unbound
        );
        map.reset(Some("tabs.close"));
        let entry = map
            .entries()
            .into_iter()
            .find(|e| e.id == "tabs.close")
            .unwrap();
        assert_eq!(entry.accelerator.as_deref(), Some("CmdOrCtrl+W"));
    }

    #[test]
    fn invalid_accelerators_rejected() {
        let mut map = Keymap::new();
        assert!(map.bind("tabs.open", Some(""), false).is_err());
        assert!(map.bind("tabs.open", Some("ctrl+t!!"), false).is_err());
        assert!(map.bind("nope", Some("A"), false).is_err());
    }
}

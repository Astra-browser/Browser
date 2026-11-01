/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not obtained with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Spaces: the pure core-side model of organisation (plan D-05, spike S-02).
//!
//! `astra-core` owns *organisation* — spaces, their order, and the mapping
//! from each space to its isolated storage context — while Firefox owns the
//! live tab objects and the Host `Containers` module owns creating/deleting
//! the actual contextual identities. The seam between the two is
//! [`Space::container_ref`]: the `cookieStoreId` (`firefox-container-N`)
//! minted by the host, persisted here and in the `astra-store` `spaces`
//! table (which already carries a `container_ref` column from P2-T04).
//!
//! Mapping decided by S-02:
//! - one Astra space ↔ one Firefox contextual identity (container);
//!   cookies/localStorage/IndexedDB/cache are partitioned by the engine on
//!   `originAttributes.userContextId`, so sibling spaces never share them;
//! - one Astra profile ↔ one Firefox profile directory; containers alone do
//!   not separate prefs, extensions, history or logins;
//! - agent sessions use ephemeral containers the host deletes on teardown
//!   (engine `remove()` also wipes the container's site data).

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::session::SpaceSnapshot;

/// One workspace grouping tabs. Mirrors [`SpaceSnapshot`] plus the
/// host-minted isolation handle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Space {
    pub uuid: String,
    pub name: String,
    pub position: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_ref: Option<String>,
}

impl Space {
    pub fn snapshot(&self) -> SpaceSnapshot {
        SpaceSnapshot {
            uuid: self.uuid.clone(),
            name: self.name.clone(),
            position: self.position,
            container_ref: self.container_ref.clone(),
        }
    }

    pub fn from_snapshot(s: SpaceSnapshot) -> Self {
        Self {
            uuid: s.uuid,
            name: s.name,
            position: s.position,
            container_ref: s.container_ref,
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SpaceError {
    #[error("unknown space {0}")]
    UnknownSpace(String),
    #[error("space name must be a non-empty string")]
    EmptyName,
    #[error("invalid container_ref {0}")]
    InvalidContainerRef(String),
    #[error("invalid profile dir for profile {0}")]
    InvalidProfile(String),
}

/// A `cookieStoreId` minted by the host looks like `firefox-container-N`
/// (verified against `ext-contextualIdentities` xpcshell expectations on
/// the pinned ESR). The core never mints these; it only validates and
/// stores what the host returns.
pub fn valid_container_ref(value: &str) -> bool {
    let rest = match value.strip_prefix("firefox-container-") {
        Some(rest) => rest,
        None => return false,
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
}

/// Display name proposed for the contextual identity of a space. The engine
/// rejects whitespace-only identity names, so an empty/blank space name
/// falls back to the space uuid (which is never empty).
pub fn container_name_for_space(space: &Space) -> String {
    if space.name.trim().is_empty() {
        space.uuid.clone()
    } else {
        space.name.clone()
    }
}

/// Profile-directory leaf for an Astra profile: `astra-<uuid>`, sanitised so
/// it is always a safe single path segment. Containers alone do not separate
/// prefs/extensions/history/logins, hence one directory per profile (S-02).
pub fn profile_dir_name(profile_uuid: &str) -> Result<String, SpaceError> {
    if profile_uuid.trim().is_empty() {
        return Err(SpaceError::InvalidProfile(profile_uuid.to_owned()));
    }
    let safe: String = profile_uuid
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    Ok(format!("astra-{safe}"))
}

/// Ordered set of spaces with their container bindings.
#[derive(Clone, Debug, Default)]
pub struct SpaceStore {
    spaces: Vec<Space>,
}

impl SpaceStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spaces(&self) -> &[Space] {
        &self.spaces
    }

    pub fn get(&self, uuid: &str) -> Option<&Space> {
        self.spaces.iter().find(|s| s.uuid == uuid)
    }

    /// Create a space. The container identity itself is minted by the host
    /// afterwards; attach it with [`SpaceStore::attach_container`].
    pub fn create(
        &mut self,
        uuid: impl Into<String>,
        name: impl Into<String>,
    ) -> Result<Space, SpaceError> {
        let uuid = uuid.into();
        let name = name.into();
        if self.spaces.iter().any(|s| s.uuid == uuid) {
            return Err(SpaceError::UnknownSpace(uuid));
        }
        if name.trim().is_empty() {
            return Err(SpaceError::EmptyName);
        }
        let position = self.spaces.len() as i64;
        let space = Space {
            uuid,
            name,
            position,
            container_ref: None,
        };
        self.spaces.push(space.clone());
        Ok(space)
    }

    pub fn rename(&mut self, uuid: &str, name: impl Into<String>) -> Result<(), SpaceError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(SpaceError::EmptyName);
        }
        let space = self
            .spaces
            .iter_mut()
            .find(|s| s.uuid == uuid)
            .ok_or_else(|| SpaceError::UnknownSpace(uuid.to_owned()))?;
        space.name = name;
        Ok(())
    }

    /// Bind the host-minted `cookieStoreId` to a space.
    pub fn attach_container(
        &mut self,
        uuid: &str,
        container_ref: impl Into<String>,
    ) -> Result<(), SpaceError> {
        let container_ref = container_ref.into();
        if !valid_container_ref(&container_ref) {
            return Err(SpaceError::InvalidContainerRef(container_ref));
        }
        let space = self
            .spaces
            .iter_mut()
            .find(|s| s.uuid == uuid)
            .ok_or_else(|| SpaceError::UnknownSpace(uuid.to_owned()))?;
        space.container_ref = Some(container_ref);
        Ok(())
    }

    /// Move a space to `position` (clamped), re-numbering positions densely.
    pub fn move_space(&mut self, uuid: &str, position: usize) -> Result<(), SpaceError> {
        let from = self
            .spaces
            .iter()
            .position(|s| s.uuid == uuid)
            .ok_or_else(|| SpaceError::UnknownSpace(uuid.to_owned()))?;
        let space = self.spaces.remove(from);
        let dest = position.min(self.spaces.len());
        self.spaces.insert(dest, space);
        for (i, s) in self.spaces.iter_mut().enumerate() {
            s.position = i as i64;
        }
        Ok(())
    }

    /// Delete a space. Returns the bound `container_ref` (if any) so the
    /// caller can delete the identity through the host — engine `remove()`
    /// also wipes that container's site data.
    pub fn remove(&mut self, uuid: &str) -> Result<Option<String>, SpaceError> {
        let pos = self
            .spaces
            .iter()
            .position(|s| s.uuid == uuid)
            .ok_or_else(|| SpaceError::UnknownSpace(uuid.to_owned()))?;
        let space = self.spaces.remove(pos);
        for (i, s) in self.spaces.iter_mut().enumerate() {
            s.position = i as i64;
        }
        Ok(space.container_ref)
    }

    /// Space whose container a tab with no explicit binding opens in.
    pub fn default_space(&self) -> Option<&Space> {
        self.spaces.first()
    }

    /// Look up a space by its container binding (host → core direction).
    pub fn space_for_container(&self, container_ref: &str) -> Option<&Space> {
        self.spaces
            .iter()
            .find(|s| s.container_ref.as_deref() == Some(container_ref))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_two() -> SpaceStore {
        let mut store = SpaceStore::new();
        store.create("space-work", "Work").unwrap();
        store.create("space-personal", "Personal").unwrap();
        store
    }

    #[test]
    fn create_assigns_dense_positions() {
        let store = store_two();
        assert_eq!(store.spaces()[0].position, 0);
        assert_eq!(store.spaces()[1].position, 1);
        assert_eq!(store.spaces()[0].container_ref, None);
    }

    #[test]
    fn create_rejects_blank_names_and_dup_uuids() {
        let mut store = SpaceStore::new();
        assert_eq!(
            store.create("s1", "   ").unwrap_err(),
            SpaceError::EmptyName
        );
        store.create("s1", "One").unwrap();
        assert!(matches!(
            store.create("s1", "Again").unwrap_err(),
            SpaceError::UnknownSpace(_)
        ));
    }

    #[test]
    fn attach_container_validates_ref_shape() {
        let mut store = store_two();
        store
            .attach_container("space-work", "firefox-container-1")
            .unwrap();
        assert_eq!(
            store.get("space-work").unwrap().container_ref.as_deref(),
            Some("firefox-container-1")
        );
        assert_eq!(
            store
                .attach_container("space-personal", "container-xyz")
                .unwrap_err(),
            SpaceError::InvalidContainerRef("container-xyz".to_owned())
        );
        assert_eq!(
            store
                .attach_container("missing", "firefox-container-2")
                .unwrap_err(),
            SpaceError::UnknownSpace("missing".to_owned())
        );
    }

    #[test]
    fn remove_returns_container_ref_for_host_cleanup() {
        let mut store = store_two();
        store
            .attach_container("space-work", "firefox-container-1")
            .unwrap();
        assert_eq!(
            store.remove("space-work").unwrap(),
            Some("firefox-container-1".to_owned())
        );
        assert_eq!(store.spaces()[0].position, 0);
        assert_eq!(
            store.remove("space-work").unwrap_err(),
            SpaceError::UnknownSpace("space-work".to_owned())
        );
    }

    #[test]
    fn move_space_renumbers() {
        let mut store = store_two();
        store.move_space("space-personal", 0).unwrap();
        assert_eq!(store.spaces()[0].uuid, "space-personal");
        assert_eq!(store.spaces()[0].position, 0);
        assert_eq!(store.spaces()[1].position, 1);
        assert!(matches!(
            store.move_space("missing", 0).unwrap_err(),
            SpaceError::UnknownSpace(_)
        ));
    }

    #[test]
    fn rename_rejects_blank() {
        let mut store = store_two();
        store.rename("space-work", "Job").unwrap();
        assert_eq!(store.get("space-work").unwrap().name, "Job");
        assert_eq!(
            store.rename("space-work", "").unwrap_err(),
            SpaceError::EmptyName
        );
    }

    #[test]
    fn lookups_by_container_and_default() {
        let mut store = store_two();
        assert_eq!(store.default_space().unwrap().uuid, "space-work");
        assert_eq!(store.space_for_container("firefox-container-9"), None);
        store
            .attach_container("space-personal", "firefox-container-9")
            .unwrap();
        assert_eq!(
            store
                .space_for_container("firefox-container-9")
                .unwrap()
                .uuid,
            "space-personal"
        );
    }

    #[test]
    fn container_name_falls_back_to_uuid() {
        let blank = Space {
            uuid: "s-1".to_owned(),
            name: "  ".to_owned(),
            position: 0,
            container_ref: None,
        };
        assert_eq!(container_name_for_space(&blank), "s-1");
        let named = Space {
            uuid: "s-2".to_owned(),
            name: "Work".to_owned(),
            position: 1,
            container_ref: None,
        };
        assert_eq!(container_name_for_space(&named), "Work");
    }

    #[test]
    fn profile_dir_name_sanitises() {
        assert_eq!(profile_dir_name("default").unwrap(), "astra-default");
        assert_eq!(profile_dir_name("../../evil").unwrap(), "astra-______evil");
        assert!(profile_dir_name("  ").is_err());
    }

    #[test]
    fn snapshot_round_trip() {
        let mut store = store_two();
        store
            .attach_container("space-work", "firefox-container-3")
            .unwrap();
        let snaps: Vec<SpaceSnapshot> = store.spaces().iter().map(Space::snapshot).collect();
        let back: Vec<Space> = snaps.into_iter().map(Space::from_snapshot).collect();
        assert_eq!(back, store.spaces().to_vec());
    }
}

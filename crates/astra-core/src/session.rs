/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Session snapshot/restore: core-owned organisation (`SessionSnapshot`).
//!
//! Firefox owns *live* tab objects; `astra-core` owns *organisation*
//! (spaces, folders, pins, order, per-tab scroll/zoom/history) per plan
//! §5.4. This module is the pure contract both sides share:
//!
//! - [`SessionSnapshot`] captures tabs + spaces + folders + windows +
//!   scroll/per-tab state as versioned JSON.
//! - Persistence is a single row in the `astra-store` `sessions` table
//!   (`session_save(name, snapshot_json)` / `session_load(name)`); this
//!   crate serializes, the store persists (no dependency either way).
//! - [`SessionSnapshot::reconcile`] computes the startup restore plan.
//!   Conflict rule (§5.4): **live-existence wins for tabs** (never close a
//!   live tab, never fail on a missing one — recreate it), **core wins for
//!   organisation** (order, pins, spaces, active tab come from the snapshot).
//! - The Host `Session` module (`overlay/astra/host/Session.sys.mjs`)
//!   applies the plan through the `Tabs`/`Windows` API on startup.
//!
//! Kill -9 acceptance: snapshot → kill → restore yields identical
//! organisation (URLs, order, spaces, folders, pins, active tab, scroll).

use crate::layout::SplitLayout;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

/// Snapshot format version. Bump on any breaking shape change and keep
/// [`SessionError::VersionMismatch`] so old rows fail loudly, never silently.
pub const SESSION_SNAPSHOT_VERSION: u32 = 1;

/// Default row name in the `sessions` table for the automatic session.
pub const SESSION_NAME_LAST: &str = "last";

/// Zoom bounds mirrored from the Host `Navigation` module (FullZoom limits
/// 0.3–3.0); snapshots outside this range are rejected at validation.
pub const SESSION_MIN_ZOOM: f64 = 0.3;
pub const SESSION_MAX_ZOOM: f64 = 3.0;

/// Viewport scroll offset in CSS pixels, captured per tab.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScrollState {
    pub x: i64,
    pub y: i64,
}

impl ScrollState {
    pub fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }
}

/// One workspace grouping tabs. State lives in core, applied via host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpaceSnapshot {
    pub uuid: String,
    pub name: String,
    pub position: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_ref: Option<String>,
    /// The one Astra profile that owns the space. `None` in snapshots written
    /// before per-profile ownership existed; the running profile adopts those
    /// on first read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

/// One tab folder inside a space.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FolderSnapshot {
    pub uuid: String,
    pub space_uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_uuid: Option<String>,
    pub name: String,
    pub position: i64,
}

/// One browser window (private windows are never snapshotted — private
/// browsing keeps nothing — and are filtered by [`SessionSnapshot::capture`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WindowSnapshot {
    pub window_id: String,
    pub focused: bool,
    #[serde(default)]
    pub title: String,
}

/// One tab's organisation + per-tab state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TabSnapshot {
    pub astra_tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_uuid: Option<String>,
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub pinned: bool,
    pub position: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll: Option<ScrollState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub discarded: bool,
    #[serde(default)]
    pub window_id: String,
    /// Back/forward history stack (oldest → newest); empty means "URL only".
    #[serde(default)]
    pub history: Vec<String>,
    /// Index into [`TabSnapshot::history`] of the current entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_index: Option<usize>,
}

/// Versioned session snapshot. Field order is the canonical display order
/// only via each tab's `position`; vectors are stored sorted by position.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub version: u32,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub spaces: Vec<SpaceSnapshot>,
    #[serde(default)]
    pub folders: Vec<FolderSnapshot>,
    #[serde(default)]
    pub windows: Vec<WindowSnapshot>,
    #[serde(default)]
    pub tabs: Vec<TabSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    /// Split view arrangement (P3-T06). Optional so pre-P3-T06 rows without
    /// the key keep parsing; validated when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<SplitLayout>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SessionError {
    #[error("unsupported snapshot version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid snapshot: {0}")]
    Invalid(String),
    #[error("snapshot JSON error: {0}")]
    Json(String),
}

/// One row of [`SessionSnapshot::organisation_view`]:
/// `(url, space_uuid, folder_uuid, pinned, scroll_xy, position)`.
pub type OrganisationRow = (
    String,
    Option<String>,
    Option<String>,
    bool,
    Option<(i64, i64)>,
    i64,
);

/// Startup restore plan from [`SessionSnapshot::reconcile`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestorePlan {
    /// Snapshot tabs missing live — recreate (by URL) on startup.
    pub to_create_ids: Vec<String>,
    /// Live tab ids to keep (live-existence wins: every live tab survives,
    /// even when absent from the snapshot).
    pub to_keep_ids: Vec<String>,
    /// Final display order: snapshot order for known tabs, live-only tabs
    /// appended in live order (core wins organisation).
    pub final_order: Vec<String>,
    /// Tab to activate after restore, if any survives.
    pub active_tab_id: Option<String>,
}

impl SessionSnapshot {
    /// Empty snapshot named `name`.
    pub fn new(name: impl Into<String>, created_at: i64) -> Self {
        Self {
            version: SESSION_SNAPSHOT_VERSION,
            name: name.into(),
            created_at,
            spaces: Vec::new(),
            folders: Vec::new(),
            windows: Vec::new(),
            tabs: Vec::new(),
            active_tab_id: None,
            layout: None,
        }
    }

    /// Attach a split view arrangement (P3-T06). Builder form so
    /// [`SessionSnapshot::capture`] keeps its signature — this extends the
    /// P2-T09 snapshot, it does not rewrite it.
    pub fn with_layout(mut self, layout: SplitLayout) -> Self {
        self.layout = Some(layout);
        self
    }

    /// Build a snapshot from parts. Private windows (and their tabs) are
    /// dropped. Vectors are sorted by `position` for canonical form.
    #[allow(clippy::too_many_arguments)]
    pub fn capture(
        name: impl Into<String>,
        created_at: i64,
        spaces: Vec<SpaceSnapshot>,
        folders: Vec<FolderSnapshot>,
        windows: Vec<WindowSnapshot>,
        tabs: Vec<TabSnapshot>,
        active_tab_id: Option<String>,
        private_window_ids: &HashSet<String>,
    ) -> Self {
        let mut windows: Vec<WindowSnapshot> = windows
            .into_iter()
            .filter(|w| !private_window_ids.contains(&w.window_id))
            .collect();
        windows.sort_by(|a, b| a.window_id.cmp(&b.window_id));
        let mut tabs: Vec<TabSnapshot> = tabs
            .into_iter()
            .filter(|t| !private_window_ids.contains(&t.window_id))
            .collect();
        tabs.sort_by(|a, b| {
            a.position
                .cmp(&b.position)
                .then(a.astra_tab_id.cmp(&b.astra_tab_id))
        });
        let mut spaces = spaces;
        spaces.sort_by(|a, b| a.position.cmp(&b.position).then(a.uuid.cmp(&b.uuid)));
        let mut folders = folders;
        folders.sort_by(|a, b| a.position.cmp(&b.position).then(a.uuid.cmp(&b.uuid)));
        // A private-window active tab (or any dangling id) must not survive.
        let live: HashSet<&str> = tabs.iter().map(|t| t.astra_tab_id.as_str()).collect();
        let active_tab_id = active_tab_id.filter(|id| live.contains(id.as_str()));
        Self {
            version: SESSION_SNAPSHOT_VERSION,
            name: name.into(),
            created_at,
            spaces,
            folders,
            windows,
            tabs,
            active_tab_id,
            layout: None,
        }
    }

    /// Serialize to the string stored in the `sessions.snapshot` column.
    pub fn to_json(&self) -> Result<String, SessionError> {
        serde_json::to_string(self).map_err(|e| SessionError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, SessionError> {
        let snapshot: Self =
            serde_json::from_str(json).map_err(|e| SessionError::Json(e.to_string()))?;
        snapshot.validate()?;
        Ok(snapshot)
    }

    /// Structural validation: version, non-empty ids/URLs, referential
    /// integrity (folders → spaces, tabs → spaces/folders/windows), history
    /// index in range, at most one focused window, active tab present.
    pub fn validate(&self) -> Result<(), SessionError> {
        if self.version != SESSION_SNAPSHOT_VERSION {
            return Err(SessionError::VersionMismatch(
                self.version,
                SESSION_SNAPSHOT_VERSION,
            ));
        }
        if self.name.is_empty() {
            return Err(SessionError::Invalid(
                "snapshot name must not be empty".to_owned(),
            ));
        }
        let mut space_ids = HashSet::new();
        for space in &self.spaces {
            if space.uuid.is_empty() {
                return Err(SessionError::Invalid(
                    "space uuid must not be empty".to_owned(),
                ));
            }
            if !space_ids.insert(space.uuid.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "duplicate space {}",
                    space.uuid
                )));
            }
        }
        let mut folder_ids = HashSet::new();
        for folder in &self.folders {
            if folder.uuid.is_empty() {
                return Err(SessionError::Invalid(
                    "folder uuid must not be empty".to_owned(),
                ));
            }
            if !folder_ids.insert(folder.uuid.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "duplicate folder {}",
                    folder.uuid
                )));
            }
            if !space_ids.contains(folder.space_uuid.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "folder {} references unknown space {}",
                    folder.uuid, folder.space_uuid
                )));
            }
            if let Some(parent) = &folder.parent_uuid {
                if parent == &folder.uuid {
                    return Err(SessionError::Invalid(format!(
                        "folder {} is its own parent",
                        folder.uuid
                    )));
                }
            }
        }
        // Parent folders must exist when set (checked after collecting ids so
        // forward references validate).
        for folder in &self.folders {
            if let Some(parent) = &folder.parent_uuid {
                if !folder_ids.contains(parent.as_str()) {
                    return Err(SessionError::Invalid(format!(
                        "folder {} references unknown parent {}",
                        folder.uuid, parent
                    )));
                }
            }
        }
        let window_ids: HashSet<&str> = self.windows.iter().map(|w| w.window_id.as_str()).collect();
        if self
            .windows
            .iter()
            .filter(|w| w.window_id.is_empty())
            .count()
            > 0
        {
            return Err(SessionError::Invalid(
                "window_id must not be empty".to_owned(),
            ));
        }
        if self.windows.iter().filter(|w| w.focused).count() > 1 {
            return Err(SessionError::Invalid(
                "at most one window may be focused".to_owned(),
            ));
        }
        let mut tab_ids = HashSet::new();
        for tab in &self.tabs {
            if tab.astra_tab_id.is_empty() {
                return Err(SessionError::Invalid(
                    "astra_tab_id must not be empty".to_owned(),
                ));
            }
            if !tab_ids.insert(tab.astra_tab_id.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "duplicate tab {}",
                    tab.astra_tab_id
                )));
            }
            if tab.url.is_empty() {
                return Err(SessionError::Invalid(format!(
                    "tab {} url must not be empty",
                    tab.astra_tab_id
                )));
            }
            if let Some(space) = &tab.space_uuid {
                if !space_ids.contains(space.as_str()) {
                    return Err(SessionError::Invalid(format!(
                        "tab {} references unknown space {}",
                        tab.astra_tab_id, space
                    )));
                }
            }
            if let Some(folder) = &tab.folder_uuid {
                if !folder_ids.contains(folder.as_str()) {
                    return Err(SessionError::Invalid(format!(
                        "tab {} references unknown folder {}",
                        tab.astra_tab_id, folder
                    )));
                }
            }
            if !tab.window_id.is_empty() && !window_ids.contains(tab.window_id.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "tab {} references unknown window {}",
                    tab.astra_tab_id, tab.window_id
                )));
            }
            if let Some(zoom) = tab.zoom {
                if !zoom.is_finite() || zoom < SESSION_MIN_ZOOM || zoom > SESSION_MAX_ZOOM {
                    return Err(SessionError::Invalid(format!(
                        "tab {} zoom out of range",
                        tab.astra_tab_id
                    )));
                }
            }
            if let Some(index) = tab.history_index {
                if tab.history.is_empty() || index >= tab.history.len() {
                    return Err(SessionError::Invalid(format!(
                        "tab {} history_index out of range",
                        tab.astra_tab_id
                    )));
                }
            }
        }
        if let Some(active) = &self.active_tab_id {
            if !tab_ids.contains(active.as_str()) {
                return Err(SessionError::Invalid(format!(
                    "active tab {active} not in snapshot"
                )));
            }
        }
        if let Some(layout) = &self.layout {
            layout
                .validate()
                .map_err(|e| SessionError::Invalid(format!("layout: {e}")))?;
        }
        Ok(())
    }

    /// Compute the startup restore plan against live tab ids.
    ///
    /// - **Live-existence wins:** every live tab is kept (`to_keep_ids`),
    ///   even when absent from the snapshot; missing snapshot tabs are
    ///   recreated (`to_create_ids`) — after a kill -9 the live set is empty
    ///   so the whole snapshot is recreated.
    /// - **Core wins organisation:** `final_order` follows snapshot
    ///   `position` for known tabs; live-only tabs are appended in the live
    ///   order given; `active_tab_id` survives when still present.
    pub fn reconcile(&self, live_order: &[String]) -> RestorePlan {
        let live: HashSet<&str> = live_order.iter().map(String::as_str).collect();
        let snapshot_ids: HashSet<&str> =
            self.tabs.iter().map(|t| t.astra_tab_id.as_str()).collect();
        let to_create_ids: Vec<String> = self
            .tabs
            .iter()
            .filter(|t| !live.contains(t.astra_tab_id.as_str()))
            .map(|t| t.astra_tab_id.clone())
            .collect();
        let to_keep_ids: Vec<String> = live_order.to_vec();
        let mut final_order: Vec<String> =
            self.tabs.iter().map(|t| t.astra_tab_id.clone()).collect();
        for id in live_order {
            if !snapshot_ids.contains(id.as_str()) {
                final_order.push(id.clone());
            }
        }
        let surviving: HashSet<&str> = final_order.iter().map(String::as_str).collect();
        let active_tab_id = self
            .active_tab_id
            .as_ref()
            .filter(|id| surviving.contains(id.as_str()))
            .cloned();
        RestorePlan {
            to_create_ids,
            to_keep_ids,
            final_order,
            active_tab_id,
        }
    }

    /// Organisation view for equality checks: per-tab
    /// `(url, space, folder, pinned, scroll, position)` in display order.
    /// Tab ids are intentionally excluded — the host mints fresh ids on
    /// restore, so identity is by content + placement, not by id.
    pub fn organisation_view(&self) -> Vec<OrganisationRow> {
        let mut tabs = self.tabs.clone();
        tabs.sort_by_key(|t| t.position);
        tabs.into_iter()
            .map(|t| {
                (
                    t.url,
                    t.space_uuid,
                    t.folder_uuid,
                    t.pinned,
                    t.scroll.map(|s| (s.x, s.y)),
                    t.position,
                )
            })
            .collect()
    }

    /// Tab lookup by id.
    pub fn tab(&self, id: &str) -> Option<&TabSnapshot> {
        self.tabs.iter().find(|t| t.astra_tab_id == id)
    }

    /// Space lookup by uuid.
    pub fn space(&self, uuid: &str) -> Option<&SpaceSnapshot> {
        self.spaces.iter().find(|s| s.uuid == uuid)
    }
}

/// Per-tab scroll/zoom overrides keyed by tab id, for
/// [`capture_with_state`]-style callers that keep live UI state outside the
/// tab strip.
pub type ScrollMap = HashMap<String, ScrollState>;
pub type ZoomMap = HashMap<String, f64>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tabs::TabStrip;

    fn sample_snapshot() -> SessionSnapshot {
        let spaces = vec![
            SpaceSnapshot {
                uuid: "space-work".to_owned(),
                name: "Work".to_owned(),
                position: 0,
                container_ref: Some("ctx-work".to_owned()),
                profile_id: None,
            },
            SpaceSnapshot {
                uuid: "space-play".to_owned(),
                name: "Play".to_owned(),
                position: 1,
                container_ref: None,
                profile_id: None,
            },
        ];
        let folders = vec![FolderSnapshot {
            uuid: "folder-inbox".to_owned(),
            space_uuid: "space-work".to_owned(),
            parent_uuid: None,
            name: "Inbox".to_owned(),
            position: 0,
        }];
        let windows = vec![
            WindowSnapshot {
                window_id: "win-1".to_owned(),
                focused: true,
                title: "Astra".to_owned(),
            },
            WindowSnapshot {
                window_id: "win-2".to_owned(),
                focused: false,
                title: "Side".to_owned(),
            },
        ];
        let tabs = vec![
            TabSnapshot {
                astra_tab_id: "tab-a".to_owned(),
                space_uuid: Some("space-work".to_owned()),
                folder_uuid: Some("folder-inbox".to_owned()),
                url: "https://a.example/".to_owned(),
                title: "A".to_owned(),
                pinned: true,
                position: 0,
                scroll: Some(ScrollState::new(0, 240)),
                zoom: Some(1.25),
                muted: false,
                discarded: false,
                window_id: "win-1".to_owned(),
                history: vec![
                    "https://a.example/".to_owned(),
                    "https://a.example/2".to_owned(),
                ],
                history_index: Some(1),
            },
            TabSnapshot {
                astra_tab_id: "tab-b".to_owned(),
                space_uuid: Some("space-work".to_owned()),
                folder_uuid: None,
                url: "https://b.example/".to_owned(),
                title: "B".to_owned(),
                pinned: false,
                position: 1,
                scroll: Some(ScrollState::new(10, 20)),
                zoom: None,
                muted: true,
                discarded: false,
                window_id: "win-1".to_owned(),
                history: vec![],
                history_index: None,
            },
            TabSnapshot {
                astra_tab_id: "tab-c".to_owned(),
                space_uuid: Some("space-play".to_owned()),
                folder_uuid: None,
                url: "https://c.example/".to_owned(),
                title: "C".to_owned(),
                pinned: false,
                position: 2,
                scroll: None,
                zoom: None,
                muted: false,
                discarded: true,
                window_id: "win-2".to_owned(),
                history: vec![],
                history_index: None,
            },
        ];
        SessionSnapshot {
            version: SESSION_SNAPSHOT_VERSION,
            name: SESSION_NAME_LAST.to_owned(),
            created_at: 1_700_000_000,
            spaces,
            folders,
            windows,
            tabs,
            active_tab_id: Some("tab-b".to_owned()),
            layout: None,
        }
    }

    #[test]
    fn round_trip_json_preserves_organisation() {
        let snapshot = sample_snapshot();
        assert!(snapshot.validate().is_ok());
        let json = snapshot.to_json().unwrap();
        let parsed = SessionSnapshot::from_json(&json).unwrap();
        assert_eq!(parsed, snapshot);
        assert_eq!(parsed.organisation_view(), snapshot.organisation_view());
        assert_eq!(parsed.active_tab_id.as_deref(), Some("tab-b"));
    }

    #[test]
    fn kill9_empty_live_recreates_everything_in_order() {
        // Acceptance: snapshot → kill -9 (live set empty) → restore yields
        // identical organisation.
        let snapshot = sample_snapshot();
        let plan = snapshot.reconcile(&[]);
        assert_eq!(plan.to_create_ids, vec!["tab-a", "tab-b", "tab-c"]);
        assert!(plan.to_keep_ids.is_empty());
        assert_eq!(plan.final_order, vec!["tab-a", "tab-b", "tab-c"]);
        assert_eq!(plan.active_tab_id.as_deref(), Some("tab-b"));

        // Simulate the restore: recreated tabs carry identical organisation.
        let restored_json = snapshot.to_json().unwrap();
        let restored = SessionSnapshot::from_json(&restored_json).unwrap();
        assert_eq!(restored.organisation_view(), snapshot.organisation_view());
        assert_eq!(restored.spaces, snapshot.spaces);
        assert_eq!(restored.folders, snapshot.folders);
    }

    #[test]
    fn conflict_live_existence_wins_core_organisation_wins() {
        // Snapshot knows A + B; live has B + C (A closed live, C opened live).
        let snapshot = sample_snapshot();
        let live = vec!["tab-b".to_owned(), "tab-live-new".to_owned()];
        let plan = snapshot.reconcile(&live);
        // A is missing live → recreated; B exists live → kept, not duplicated.
        assert!(plan.to_create_ids.contains(&"tab-a".to_owned()));
        assert!(plan.to_create_ids.contains(&"tab-c".to_owned()));
        assert!(!plan.to_create_ids.contains(&"tab-b".to_owned()));
        // Live-existence wins: every live tab survives, including C which the
        // snapshot never knew.
        assert!(plan.to_keep_ids.contains(&"tab-live-new".to_owned()));
        assert!(plan.to_keep_ids.contains(&"tab-b".to_owned()));
        // Core wins organisation: snapshot order first, live-only appended.
        assert_eq!(
            plan.final_order,
            vec!["tab-a", "tab-b", "tab-c", "tab-live-new"]
        );
        // Active tab from core survives (tab-b is still present).
        assert_eq!(plan.active_tab_id.as_deref(), Some("tab-b"));
    }

    #[test]
    fn conflict_active_gone_falls_back_to_none() {
        let mut snapshot = sample_snapshot();
        snapshot.active_tab_id = Some("tab-a".to_owned());
        // Live-only world with none of the snapshot tabs surviving as
        // activatable: reconcile keeps active only when still present. Here
        // tab-a IS in final_order (recreated), so it survives…
        let plan = snapshot.reconcile(&["tab-live-new".to_owned()]);
        assert_eq!(plan.active_tab_id.as_deref(), Some("tab-a"));
        // …but a snapshot pointing at an unknown tab fails validation instead
        // of restoring a dangling selection.
        snapshot.active_tab_id = Some("tab-ghost".to_owned());
        assert!(snapshot.validate().is_err());
    }

    #[test]
    fn private_windows_and_tabs_are_excluded() {
        let mut private = HashSet::new();
        private.insert("win-2".to_owned());
        let snapshot = SessionSnapshot::capture(
            SESSION_NAME_LAST,
            42,
            vec![SpaceSnapshot {
                uuid: "s".to_owned(),
                name: "S".to_owned(),
                position: 0,
                container_ref: None,
                profile_id: None,
            }],
            vec![],
            vec![
                WindowSnapshot {
                    window_id: "win-1".to_owned(),
                    focused: true,
                    title: String::new(),
                },
                WindowSnapshot {
                    window_id: "win-2".to_owned(),
                    focused: false,
                    title: String::new(),
                },
            ],
            vec![
                TabSnapshot {
                    astra_tab_id: "t1".to_owned(),
                    space_uuid: None,
                    folder_uuid: None,
                    url: "https://a.example/".to_owned(),
                    title: String::new(),
                    pinned: false,
                    position: 0,
                    scroll: None,
                    zoom: None,
                    muted: false,
                    discarded: false,
                    window_id: "win-1".to_owned(),
                    history: vec![],
                    history_index: None,
                },
                TabSnapshot {
                    astra_tab_id: "t2".to_owned(),
                    space_uuid: None,
                    folder_uuid: None,
                    url: "https://secret.example/".to_owned(),
                    title: String::new(),
                    pinned: false,
                    position: 1,
                    scroll: None,
                    zoom: None,
                    muted: false,
                    discarded: false,
                    window_id: "win-2".to_owned(),
                    history: vec![],
                    history_index: None,
                },
            ],
            Some("t2".to_owned()),
            &private,
        );
        assert_eq!(snapshot.windows.len(), 1);
        assert_eq!(snapshot.tabs.len(), 1);
        // Dangling active tab (t2 was private) is cleared, not preserved.
        assert_eq!(snapshot.active_tab_id, None);
    }

    #[test]
    fn capture_sorts_by_position_for_canonical_form() {
        let mk = |id: &str, pos: i64| TabSnapshot {
            astra_tab_id: id.to_owned(),
            space_uuid: None,
            folder_uuid: None,
            url: format!("https://{id}.example/"),
            title: String::new(),
            pinned: false,
            position: pos,
            scroll: None,
            zoom: None,
            muted: false,
            discarded: false,
            window_id: "win-1".to_owned(),
            history: vec![],
            history_index: None,
        };
        let snapshot = SessionSnapshot::capture(
            "x",
            0,
            vec![],
            vec![],
            vec![WindowSnapshot {
                window_id: "win-1".to_owned(),
                focused: true,
                title: String::new(),
            }],
            vec![mk("t2", 1), mk("t1", 0)],
            None,
            &HashSet::new(),
        );
        assert_eq!(snapshot.tabs[0].astra_tab_id, "t1");
        assert_eq!(snapshot.tabs[1].astra_tab_id, "t2");
    }

    #[test]
    fn capture_from_tab_strip_ids_survive_json() {
        let mut strip = TabStrip::new();
        let a = strip.open("https://a.example/");
        let b = strip.open("https://b.example/");
        // Minimal projection of the strip into tab snapshots (organisation
        // fields default; spaces/folders supplied by the caller).
        let tabs: Vec<TabSnapshot> = strip
            .tabs()
            .iter()
            .enumerate()
            .map(|(i, entry)| TabSnapshot {
                astra_tab_id: entry.id.to_string(),
                space_uuid: None,
                folder_uuid: None,
                url: entry.url.clone(),
                title: entry.title.clone(),
                pinned: entry.essential,
                position: i as i64,
                scroll: None,
                zoom: None,
                muted: false,
                discarded: false,
                window_id: "win-1".to_owned(),
                history: vec![entry.url.clone()],
                history_index: Some(0),
            })
            .collect();
        let snapshot = SessionSnapshot::capture(
            SESSION_NAME_LAST,
            7,
            vec![],
            vec![],
            vec![WindowSnapshot {
                window_id: "win-1".to_owned(),
                focused: true,
                title: String::new(),
            }],
            tabs,
            strip.active().map(|id| id.to_string()),
            &HashSet::new(),
        );
        assert!(snapshot.validate().is_ok());
        let parsed = SessionSnapshot::from_json(&snapshot.to_json().unwrap()).unwrap();
        let urls: Vec<&str> = parsed.tabs.iter().map(|t| t.url.as_str()).collect();
        assert_eq!(urls, vec!["https://a.example/", "https://b.example/"]);
        assert_eq!(parsed.active_tab_id, Some(b.to_string()));
        assert!(parsed.tab(&a.to_string()).is_some());
    }

    #[test]
    fn validation_rejects_broken_shapes() {
        let mut bad = sample_snapshot();
        bad.version = 999;
        assert_eq!(
            bad.validate(),
            Err(SessionError::VersionMismatch(999, SESSION_SNAPSHOT_VERSION))
        );
        assert!(SessionSnapshot::from_json(&bad.to_json().unwrap()).is_err());

        let mut bad = sample_snapshot();
        bad.tabs[0].url.clear();
        assert!(bad.validate().is_err());

        let mut bad = sample_snapshot();
        bad.tabs[0].space_uuid = Some("space-ghost".to_owned());
        assert!(bad.validate().is_err());

        let mut bad = sample_snapshot();
        bad.folders[0].space_uuid = "space-ghost".to_owned();
        assert!(bad.validate().is_err());

        let mut bad = sample_snapshot();
        bad.tabs.push(bad.tabs[0].clone());
        assert!(bad.validate().is_err());

        let mut bad = sample_snapshot();
        bad.tabs[0].history_index = Some(7);
        assert!(bad.validate().is_err());

        let mut bad = sample_snapshot();
        bad.tabs[0].zoom = Some(f64::INFINITY);
        assert!(bad.validate().is_err());

        // Malformed JSON surfaces as Json, not a panic.
        assert!(matches!(
            SessionSnapshot::from_json("{not json"),
            Err(SessionError::Json(_))
        ));
    }

    #[test]
    fn store_sessions_table_round_trip() {
        // Proves the store half of the design: the snapshot string persists
        // verbatim under its session name.
        let store = astra_store::Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        let snapshot = sample_snapshot();
        let json = snapshot.to_json().unwrap();
        store.session_save(SESSION_NAME_LAST, &json).unwrap();
        let row = store.session_load(SESSION_NAME_LAST).unwrap().unwrap();
        assert_eq!(row.snapshot, json);
        assert_eq!(SessionSnapshot::from_json(&row.snapshot).unwrap(), snapshot);
        // Re-saving replaces the row (kill -9 overwrites, never duplicates).
        let mut second = snapshot.clone();
        second.tabs.pop();
        let json2 = second.to_json().unwrap();
        store.session_save(SESSION_NAME_LAST, &json2).unwrap();
        let row2 = store.session_load(SESSION_NAME_LAST).unwrap().unwrap();
        assert_eq!(row2.snapshot, json2);
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Split view layout: core-owned organisation of content slots (P3-T06).
//!
//! Builds on spike S-01 (`docs/astra/spikes/S-01.md`): a fixed pool of at
//! most [`MAX_SPLIT_SLOTS`] panes is laid out by CSS grid (`single` /
//! `cols-2` / `grid-2x2`); DOM nodes are never reparented, so a *slot* keeps
//! its identity for life and only the *tab binding* moves. [`swap_slots`]
//! therefore exchanges `astra_tab_id`s, never slot positions.
//!
//! Persistence rides the P2-T09 session snapshot without rewriting it:
//! [`SessionSnapshot`](crate::session::SessionSnapshot) gains an optional
//! `layout` field (`with_layout` builder), and the JSON keeps living in the
//! `astra-store` `sessions` table under `"last"`. Snapshots written before
//! P3-T06 have no `layout` key and still parse (`#[serde(default)]`).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;

/// Layout format version. Bump on any breaking shape change and keep
/// [`LayoutError::VersionMismatch`] so old rows fail loudly, never silently.
pub const LAYOUT_SNAPSHOT_VERSION: u32 = 1;

/// Fixed pool size from S-01 (`MAX_SLOTS`): one remote `<browser>` per cell,
/// visibility only — never created, moved, or destroyed by layout switches.
pub const MAX_SPLIT_SLOTS: usize = 3;

/// Minimum/maximum share of the split axis one slot may hold. Resizes clamp
/// into this band and siblings absorb the difference proportionally.
pub const MIN_SLOT_RATIO: f64 = 0.05;
pub const MAX_SLOT_RATIO: f64 = 0.95;

/// One content slot: a stable cell identity plus the tab it shows and its
/// share of the split axis. Ratios across a layout always sum to 1.0.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlotLayout {
    pub slot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub astra_tab_id: Option<String>,
    pub ratio: f64,
    pub position: i64,
}

/// The whole split arrangement: slots in display order plus the focused one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SplitLayout {
    pub version: u32,
    #[serde(default)]
    pub slots: Vec<SlotLayout>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_slot_id: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum LayoutError {
    #[error("unsupported layout version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid layout: {0}")]
    Invalid(String),
    #[error("layout JSON error: {0}")]
    Json(String),
}

impl SlotLayout {
    fn fresh(slot_id: impl Into<String>, position: i64, ratio: f64) -> Self {
        Self {
            slot_id: slot_id.into(),
            astra_tab_id: None,
            ratio,
            position,
        }
    }
}

impl SplitLayout {
    /// A single empty pane — the default arrangement, mirrors S-01 `single`.
    pub fn single() -> Self {
        Self {
            version: LAYOUT_SNAPSHOT_VERSION,
            slots: vec![SlotLayout::fresh("slot-1", 0, 1.0)],
            active_slot_id: Some("slot-1".to_owned()),
        }
    }

    /// CSS-grid variant for the current slot count (mirrors S-01 `layoutFor`
    /// and `slots.css` `[data-layout=...]`): 1 → `single`, 2 → `cols-2`,
    /// 3/4 → `grid-2x2`.
    pub fn variant(&self) -> &'static str {
        match self.slots.len() {
            0 | 1 => "single",
            2 => "cols-2",
            _ => "grid-2x2",
        }
    }

    pub fn slot(&self, id: &str) -> Option<&SlotLayout> {
        self.slots.iter().find(|s| s.slot_id == id)
    }

    fn slot_mut(&mut self, id: &str) -> Option<&mut SlotLayout> {
        self.slots.iter_mut().find(|s| s.slot_id == id)
    }

    /// Split the focused (or first) pane to show `tab_id`, up to
    /// [`MAX_SPLIT_SLOTS`] slots. The new slot becomes active; every slot's
    /// share is re-equalised so the axis still sums to 1.0.
    pub fn open_split(&mut self, tab_id: Option<String>) -> Result<&SlotLayout, LayoutError> {
        if self.slots.len() >= MAX_SPLIT_SLOTS {
            return Err(LayoutError::Invalid(format!(
                "at most {MAX_SPLIT_SLOTS} split slots"
            )));
        }
        let n = self.slots.len() as i64;
        let slot_id = format!("slot-{}", n + 1);
        let mut slot = SlotLayout::fresh(&slot_id, n, 0.0);
        slot.astra_tab_id = tab_id;
        self.slots.push(slot);
        self.equalise_ratios();
        self.active_slot_id = Some(slot_id.clone());
        Ok(self.slot(&slot_id).expect("just pushed"))
    }

    /// Close a slot. Closing the final slot resets to a single empty pane
    /// (S-01 never drops below one visible cell); otherwise the closed
    /// share is redistributed equally and focus falls back to slot-1.
    pub fn close_slot(&mut self, slot_id: &str) -> Result<(), LayoutError> {
        let at = self
            .slots
            .iter()
            .position(|s| s.slot_id == slot_id)
            .ok_or_else(|| LayoutError::Invalid(format!("unknown slot {slot_id}")))?;
        self.slots.remove(at);
        if self.slots.is_empty() {
            *self = Self::single();
            return Ok(());
        }
        for (i, slot) in self.slots.iter_mut().enumerate() {
            slot.position = i as i64;
        }
        self.equalise_ratios();
        if self.active_slot_id.as_deref() == Some(slot_id) {
            self.active_slot_id = Some("slot-1".to_owned());
        }
        Ok(())
    }

    /// Resize a slot to `ratio` of the split axis. Clamped into
    /// `MIN_SLOT_RATIO..=MAX_SLOT_RATIO`; siblings scale proportionally so
    /// the axis still sums to 1.0. A lone slot is always full-width.
    pub fn resize_slot(&mut self, slot_id: &str, ratio: f64) -> Result<(), LayoutError> {
        if !ratio.is_finite() {
            return Err(LayoutError::Invalid(format!(
                "slot {slot_id} ratio must be finite"
            )));
        }
        if self.slot(slot_id).is_none() {
            return Err(LayoutError::Invalid(format!("unknown slot {slot_id}")));
        }
        if self.slots.len() == 1 {
            self.slots[0].ratio = 1.0;
            return Ok(());
        }
        let clamped = ratio.clamp(MIN_SLOT_RATIO, MAX_SLOT_RATIO);
        let rest = 1.0 - clamped;
        let sibling_count = self.slots.len() - 1;
        let old_rest: f64 = self
            .slots
            .iter()
            .filter(|s| s.slot_id != slot_id)
            .map(|s| s.ratio)
            .sum();
        for slot in &mut self.slots {
            if slot.slot_id == slot_id {
                slot.ratio = clamped;
            } else if old_rest > 0.0 {
                slot.ratio = slot.ratio / old_rest * rest;
            } else {
                slot.ratio = rest / sibling_count as f64;
            }
        }
        Ok(())
    }

    /// Exchange which tabs two slots show. Slot (cell) identity is stable —
    /// the S-01 no-reparenting rule — only the bindings move.
    pub fn swap_slots(&mut self, a: &str, b: &str) -> Result<(), LayoutError> {
        if a == b {
            return Ok(());
        }
        let (ia, ib) = match (
            self.slots.iter().position(|s| s.slot_id == a),
            self.slots.iter().position(|s| s.slot_id == b),
        ) {
            (Some(ia), Some(ib)) => (ia, ib),
            _ => {
                return Err(LayoutError::Invalid(format!(
                    "unknown slot in swap {a} <-> {b}"
                )))
            }
        };
        let tmp = self.slots[ia].astra_tab_id.clone();
        self.slots[ia].astra_tab_id = self.slots[ib].astra_tab_id.clone();
        self.slots[ib].astra_tab_id = tmp;
        Ok(())
    }

    /// Bind a tab to a slot (model-side only — the cell keeps its own
    /// `<browser>`, rebinding loads the URL there).
    pub fn bind_tab(&mut self, slot_id: &str, tab_id: Option<String>) -> Result<(), LayoutError> {
        let slot = self
            .slot_mut(slot_id)
            .ok_or_else(|| LayoutError::Invalid(format!("unknown slot {slot_id}")))?;
        slot.astra_tab_id = tab_id;
        Ok(())
    }

    /// Focus a slot; focusing also drives `Tabs.select` on the host side.
    pub fn set_active(&mut self, slot_id: &str) -> Result<(), LayoutError> {
        if self.slot(slot_id).is_none() {
            return Err(LayoutError::Invalid(format!("unknown slot {slot_id}")));
        }
        self.active_slot_id = Some(slot_id.to_owned());
        Ok(())
    }

    /// Serialize to the string stored alongside the session snapshot.
    pub fn to_json(&self) -> Result<String, LayoutError> {
        serde_json::to_string(self).map_err(|e| LayoutError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, LayoutError> {
        let layout: Self =
            serde_json::from_str(json).map_err(|e| LayoutError::Json(e.to_string()))?;
        layout.validate()?;
        Ok(layout)
    }

    /// Structural validation: version, non-empty unique ids, ratios in
    /// range summing to ~1.0, active slot present.
    pub fn validate(&self) -> Result<(), LayoutError> {
        if self.version != LAYOUT_SNAPSHOT_VERSION {
            return Err(LayoutError::VersionMismatch(
                self.version,
                LAYOUT_SNAPSHOT_VERSION,
            ));
        }
        if self.slots.is_empty() || self.slots.len() > MAX_SPLIT_SLOTS {
            return Err(LayoutError::Invalid(format!(
                "slot count must be 1..={MAX_SPLIT_SLOTS}"
            )));
        }
        let mut seen = HashSet::new();
        let mut sum = 0.0;
        for slot in &self.slots {
            if slot.slot_id.is_empty() {
                return Err(LayoutError::Invalid("slot_id must not be empty".to_owned()));
            }
            if !seen.insert(slot.slot_id.as_str()) {
                return Err(LayoutError::Invalid(format!(
                    "duplicate slot {}",
                    slot.slot_id
                )));
            }
            if !slot.ratio.is_finite() || slot.ratio <= 0.0 || slot.ratio > 1.0 {
                return Err(LayoutError::Invalid(format!(
                    "slot {} ratio out of range",
                    slot.slot_id
                )));
            }
            sum += slot.ratio;
        }
        if (sum - 1.0).abs() > 1e-6 {
            return Err(LayoutError::Invalid(format!(
                "slot ratios must sum to 1.0 (got {sum})"
            )));
        }
        if let Some(active) = &self.active_slot_id {
            if !seen.contains(active.as_str()) {
                return Err(LayoutError::Invalid(format!(
                    "active slot {active} not in layout"
                )));
            }
        }
        Ok(())
    }

    /// Display order for equality checks: `(slot_id, tab_id)` by position.
    pub fn organisation_view(&self) -> Vec<(String, Option<String>)> {
        let mut slots = self.slots.clone();
        slots.sort_by_key(|s| s.position);
        slots
            .into_iter()
            .map(|s| (s.slot_id, s.astra_tab_id))
            .collect()
    }

    fn equalise_ratios(&mut self) {
        let share = 1.0 / self.slots.len() as f64;
        for slot in &mut self.slots {
            slot.ratio = share;
        }
    }
}

/// Free function mirroring the model for callers that only need the grid
/// variant (kept next to the S-01 `layoutFor` naming for greppability).
pub fn layout_for(visible_count: usize) -> &'static str {
    match visible_count {
        0 | 1 => "single",
        2 => "cols-2",
        _ => "grid-2x2",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_sum(layout: &SplitLayout) -> f64 {
        layout.slots.iter().map(|s| s.ratio).sum()
    }

    #[test]
    fn single_starts_full_width_and_valid() {
        let layout = SplitLayout::single();
        assert_eq!(layout.variant(), "single");
        assert_eq!(layout.slots.len(), 1);
        assert_eq!(layout.slots[0].ratio, 1.0);
        assert!(layout.validate().is_ok());
    }

    #[test]
    fn open_split_grows_to_cols_then_grid() {
        let mut layout = SplitLayout::single();
        layout.bind_tab("slot-1", Some("tab-a".to_owned())).unwrap();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        assert_eq!(layout.variant(), "cols-2");
        assert_eq!(layout.active_slot_id.as_deref(), Some("slot-2"));
        layout.open_split(Some("tab-c".to_owned())).unwrap();
        layout.open_split(Some("tab-d".to_owned())).unwrap();
        assert_eq!(layout.variant(), "grid-2x2");
        assert!((approx_sum(&layout) - 1.0).abs() < 1e-9);
        assert!(layout.validate().is_ok());
        // Pool is fixed at four — a fifth split is refused, never silently
        // dropped.
        assert!(layout.open_split(Some("tab-e".to_owned())).is_err());
        assert_eq!(layout.slots.len(), MAX_SPLIT_SLOTS);
    }

    #[test]
    fn resize_clamps_and_keeps_axis_sum() {
        let mut layout = SplitLayout::single();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        layout.resize_slot("slot-1", 0.7).unwrap();
        assert!((layout.slot("slot-1").unwrap().ratio - 0.7).abs() < 1e-9);
        assert!((approx_sum(&layout) - 1.0).abs() < 1e-9);
        // Clamp: absurd values pin to the band, siblings absorb the rest.
        layout.resize_slot("slot-1", 99.0).unwrap();
        assert!((layout.slot("slot-1").unwrap().ratio - MAX_SLOT_RATIO).abs() < 1e-9);
        assert!((approx_sum(&layout) - 1.0).abs() < 1e-9);
        layout.resize_slot("slot-2", -3.0).unwrap();
        assert!((layout.slot("slot-2").unwrap().ratio - MIN_SLOT_RATIO).abs() < 1e-9);
        assert!((approx_sum(&layout) - 1.0).abs() < 1e-9);
        // Unknown slots and NaN fail loudly.
        assert!(layout.resize_slot("slot-9", 0.5).is_err());
        assert!(layout.resize_slot("slot-1", f64::NAN).is_err());
        assert!(layout.validate().is_ok());
    }

    #[test]
    fn resize_lone_slot_stays_full_width() {
        let mut layout = SplitLayout::single();
        layout.resize_slot("slot-1", 0.3).unwrap();
        assert_eq!(layout.slot("slot-1").unwrap().ratio, 1.0);
    }

    #[test]
    fn swap_exchanges_bindings_not_cells() {
        let mut layout = SplitLayout::single();
        layout.bind_tab("slot-1", Some("tab-a".to_owned())).unwrap();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        layout.swap_slots("slot-1", "slot-2").unwrap();
        assert_eq!(
            layout.slot("slot-1").unwrap().astra_tab_id.as_deref(),
            Some("tab-b")
        );
        assert_eq!(
            layout.slot("slot-2").unwrap().astra_tab_id.as_deref(),
            Some("tab-a")
        );
        // Cell order (and ratios) are untouched — only bindings moved.
        assert_eq!(layout.slots[0].slot_id, "slot-1");
        // Self-swap is a no-op; unknown ids fail.
        layout.swap_slots("slot-1", "slot-1").unwrap();
        assert!(layout.swap_slots("slot-1", "slot-9").is_err());
        assert!(layout.validate().is_ok());
    }

    #[test]
    fn close_redistributes_and_last_close_resets() {
        let mut layout = SplitLayout::single();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        layout.open_split(Some("tab-c".to_owned())).unwrap();
        layout.set_active("slot-3").unwrap();
        layout.close_slot("slot-3").unwrap();
        assert_eq!(layout.slots.len(), 2);
        // Focus fell back off the closed slot; axis still sums to one.
        assert_eq!(layout.active_slot_id.as_deref(), Some("slot-1"));
        assert!((approx_sum(&layout) - 1.0).abs() < 1e-9);
        assert!(layout.close_slot("slot-9").is_err());
        layout.close_slot("slot-1").unwrap();
        layout.close_slot("slot-2").unwrap();
        // Never below one visible cell: back to a fresh single pane.
        assert_eq!(layout, SplitLayout::single());
    }

    #[test]
    fn set_active_and_bind_reject_unknown_slots() {
        let mut layout = SplitLayout::single();
        assert!(layout.set_active("slot-9").is_err());
        assert!(layout.bind_tab("slot-9", None).is_err());
        layout.set_active("slot-1").unwrap();
        layout.bind_tab("slot-1", Some("tab-a".to_owned())).unwrap();
        layout.bind_tab("slot-1", None).unwrap();
        assert_eq!(layout.slot("slot-1").unwrap().astra_tab_id, None);
    }

    #[test]
    fn json_round_trip_preserves_layout() {
        let mut layout = SplitLayout::single();
        layout.bind_tab("slot-1", Some("tab-a".to_owned())).unwrap();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        layout.resize_slot("slot-2", 0.35).unwrap();
        let json = layout.to_json().unwrap();
        let parsed = SplitLayout::from_json(&json).unwrap();
        assert_eq!(parsed, layout);
        assert_eq!(parsed.organisation_view(), layout.organisation_view());
    }

    #[test]
    fn validation_rejects_broken_shapes() {
        let mut bad = SplitLayout::single();
        bad.version = 999;
        assert_eq!(
            bad.validate(),
            Err(LayoutError::VersionMismatch(999, LAYOUT_SNAPSHOT_VERSION))
        );
        assert!(SplitLayout::from_json(&bad.to_json().unwrap()).is_err());

        let mut bad = SplitLayout::single();
        bad.slots.clear();
        assert!(bad.validate().is_err());

        let mut bad = SplitLayout::single();
        bad.open_split(None).unwrap();
        bad.slots[0].ratio = 0.0;
        assert!(bad.validate().is_err());

        let mut bad = SplitLayout::single();
        bad.open_split(None).unwrap();
        bad.slots[1].ratio = 0.9; // sum 1.4
        assert!(bad.validate().is_err());

        let mut bad = SplitLayout::single();
        bad.active_slot_id = Some("slot-ghost".to_owned());
        assert!(bad.validate().is_err());

        let mut bad = SplitLayout::single();
        bad.open_split(None).unwrap();
        bad.slots[1].slot_id = "slot-1".to_owned();
        assert!(bad.validate().is_err());

        assert!(matches!(
            SplitLayout::from_json("{not json"),
            Err(LayoutError::Json(_))
        ));
    }

    #[test]
    fn layout_survives_sessions_table_round_trip() {
        // Acceptance: layout persists via the P2-T09 sessions table —
        // snapshot JSON (layout embedded) → `session_save` → kill →
        // `session_load` → identical organisation.
        use crate::session::{SessionSnapshot, SESSION_NAME_LAST};

        let mut layout = SplitLayout::single();
        layout.bind_tab("slot-1", Some("tab-a".to_owned())).unwrap();
        layout.open_split(Some("tab-b".to_owned())).unwrap();
        layout.resize_slot("slot-2", 0.35).unwrap();
        layout.swap_slots("slot-1", "slot-2").unwrap();

        let snapshot = SessionSnapshot::new(SESSION_NAME_LAST, 1_700_000_001).with_layout(layout);
        assert!(snapshot.validate().is_ok());
        let json = snapshot.to_json().unwrap();

        let store = astra_store::Store::open_in_memory().unwrap();
        store.migrate().unwrap();
        store.session_save(SESSION_NAME_LAST, &json).unwrap();
        let row = store.session_load(SESSION_NAME_LAST).unwrap().unwrap();
        assert_eq!(row.snapshot, json);

        let restored = SessionSnapshot::from_json(&row.snapshot).unwrap();
        let restored_layout = restored.layout.as_ref().unwrap();
        assert_eq!(
            restored_layout.organisation_view(),
            vec![
                ("slot-1".to_owned(), Some("tab-b".to_owned())),
                ("slot-2".to_owned(), Some("tab-a".to_owned())),
            ]
        );
        assert!((restored_layout.slot("slot-2").unwrap().ratio - 0.35).abs() < 1e-9);
        assert_eq!(restored_layout.variant(), "cols-2");
    }

    #[test]
    fn snapshots_without_layout_still_parse() {
        // Pre-P3-T06 rows have no `layout` key — they must keep restoring.
        use crate::session::SessionSnapshot;
        let legacy = r#"{"version":1,"name":"last","created_at":0}"#;
        let parsed = SessionSnapshot::from_json(legacy).unwrap();
        assert_eq!(parsed.layout, None);
    }
}

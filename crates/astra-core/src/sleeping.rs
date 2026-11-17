/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tab sleeping policy: idle timers, memory pressure, exclusions (P4-T06).
//!
//! Inactive tabs sleep (discard) and wake on demand. This module is the
//! **pure policy core**: given a [`TabState`] snapshot and `now_ms`, decide
//! with [`should_sleep`]; given a host event, decide with
//! [`should_wake`]. Effects stay behind the [`SleepHost`] seam, which maps
//! 1:1 onto the Host API `Tabs.discard` / `Tabs.wakeup`
//! (`overlay/astra/host/Tabs.sys.mjs`, live binding `discardBrowser` /
//! tab reload — see `docs/astra/HOST_API_v1.md`). This crate never touches
//! the host modules; the [`StubSleepHost`] below is the test double that
//! proves the discard → wakeup round-trip preserves URL/scroll via the
//! session snapshot ([`TabSnapshot`][crate::session::TabSnapshot]).
//!
//! Benchmark hooks: [`SleepMetrics`] records wake-latency samples and an
//! estimated memory-savings counter. Live discard/restore timing belongs in
//! the Host contract suite; the stub measures the policy round-trip here.

use crate::session::{ScrollState, TabSnapshot};
use std::collections::HashMap;
use std::time::Instant;
use thiserror::Error;

/// Default idle time before a tab becomes sleep-eligible (5 minutes).
pub const DEFAULT_IDLE_TIMEOUT_MS: i64 = 5 * 60 * 1000;

/// Default keep-warm window: this many most recently active tabs are never
/// selected for sleep, so a click on one of them does not reload.
pub const DEFAULT_KEEP_WARM_COUNT: usize = 6;

/// Default per-discarded-tab memory-saving estimate (50 MiB, Firefox
/// content-process ballpark; refined by P4-T10 baselines in PERF.md).
pub const DEFAULT_ESTIMATED_SAVED_KB_PER_TAB: u64 = 50 * 1024;

/// Host memory-pressure level driving sleep aggressiveness.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MemoryPressure {
    /// Normal operation: sleep only past the idle timeout.
    #[default]
    None,
    /// Elevated usage: halve the effective idle timeout.
    Moderate,
    /// Critical usage: sleep any inactive, non-excluded tab immediately.
    Critical,
}

/// Point-in-time tab state the policy reasons over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabState {
    pub id: String,
    /// Last user-visible activity (ms since unix epoch, same clock as `now`).
    pub last_active_ms: i64,
    /// Currently selected / visible tab. Never sleeps while active.
    pub active: bool,
    /// Audible media playing. Never auto-sleeps.
    pub audible: bool,
    /// Pinned (or essential). Never auto-sleeps.
    pub pinned: bool,
    /// Devtools open on this tab. Never auto-sleeps.
    pub devtools_open: bool,
    /// Already discarded. Never re-sleeps (wake first).
    pub discarded: bool,
}

impl TabState {
    pub fn new(id: impl Into<String>, last_active_ms: i64) -> Self {
        Self {
            id: id.into(),
            last_active_ms,
            active: false,
            audible: false,
            pinned: false,
            devtools_open: false,
            discarded: false,
        }
    }

    pub fn active(mut self) -> Self {
        self.active = true;
        self
    }

    pub fn audible(mut self) -> Self {
        self.audible = true;
        self
    }

    pub fn pinned(mut self) -> Self {
        self.pinned = true;
        self
    }

    pub fn devtools_open(mut self) -> Self {
        self.devtools_open = true;
        self
    }

    pub fn discarded(mut self) -> Self {
        self.discarded = true;
        self
    }
}

/// Tunables for [`should_sleep`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SleepConfig {
    /// Idle milliseconds before a tab is sleep-eligible under no pressure.
    pub idle_timeout_ms: i64,
    /// Most recently active non-excluded tabs that never sleep, never more
    /// than the population itself. Applies to [`select_for_sleep`]; one tab's
    /// own [`should_sleep`] cannot see its peers, so the window is enforced at
    /// selection.
    pub keep_warm_count: usize,
    /// Estimated KiB saved per discarded tab (metrics only).
    pub estimated_saved_kb_per_tab: u64,
}

impl Default for SleepConfig {
    fn default() -> Self {
        Self {
            idle_timeout_ms: DEFAULT_IDLE_TIMEOUT_MS,
            keep_warm_count: DEFAULT_KEEP_WARM_COUNT,
            estimated_saved_kb_per_tab: DEFAULT_ESTIMATED_SAVED_KB_PER_TAB,
        }
    }
}

/// Why a tab stays awake. Exclusions are explicit so call sites and the
/// SLEEPING.md matrix can cite them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StayReason {
    Active,
    Audible,
    Pinned,
    DevtoolsOpen,
    AlreadyDiscarded,
    RecentlyActive,
}

/// Policy outcome for one tab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepDecision {
    Sleep,
    Stay(StayReason),
}

impl SleepDecision {
    pub fn should_sleep(&self) -> bool {
        matches!(self, SleepDecision::Sleep)
    }
}

/// Effective idle timeout under pressure. Moderate halves it; Critical
/// returns 0 so any inactive tab is immediately eligible. A negative delay
/// reads as 0, so the rounded half cannot differ between the two mirrors
/// (Rust truncates, JS `Math.floor` does not).
pub fn effective_timeout_ms(config: &SleepConfig, pressure: MemoryPressure) -> i64 {
    let base = config.idle_timeout_ms.max(0);
    match pressure {
        MemoryPressure::None => base,
        MemoryPressure::Moderate => base / 2 + base % 2,
        MemoryPressure::Critical => 0,
    }
}

/// Exclusions shared by [`should_sleep`] and [`select_for_sleep`], so the
/// keep-warm ranking and the per-tab test cannot drift apart.
fn exclusion_reason(tab: &TabState) -> Option<StayReason> {
    if tab.active {
        Some(StayReason::Active)
    } else if tab.discarded {
        Some(StayReason::AlreadyDiscarded)
    } else if tab.audible {
        Some(StayReason::Audible)
    } else if tab.pinned {
        Some(StayReason::Pinned)
    } else if tab.devtools_open {
        Some(StayReason::DevtoolsOpen)
    } else {
        None
    }
}

/// Pure policy: should this tab sleep at `now_ms`?
///
/// Order of checks (exclusions first, timers last):
/// active → discarded → audible → pinned → devtools → idle timeout
/// (pressure-adjusted). Clocks skewed into the future count as
/// recently-active (never sleep on negative idle age).
pub fn should_sleep(
    tab: &TabState,
    now_ms: i64,
    config: &SleepConfig,
    pressure: MemoryPressure,
) -> SleepDecision {
    if let Some(reason) = exclusion_reason(tab) {
        return SleepDecision::Stay(reason);
    }
    let idle_ms = now_ms.saturating_sub(tab.last_active_ms);
    if idle_ms >= effective_timeout_ms(config, pressure) {
        SleepDecision::Sleep
    } else {
        SleepDecision::Stay(StayReason::RecentlyActive)
    }
}

/// Oldest-first sleep candidates, capped at `max_count` (`usize::MAX` for
/// all). Only tabs with [`SleepDecision::Sleep`] are returned, ordered by
/// `last_active_ms` ascending so memory-pressure batch sleeps reclaim the
/// stalest tabs first.
///
/// The `keep_warm_count` most recently active non-excluded tabs are dropped
/// after the exclusions and before the idle/pressure test, so they never
/// sleep whatever their idle age. Ranking ties go to the lower id. The window
/// never protects more tabs than exist: a population at or under the window
/// sleeps nothing, so a small set keeps every tab warm.
pub fn select_for_sleep<'a>(
    tabs: &'a [TabState],
    now_ms: i64,
    config: &SleepConfig,
    pressure: MemoryPressure,
    max_count: usize,
) -> Vec<&'a TabState> {
    let mut eligible: Vec<&TabState> = tabs
        .iter()
        .filter(|t| exclusion_reason(t).is_none())
        .collect();
    eligible.sort_by(|a, b| {
        b.last_active_ms
            .cmp(&a.last_active_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    let warm_len = config.keep_warm_count.min(eligible.len());
    let mut selected: Vec<&TabState> = eligible[warm_len..]
        .iter()
        .copied()
        .filter(|t| should_sleep(t, now_ms, config, pressure).should_sleep())
        .collect();
    selected.sort_by_key(|t| t.last_active_ms);
    selected.truncate(max_count);
    selected
}

/// Host-side events that may wake a discarded tab.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WakeEvent {
    /// User selected / focused the tab.
    UserActivated { tab_id: String },
    /// Navigation committed or requested in the tab.
    Navigated { tab_id: String },
    /// Media playback requested while discarded.
    MediaRequested { tab_id: String },
    /// Extension or Work helper asked for the live page.
    ExtensionRequested { tab_id: String },
    /// Background tick / timer — never wakes.
    BackgroundTick { tab_id: String },
    /// Memory-pressure change — never wakes (sleep-side only).
    PressureChanged,
}

impl WakeEvent {
    pub fn tab_id(&self) -> Option<&str> {
        match self {
            WakeEvent::UserActivated { tab_id }
            | WakeEvent::Navigated { tab_id }
            | WakeEvent::MediaRequested { tab_id }
            | WakeEvent::ExtensionRequested { tab_id }
            | WakeEvent::BackgroundTick { tab_id } => Some(tab_id),
            WakeEvent::PressureChanged => None,
        }
    }

    /// Whether this event wakes a discarded tab.
    pub fn requires_wake(&self) -> bool {
        matches!(
            self,
            WakeEvent::UserActivated { .. }
                | WakeEvent::Navigated { .. }
                | WakeEvent::MediaRequested { .. }
                | WakeEvent::ExtensionRequested { .. }
        )
    }
}

/// Pure wake policy: a discarded tab wakes exactly when the event requires
/// it. Non-discarded tabs never "wake" (returns false).
pub fn should_wake(discarded: bool, event: &WakeEvent) -> bool {
    discarded && event.requires_wake()
}

/// Errors from the [`SleepHost`] seam.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SleepError {
    #[error("unknown tab {0}")]
    UnknownTab(String),
    #[error("tab {0} already discarded")]
    AlreadyDiscarded(String),
    #[error("tab {0} is not discarded")]
    NotDiscarded(String),
}

/// Discard/wakeup seam. Maps onto Host API `Tabs.discard` / `Tabs.wakeup`
/// in production; the stub below backs unit/benchmark tests so this crate
/// never depends on the host modules.
pub trait SleepHost {
    fn discard(&mut self, tab_id: &str, now_ms: i64) -> Result<(), SleepError>;
    fn wakeup(&mut self, tab_id: &str, now_ms: i64) -> Result<(), SleepError>;
    fn is_discarded(&self, tab_id: &str) -> Option<bool>;
}

/// Wake-latency + memory-savings benchmark hooks.
///
/// - `record_discard` bumps the discarded counter and the KiB estimate.
/// - `record_wakeup` bumps the restored counter and pushes a latency sample.
/// - [`SleepBench`] times a discard → wakeup round-trip with `Instant` for
///   live/contract harnesses; unit tests use the stub's simulated clock.
#[derive(Clone, Debug, Default)]
pub struct SleepMetrics {
    pub discarded_count: u64,
    pub restored_count: u64,
    pub estimated_saved_kb: u64,
    pub wake_latency_micros: Vec<u64>,
}

impl SleepMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_discard(&mut self, estimated_kb: u64) {
        self.discarded_count += 1;
        self.estimated_saved_kb += estimated_kb;
    }

    pub fn record_wakeup(&mut self, latency_micros: u64) {
        self.restored_count += 1;
        self.wake_latency_micros.push(latency_micros);
    }

    pub fn mean_wake_latency_micros(&self) -> Option<f64> {
        if self.wake_latency_micros.is_empty() {
            return None;
        }
        let sum: u128 = self.wake_latency_micros.iter().map(|&v| v as u128).sum();
        Some(sum as f64 / self.wake_latency_micros.len() as f64)
    }

    pub fn max_wake_latency_micros(&self) -> Option<u64> {
        self.wake_latency_micros.iter().copied().max()
    }
}

/// Wall-clock round-trip timer for live/contract harnesses: call
/// `discard()` then `wakeup()` around the Host `discard`/`wakeup` calls and
/// push `elapsed_micros()` into [`SleepMetrics::record_wakeup`].
#[derive(Debug)]
pub struct SleepBench {
    start: Instant,
}

impl SleepBench {
    pub fn discard() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    pub fn elapsed_micros(&self) -> u64 {
        self.start.elapsed().as_micros() as u64
    }
}

/// In-memory [`SleepHost`] double. Discard snapshots the tab's URL/scroll
/// (via [`TabSnapshot`]) and marks it discarded; wakeup restores the exact
/// snapshot. Unknown tabs error like the Host `no_such_tab` code.
#[derive(Debug, Default)]
pub struct StubSleepHost {
    tabs: HashMap<String, TabSnapshot>,
    pub metrics: SleepMetrics,
    estimated_kb_per_tab: u64,
}

impl StubSleepHost {
    pub fn new() -> Self {
        Self {
            tabs: HashMap::new(),
            metrics: SleepMetrics::new(),
            estimated_kb_per_tab: DEFAULT_ESTIMATED_SAVED_KB_PER_TAB,
        }
    }

    pub fn with_estimate(mut self, kb: u64) -> Self {
        self.estimated_kb_per_tab = kb;
        self
    }

    /// Register a live tab (discarded = false) for the test.
    pub fn add_tab(&mut self, id: &str, url: &str, scroll: Option<ScrollState>) {
        self.tabs.insert(
            id.to_owned(),
            TabSnapshot {
                astra_tab_id: id.to_owned(),
                space_uuid: None,
                folder_uuid: None,
                url: url.to_owned(),
                title: String::new(),
                pinned: false,
                position: self.tabs.len() as i64,
                scroll,
                zoom: None,
                muted: false,
                discarded: false,
                window_id: "win-1".to_owned(),
                history: vec![url.to_owned()],
                history_index: Some(0),
            },
        );
    }

    pub fn snapshot(&self, tab_id: &str) -> Option<&TabSnapshot> {
        self.tabs.get(tab_id)
    }
}

impl SleepHost for StubSleepHost {
    fn discard(&mut self, tab_id: &str, _now_ms: i64) -> Result<(), SleepError> {
        match self.tabs.get_mut(tab_id) {
            None => Err(SleepError::UnknownTab(tab_id.to_owned())),
            Some(tab) if tab.discarded => Err(SleepError::AlreadyDiscarded(tab_id.to_owned())),
            Some(tab) => {
                tab.discarded = true;
                self.metrics.record_discard(self.estimated_kb_per_tab);
                Ok(())
            }
        }
    }

    fn wakeup(&mut self, tab_id: &str, _now_ms: i64) -> Result<(), SleepError> {
        match self.tabs.get_mut(tab_id) {
            None => Err(SleepError::UnknownTab(tab_id.to_owned())),
            Some(tab) if !tab.discarded => Err(SleepError::NotDiscarded(tab_id.to_owned())),
            Some(tab) => {
                // Simulated restore cost: sub-millisecond stub-level sample so
                // the metrics path is exercised without a live engine.
                let bench = SleepBench::discard();
                tab.discarded = false;
                self.metrics.record_wakeup(bench.elapsed_micros().max(1));
                Ok(())
            }
        }
    }

    fn is_discarded(&self, tab_id: &str) -> Option<bool> {
        self.tabs.get(tab_id).map(|t| t.discarded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ScrollState;

    const NOW: i64 = 1_700_000_000_000;

    fn idle(id: &str, idle_ms: i64) -> TabState {
        TabState::new(id, NOW - idle_ms)
    }

    #[test]
    fn idle_timeout_gates_sleep() {
        let config = SleepConfig::default();
        assert_eq!(
            should_sleep(&idle("fresh", 1_000), NOW, &config, MemoryPressure::None),
            SleepDecision::Stay(StayReason::RecentlyActive)
        );
        assert_eq!(
            should_sleep(
                &idle("stale", DEFAULT_IDLE_TIMEOUT_MS + 1),
                NOW,
                &config,
                MemoryPressure::None
            ),
            SleepDecision::Sleep
        );
        // Exactly at the timeout counts as idle.
        assert_eq!(
            should_sleep(
                &idle("edge", DEFAULT_IDLE_TIMEOUT_MS),
                NOW,
                &config,
                MemoryPressure::None
            ),
            SleepDecision::Sleep
        );
        // Future timestamps never sleep (clock skew → recently active).
        assert_eq!(
            should_sleep(
                &TabState::new("skew", NOW + 60_000),
                NOW,
                &config,
                MemoryPressure::None
            ),
            SleepDecision::Stay(StayReason::RecentlyActive)
        );
    }

    #[test]
    fn exclusions_never_sleep_even_when_idle() {
        let config = SleepConfig::default();
        let stale = DEFAULT_IDLE_TIMEOUT_MS + 60_000;
        let cases = vec![
            (idle("active", stale).active(), StayReason::Active),
            (idle("audible", stale).audible(), StayReason::Audible),
            (idle("pinned", stale).pinned(), StayReason::Pinned),
            (
                idle("devtools", stale).devtools_open(),
                StayReason::DevtoolsOpen,
            ),
            (
                idle("discarded", stale).discarded(),
                StayReason::AlreadyDiscarded,
            ),
        ];
        for (tab, reason) in cases {
            assert_eq!(
                should_sleep(&tab, NOW, &config, MemoryPressure::Critical),
                SleepDecision::Stay(reason),
                "tab {} must stay under critical pressure",
                tab.id
            );
        }
    }

    #[test]
    fn memory_pressure_accelerates_sleep() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tab = idle("t", 30_000); // idle 30s of a 60s timeout
        assert_eq!(
            should_sleep(&tab, NOW, &config, MemoryPressure::None),
            SleepDecision::Stay(StayReason::RecentlyActive)
        );
        // Moderate halves the timeout to 30s → eligible.
        assert_eq!(
            should_sleep(&tab, NOW, &config, MemoryPressure::Moderate),
            SleepDecision::Sleep
        );
        // Critical sleeps any inactive tab immediately.
        let fresh = idle("fresh", 0);
        assert_eq!(
            should_sleep(&fresh, NOW, &config, MemoryPressure::Critical),
            SleepDecision::Sleep
        );
        assert_eq!(effective_timeout_ms(&config, MemoryPressure::None), 60_000);
        assert_eq!(
            effective_timeout_ms(&config, MemoryPressure::Moderate),
            30_000
        );
        assert_eq!(effective_timeout_ms(&config, MemoryPressure::Critical), 0);
    }

    #[test]
    fn select_for_sleep_returns_oldest_first_with_cap() {
        let config = SleepConfig {
            idle_timeout_ms: 10_000,
            // Ordering/cap in isolation; the keep-warm window has its own test.
            keep_warm_count: 0,
            ..SleepConfig::default()
        };
        let tabs = vec![
            idle("new-stale", 20_000),
            idle("old-stale", 90_000),
            idle("fresh", 1_000),
            idle("excluded", 90_000).audible(),
        ];
        let all = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        let ids: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["old-stale", "new-stale"]);
        let capped = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, 1);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].id, "old-stale");
    }

    #[test]
    fn idle_default_is_five_minutes() {
        assert_eq!(DEFAULT_IDLE_TIMEOUT_MS, 300_000);
        let config = SleepConfig::default();
        assert_eq!(config.idle_timeout_ms, 300_000);
        assert_eq!(
            should_sleep(&idle("u", 240_000), NOW, &config, MemoryPressure::None),
            SleepDecision::Stay(StayReason::RecentlyActive)
        );
        assert_eq!(
            should_sleep(&idle("t", 300_000), NOW, &config, MemoryPressure::None),
            SleepDecision::Sleep
        );
    }

    #[test]
    fn default_keep_warm_count_is_six() {
        assert_eq!(DEFAULT_KEEP_WARM_COUNT, 6);
        assert_eq!(SleepConfig::default().keep_warm_count, 6);
    }

    #[test]
    fn negative_idle_timeout_clamps_to_zero() {
        let config = SleepConfig {
            idle_timeout_ms: -300_001,
            // Keep-warm off: this test is about the timeout, and a one-tab
            // population is otherwise all-warm.
            keep_warm_count: 0,
            ..SleepConfig::default()
        };
        assert_eq!(effective_timeout_ms(&config, MemoryPressure::None), 0);
        assert_eq!(effective_timeout_ms(&config, MemoryPressure::Moderate), 0);
        assert_eq!(effective_timeout_ms(&config, MemoryPressure::Critical), 0);
        // No truncation/floor divergence at odd negatives.
        for value in [-1, -2] {
            let odd = SleepConfig {
                idle_timeout_ms: value,
                ..SleepConfig::default()
            };
            assert_eq!(effective_timeout_ms(&odd, MemoryPressure::None), 0);
            assert_eq!(effective_timeout_ms(&odd, MemoryPressure::Moderate), 0);
        }
        // No panic; a fresh inactive tab is immediately eligible.
        let tabs = vec![idle("fresh", 0).audible(), idle("cold", 0)];
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["cold"]);
    }

    #[test]
    fn keep_warm_window_protects_the_recent_tabs() {
        // 8 idle tabs, default keep-warm 6: only the two oldest are candidates.
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tabs: Vec<TabState> = (0..8)
            .map(|i| idle(&format!("t{i}"), 120_000 + i as i64 * 60_000))
            .collect();
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t7", "t6"]);
        // The same tabs under critical pressure: the window still holds.
        let critical = select_for_sleep(&tabs, NOW, &config, MemoryPressure::Critical, usize::MAX);
        let critical_ids: Vec<&str> = critical.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(critical_ids, vec!["t7", "t6"]);
    }

    #[test]
    fn keep_warm_ties_rank_by_id() {
        // Eight tabs share one last_active_ms; the six warm slots go to the
        // six lowest ids, so exactly t6 and t7 are candidates.
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tabs: Vec<TabState> = (0..8).map(|i| idle(&format!("t{i}"), 600_000)).collect();
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, vec!["t6", "t7"]);
    }

    #[test]
    fn discarded_tabs_do_not_consume_warm_slots() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            keep_warm_count: 2,
            ..SleepConfig::default()
        };
        // The discarded tabs are the newest, so a ranking that forgot to filter
        // exclusions first would hand them both warm slots and select all three
        // live tabs instead of one.
        let tabs = vec![
            idle("discarded-1", 60_000).discarded(),
            idle("discarded-2", 120_000).discarded(),
            idle("live-a", 20 * 60_000),
            idle("live-b", 21 * 60_000),
            idle("live-c", 22 * 60_000),
        ];
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        // Warm slots hold the two newest live tabs, not the discarded ones.
        assert_eq!(ids, vec!["live-c"]);
    }

    #[test]
    fn keep_warm_never_overrides_exclusions() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            keep_warm_count: 1,
            ..SleepConfig::default()
        };
        // Every excluded tab is newer than both live tabs: ranking them would
        // give the one warm slot to the selected tab and leave two candidates.
        let tabs = vec![
            idle("selected", 60_000).active(),
            idle("audible", 120_000).audible(),
            idle("pinned", 180_000).pinned(),
            idle("devtools", 240_000).devtools_open(),
            idle("discarded", 300_000).discarded(),
            idle("warm", 20 * 60_000),
            idle("cold", 25 * 60_000),
        ];
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::Critical, usize::MAX);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        // Excluded tabs neither sleep nor take the warm slot: the newest
        // eligible tab ("warm", 20 min) is protected, "cold" sleeps.
        assert_eq!(ids, vec!["cold"]);
    }

    #[test]
    fn empty_and_fully_excluded_sets_select_nothing() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let empty: Vec<TabState> = Vec::new();
        assert!(
            select_for_sleep(&empty, NOW, &config, MemoryPressure::Critical, usize::MAX).is_empty()
        );
        let excluded = vec![
            idle("a", 90 * 60_000).active(),
            idle("b", 90 * 60_000).audible(),
            idle("c", 90 * 60_000).pinned(),
            idle("d", 90 * 60_000).devtools_open(),
            idle("e", 90 * 60_000).discarded(),
        ];
        let chosen = select_for_sleep(
            &excluded,
            NOW,
            &config,
            MemoryPressure::Critical,
            usize::MAX,
        );
        assert!(chosen.is_empty());
    }

    #[test]
    fn max_count_zero_selects_nothing() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tabs: Vec<TabState> = (0..3)
            .map(|i| idle(&format!("z{i}"), (20 + i as i64) * 60_000))
            .collect();
        assert!(select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, 0).is_empty());
    }

    #[test]
    fn keep_warm_covers_a_population_smaller_than_the_window() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let few: Vec<TabState> = (0..3)
            .map(|i| idle(&format!("n{i}"), (8 + i as i64) * 60_000))
            .collect();
        // Three eligible tabs under a window of six: all three stay warm.
        let chosen = select_for_sleep(&few, NOW, &config, MemoryPressure::None, usize::MAX);
        assert!(chosen.is_empty());
        let none = SleepConfig {
            keep_warm_count: 0,
            ..config
        };
        let all = select_for_sleep(&few, NOW, &none, MemoryPressure::None, usize::MAX);
        let all_ids: Vec<&str> = all.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(all_ids, vec!["n2", "n1", "n0"]);
    }

    #[test]
    fn exactly_keep_warm_tabs_sleep_nothing() {
        // n == K: the whole population is the window, on every tick.
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tabs: Vec<TabState> = (0..6)
            .map(|i| idle(&format!("k{i}"), (10 + i as i64) * 60_000))
            .collect();
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        assert!(chosen.is_empty());
    }

    #[test]
    fn keep_warm_window_survives_repeated_ticks() {
        // Six eligible tabs and a window of six: a tick must not eat a warm
        // tab, so three ticks in a row still protect all six.
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let all: Vec<TabState> = (0..6)
            .map(|i| idle(&format!("w{i}"), (10 + i as i64) * 60_000))
            .collect();
        let mut remaining = all;
        for tick in 0..3 {
            let chosen =
                select_for_sleep(&remaining, NOW, &config, MemoryPressure::None, usize::MAX);
            let ids: Vec<String> = chosen.iter().map(|t| t.id.clone()).collect();
            assert!(chosen.is_empty(), "tick {tick} discarded {ids:?}");
            // Removing no candidates must leave the protected set unchanged.
            remaining.retain(|t| !ids.contains(&t.id));
        }
        assert_eq!(remaining.len(), 6);
    }

    #[test]
    fn keep_warm_and_batch_cap_compose() {
        let config = SleepConfig {
            idle_timeout_ms: 60_000,
            ..SleepConfig::default()
        };
        let tabs: Vec<TabState> = (0..12)
            .map(|i| idle(&format!("m{i}"), (5 + i as i64) * 60_000))
            .collect();
        let chosen = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, 4);
        let ids: Vec<&str> = chosen.iter().map(|t| t.id.as_str()).collect();
        // 12 eligible, 6 kept warm → 6 candidates, capped to the oldest 4.
        assert_eq!(ids, vec!["m11", "m10", "m9", "m8"]);
    }

    #[test]
    fn wake_on_events_only_when_discarded() {
        let wake_events = vec![
            WakeEvent::UserActivated {
                tab_id: "t".to_owned(),
            },
            WakeEvent::Navigated {
                tab_id: "t".to_owned(),
            },
            WakeEvent::MediaRequested {
                tab_id: "t".to_owned(),
            },
            WakeEvent::ExtensionRequested {
                tab_id: "t".to_owned(),
            },
        ];
        for event in &wake_events {
            assert!(event.requires_wake());
            assert!(should_wake(true, event));
            assert!(!should_wake(false, event));
        }
        let quiet = vec![
            WakeEvent::BackgroundTick {
                tab_id: "t".to_owned(),
            },
            WakeEvent::PressureChanged,
        ];
        for event in &quiet {
            assert!(!event.requires_wake());
            assert!(!should_wake(true, event));
        }
    }

    #[test]
    fn stub_round_trip_preserves_url_and_scroll() {
        let mut host = StubSleepHost::new();
        let scroll = ScrollState::new(0, 240);
        host.add_tab("tab-a", "https://a.example/", Some(scroll.clone()));
        let before = host.snapshot("tab-a").unwrap().clone();
        assert!(!before.discarded);

        host.discard("tab-a", NOW).unwrap();
        let sleeping = host.snapshot("tab-a").unwrap();
        assert!(sleeping.discarded);
        assert_eq!(sleeping.url, before.url);
        assert_eq!(sleeping.scroll, before.scroll);
        assert_eq!(host.metrics.discarded_count, 1);
        assert_eq!(
            host.metrics.estimated_saved_kb,
            DEFAULT_ESTIMATED_SAVED_KB_PER_TAB
        );

        host.wakeup("tab-a", NOW + 5_000).unwrap();
        let restored = host.snapshot("tab-a").unwrap();
        assert!(!restored.discarded);
        // Discard → wakeup preserves organisation: URL, scroll, history.
        assert_eq!(restored.url, "https://a.example/");
        assert_eq!(restored.scroll, Some(scroll));
        assert_eq!(restored.history, before.history);
        assert_eq!(restored.history_index, before.history_index);
        assert_eq!(host.metrics.restored_count, 1);
        assert_eq!(host.metrics.wake_latency_micros.len(), 1);
        assert!(host.metrics.mean_wake_latency_micros().unwrap() >= 1.0);
        assert!(host.metrics.max_wake_latency_micros().unwrap() >= 1);
    }

    #[test]
    fn stub_rejects_bad_transitions_like_host_errors() {
        let mut host = StubSleepHost::new();
        assert_eq!(
            host.discard("ghost", NOW),
            Err(SleepError::UnknownTab("ghost".to_owned()))
        );
        host.add_tab("t", "https://t.example/", None);
        assert_eq!(
            host.wakeup("t", NOW),
            Err(SleepError::NotDiscarded("t".to_owned()))
        );
        host.discard("t", NOW).unwrap();
        assert_eq!(
            host.discard("t", NOW),
            Err(SleepError::AlreadyDiscarded("t".to_owned()))
        );
        assert_eq!(host.is_discarded("t"), Some(true));
        assert_eq!(host.is_discarded("ghost"), None);
    }

    #[test]
    fn policy_driven_stub_sleep_and_wake() {
        // End-to-end at stub level: policy selects, host discards, wake
        // event restores.
        let config = SleepConfig {
            idle_timeout_ms: 10_000,
            // No keep-warm: the one eligible tab must be the candidate.
            keep_warm_count: 0,
            ..SleepConfig::default()
        };
        let tabs = vec![idle("old", 60_000), idle("young", 1_000)];
        let candidates = select_for_sleep(&tabs, NOW, &config, MemoryPressure::None, usize::MAX);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].id, "old");

        let mut host = StubSleepHost::new();
        host.add_tab("old", "https://old.example/", Some(ScrollState::new(5, 5)));
        host.add_tab("young", "https://young.example/", None);
        for tab in &candidates {
            host.discard(&tab.id, NOW).unwrap();
        }
        assert_eq!(host.is_discarded("old"), Some(true));
        assert_eq!(host.is_discarded("young"), Some(false));

        let wake = WakeEvent::UserActivated {
            tab_id: "old".to_owned(),
        };
        assert!(should_wake(host.is_discarded("old").unwrap(), &wake));
        host.wakeup("old", NOW + 1_000).unwrap();
        assert_eq!(host.snapshot("old").unwrap().url, "https://old.example/");
    }

    #[test]
    fn metrics_accumulate_across_tabs() {
        let mut metrics = SleepMetrics::new();
        assert_eq!(metrics.mean_wake_latency_micros(), None);
        metrics.record_discard(1024);
        metrics.record_discard(2048);
        metrics.record_wakeup(100);
        metrics.record_wakeup(300);
        assert_eq!(metrics.discarded_count, 2);
        assert_eq!(metrics.restored_count, 2);
        assert_eq!(metrics.estimated_saved_kb, 3072);
        assert_eq!(metrics.mean_wake_latency_micros(), Some(200.0));
        assert_eq!(metrics.max_wake_latency_micros(), Some(300));
    }
}

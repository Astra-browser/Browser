/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Pure-sync activity aggregation: tab-activity events in, per-site totals out.
//!
//! A [`TimeTracker`] credits the elapsed time between consecutive events to
//! the *previous* event's host when that event left the tab active. Idle
//! events stop the clock without crediting; out-of-order events (earlier
//! than the last seen timestamp) re-anchor without crediting. Hosts are
//! keyed by [`canonical_host`][crate::host::canonical_host], so totals are
//! per site, device-only (no sync, no network).

use crate::host::canonical_host;
use std::collections::HashMap;

/// One tab-activity observation: the tab the user is on at `at_secs`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivityEvent {
    /// Tab URL (any URL form; canonicalized to a host key).
    pub url: String,
    /// Tab title (informational; not used for totals).
    pub title: String,
    /// Observation time, UTC seconds.
    pub at_secs: i64,
    /// Whether the tab was active (focused, visible). Idle observations
    /// stop the clock instead of crediting time.
    pub active: bool,
}

impl ActivityEvent {
    /// Builds an event; empty URLs canonicalize to `""` and are ignored.
    pub fn new(url: &str, title: &str, at_secs: i64, active: bool) -> Self {
        Self {
            url: url.to_string(),
            title: title.to_string(),
            at_secs,
            active,
        }
    }
}

/// In-memory per-site accumulator over [`ActivityEvent`]s.
#[derive(Clone, Debug, Default)]
pub struct TimeTracker {
    totals: HashMap<String, i64>,
    current_host: Option<String>,
    last_at: Option<i64>,
    last_active: bool,
}

impl TimeTracker {
    /// Empty tracker with no history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one event, crediting elapsed time since the previous event
    /// to the previous host when the previous state was active.
    pub fn record(&mut self, event: &ActivityEvent) {
        let host = canonical_host(&event.url);
        if let Some(last_at) = self.last_at {
            let elapsed = event.at_secs.saturating_sub(last_at);
            if self.last_active && !elapsed.is_negative() {
                if let Some(prev) = self.current_host.clone() {
                    if !prev.is_empty() {
                        *self.totals.entry(prev).or_insert(0) += elapsed;
                    }
                }
            }
        }
        if !host.is_empty() {
            self.current_host = Some(host);
        }
        self.last_at = Some(event.at_secs);
        self.last_active = event.active;
    }

    /// Accumulated seconds for a host or URL (canonicalized). Zero when unseen.
    pub fn total_for(&self, host_or_url: &str) -> i64 {
        let key = canonical_host(host_or_url);
        self.totals.get(&key).copied().unwrap_or(0)
    }

    /// All per-site totals, sorted by host for stable output.
    pub fn totals(&self) -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = self
            .totals
            .iter()
            .map(|(host, secs)| (host.clone(), *secs))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Grand total across all sites.
    pub fn grand_total(&self) -> i64 {
        self.totals.values().sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_activity_totals_match() {
        let mut tracker = TimeTracker::new();
        // 100s on a.example (active), 50s idle (uncounted), 200s on b.example.
        tracker.record(&ActivityEvent::new("https://a.example/x", "A", 1000, true));
        tracker.record(&ActivityEvent::new("https://a.example/y", "A2", 1100, true));
        tracker.record(&ActivityEvent::new(
            "https://a.example/y",
            "idle",
            1150,
            false,
        ));
        tracker.record(&ActivityEvent::new("https://b.example/z", "B", 1200, true));
        tracker.record(&ActivityEvent::new("https://b.example/z", "B", 1400, true));
        // Final boundary: clock stops here; credits the last 200s leg.
        tracker.record(&ActivityEvent::new(
            "https://b.example/z",
            "end",
            1600,
            false,
        ));

        assert_eq!(tracker.total_for("a.example"), 150);
        assert_eq!(tracker.total_for("b.example"), 400);
        assert_eq!(tracker.grand_total(), 550);
    }

    #[test]
    fn idle_and_out_of_order_credit_nothing() {
        let mut tracker = TimeTracker::new();
        tracker.record(&ActivityEvent::new("https://a.example/", "A", 1000, false));
        tracker.record(&ActivityEvent::new("https://a.example/", "A", 1100, true));
        // Out-of-order timestamp: re-anchors, credits nothing.
        tracker.record(&ActivityEvent::new("https://a.example/", "A", 900, true));
        assert_eq!(tracker.total_for("a.example"), 0);
    }

    #[test]
    fn www_and_case_variants_share_one_total() {
        let mut tracker = TimeTracker::new();
        tracker.record(&ActivityEvent::new("https://Example.COM/", "A", 0, true));
        tracker.record(&ActivityEvent::new(
            "https://www.example.com/x",
            "A",
            60,
            true,
        ));
        tracker.record(&ActivityEvent::new(
            "https://example.com:8080/y",
            "A",
            120,
            false,
        ));
        assert_eq!(tracker.total_for("example.com"), 120);
    }
}

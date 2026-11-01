/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Focus timer plus focus-mode site blocking (P5-T04).
//!
//! A [`FocusSession`] blocks a fixed set of sites until its timer ends or
//! the user takes a break (which ends blocking immediately). The verdict
//! surface is [`FocusBlockHook`]: the Net hook interface the network layer
//! consults per request. It deliberately mirrors `astra-blocker::Verdict`
//! (`Allow` vs `Block`) so P4-T11 can compose the two checks without
//! reshaping either; live wiring against `astra-blocker` happens there,
//! not here.
//!
//! Host matching is canonical ([`canonical_host`][crate::host::canonical_host]),
//! so `WWW.` / case / port / userinfo variants of a blocked host are
//! blocked too.

use crate::host::canonical_host;
use std::collections::HashSet;

/// Verdict for one URL under focus mode. Mirrors
/// `astra-blocker::Verdict` so the P4-T11 Net hook can compose both.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FocusVerdict {
    /// The request may proceed (focus inactive, on break, or host not blocked).
    Allow,
    /// The request must be cancelled: focus is active and the URL's
    /// canonical host is blocked. Carries the matched host.
    Block {
        /// Canonical host that matched a focus rule.
        host: String,
    },
}

impl FocusVerdict {
    /// Whether the request must be cancelled.
    pub fn is_block(&self) -> bool {
        matches!(self, FocusVerdict::Block { .. })
    }
}

/// Net hook interface: per-request focus verdict for a URL at `now_secs`.
///
/// The network layer calls [`check_url`][FocusBlockHook::check_url] before
/// (or alongside, in P4-T11) the adblock engine check. Pure-sync so it can
/// run on the request path without an executor.
pub trait FocusBlockHook: Send + Sync {
    /// Returns the focus verdict for `url` at UTC `now_secs`.
    fn check_url(&self, url: &str, now_secs: i64) -> FocusVerdict;
}

/// A focus session: blocked sites plus a timer.
///
/// Blocking is active while `now_secs < ends_at_secs` and no break has been
/// taken. [`take_break`][FocusSession::take_break] ends the session early
/// (sites unblock); expiry ends it automatically.
#[derive(Clone, Debug)]
pub struct FocusSession {
    blocked: HashSet<String>,
    ends_at_secs: i64,
    on_break: bool,
}

impl FocusSession {
    /// Starts a session blocking `hosts` (canonicalized) for
    /// `duration_secs` from UTC `now_secs`. Non-positive durations yield an
    /// immediately-expired session.
    pub fn start(hosts: &[&str], duration_secs: i64, now_secs: i64) -> Self {
        let blocked = hosts
            .iter()
            .map(|host| canonical_host(host))
            .filter(|host| !host.is_empty())
            .collect();
        Self {
            blocked,
            ends_at_secs: now_secs.saturating_add(duration_secs.max(0)),
            on_break: false,
        }
    }

    /// Ends blocking immediately; the timer is abandoned.
    pub fn take_break(&mut self) {
        self.on_break = true;
    }

    /// Whether blocking is in force at UTC `now_secs`.
    pub fn is_blocking(&self, now_secs: i64) -> bool {
        !self.on_break && now_secs < self.ends_at_secs
    }

    /// UTC seconds when the timer ends (blocking lifts even without a break).
    pub fn ends_at_secs(&self) -> i64 {
        self.ends_at_secs
    }

    /// Whether a break has been taken.
    pub fn on_break(&self) -> bool {
        self.on_break
    }

    /// Canonical blocked hosts, sorted for stable output.
    pub fn blocked_hosts(&self) -> Vec<String> {
        let mut out: Vec<String> = self.blocked.iter().cloned().collect();
        out.sort();
        out
    }

    /// Verdict for one URL at UTC `now_secs`.
    pub fn verdict(&self, url: &str, now_secs: i64) -> FocusVerdict {
        if !self.is_blocking(now_secs) {
            return FocusVerdict::Allow;
        }
        let host = canonical_host(url);
        if !host.is_empty() && self.blocked.contains(&host) {
            FocusVerdict::Block { host }
        } else {
            FocusVerdict::Allow
        }
    }
}

impl FocusBlockHook for FocusSession {
    fn check_url(&self, url: &str, now_secs: i64) -> FocusVerdict {
        self.verdict(url, now_secs)
    }
}

/// A hook that never blocks. Useful as the Net hook default when no focus
/// session is active.
#[derive(Clone, Copy, Debug, Default)]
pub struct AllowAllHook;

impl FocusBlockHook for AllowAllHook {
    fn check_url(&self, _url: &str, _now_secs: i64) -> FocusVerdict {
        FocusVerdict::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_host_verdict_and_expiry() {
        let session = FocusSession::start(&["example.com"], 600, 1000);
        assert!(session.is_blocking(1000));
        assert_eq!(
            session.verdict("https://example.com/feed", 1200),
            FocusVerdict::Block {
                host: "example.com".to_string()
            }
        );
        assert_eq!(
            session.verdict("https://other.example/x", 1200),
            FocusVerdict::Allow
        );
        // Timer expiry lifts blocking without a break.
        assert_eq!(
            session.verdict("https://example.com/feed", 1600),
            FocusVerdict::Allow
        );
        assert!(!session.is_blocking(1600));
    }

    #[test]
    fn no_bypass_via_trivial_url_tricks() {
        let session = FocusSession::start(&["Example.COM"], 600, 0);
        for trick in [
            "https://example.com/",
            "https://EXAMPLE.com/page",
            "https://www.example.com/",
            "https://WWW.EXAMPLE.COM:443/x?q=1",
            "http://example.com:8080/x",
            "http://user@example.com/x",
            "http://example.com./x",
        ] {
            assert_eq!(
                session.verdict(trick, 10),
                FocusVerdict::Block {
                    host: "example.com".to_string()
                },
                "bypass via {trick}"
            );
        }
        // Lookalikes must NOT match: subdomain, suffix, and infix are distinct sites.
        for innocent in [
            "https://notexample.com/",
            "https://example.com.evil.com/",
            "https://myexample.com/",
        ] {
            assert_eq!(
                session.verdict(innocent, 10),
                FocusVerdict::Allow,
                "over-blocked {innocent}"
            );
        }
    }

    #[test]
    fn break_ends_blocking() {
        let mut session = FocusSession::start(&["example.com"], 3600, 0);
        assert!(session.is_blocking(10));
        session.take_break();
        assert!(session.on_break());
        assert!(!session.is_blocking(10));
        assert_eq!(
            session.verdict("https://example.com/", 10),
            FocusVerdict::Allow
        );
    }

    #[test]
    fn hook_trait_object_routes_verdicts() {
        let session = FocusSession::start(&["example.com"], 600, 0);
        let hook: &dyn FocusBlockHook = &session;
        assert!(hook.check_url("https://example.com/", 10).is_block());
        assert!(!hook.check_url("https://elsewhere.test/", 10).is_block());
        let allow: &dyn FocusBlockHook = &AllowAllHook;
        assert!(!allow.check_url("https://example.com/", 10).is_block());
    }
}

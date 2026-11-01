/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Persistence shell: [`TimeService`] writes through `astra-store` with
//! every write path gated on [`PrivateScope`][astra_core::private::PrivateScope].
//!
//! Contract (see `docs/astra/PRIVATE.md`): `time_start` / `time_end` pass
//! through `scope.gate("time", …)` and return `None` in private scope, so
//! private windows persist nothing. Total reads in private scope return
//! zero without touching the store, so private activity cannot leak
//! through aggregates either. Focus rules use the same `"time"` gate —
//! they are time-tracking state, and the guard defaults unknown action
//! names to the master switch anyway.

use astra_core::private::PrivateScope;
use astra_store::{FocusRuleRow, Store, StoreError, TimeSessionRow};

use crate::host::canonical_host;

/// Thin sync shell over [`Store`] time tables with private-mode gating.
///
/// Borrowed from the caller (host/bridge layer owns the `Store`); all
/// methods are sync so activity events can be recorded inline.
pub struct TimeService<'a> {
    store: &'a Store,
    scope: PrivateScope,
}

impl<'a> TimeService<'a> {
    /// Wraps `store` with `scope` (`PrivateScope::public()` persists,
    /// `PrivateScope::private()` records nothing).
    pub fn new(store: &'a Store, scope: PrivateScope) -> Self {
        Self { store, scope }
    }

    /// Starts a time session for `url` at UTC `start_secs`.
    /// Returns `None` without touching the store in private scope.
    pub fn start_session(
        &self,
        url: &str,
        title: &str,
        start_secs: i64,
    ) -> Option<Result<TimeSessionRow, StoreError>> {
        let host = canonical_host(url);
        self.scope.gate("time", || {
            self.store.time_start(url, &host, title, start_secs)
        })
    }

    /// Ends session `id` at UTC `end_secs`.
    /// Returns `None` without touching the store in private scope.
    pub fn end_session(&self, id: i64, end_secs: i64) -> Option<Result<(), StoreError>> {
        self.scope
            .gate("time", || self.store.time_end(id, end_secs))
    }

    /// Total persisted seconds for a host or URL (canonicalized).
    /// Returns zero without touching the store in private scope.
    pub fn total_for_host(&self, host_or_url: &str) -> i64 {
        if !self.scope.time_allowed() {
            return 0;
        }
        let host = canonical_host(host_or_url);
        if host.is_empty() {
            return 0;
        }
        self.store.time_for_host(&host).unwrap_or(0)
    }

    /// Sets the focus rule for a host (`"block"` / `"allow"`).
    /// Returns `None` without touching the store in private scope.
    pub fn set_focus_rule(
        &self,
        host_or_url: &str,
        mode: &str,
    ) -> Option<Result<FocusRuleRow, StoreError>> {
        let host = canonical_host(host_or_url);
        if host.is_empty() {
            return None;
        }
        self.scope
            .gate("time", || self.store.focus_rule_set(&host, mode))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use astra_core::private::PrivateScope;

    fn test_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(dir.path().join("astra.db")).expect("open store");
        store.migrate().expect("migrate store");
        (dir, store)
    }

    #[test]
    fn public_scope_round_trip_matches_store_totals() {
        let (_dir, store) = test_store();
        let service = TimeService::new(&store, PrivateScope::public());
        let row = service
            .start_session("https://a.example/x", "X", 100)
            .expect("public scope writes")
            .expect("time_start");
        assert_eq!(row.host, "a.example");
        service
            .end_session(row.id, 160)
            .expect("public scope writes")
            .expect("time_end");
        assert_eq!(service.total_for_host("https://www.A.example:443/y"), 60);
    }

    #[test]
    fn private_mode_exclusion_writes_nothing_reads_zero() {
        let (_dir, store) = test_store();
        // Seed public data first so the test proves exclusion, not emptiness.
        let public = TimeService::new(&store, PrivateScope::public());
        let seed = public
            .start_session("https://pub.example/", "P", 10)
            .expect("public scope writes")
            .expect("time_start");
        public
            .end_session(seed.id, 70)
            .expect("public writes")
            .expect("time_end");

        let private = TimeService::new(&store, PrivateScope::private());
        assert!(private
            .start_session("https://secret.example/x", "S", 100)
            .is_none());
        assert!(private.end_session(seed.id, 200).is_none());
        assert!(private.set_focus_rule("secret.example", "block").is_none());
        // Private reads see nothing, even for public data.
        assert_eq!(private.total_for_host("pub.example"), 0);
        assert_eq!(private.total_for_host("secret.example"), 0);

        // Public view is untouched by the private attempts.
        assert_eq!(public.total_for_host("pub.example"), 60);
        assert_eq!(public.total_for_host("secret.example"), 0);
    }

    #[test]
    fn focus_rules_canonicalize_hosts() {
        let (_dir, store) = test_store();
        let service = TimeService::new(&store, PrivateScope::public());
        let rule = service
            .set_focus_rule("https://WWW.Example.COM:443/feed", "block")
            .expect("public scope writes")
            .expect("focus_rule_set");
        assert_eq!(rule.host, "example.com");
        assert_eq!(rule.mode, "block");
        assert!(service.set_focus_rule("", "block").is_none());
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Caller-policy authorization: the pure half of the IPC auth model.
//!
//! Every command arrived with a caller identity and an expected profile
//! scope; the same check now gates `BrowserHost` calls in core services
//! before they reach the host.

use astra_host_trait::ProfileId;

/// Authenticated caller: which UI surface acts, and in which profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caller {
    /// UI surface label (e.g. `"browser"`, `"panel"`, `"onboarding"`).
    pub label: String,
    /// Profile the surface claims to act in.
    pub profile: ProfileId,
}

impl Caller {
    pub fn new(label: impl Into<String>, profile: ProfileId) -> Self {
        Self {
            label: label.into(),
            profile,
        }
    }
}

/// Returns true when `caller` may act in `expected_profile`.
pub fn authorize(caller: &Caller, expected_profile: &ProfileId) -> bool {
    !caller.label.is_empty() && &caller.profile == expected_profile
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matching_profile_and_label_authorizes() {
        let caller = Caller::new("browser", ProfileId::new("p1"));
        assert!(authorize(&caller, &ProfileId::new("p1")));
    }

    #[test]
    fn mismatched_profile_denies() {
        let caller = Caller::new("browser", ProfileId::new("p1"));
        assert!(!authorize(&caller, &ProfileId::new("p2")));
    }

    #[test]
    fn empty_label_denies() {
        let caller = Caller::new("", ProfileId::new("p1"));
        assert!(!authorize(&caller, &ProfileId::new("p1")));
    }
}

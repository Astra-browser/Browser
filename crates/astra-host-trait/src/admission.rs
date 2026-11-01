/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Operation admission: the common reply for commands that the host may
//! accept, defer, or deny (mirrors the `OperationAdmission` IPC shape).

use serde::{Deserialize, Serialize};

/// Outcome of a host-routed operation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Admission {
    /// The host accepted and applied the operation.
    Admitted,
    /// The host queued the operation (e.g. waiting on a gate or restart).
    Deferred { reason: String },
    /// The host refused the operation.
    Denied { reason: String },
}

impl Admission {
    pub fn admitted() -> Self {
        Self::Admitted
    }

    pub fn deferred(reason: impl Into<String>) -> Self {
        Self::Deferred {
            reason: reason.into(),
        }
    }

    pub fn denied(reason: impl Into<String>) -> Self {
        Self::Denied {
            reason: reason.into(),
        }
    }

    pub fn is_admitted(&self) -> bool {
        matches!(self, Self::Admitted)
    }

    /// Combine two admissions, keeping the most restrictive outcome.
    pub fn combine(self, other: Self) -> Self {
        match (self, other) {
            (Self::Denied { reason }, _) | (_, Self::Denied { reason }) => Self::Denied { reason },
            (Self::Deferred { reason }, _) | (_, Self::Deferred { reason }) => {
                Self::Deferred { reason }
            }
            (Self::Admitted, Self::Admitted) => Self::Admitted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_keeps_most_restrictive() {
        assert!(Admission::admitted()
            .combine(Admission::admitted())
            .is_admitted());
        let denied = Admission::admitted().combine(Admission::denied("no"));
        assert_eq!(denied, Admission::denied("no"));
        let deferred = Admission::admitted().combine(Admission::deferred("later"));
        assert_eq!(deferred, Admission::deferred("later"));
        // Denied wins over deferred.
        let both = Admission::deferred("later").combine(Admission::denied("never"));
        assert_eq!(both, Admission::denied("never"));
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Site permission shapes (Host API `Permissions`).

use serde::{Deserialize, Serialize};

/// Permission-gated capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionKind {
    Camera,
    Microphone,
    Location,
    Notifications,
    Clipboard,
    Midi,
}

/// Decision applied to a pending permission prompt.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionDecision {
    Grant,
    Deny,
    /// Remember the decision for this origin.
    GrantAlways,
    DenyAlways,
}

/// Pending prompt awaiting a decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub origin: String,
    pub kind: PermissionKind,
    pub request_id: String,
}

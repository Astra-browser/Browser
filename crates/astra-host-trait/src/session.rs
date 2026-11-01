/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Profile / space shapes (Host API `Containers`; shell UI state in core).

use crate::ids::{ProfileId, SpaceId};
use serde::{Deserialize, Serialize};

/// A browsing profile (container) owned by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileInfo {
    pub id: ProfileId,
    pub name: String,
}

/// A shell workspace grouping tabs (state lives in core, applied via host).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpaceInfo {
    pub id: SpaceId,
    pub profile: ProfileId,
    pub name: String,
}

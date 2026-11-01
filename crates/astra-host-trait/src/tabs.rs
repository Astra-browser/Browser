/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tabs + navigation shapes (Host API `Tabs`, `Navigation`, `Content`).

use crate::ids::{ProfileId, TabId, WindowId};
use serde::{Deserialize, Serialize};

/// Point-in-time view of a tab owned by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabInfo {
    pub id: TabId,
    pub window: WindowId,
    pub profile: ProfileId,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub muted: bool,
    pub essential: bool,
}

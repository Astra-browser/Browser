/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Window shapes (Host API `Windows`).

use crate::ids::{TabId, WindowId};
use serde::{Deserialize, Serialize};

/// Point-in-time view of a browser window owned by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: WindowId,
    pub focused: bool,
    pub tabs: Vec<TabId>,
}

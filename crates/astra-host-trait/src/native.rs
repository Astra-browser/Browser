/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! OS-service shapes behind the `Native` seam (haptics, clipboard, …).

use serde::{Deserialize, Serialize};

/// Haptic feedback kind for the `haptic` command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HapticKind {
    Light,
    Medium,
    Heavy,
}

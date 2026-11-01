/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Download shapes (Host API `Downloads`).

use crate::ids::DownloadId;
use serde::{Deserialize, Serialize};

/// Download lifecycle state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadState {
    InProgress { received_bytes: u64, total_bytes: Option<u64> },
    Done { path: String },
    Failed { reason: String },
    Cancelled,
}

/// Point-in-time view of a download owned by the host.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadInfo {
    pub id: DownloadId,
    pub url: String,
    pub filename: String,
    pub state: DownloadState,
}

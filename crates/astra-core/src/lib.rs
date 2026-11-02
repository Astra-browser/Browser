/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-core`: pure browser-logic domains with no shell-runtime coupling.
//!
//! Anything that touches windows, tabs, or OS services goes through
//! [`BrowserHost`][astra_host_trait::BrowserHost]; this crate only holds the
//! logic that can be tested without an engine.

pub mod diagnostics;
pub mod history;
pub mod keymap;
pub mod keymap_ext;
pub mod layout;
pub mod logging;
pub mod memory_ext;
pub mod policy;
pub mod private;
pub mod search;
pub mod session;
pub mod settings;
pub mod settings_ext;
pub mod sleeping;
pub mod spaces;
pub mod tabs;

pub use diagnostics::{check_db_integrity, collect as collect_diagnostics, log_tail};
pub use diagnostics::{DbIntegrity, DiagnosticsBundle};
pub use history::{filter_history, HistoryEntry, HistoryFilter};
pub use keymap::{Keymap, KeymapEntry, KeymapError, KeymapOutcome};
pub use keymap_ext::{
    conflicts_in, export_keymap, find_conflicts, import_keymap, ConflictReport, KeyConflict,
    KeymapImport, KeymapStoreError,
};
pub use layout::{
    layout_for, LayoutError, SlotLayout, SplitLayout, LAYOUT_SNAPSHOT_VERSION, MAX_SLOT_RATIO,
    MAX_SPLIT_SLOTS, MIN_SLOT_RATIO,
};
pub use logging::{
    init_logging, is_secret_key, log_path_for_today, redact_pair, redact_text, today_log_path,
    LoggingError, LoggingGuard, RedactingFileWriter, RedactingSink, MAX_LOG_BYTES, REDACTED,
};
pub use policy::{authorize, Caller};
pub use search::{rank, score_match};
pub use session::{
    FolderSnapshot, OrganisationRow, RestorePlan, ScrollState, SessionError, SessionSnapshot,
    SpaceSnapshot, TabSnapshot, WindowSnapshot, SESSION_NAME_LAST, SESSION_SNAPSHOT_VERSION,
};
pub use settings::{default_for, validate, SettingsError, KNOWN_SETTINGS};
pub use settings_ext::{apply_defaults, defaults as settings_defaults, migrate, validate_all};
pub use settings_ext::{MigrationReport, SettingsExtError};
pub use spaces::{container_name_for_space, profile_dir_name, valid_container_ref};
pub use spaces::{Space, SpaceError, SpaceStore};
pub use tabs::{TabEntry, TabStrip, TabStripError};

use astra_host_trait::{Admission, BrowserHost};
use thiserror::Error;

/// Errors from core services that coordinate with the host.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid setting: {0}")]
    Setting(#[from] settings::SettingsError),
    #[error("unauthorized caller for profile {0}")]
    Unauthorized(astra_host_trait::ProfileId),
    #[error("host error: {0}")]
    Host(String),
}

/// Validate a setting, check the caller scope, then apply it via the host.
///
/// Example of the intended seam direction: policy + pure logic in core,
/// effects behind [`BrowserHost`].
#[tracing::instrument(skip(host, caller, expected_profile))]
pub async fn apply_setting<H: BrowserHost>(
    host: &H,
    caller: &Caller,
    expected_profile: &astra_host_trait::ProfileId,
    key: &str,
    value: &str,
) -> Result<Admission, CoreError> {
    validate(key, value)?;
    if !authorize(caller, expected_profile) {
        return Err(CoreError::Unauthorized(expected_profile.clone()));
    }
    host.setting_set(key, value)
        .await
        .map_err(|e| CoreError::Host(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use astra_host_trait::{MockHost, ProfileId};

    #[tokio::test]
    async fn apply_setting_validates_then_routes_to_host() {
        let host = MockHost::new();
        let caller = Caller::new("browser", ProfileId::new("default"));
        let admission = apply_setting(
            &host,
            &caller,
            &ProfileId::new("default"),
            "appearance.theme",
            "dark",
        )
        .await
        .unwrap();
        assert!(admission.is_admitted());
        assert_eq!(
            host.setting_get("appearance.theme").await.unwrap(),
            Some("dark".to_owned())
        );
        assert!(host.calls().contains(&"setting_set".to_owned()));
    }

    #[tokio::test]
    async fn apply_setting_rejects_bad_value_before_host() {
        let host = MockHost::new();
        let caller = Caller::new("browser", ProfileId::new("default"));
        let err = apply_setting(
            &host,
            &caller,
            &ProfileId::new("default"),
            "appearance.theme",
            "neon",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CoreError::Setting(_)));
        assert!(!host.calls().contains(&"setting_set".to_owned()));
    }

    #[tokio::test]
    async fn apply_setting_rejects_scope_mismatch() {
        let host = MockHost::new();
        let caller = Caller::new("browser", ProfileId::new("p1"));
        let err = apply_setting(
            &host,
            &caller,
            &ProfileId::new("p2"),
            "appearance.theme",
            "dark",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, CoreError::Unauthorized(_)));
        assert!(!host.calls().contains(&"setting_set".to_owned()));
    }
}

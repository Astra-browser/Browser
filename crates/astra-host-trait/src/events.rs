/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Host event channels.
//!
//! Derived from the IPC surface inventory (35 channels). Channels that
//! carried the previous product name are minted here under the `astra:`
//! prefix; all other wire names are kept stable.

use serde::{Deserialize, Serialize};

/// A host event channel identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EventChannel(pub &'static str);

impl EventChannel {
    pub const BLOCKER_STATUS_CHANGED: Self = Self("blocker-status-changed");
    pub const BROWSER_CREDENTIAL_CAPABILITY_CHANGED: Self =
        Self("browser-credential-capability-changed");
    pub const DOWNLOADS_CHANGED: Self = Self("downloads-changed");
    pub const EXTENSION_ACTION_FAILED: Self = Self("extension-action-failed");
    pub const EXTENSION_ACTION_SHORTCUT: Self = Self("extension-action-shortcut");
    pub const EXTENSION_ACTIONS_CHANGED: Self = Self("extension-actions-changed");
    pub const FAVICONS_CHANGED: Self = Self("favicons-changed");
    pub const FIND_CHANGED: Self = Self("find-changed");
    pub const FOCUS_CHANGED: Self = Self("focus-changed");
    pub const ITEMS_CHANGED: Self = Self("items-changed");
    pub const LAYOUT_CHANGED: Self = Self("layout-changed");
    pub const MEDIA_PLAYER_CHANGED: Self = Self("media-player-changed");
    pub const NOTE_OPEN_REQUESTED: Self = Self("note-open-requested");
    pub const NOTES_CHANGED: Self = Self("notes-changed");
    pub const OPERATION_PROCESSED: Self = Self("operation-processed");
    pub const PAGE_PERMISSION_PROMPT_CHANGED: Self = Self("page-permission-prompt-changed");
    pub const RESOURCE_CHANGED: Self = Self("resource-changed");
    pub const RUNTIME_STATUS_CHANGED: Self = Self("runtime-status-changed");
    pub const SEARCH_CHANGED: Self = Self("search-changed");
    pub const TAB_CHANGED: Self = Self("tab-changed");
    pub const UI_COMMAND: Self = Self("ui-command");
    pub const WEB_EXTENSION_ACCESS_REQUESTED: Self = Self("web-extension-access-requested");
    pub const WEB_EXTENSION_STORE_CLICKED: Self = Self("web-extension-store-clicked");
    pub const WORK_CHANGED: Self = Self("work-changed");
    pub const WORK_ENVIRONMENT_CHANGED: Self = Self("work-environment-changed");
    // Renamed channels (previously carried the old product prefix).
    pub const ACCOUNT_CHANGED: Self = Self("astra:account-changed");
    pub const IMPORT_PROGRESS: Self = Self("astra:import-progress");
    pub const KEYMAP_CHANGED: Self = Self("astra:keymap-changed");
    pub const PAGE_ASSIST_CHANGED: Self = Self("astra:page-assist-changed");
    pub const SWIPE: Self = Self("astra:swipe");
    pub const VOICE_CHANGED: Self = Self("astra:voice-changed");
    pub const VOICE_LEVELS: Self = Self("astra:voice-levels");
    pub const WORK_DECISION_PREFERENCE_CHANGED: Self =
        Self("astra:work-decision-preference-changed");
    pub const WORK_HUMAN_CHANGED: Self = Self("astra:work-human-changed");
    pub const WORK_MODELS_CHANGED: Self = Self("astra:work-models-changed");

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

/// An event emitted by the host on a channel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEvent {
    pub channel: &'static str,
    pub payload: serde_json::Value,
}

impl HostEvent {
    pub fn new(channel: EventChannel, payload: serde_json::Value) -> Self {
        Self {
            channel: channel.as_str(),
            payload,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renamed_channels_use_astra_prefix() {
        for channel in [
            EventChannel::ACCOUNT_CHANGED,
            EventChannel::IMPORT_PROGRESS,
            EventChannel::KEYMAP_CHANGED,
            EventChannel::PAGE_ASSIST_CHANGED,
            EventChannel::SWIPE,
            EventChannel::VOICE_CHANGED,
            EventChannel::VOICE_LEVELS,
            EventChannel::WORK_DECISION_PREFERENCE_CHANGED,
            EventChannel::WORK_HUMAN_CHANGED,
            EventChannel::WORK_MODELS_CHANGED,
        ] {
            assert!(
                channel.as_str().starts_with("astra:"),
                "missing astra: prefix: {}",
                channel.as_str()
            );
        }
    }

    #[test]
    fn stable_channels_have_no_prefix() {
        assert_eq!(EventChannel::TAB_CHANGED.as_str(), "tab-changed");
        assert_eq!(EventChannel::WORK_CHANGED.as_str(), "work-changed");
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! In-memory [`BrowserHost`] for unit tests and dev harnesses.
//!
//! The mock records every call (in order) and serves scripted state, so
//! `astra-core` services can be tested without a browser engine.

use crate::admission::Admission;
use crate::downloads::{DownloadInfo, DownloadState};
use crate::events::{EventChannel, HostEvent};
use crate::ids::{DownloadId, ProfileId, TabId, WindowId};
use crate::native::HapticKind;
use crate::permissions::{PermissionDecision, PermissionRequest};
use crate::session::ProfileInfo;
use crate::tabs::TabInfo;
use std::collections::{HashMap, VecDeque};
use std::sync::{mpsc, Mutex};
use thiserror::Error;

/// Error type for [`MockHost`]; programming or assertion failures only.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum MockError {
    #[error("mock: unknown tab {0}")]
    UnknownTab(TabId),
    #[error("mock: unknown window {0}")]
    UnknownWindow(WindowId),
    #[error("mock: unknown download {0}")]
    UnknownDownload(DownloadId),
    #[error("mock: no scripted admission left for {0}")]
    AdmissionExhausted(String),
}

struct MockState {
    calls: Vec<String>,
    tabs: HashMap<TabId, TabInfo>,
    settings: HashMap<String, String>,
    profiles: Vec<ProfileInfo>,
    downloads: HashMap<DownloadId, DownloadInfo>,
    clipboard: Option<String>,
    haptics: Vec<HapticKind>,
    permission_decisions: Vec<(PermissionRequest, PermissionDecision)>,
    /// Scripted admissions; when empty every mutating call is admitted.
    admissions: VecDeque<Admission>,
    next_tab: u64,
    next_window: u64,
    next_download: u64,
    event_sinks: HashMap<&'static str, Vec<mpsc::Sender<HostEvent>>>,
}

/// In-memory [`BrowserHost`][crate::BrowserHost] implementation.
pub struct MockHost {
    state: Mutex<MockState>,
}

impl MockHost {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MockState {
                calls: Vec::new(),
                tabs: HashMap::new(),
                settings: HashMap::new(),
                profiles: vec![ProfileInfo {
                    id: ProfileId::new("default"),
                    name: "Default".to_owned(),
                }],
                downloads: HashMap::new(),
                clipboard: None,
                haptics: Vec::new(),
                permission_decisions: Vec::new(),
                admissions: VecDeque::new(),
                next_tab: 1,
                next_window: 1,
                next_download: 1,
                event_sinks: HashMap::new(),
            }),
        }
    }

    /// Queue scripted admissions consumed (FIFO) by mutating calls.
    pub fn script_admissions(&self, admissions: Vec<Admission>) {
        self.state.lock().unwrap().admissions = admissions.into();
    }

    /// Names of host calls made so far, in order.
    pub fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }

    /// Push an event to all subscribers of its channel.
    pub fn emit(&self, event: HostEvent) {
        let state = self.state.lock().unwrap();
        if let Some(sinks) = state.event_sinks.get(event.channel) {
            for sink in sinks {
                let _ = sink.send(event.clone());
            }
        }
    }

    fn record_and_admit(state: &mut MockState, call: &str) -> Admission {
        state.calls.push(call.to_owned());
        state.admissions.pop_front().unwrap_or(Admission::Admitted)
    }
}

impl Default for MockHost {
    fn default() -> Self {
        Self::new()
    }
}

impl crate::BrowserHost for MockHost {
    type Error = MockError;

    fn host_name(&self) -> &'static str {
        "mock"
    }

    async fn tab_open(&self, profile: &ProfileId) -> Result<TabId, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("tab_open".to_owned());
        let id = TabId::new(format!("tab-{}", state.next_tab));
        state.next_tab += 1;
        state.tabs.insert(
            id.clone(),
            TabInfo {
                id: id.clone(),
                window: WindowId::new("window-1"),
                profile: profile.clone(),
                url: String::new(),
                title: String::new(),
                active: true,
                muted: false,
                essential: false,
            },
        );
        Ok(id)
    }

    async fn tab_close(&self, id: &TabId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if state.tabs.remove(id).is_none() {
            return Err(MockError::UnknownTab(id.clone()));
        }
        Ok(Self::record_and_admit(&mut state, "tab_close"))
    }

    async fn tab_activate(&self, id: &TabId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if !state.tabs.contains_key(id) {
            return Err(MockError::UnknownTab(id.clone()));
        }
        for tab in state.tabs.values_mut() {
            tab.active = &tab.id == id;
        }
        Ok(Self::record_and_admit(&mut state, "tab_activate"))
    }

    async fn tab_navigate(&self, id: &TabId, input: &str) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        match state.tabs.get_mut(id) {
            Some(tab) => {
                tab.url = input.to_owned();
                Ok(Self::record_and_admit(&mut state, "tab_navigate"))
            }
            None => Err(MockError::UnknownTab(id.clone())),
        }
    }

    async fn tab_reload(&self, id: &TabId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if !state.tabs.contains_key(id) {
            return Err(MockError::UnknownTab(id.clone()));
        }
        Ok(Self::record_and_admit(&mut state, "tab_reload"))
    }

    async fn tab_back(&self, id: &TabId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if !state.tabs.contains_key(id) {
            return Err(MockError::UnknownTab(id.clone()));
        }
        Ok(Self::record_and_admit(&mut state, "tab_back"))
    }

    async fn tab_forward(&self, id: &TabId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if !state.tabs.contains_key(id) {
            return Err(MockError::UnknownTab(id.clone()));
        }
        Ok(Self::record_and_admit(&mut state, "tab_forward"))
    }

    async fn tab_set_muted(&self, id: &TabId, muted: bool) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        match state.tabs.get_mut(id) {
            Some(tab) => {
                tab.muted = muted;
                Ok(Self::record_and_admit(&mut state, "tab_set_muted"))
            }
            None => Err(MockError::UnknownTab(id.clone())),
        }
    }

    async fn tab_snapshot(&self, id: &TabId) -> Result<Option<TabInfo>, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("tab_snapshot".to_owned());
        Ok(state.tabs.get(id).cloned())
    }

    async fn window_open(&self, _profile: &ProfileId) -> Result<WindowId, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("window_open".to_owned());
        let id = WindowId::new(format!("window-{}", state.next_window));
        state.next_window += 1;
        Ok(id)
    }

    async fn window_close(&self, id: &WindowId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if id.as_str() != "window-1" {
            return Err(MockError::UnknownWindow(id.clone()));
        }
        Ok(Self::record_and_admit(&mut state, "window_close"))
    }

    async fn setting_get(&self, key: &str) -> Result<Option<String>, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("setting_get".to_owned());
        Ok(state.settings.get(key).cloned())
    }

    async fn setting_set(&self, key: &str, value: &str) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        state.settings.insert(key.to_owned(), value.to_owned());
        Ok(Self::record_and_admit(&mut state, "setting_set"))
    }

    async fn download_start(
        &self,
        url: &str,
        _profile: &ProfileId,
    ) -> Result<DownloadId, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("download_start".to_owned());
        let id = DownloadId::new(format!("dl-{}", state.next_download));
        state.next_download += 1;
        state.downloads.insert(
            id.clone(),
            DownloadInfo {
                id: id.clone(),
                url: url.to_owned(),
                filename: url.rsplit('/').next().unwrap_or("download").to_owned(),
                state: DownloadState::InProgress {
                    received_bytes: 0,
                    total_bytes: None,
                },
            },
        );
        Ok(id)
    }

    async fn download_state(&self, id: &DownloadId) -> Result<Option<DownloadInfo>, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("download_state".to_owned());
        Ok(state.downloads.get(id).cloned())
    }

    async fn permission_decide(
        &self,
        req: &PermissionRequest,
        decision: PermissionDecision,
    ) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        state.permission_decisions.push((req.clone(), decision));
        Ok(Self::record_and_admit(&mut state, "permission_decide"))
    }

    async fn profiles_list(&self) -> Result<Vec<ProfileInfo>, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("profiles_list".to_owned());
        Ok(state.profiles.clone())
    }

    async fn profile_switch(&self, id: &ProfileId) -> Result<Admission, MockError> {
        let mut state = self.state.lock().unwrap();
        if !state.profiles.iter().any(|p| &p.id == id) {
            return Ok(Admission::denied(format!("unknown profile {}", id)));
        }
        Ok(Self::record_and_admit(&mut state, "profile_switch"))
    }

    async fn haptic(&self, kind: HapticKind) -> Result<(), MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("haptic".to_owned());
        state.haptics.push(kind);
        Ok(())
    }

    async fn clipboard_write(&self, text: &str) -> Result<(), MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("clipboard_write".to_owned());
        state.clipboard = Some(text.to_owned());
        Ok(())
    }

    async fn clipboard_read(&self) -> Result<Option<String>, MockError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("clipboard_read".to_owned());
        Ok(state.clipboard.clone())
    }

    fn subscribe(&self, channel: EventChannel) -> Result<mpsc::Receiver<HostEvent>, MockError> {
        let (tx, rx) = mpsc::channel();
        self.state
            .lock()
            .unwrap()
            .event_sinks
            .entry(channel.as_str())
            .or_default()
            .push(tx);
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::BrowserHost;

    #[tokio::test]
    async fn tab_lifecycle_round_trip() {
        let host = MockHost::new();
        let profile = ProfileId::new("default");
        let tab = host.tab_open(&profile).await.unwrap();
        host.tab_navigate(&tab, "https://example.com")
            .await
            .unwrap();
        host.tab_set_muted(&tab, true).await.unwrap();
        let snap = host.tab_snapshot(&tab).await.unwrap().unwrap();
        assert_eq!(snap.url, "https://example.com");
        assert!(snap.muted);
        assert!(host.tab_close(&tab).await.unwrap().is_admitted());
        assert!(host.tab_snapshot(&tab).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unknown_tab_errors() {
        let host = MockHost::new();
        let err = host.tab_close(&TabId::new("nope")).await.unwrap_err();
        assert_eq!(err, MockError::UnknownTab(TabId::new("nope")));
    }

    #[tokio::test]
    async fn scripted_admissions_are_consumed_fifo() {
        let host = MockHost::new();
        host.script_admissions(vec![
            Admission::deferred("gate"),
            Admission::denied("policy"),
        ]);
        let profile = ProfileId::new("default");
        let tab = host.tab_open(&profile).await.unwrap();
        assert_eq!(
            host.tab_close(&tab).await.unwrap(),
            Admission::deferred("gate")
        );
        assert_eq!(
            host.profile_switch(&ProfileId::new("default"))
                .await
                .unwrap(),
            Admission::denied("policy")
        );
        // Exhausted script falls back to admitted.
        assert!(host
            .profile_switch(&ProfileId::new("default"))
            .await
            .unwrap()
            .is_admitted());
    }

    #[tokio::test]
    async fn settings_and_clipboard_round_trip() {
        let host = MockHost::new();
        assert_eq!(host.setting_get("theme").await.unwrap(), None);
        assert!(host
            .setting_set("theme", "dark")
            .await
            .unwrap()
            .is_admitted());
        assert_eq!(
            host.setting_get("theme").await.unwrap(),
            Some("dark".to_owned())
        );
        host.clipboard_write("hi").await.unwrap();
        assert_eq!(host.clipboard_read().await.unwrap(), Some("hi".to_owned()));
    }

    #[test]
    fn events_fan_out_to_subscribers() {
        let host = MockHost::new();
        let rx = host.subscribe(EventChannel::TAB_CHANGED).unwrap();
        host.emit(HostEvent::new(
            EventChannel::TAB_CHANGED,
            serde_json::json!({"id": "tab-1"}),
        ));
        let got = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        assert_eq!(got.channel, "tab-changed");
    }
}

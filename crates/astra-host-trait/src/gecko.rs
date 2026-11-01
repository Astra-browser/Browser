/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! [`GeckoHost`]: the [`BrowserHost`] that speaks the Host API wire format.
//!
//! This is the only implementor allowed to speak the Host API protocol.
//! Requests go out as `req` envelopes over an [`astra_ipc`] transport (child
//! stdio pipes in production per D-31, loopback TCP in tests via
//! [`astra_ipc::loopback`)); responses come back as `res` envelopes
//! correlated by `id`, and host pushes arrive as `evt` envelopes routed to
//! [`subscribe`][BrowserHost::subscribe] sinks by channel name.
//!
//! ## Request mapping (P2-T05 test protocol)
//!
//! Envelope `name`s reuse the `astra-proto` command registry where one
//! exists; the rest live under `host.*` so they can never collide with
//! registered commands. Shapes mirror the Host API modules in
//! `overlay/astra/host/*.sys.mjs` (read-only reference) where those modules
//! exist:
//!
//! | `BrowserHost` method | envelope `name` | response payload |
//! |---|---|---|
//! | `tab_open` | `tabs_open` (`{profile}`) | `{tab_id}` (also accepts `astra_tab_id`) |
//! | `tab_close` | `tabs_close` (`{id}`) | `{admission}` |
//! | `tab_activate` | `tabs_activate` (`{id}`) | `{admission}` |
//! | `tab_navigate` | `tabs_navigate` (`{id, input}`) | `{admission}` |
//! | `tab_reload` | `tabs_reload` (`{id}`) | `{admission}` |
//! | `tab_back` | `tabs_back` (`{id}`) | `{admission}` |
//! | `tab_forward` | `tabs_forward` (`{id}`) | `{admission}` |
//! | `tab_set_muted` | `tab_set_muted` (`{id, muted}`) | `{admission}` |
//! | `tab_snapshot` | `host.tabs_snapshot` (`{id}`) | `{tab: TabInfo | null}` |
//! | `window_open` | `host.windows_open` (`{profile}`) | `{window_id}` |
//! | `window_close` | `host.windows_close` (`{id}`) | `{admission}` |
//! | `setting_get` | `setting_get` (`{key}`) | `{value: string | null}` |
//! | `setting_set` | `setting_set` (`{key, value}`) | `{admission}` |
//! | `download_start` | `host.downloads_start` (`{url, profile}`) | `{download: DownloadInfo}` |
//! | `download_state` | `host.downloads_state` (`{id}`) | `{download: DownloadInfo | null}` |
//! | `permission_decide` | `page_permission_respond` (`{origin, kind, request_id, decision}`) | `{admission}` |
//! | `profiles_list` | `profiles_get` (`{}`) | `{profiles: ProfileInfo[]}` |
//! | `profile_switch` | `profiles_switch` (`{profile}`) | `{admission}` |
//! | `haptic` | `haptic` (`{kind}`) | `{}` |
//! | `clipboard_write` | `host.clipboard_write` (`{text}`) | `{}` |
//! | `clipboard_read` | `host.clipboard_read` (`{}`) | `{text: string | null}` |
//!
//! Admissions are `{status: "admitted" | "deferred" | "denied", reason?}`.
//! Host failures arrive as `res` envelopes with `error: {code, message}`
//! (e.g. `no_such_tab`, mirroring `Tabs.sys.mjs`) and surface as
//! [`GeckoError::Host`]. Events arrive as `evt` envelopes whose `name` is the
//! event channel (e.g. `tab-changed`); unknown channel names are dropped.
//!
//! The P2-T06 Host API v1 binding owns the authoritative protocol; names
//! here are updated to match it when it lands.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use astra_ipc::{Transport, TransportEvent};
use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::{mpsc as async_mpsc, oneshot};

use crate::admission::Admission;
use crate::downloads::DownloadInfo;
use crate::events::{EventChannel, HostEvent};
use crate::ids::{DownloadId, ProfileId, TabId, WindowId};
use crate::native::HapticKind;
use crate::permissions::{PermissionDecision, PermissionRequest};
use crate::session::ProfileInfo;
use crate::tabs::TabInfo;
use crate::BrowserHost;

/// Envelope `name` for [`BrowserHost::tab_open`].
pub const CMD_TABS_OPEN: &str = "tabs_open";
/// Envelope `name` for [`BrowserHost::tab_close`].
pub const CMD_TABS_CLOSE: &str = "tabs_close";
/// Envelope `name` for [`BrowserHost::tab_activate`].
pub const CMD_TABS_ACTIVATE: &str = "tabs_activate";
/// Envelope `name` for [`BrowserHost::tab_navigate`].
pub const CMD_TABS_NAVIGATE: &str = "tabs_navigate";
/// Envelope `name` for [`BrowserHost::tab_reload`].
pub const CMD_TABS_RELOAD: &str = "tabs_reload";
/// Envelope `name` for [`BrowserHost::tab_back`].
pub const CMD_TABS_BACK: &str = "tabs_back";
/// Envelope `name` for [`BrowserHost::tab_forward`].
pub const CMD_TABS_FORWARD: &str = "tabs_forward";
/// Envelope `name` for [`BrowserHost::tab_set_muted`].
pub const CMD_TAB_SET_MUTED: &str = "tab_set_muted";
/// Envelope `name` for [`BrowserHost::tab_snapshot`].
pub const CMD_TABS_SNAPSHOT: &str = "host.tabs_snapshot";
/// Envelope `name` for [`BrowserHost::window_open`].
pub const CMD_WINDOWS_OPEN: &str = "host.windows_open";
/// Envelope `name` for [`BrowserHost::window_close`].
pub const CMD_WINDOWS_CLOSE: &str = "host.windows_close";
/// Envelope `name` for [`BrowserHost::setting_get`].
pub const CMD_SETTING_GET: &str = "setting_get";
/// Envelope `name` for [`BrowserHost::setting_set`].
pub const CMD_SETTING_SET: &str = "setting_set";
/// Envelope `name` for [`BrowserHost::download_start`].
pub const CMD_DOWNLOADS_START: &str = "host.downloads_start";
/// Envelope `name` for [`BrowserHost::download_state`].
pub const CMD_DOWNLOADS_STATE: &str = "host.downloads_state";
/// Envelope `name` for [`BrowserHost::permission_decide`].
pub const CMD_PERMISSION_RESPOND: &str = "page_permission_respond";
/// Envelope `name` for [`BrowserHost::profiles_list`].
pub const CMD_PROFILES_GET: &str = "profiles_get";
/// Envelope `name` for [`BrowserHost::profile_switch`].
pub const CMD_PROFILES_SWITCH: &str = "profiles_switch";
/// Envelope `name` for [`BrowserHost::haptic`].
pub const CMD_HAPTIC: &str = "haptic";
/// Envelope `name` for [`BrowserHost::clipboard_write`].
pub const CMD_CLIPBOARD_WRITE: &str = "host.clipboard_write";
/// Envelope `name` for [`BrowserHost::clipboard_read`].
pub const CMD_CLIPBOARD_READ: &str = "host.clipboard_read";
/// Test-only envelope `name` (mirrors the overlay `__resetForTests`
/// convention): queues scripted admissions on the peer, consumed FIFO by
/// mutating calls exactly like [`MockHost`][crate::MockHost] scripting.
pub const CMD_TEST_SCRIPT_ADMISSIONS: &str = "host.__script_admissions";

/// Error type for [`GeckoHost`]: transport failures, timeouts, host-side
/// errors, and malformed payloads.
#[derive(Debug, Error)]
pub enum GeckoError {
    /// The frame link failed.
    #[error("gecko host: transport: {0}")]
    Transport(String),
    /// The link is closed (peer gone, or host dropped).
    #[error("gecko host: connection closed")]
    Closed,
    /// No response arrived within the call timeout.
    #[error("gecko host: call {name} ({id}) timed out after {timeout:?}")]
    Timeout {
        id: String,
        name: String,
        timeout: Duration,
    },
    /// The host answered with `error: {code, message}` (e.g. `no_such_tab`).
    #[error("gecko host: host error {code}: {message}")]
    Host { code: String, message: String },
    /// The host answered without an error but the payload shape was wrong.
    #[error("gecko host: bad payload for {name}: {message}")]
    Protocol { name: String, message: String },
    /// A lock was poisoned; unreachable without a panicking pump thread.
    #[error("gecko host: internal lock poisoned")]
    Internal,
}

impl From<astra_ipc::TransportError> for GeckoError {
    fn from(err: astra_ipc::TransportError) -> Self {
        Self::Transport(err.to_string())
    }
}

/// Wire shape of an [`Admission`]: `{status, reason?}`.
pub fn admission_to_value(admission: &Admission) -> Value {
    match admission {
        Admission::Admitted => serde_json::json!({"status": "admitted"}),
        Admission::Deferred { reason } => {
            serde_json::json!({"status": "deferred", "reason": reason})
        }
        Admission::Denied { reason } => serde_json::json!({"status": "denied", "reason": reason}),
    }
}

/// Parse the [`admission_to_value`] wire shape back into an [`Admission`].
pub fn admission_from_value(value: &Value) -> Result<Admission, String> {
    let status = value
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string \"status\": {value}"))?;
    match status {
        "admitted" => Ok(Admission::Admitted),
        "deferred" => Ok(Admission::deferred(
            value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )),
        "denied" => Ok(Admission::denied(
            value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )),
        other => Err(format!("unknown admission status {other:?}")),
    }
}

/// Map an event envelope `name` to its channel; unknown names are `None`.
pub fn channel_from_name(name: &str) -> Option<EventChannel> {
    Some(match name {
        "blocker-status-changed" => EventChannel::BLOCKER_STATUS_CHANGED,
        "browser-credential-capability-changed" => {
            EventChannel::BROWSER_CREDENTIAL_CAPABILITY_CHANGED
        }
        "downloads-changed" => EventChannel::DOWNLOADS_CHANGED,
        "extension-action-failed" => EventChannel::EXTENSION_ACTION_FAILED,
        "extension-action-shortcut" => EventChannel::EXTENSION_ACTION_SHORTCUT,
        "extension-actions-changed" => EventChannel::EXTENSION_ACTIONS_CHANGED,
        "favicons-changed" => EventChannel::FAVICONS_CHANGED,
        "find-changed" => EventChannel::FIND_CHANGED,
        "focus-changed" => EventChannel::FOCUS_CHANGED,
        "items-changed" => EventChannel::ITEMS_CHANGED,
        "layout-changed" => EventChannel::LAYOUT_CHANGED,
        "media-player-changed" => EventChannel::MEDIA_PLAYER_CHANGED,
        "note-open-requested" => EventChannel::NOTE_OPEN_REQUESTED,
        "notes-changed" => EventChannel::NOTES_CHANGED,
        "operation-processed" => EventChannel::OPERATION_PROCESSED,
        "page-permission-prompt-changed" => EventChannel::PAGE_PERMISSION_PROMPT_CHANGED,
        "resource-changed" => EventChannel::RESOURCE_CHANGED,
        "runtime-status-changed" => EventChannel::RUNTIME_STATUS_CHANGED,
        "search-changed" => EventChannel::SEARCH_CHANGED,
        "tab-changed" => EventChannel::TAB_CHANGED,
        "ui-command" => EventChannel::UI_COMMAND,
        "web-extension-access-requested" => EventChannel::WEB_EXTENSION_ACCESS_REQUESTED,
        "web-extension-store-clicked" => EventChannel::WEB_EXTENSION_STORE_CLICKED,
        "work-changed" => EventChannel::WORK_CHANGED,
        "work-environment-changed" => EventChannel::WORK_ENVIRONMENT_CHANGED,
        "astra:account-changed" => EventChannel::ACCOUNT_CHANGED,
        "astra:import-progress" => EventChannel::IMPORT_PROGRESS,
        "astra:keymap-changed" => EventChannel::KEYMAP_CHANGED,
        "astra:page-assist-changed" => EventChannel::PAGE_ASSIST_CHANGED,
        "astra:swipe" => EventChannel::SWIPE,
        "astra:voice-changed" => EventChannel::VOICE_CHANGED,
        "astra:voice-levels" => EventChannel::VOICE_LEVELS,
        "astra:work-decision-preference-changed" => EventChannel::WORK_DECISION_PREFERENCE_CHANGED,
        "astra:work-human-changed" => EventChannel::WORK_HUMAN_CHANGED,
        "astra:work-models-changed" => EventChannel::WORK_MODELS_CHANGED,
        _ => return None,
    })
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Envelope>>>>;
type EventMap = Arc<Mutex<HashMap<&'static str, Vec<mpsc::Sender<HostEvent>>>>>;

/// [`BrowserHost`] over the Host API frame link.
///
/// Created with [`GeckoHost::spawn`] around a live [`Transport`]; a pump task
/// owns the transport, forwards queued requests, correlates `res` envelopes
/// by `id`, and fans `evt` envelopes out to [`subscribe`][BrowserHost::subscribe]
/// receivers. Dropping the last clone closes the link: queued mail is
/// flushed by the transport, then the pump exits. Must be created inside a
/// Tokio runtime (the pump is spawned on it).
pub struct GeckoHost {
    outbound: async_mpsc::UnboundedSender<Envelope>,
    pending: PendingMap,
    events: EventMap,
    next: AtomicU64,
    call_timeout: Duration,
}

impl GeckoHost {
    /// Default per-call timeout (loopback/stdio answers in milliseconds).
    pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(5);

    /// Attach to a live transport and start the pump task.
    pub fn spawn(transport: Transport) -> Self {
        Self::spawn_with_timeout(transport, Self::DEFAULT_CALL_TIMEOUT)
    }

    /// Attach with an explicit per-call timeout (tests use short timeouts).
    pub fn spawn_with_timeout(transport: Transport, call_timeout: Duration) -> Self {
        let (tx, rx) = async_mpsc::unbounded_channel();
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let events: EventMap = Arc::new(Mutex::new(HashMap::new()));
        tokio::spawn(pump_task(
            transport,
            rx,
            Arc::clone(&pending),
            Arc::clone(&events),
        ));
        Self {
            outbound: tx,
            pending,
            events,
            next: AtomicU64::new(1),
            call_timeout,
        }
    }

    /// Test-only (mirrors the overlay `__resetForTests` convention): queue
    /// scripted admissions on the peer, consumed FIFO by mutating calls.
    pub async fn script_admissions(&self, admissions: Vec<Admission>) -> Result<(), GeckoError> {
        let items: Vec<Value> = admissions.iter().map(admission_to_value).collect();
        self.call(
            CMD_TEST_SCRIPT_ADMISSIONS,
            serde_json::json!({"admissions": items}),
        )
        .await?;
        Ok(())
    }

    fn next_id(&self) -> String {
        format!("gecko-{}", self.next.fetch_add(1, Ordering::Relaxed))
    }

    async fn call(&self, name: &'static str, payload: Value) -> Result<Value, GeckoError> {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| GeckoError::Internal)?
            .insert(id.clone(), tx);
        let env = Envelope {
            v: PROTOCOL_VERSION,
            id: id.clone(),
            kind: Kind::Req,
            name: name.to_string(),
            seq: None,
            payload,
            error: None,
        };
        if self.outbound.send(env).is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(GeckoError::Closed);
        }
        let res = tokio::time::timeout(self.call_timeout, rx)
            .await
            .map_err(|_| {
                if let Ok(mut pending) = self.pending.lock() {
                    pending.remove(&id);
                }
                GeckoError::Timeout {
                    id: id.clone(),
                    name: name.to_string(),
                    timeout: self.call_timeout,
                }
            })?
            .map_err(|_| GeckoError::Closed)?;
        if res.kind != Kind::Res {
            return Err(GeckoError::Protocol {
                name: name.to_string(),
                message: format!("expected res, got {:?}", res.kind),
            });
        }
        if let Some(err) = res.error {
            return Err(GeckoError::Host {
                code: err.code,
                message: err.message,
            });
        }
        Ok(res.payload)
    }

    fn protocol<T>(name: &'static str, message: String) -> Result<T, GeckoError> {
        Err(GeckoError::Protocol {
            name: name.to_string(),
            message,
        })
    }

    async fn call_admission(
        &self,
        name: &'static str,
        payload: Value,
    ) -> Result<Admission, GeckoError> {
        let res = self.call(name, payload).await?;
        match res.get("admission") {
            Some(value) => admission_from_value(value).map_err(|message| GeckoError::Protocol {
                name: name.to_string(),
                message,
            }),
            None => Self::protocol(name, format!("missing \"admission\": {res}")),
        }
    }

    fn required<'a>(
        res: &'a Value,
        name: &'static str,
        key: &str,
    ) -> Result<&'a Value, GeckoError> {
        res.get(key).ok_or_else(|| GeckoError::Protocol {
            name: name.to_string(),
            message: format!("missing {key:?}: {res}"),
        })
    }
}

fn fail_all(pending: &PendingMap) {
    if let Ok(mut guard) = pending.lock() {
        for (_, tx) in guard.drain() {
            drop(tx);
        }
    }
}

fn route(pending: &PendingMap, events: &EventMap, env: Envelope) {
    match env.kind {
        Kind::Res => {
            let tx = pending
                .lock()
                .ok()
                .and_then(|mut guard| guard.remove(&env.id));
            if let Some(tx) = tx {
                let _ = tx.send(env);
            }
        }
        Kind::Evt => {
            if let Some(channel) = channel_from_name(&env.name) {
                let evt = HostEvent::new(channel, env.payload);
                if let Ok(mut guard) = events.lock() {
                    if let Some(sinks) = guard.get_mut(channel.as_str()) {
                        sinks.retain(|sink| sink.send(evt.clone()).is_ok());
                    }
                }
            }
        }
        // The host never sends us requests on this link.
        Kind::Req => {}
    }
}

async fn pump_task(
    mut transport: Transport,
    mut outbound: async_mpsc::UnboundedReceiver<Envelope>,
    pending: PendingMap,
    events: EventMap,
) {
    loop {
        tokio::select! {
            biased;
            next = outbound.recv() => {
                match next {
                    Some(env) => {
                        if transport.send(env).await.is_err() {
                            fail_all(&pending);
                            break;
                        }
                    }
                    // All hosts dropped: flush via close, fail stragglers.
                    None => {
                        transport.close();
                        fail_all(&pending);
                        break;
                    }
                }
            }
            ev = transport.recv() => {
                match ev {
                    Some(TransportEvent::Message(env)) => route(&pending, &events, env),
                    Some(TransportEvent::PeerTimeout) => {}
                    None => {
                        fail_all(&pending);
                        break;
                    }
                }
            }
        }
    }
}

impl BrowserHost for GeckoHost {
    type Error = GeckoError;

    fn host_name(&self) -> &'static str {
        "gecko"
    }

    async fn tab_open(&self, profile: &ProfileId) -> Result<TabId, GeckoError> {
        let res = self
            .call(
                CMD_TABS_OPEN,
                serde_json::json!({"profile": profile.as_str()}),
            )
            .await?;
        let id = res
            .get("tab_id")
            .or_else(|| res.get("astra_tab_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| GeckoError::Protocol {
                name: CMD_TABS_OPEN.to_string(),
                message: format!("missing \"tab_id\": {res}"),
            })?;
        Ok(TabId::new(id))
    }

    async fn tab_close(&self, id: &TabId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_TABS_CLOSE, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn tab_activate(&self, id: &TabId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_TABS_ACTIVATE, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn tab_navigate(&self, id: &TabId, input: &str) -> Result<Admission, GeckoError> {
        self.call_admission(
            CMD_TABS_NAVIGATE,
            serde_json::json!({"id": id.as_str(), "input": input}),
        )
        .await
    }

    async fn tab_reload(&self, id: &TabId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_TABS_RELOAD, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn tab_back(&self, id: &TabId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_TABS_BACK, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn tab_forward(&self, id: &TabId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_TABS_FORWARD, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn tab_set_muted(&self, id: &TabId, muted: bool) -> Result<Admission, GeckoError> {
        self.call_admission(
            CMD_TAB_SET_MUTED,
            serde_json::json!({"id": id.as_str(), "muted": muted}),
        )
        .await
    }

    async fn tab_snapshot(&self, id: &TabId) -> Result<Option<TabInfo>, GeckoError> {
        let res = self
            .call(CMD_TABS_SNAPSHOT, serde_json::json!({"id": id.as_str()}))
            .await?;
        match res.get("tab") {
            None | Some(Value::Null) => Ok(None),
            Some(tab) => serde_json::from_value(tab.clone())
                .map(Some)
                .map_err(|err| GeckoError::Protocol {
                    name: CMD_TABS_SNAPSHOT.to_string(),
                    message: format!("bad tab snapshot: {err}"),
                }),
        }
    }

    async fn window_open(&self, profile: &ProfileId) -> Result<WindowId, GeckoError> {
        let res = self
            .call(
                CMD_WINDOWS_OPEN,
                serde_json::json!({"profile": profile.as_str()}),
            )
            .await?;
        let id = Self::required(&res, CMD_WINDOWS_OPEN, "window_id")?
            .as_str()
            .ok_or_else(|| GeckoError::Protocol {
                name: CMD_WINDOWS_OPEN.to_string(),
                message: format!("\"window_id\" not a string: {res}"),
            })?;
        Ok(WindowId::new(id))
    }

    async fn window_close(&self, id: &WindowId) -> Result<Admission, GeckoError> {
        self.call_admission(CMD_WINDOWS_CLOSE, serde_json::json!({"id": id.as_str()}))
            .await
    }

    async fn setting_get(&self, key: &str) -> Result<Option<String>, GeckoError> {
        let res = self
            .call(CMD_SETTING_GET, serde_json::json!({"key": key}))
            .await?;
        match res.get("value") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|err| GeckoError::Protocol {
                    name: CMD_SETTING_GET.to_string(),
                    message: format!("bad setting value: {err}"),
                }),
        }
    }

    async fn setting_set(&self, key: &str, value: &str) -> Result<Admission, GeckoError> {
        self.call_admission(
            CMD_SETTING_SET,
            serde_json::json!({"key": key, "value": value}),
        )
        .await
    }

    async fn download_start(
        &self,
        url: &str,
        profile: &ProfileId,
    ) -> Result<DownloadId, GeckoError> {
        let res = self
            .call(
                CMD_DOWNLOADS_START,
                serde_json::json!({"url": url, "profile": profile.as_str()}),
            )
            .await?;
        let info: DownloadInfo =
            serde_json::from_value(Self::required(&res, CMD_DOWNLOADS_START, "download")?.clone())
                .map_err(|err| GeckoError::Protocol {
                    name: CMD_DOWNLOADS_START.to_string(),
                    message: format!("bad download info: {err}"),
                })?;
        Ok(info.id)
    }

    async fn download_state(&self, id: &DownloadId) -> Result<Option<DownloadInfo>, GeckoError> {
        let res = self
            .call(CMD_DOWNLOADS_STATE, serde_json::json!({"id": id.as_str()}))
            .await?;
        match res.get("download") {
            None | Some(Value::Null) => Ok(None),
            Some(info) => serde_json::from_value(info.clone())
                .map(Some)
                .map_err(|err| GeckoError::Protocol {
                    name: CMD_DOWNLOADS_STATE.to_string(),
                    message: format!("bad download info: {err}"),
                }),
        }
    }

    async fn permission_decide(
        &self,
        req: &PermissionRequest,
        decision: PermissionDecision,
    ) -> Result<Admission, GeckoError> {
        let mut payload = serde_json::to_value(req).map_err(|err| GeckoError::Protocol {
            name: CMD_PERMISSION_RESPOND.to_string(),
            message: format!("bad permission request: {err}"),
        })?;
        payload["decision"] =
            serde_json::to_value(&decision).map_err(|err| GeckoError::Protocol {
                name: CMD_PERMISSION_RESPOND.to_string(),
                message: format!("bad permission decision: {err}"),
            })?;
        self.call_admission(CMD_PERMISSION_RESPOND, payload).await
    }

    async fn profiles_list(&self) -> Result<Vec<ProfileInfo>, GeckoError> {
        let res = self.call(CMD_PROFILES_GET, serde_json::json!({})).await?;
        serde_json::from_value(Self::required(&res, CMD_PROFILES_GET, "profiles")?.clone()).map_err(
            |err| GeckoError::Protocol {
                name: CMD_PROFILES_GET.to_string(),
                message: format!("bad profiles list: {err}"),
            },
        )
    }

    async fn profile_switch(&self, id: &ProfileId) -> Result<Admission, GeckoError> {
        self.call_admission(
            CMD_PROFILES_SWITCH,
            serde_json::json!({"profile": id.as_str()}),
        )
        .await
    }

    async fn haptic(&self, kind: HapticKind) -> Result<(), GeckoError> {
        let payload = serde_json::to_value(kind).map_err(|err| GeckoError::Protocol {
            name: CMD_HAPTIC.to_string(),
            message: format!("bad haptic kind: {err}"),
        })?;
        self.call(CMD_HAPTIC, serde_json::json!({"kind": payload}))
            .await?;
        Ok(())
    }

    async fn clipboard_write(&self, text: &str) -> Result<(), GeckoError> {
        self.call(CMD_CLIPBOARD_WRITE, serde_json::json!({"text": text}))
            .await?;
        Ok(())
    }

    async fn clipboard_read(&self) -> Result<Option<String>, GeckoError> {
        let res = self.call(CMD_CLIPBOARD_READ, serde_json::json!({})).await?;
        match res.get("text") {
            None | Some(Value::Null) => Ok(None),
            Some(text) => serde_json::from_value(text.clone())
                .map(Some)
                .map_err(|err| GeckoError::Protocol {
                    name: CMD_CLIPBOARD_READ.to_string(),
                    message: format!("bad clipboard text: {err}"),
                }),
        }
    }

    fn subscribe(&self, channel: EventChannel) -> Result<mpsc::Receiver<HostEvent>, GeckoError> {
        let (tx, rx) = mpsc::channel();
        self.events
            .lock()
            .map_err(|_| GeckoError::Internal)?
            .entry(channel.as_str())
            .or_default()
            .push(tx);
        Ok(rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_wire_round_trip() {
        for admission in [
            Admission::Admitted,
            Admission::deferred("gate"),
            Admission::denied("policy"),
        ] {
            let back = admission_from_value(&admission_to_value(&admission)).unwrap();
            assert_eq!(back, admission);
        }
    }

    #[test]
    fn admission_wire_rejects_garbage() {
        assert!(admission_from_value(&serde_json::json!({})).is_err());
        assert!(admission_from_value(&serde_json::json!({"status": "maybe"})).is_err());
        // Missing reason degrades to empty rather than failing.
        assert_eq!(
            admission_from_value(&serde_json::json!({"status": "denied"})).unwrap(),
            Admission::denied("")
        );
    }

    #[test]
    fn channel_names_round_trip() {
        // Every declared channel resolves from its wire name; anything else
        // is dropped by the pump.
        for channel in [
            EventChannel::BLOCKER_STATUS_CHANGED,
            EventChannel::BROWSER_CREDENTIAL_CAPABILITY_CHANGED,
            EventChannel::DOWNLOADS_CHANGED,
            EventChannel::EXTENSION_ACTION_FAILED,
            EventChannel::EXTENSION_ACTION_SHORTCUT,
            EventChannel::EXTENSION_ACTIONS_CHANGED,
            EventChannel::FAVICONS_CHANGED,
            EventChannel::FIND_CHANGED,
            EventChannel::FOCUS_CHANGED,
            EventChannel::ITEMS_CHANGED,
            EventChannel::LAYOUT_CHANGED,
            EventChannel::MEDIA_PLAYER_CHANGED,
            EventChannel::NOTE_OPEN_REQUESTED,
            EventChannel::NOTES_CHANGED,
            EventChannel::OPERATION_PROCESSED,
            EventChannel::PAGE_PERMISSION_PROMPT_CHANGED,
            EventChannel::RESOURCE_CHANGED,
            EventChannel::RUNTIME_STATUS_CHANGED,
            EventChannel::SEARCH_CHANGED,
            EventChannel::TAB_CHANGED,
            EventChannel::UI_COMMAND,
            EventChannel::WEB_EXTENSION_ACCESS_REQUESTED,
            EventChannel::WEB_EXTENSION_STORE_CLICKED,
            EventChannel::WORK_CHANGED,
            EventChannel::WORK_ENVIRONMENT_CHANGED,
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
            assert_eq!(channel_from_name(channel.as_str()), Some(channel));
        }
        assert_eq!(channel_from_name("tab.created"), None);
        assert_eq!(channel_from_name(""), None);
    }

    #[test]
    fn error_display_is_diagnostic() {
        let err = GeckoError::Host {
            code: "no_such_tab".to_string(),
            message: "unknown tab tab-9".to_string(),
        };
        assert!(err.to_string().contains("no_such_tab"));
    }
}

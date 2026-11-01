/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `MockHost` vs `GeckoHost`-over-loopback parity (P2-T05).
//!
//! Every core integration test runs against both hosts: [`MockHost`] (fast,
//! in-process) and [`GeckoHost`] (end to end over the [`astra_ipc`] loopback
//! harness — authenticated TCP, no browser needed yet). The fake peer below
//! implements the [`gecko`][astra_host_trait::gecko] test protocol with the
//! exact [`MockHost`] state semantics (id counters, unknown-id errors,
//! admission scripting, the `window-1` close quirk), and each scenario
//! collects an observable transcript on both hosts and asserts equality.

use std::collections::{HashMap, VecDeque};
use std::fmt::Debug;
use std::time::Duration;

use astra_host_trait::gecko::{
    admission_from_value, admission_to_value, GeckoHost, CMD_CLIPBOARD_READ, CMD_CLIPBOARD_WRITE,
    CMD_DOWNLOADS_START, CMD_DOWNLOADS_STATE, CMD_HAPTIC, CMD_PERMISSION_RESPOND, CMD_PROFILES_GET,
    CMD_PROFILES_SWITCH, CMD_SETTING_GET, CMD_SETTING_SET, CMD_TABS_ACTIVATE, CMD_TABS_BACK,
    CMD_TABS_CLOSE, CMD_TABS_FORWARD, CMD_TABS_NAVIGATE, CMD_TABS_OPEN, CMD_TABS_RELOAD,
    CMD_TABS_SNAPSHOT, CMD_TAB_SET_MUTED, CMD_TEST_SCRIPT_ADMISSIONS, CMD_WINDOWS_CLOSE,
    CMD_WINDOWS_OPEN,
};
use astra_host_trait::{
    Admission, BrowserHost, DownloadId, DownloadInfo, DownloadState, EventChannel, HapticKind,
    HostEvent, MockHost, PermissionDecision, PermissionKind, PermissionRequest, ProfileId,
    ProfileInfo, TabId, TabInfo, WindowId,
};
use astra_ipc::loopback::{accept, bind_loopback, connect, listener_addr};
use astra_ipc::{Transport, TransportEvent};
use astra_proto::{Envelope, Kind, PROTOCOL_VERSION};
use serde_json::{json, Value};
use tokio::sync::{mpsc as async_mpsc, oneshot};

// --- Fake host peer -------------------------------------------------------

/// Control commands for the fake peer (test setup only).
enum PeerCommand {
    Emit(HostEvent),
    ScriptAdmissions(Vec<Admission>, oneshot::Sender<()>),
}

/// Handle to a fake host peer; tests drive behavior through [`GeckoHost`]
// and use this only for setup (admissions) and event injection.
#[derive(Clone)]
struct FakeHost {
    cmds: async_mpsc::UnboundedSender<PeerCommand>,
}

impl FakeHost {
    /// Push an event to the client as an `evt` envelope.
    fn emit(&self, event: HostEvent) {
        let _ = self.cmds.send(PeerCommand::Emit(event));
    }

    /// Queue scripted admissions; resolves once applied (no ordering race
    /// with the requests that follow).
    async fn script_admissions(&self, admissions: Vec<Admission>) {
        let (tx, rx) = oneshot::channel();
        let _ = self
            .cmds
            .send(PeerCommand::ScriptAdmissions(admissions, tx));
        let _ = rx.await;
    }
}

struct PeerState {
    tabs: HashMap<String, TabInfo>,
    settings: HashMap<String, String>,
    downloads: HashMap<String, DownloadInfo>,
    clipboard: Option<String>,
    admissions: VecDeque<Admission>,
    next_tab: u64,
    next_window: u64,
    next_download: u64,
    next_evt: u64,
}

impl PeerState {
    fn new() -> Self {
        Self {
            tabs: HashMap::new(),
            settings: HashMap::new(),
            downloads: HashMap::new(),
            clipboard: None,
            admissions: VecDeque::new(),
            next_tab: 1,
            next_window: 1,
            next_download: 1,
            next_evt: 1,
        }
    }

    /// Consume one scripted admission, defaulting to admitted — the exact
    /// [`MockHost`] `record_and_admit` rule.
    fn admit(&mut self) -> Value {
        admission_to_value(&self.admissions.pop_front().unwrap_or(Admission::Admitted))
    }
}

fn res_ok(id: &str, payload: Value) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        kind: Kind::Res,
        name: "res".to_string(),
        seq: None,
        payload,
        error: None,
    }
}

fn res_err(id: &str, code: &str, message: String) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: id.to_string(),
        kind: Kind::Res,
        name: "res".to_string(),
        seq: None,
        payload: json!({}),
        error: Some(astra_proto::ProtoError {
            code: code.to_string(),
            message,
        }),
    }
}

fn no_such_tab(env_id: &str, tab: &str) -> Envelope {
    res_err(env_id, "no_such_tab", format!("unknown tab {tab}"))
}

/// Mirror of [`MockHost`]: creators never consume admissions, mutating calls
/// do (on success), reads never error on unknown ids (they return null).
fn handle_req(state: &mut PeerState, req: &Envelope) -> Envelope {
    let id = req.id.as_str();
    let get = |key: &str| req.payload.get(key).and_then(Value::as_str).unwrap_or("");
    match req.name.as_str() {
        CMD_TABS_OPEN => {
            let tab_id = format!("tab-{}", state.next_tab);
            state.next_tab += 1;
            state.tabs.insert(
                tab_id.clone(),
                TabInfo {
                    id: TabId::new(&tab_id),
                    window: WindowId::new("window-1"),
                    profile: ProfileId::new(get("profile")),
                    url: String::new(),
                    title: String::new(),
                    // Mirrors the mock: open marks active without clearing
                    // the others.
                    active: true,
                    muted: false,
                    essential: false,
                },
            );
            res_ok(id, json!({"tab_id": tab_id}))
        }
        CMD_TABS_CLOSE => match state.tabs.remove(get("id")) {
            Some(_) => res_ok(id, json!({"admission": state.admit()})),
            None => no_such_tab(id, get("id")),
        },
        CMD_TABS_ACTIVATE => {
            if !state.tabs.contains_key(get("id")) {
                return no_such_tab(id, get("id"));
            }
            let target = get("id").to_owned();
            for tab in state.tabs.values_mut() {
                tab.active = tab.id.as_str() == target;
            }
            res_ok(id, json!({"admission": state.admit()}))
        }
        CMD_TABS_NAVIGATE => match state.tabs.get_mut(get("id")) {
            Some(tab) => {
                tab.url = req
                    .payload
                    .get("input")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                res_ok(id, json!({"admission": state.admit()}))
            }
            None => no_such_tab(id, get("id")),
        },
        CMD_TABS_RELOAD | CMD_TABS_BACK | CMD_TABS_FORWARD => {
            if !state.tabs.contains_key(get("id")) {
                return no_such_tab(id, get("id"));
            }
            res_ok(id, json!({"admission": state.admit()}))
        }
        CMD_TAB_SET_MUTED => {
            let muted = req
                .payload
                .get("muted")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match state.tabs.get_mut(get("id")) {
                Some(tab) => {
                    tab.muted = muted;
                    res_ok(id, json!({"admission": state.admit()}))
                }
                None => no_such_tab(id, get("id")),
            }
        }
        CMD_TABS_SNAPSHOT => {
            let tab = state.tabs.get(get("id")).cloned();
            res_ok(id, json!({"tab": tab}))
        }
        CMD_WINDOWS_OPEN => {
            let window_id = format!("window-{}", state.next_window);
            state.next_window += 1;
            res_ok(id, json!({"window_id": window_id}))
        }
        // Mirrors the mock quirk: only "window-1" closes cleanly; anything
        // else (including freshly opened window-2+) is an unknown window.
        CMD_WINDOWS_CLOSE => {
            if get("id") == "window-1" {
                res_ok(id, json!({"admission": state.admit()}))
            } else {
                res_err(
                    id,
                    "no_such_window",
                    format!("unknown window {}", get("id")),
                )
            }
        }
        CMD_SETTING_GET => {
            let value = state.settings.get(get("key")).cloned();
            res_ok(id, json!({"value": value}))
        }
        CMD_SETTING_SET => {
            state.settings.insert(
                get("key").to_owned(),
                req.payload
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            );
            res_ok(id, json!({"admission": state.admit()}))
        }
        CMD_DOWNLOADS_START => {
            let url = get("url").to_owned();
            let dl_id = format!("dl-{}", state.next_download);
            state.next_download += 1;
            let info = DownloadInfo {
                id: DownloadId::new(&dl_id),
                url: url.clone(),
                filename: url.rsplit('/').next().unwrap_or("download").to_owned(),
                state: DownloadState::InProgress {
                    received_bytes: 0,
                    total_bytes: None,
                },
            };
            state.downloads.insert(dl_id, info.clone());
            res_ok(id, json!({"download": info}))
        }
        CMD_DOWNLOADS_STATE => {
            let info = state.downloads.get(get("id")).cloned();
            res_ok(id, json!({"download": info}))
        }
        CMD_PERMISSION_RESPOND => res_ok(id, json!({"admission": state.admit()})),
        CMD_PROFILES_GET => res_ok(
            id,
            json!({"profiles": [ProfileInfo { id: ProfileId::new("default"), name: "Default".to_owned() }]}),
        ),
        CMD_PROFILES_SWITCH => {
            if get("profile") == "default" {
                res_ok(id, json!({"admission": state.admit()}))
            } else {
                // Mirrors the mock: unknown profiles deny without consuming
                // a scripted admission.
                let denied = admission_to_value(&Admission::denied(format!(
                    "unknown profile {}",
                    get("profile")
                )));
                res_ok(id, json!({"admission": denied}))
            }
        }
        CMD_HAPTIC | CMD_CLIPBOARD_WRITE | CMD_TEST_SCRIPT_ADMISSIONS => res_ok(id, json!({})),
        CMD_CLIPBOARD_READ => res_ok(id, json!({"text": state.clipboard})),
        other => res_err(id, "unknown_command", format!("no such command {other}")),
    }
}

async fn run_peer(
    mut transport: Transport,
    mut cmds: async_mpsc::UnboundedReceiver<PeerCommand>,
    mut state: PeerState,
) {
    // Drain queued control commands first so test setup (scripted
    // admissions) always applies before the request it precedes.
    let apply = |state: &mut PeerState, cmd: PeerCommand| match cmd {
        PeerCommand::Emit(event) => {
            let env = Envelope {
                v: PROTOCOL_VERSION,
                id: format!("peer-evt-{}", state.next_evt),
                kind: Kind::Evt,
                name: event.channel.to_string(),
                seq: Some(state.next_evt),
                payload: event.payload.clone(),
                error: None,
            };
            state.next_evt += 1;
            Some(env)
        }
        PeerCommand::ScriptAdmissions(admissions, ack) => {
            state.admissions = admissions.into();
            let _ = ack.send(());
            None
        }
    };
    let mut pending_evts: Vec<Envelope> = Vec::new();
    loop {
        while let Ok(cmd) = cmds.try_recv() {
            if let Some(env) = apply(&mut state, cmd) {
                pending_evts.push(env);
            }
        }
        for env in pending_evts.drain(..) {
            if transport.send(env).await.is_err() {
                return;
            }
        }
        tokio::select! {
            biased;
            cmd = cmds.recv() => {
                match cmd {
                    Some(cmd) => {
                        if let Some(env) = apply(&mut state, cmd) {
                            if transport.send(env).await.is_err() {
                                return;
                            }
                        }
                    }
                    None => return,
                }
            }
            ev = transport.recv() => {
                match ev {
                    Some(TransportEvent::Message(req)) => {
                        if req.kind != Kind::Req {
                            continue;
                        }
                        if req.name == CMD_CLIPBOARD_WRITE {
                            state.clipboard = req.payload.get("text").and_then(Value::as_str).map(str::to_owned);
                        }
                        let res = handle_req(&mut state, &req);
                        if transport.send(res).await.is_err() {
                            return;
                        }
                    }
                    // Heartbeats are consumed by the transport; a timeout or
                    // close ends the peer.
                    Some(TransportEvent::PeerTimeout) | None => return,
                }
            }
        }
    }
}

/// Spin up an authenticated loopback pair: client transport wrapped in
/// [`GeckoHost`], server transport driven by the fake peer.
async fn pair() -> (GeckoHost, FakeHost) {
    let cfg = astra_ipc::loopback::test_config();
    let listener = bind_loopback().await.expect("bind loopback");
    let addr = listener_addr(&listener).expect("loopback addr");
    let token = astra_ipc::generate_token();
    let server_token = token.clone();
    let server_cfg = cfg.clone();
    let server = tokio::spawn(async move {
        accept(listener, &server_token, &server_cfg)
            .await
            .expect("accept loopback")
    });
    let client = connect(addr, &token, &cfg).await.expect("connect loopback");
    let server_transport = server.await.expect("server task");
    let host = GeckoHost::spawn(client);
    let (tx, rx) = async_mpsc::unbounded_channel();
    tokio::spawn(run_peer(server_transport, rx, PeerState::new()));
    (host, FakeHost { cmds: tx })
}

// --- Parity scenarios ------------------------------------------------------

/// Tab lifecycle transcript; identical on both hosts.
async fn tab_lifecycle<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    let profile = ProfileId::new("default");
    let tab = host.tab_open(&profile).await.expect("open");
    t.push(format!("open: {tab}"));
    t.push(format!(
        "navigate: {:?}",
        host.tab_navigate(&tab, "https://example.invalid/").await
    ));
    t.push(format!(
        "snapshot: {:?}",
        host.tab_snapshot(&tab).await.expect("snapshot")
    ));
    t.push(format!("muted: {:?}", host.tab_set_muted(&tab, true).await));
    t.push(format!(
        "snapshot-muted: {:?}",
        host.tab_snapshot(&tab).await.expect("snapshot")
    ));
    t.push(format!("activate: {:?}", host.tab_activate(&tab).await));
    t.push(format!("reload: {:?}", host.tab_reload(&tab).await));
    t.push(format!("back: {:?}", host.tab_back(&tab).await));
    t.push(format!("forward: {:?}", host.tab_forward(&tab).await));
    t.push(format!("close: {:?}", host.tab_close(&tab).await));
    t.push(format!(
        "snapshot-gone: {:?}",
        host.tab_snapshot(&tab).await.expect("snapshot")
    ));
    // Unknown ids error everywhere except snapshot (null), on both hosts.
    let missing = TabId::new("tab-nope");
    t.push(format!(
        "close-unknown-err: {}",
        host.tab_close(&missing).await.is_err()
    ));
    t.push(format!(
        "activate-unknown-err: {}",
        host.tab_activate(&missing).await.is_err()
    ));
    t.push(format!(
        "navigate-unknown-err: {}",
        host.tab_navigate(&missing, "https://example.invalid/")
            .await
            .is_err()
    ));
    t.push(format!(
        "muted-unknown-err: {}",
        host.tab_set_muted(&missing, true).await.is_err()
    ));
    t.push(format!(
        "snapshot-unknown: {:?}",
        host.tab_snapshot(&missing).await.expect("snapshot")
    ));
    t
}

async fn windows_case<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    let profile = ProfileId::new("default");
    let first = host.window_open(&profile).await.expect("open");
    t.push(format!("open: {first}"));
    t.push(format!(
        "close-first: {:?}",
        host.window_close(&first).await
    ));
    let second = host.window_open(&profile).await.expect("open");
    t.push(format!("open2: {second}"));
    t.push(format!(
        "close-second-err: {}",
        host.window_close(&second).await.is_err()
    ));
    t.push(format!(
        "close-unknown-err: {}",
        host.window_close(&WindowId::new("window-nope"))
            .await
            .is_err()
    ));
    t
}

async fn settings_clipboard_case<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    t.push(format!(
        "get-missing: {:?}",
        host.setting_get("theme").await
    ));
    t.push(format!(
        "set: {:?}",
        host.setting_set("theme", "dark").await
    ));
    t.push(format!("get: {:?}", host.setting_get("theme").await));
    t.push(format!(
        "overwrite: {:?}",
        host.setting_set("theme", "light").await
    ));
    t.push(format!("get2: {:?}", host.setting_get("theme").await));
    t.push(format!(
        "clipboard-empty: {:?}",
        host.clipboard_read().await
    ));
    host.clipboard_write("hello").await.expect("write");
    t.push(format!("clipboard: {:?}", host.clipboard_read().await));
    host.clipboard_write("").await.expect("write");
    t.push(format!(
        "clipboard-cleared: {:?}",
        host.clipboard_read().await
    ));
    t
}

async fn downloads_case<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    let profile = ProfileId::new("default");
    let dl = host
        .download_start("https://example.invalid/files/setup.bin", &profile)
        .await
        .expect("start");
    t.push(format!("start: {dl}"));
    t.push(format!(
        "state: {:?}",
        host.download_state(&dl).await.expect("state")
    ));
    let bare = host
        .download_start("https://example.invalid/", &profile)
        .await
        .expect("start");
    t.push(format!(
        "bare-url-state: {:?}",
        host.download_state(&bare).await.expect("state")
    ));
    t.push(format!(
        "unknown: {:?}",
        host.download_state(&DownloadId::new("dl-nope"))
            .await
            .expect("state")
    ));
    t
}

async fn permissions_profiles_case<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    let req = PermissionRequest {
        origin: "https://example.invalid/".to_string(),
        kind: PermissionKind::Camera,
        request_id: "req-1".to_string(),
    };
    t.push(format!(
        "decide: {:?}",
        host.permission_decide(&req, PermissionDecision::Grant)
            .await
    ));
    t.push(format!("profiles: {:?}", host.profiles_list().await));
    t.push(format!(
        "switch-known: {:?}",
        host.profile_switch(&ProfileId::new("default")).await
    ));
    // Unknown profiles deny (not error) on both hosts.
    t.push(format!(
        "switch-unknown: {:?}",
        host.profile_switch(&ProfileId::new("nope")).await
    ));
    host.haptic(HapticKind::Light).await.expect("haptic");
    t.push("haptic: ok".to_string());
    t
}

/// Scripted-admission flow shared by both hosts; scripting itself is
/// host-specific (sync on mock, wire call on gecko).
async fn scripted_case<H: BrowserHost>(host: &H) -> Vec<String>
where
    H::Error: Debug,
{
    let mut t = Vec::new();
    let profile = ProfileId::new("default");
    let tab = host.tab_open(&profile).await.expect("open");
    t.push(format!("close: {:?}", host.tab_close(&tab).await));
    t.push(format!("switch: {:?}", host.profile_switch(&profile).await));
    // Exhausted script falls back to admitted.
    t.push(format!(
        "switch2: {:?}",
        host.profile_switch(&profile).await
    ));
    t
}

fn script() -> Vec<Admission> {
    vec![Admission::deferred("gate"), Admission::denied("policy")]
}

// --- Tests -----------------------------------------------------------------

#[tokio::test]
async fn parity_tab_lifecycle() {
    let mock = MockHost::new();
    let expected = tab_lifecycle(&mock).await;
    let (gecko, _peer) = pair().await;
    assert_eq!(tab_lifecycle(&gecko).await, expected);
}

#[tokio::test]
async fn parity_windows() {
    let mock = MockHost::new();
    let expected = windows_case(&mock).await;
    let (gecko, _peer) = pair().await;
    assert_eq!(windows_case(&gecko).await, expected);
}

#[tokio::test]
async fn parity_settings_clipboard() {
    let mock = MockHost::new();
    let expected = settings_clipboard_case(&mock).await;
    let (gecko, _peer) = pair().await;
    assert_eq!(settings_clipboard_case(&gecko).await, expected);
}

#[tokio::test]
async fn parity_downloads() {
    let mock = MockHost::new();
    let expected = downloads_case(&mock).await;
    let (gecko, _peer) = pair().await;
    assert_eq!(downloads_case(&gecko).await, expected);
}

#[tokio::test]
async fn parity_permissions_profiles() {
    let mock = MockHost::new();
    let expected = permissions_profiles_case(&mock).await;
    let (gecko, _peer) = pair().await;
    assert_eq!(permissions_profiles_case(&gecko).await, expected);
}

#[tokio::test]
async fn parity_scripted_admissions() {
    let mock = MockHost::new();
    mock.script_admissions(script());
    let expected = scripted_case(&mock).await;
    let (gecko, peer) = pair().await;
    peer.script_admissions(script()).await;
    assert_eq!(scripted_case(&gecko).await, expected);
}

#[tokio::test]
async fn parity_admission_wire_helpers() {
    // The peer consumes scripted admissions through the same wire shape the
    // host parses; a mismatch would break parity silently.
    for admission in [
        Admission::Admitted,
        Admission::deferred("gate"),
        Admission::denied("policy"),
    ] {
        assert_eq!(
            admission_from_value(&admission_to_value(&admission)),
            Ok(admission)
        );
    }
}

#[tokio::test]
async fn events_fan_out_on_both_hosts() {
    let mock = MockHost::new();
    let (gecko, peer) = pair().await;

    let mock_rx = mock
        .subscribe(EventChannel::TAB_CHANGED)
        .expect("subscribe");
    let gecko_rx = gecko
        .subscribe(EventChannel::TAB_CHANGED)
        .expect("subscribe");
    // Other channels stay quiet.
    let _other = gecko
        .subscribe(EventChannel::WORK_CHANGED)
        .expect("subscribe");

    let event = HostEvent::new(
        EventChannel::TAB_CHANGED,
        json!({"id": "tab-1", "url": "https://example.invalid/"}),
    );
    mock.emit(event.clone());
    peer.emit(event.clone());

    let mock_got = tokio::task::spawn_blocking(move || {
        mock_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("mock event")
    })
    .await
    .expect("join");
    let gecko_got = tokio::task::spawn_blocking(move || {
        gecko_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("gecko event")
    })
    .await
    .expect("join");
    assert_eq!(mock_got, event);
    assert_eq!(gecko_got, event);
}

#[tokio::test]
async fn host_names() {
    let mock = MockHost::new();
    let (gecko, _peer) = pair().await;
    assert_eq!(mock.host_name(), "mock");
    assert_eq!(gecko.host_name(), "gecko");
}

#[tokio::test]
async fn gecko_surfaces_host_errors() {
    let (gecko, _peer) = pair().await;
    let err = gecko
        .tab_close(&TabId::new("tab-nope"))
        .await
        .expect_err("unknown tab must error");
    assert!(err.to_string().contains("no_such_tab"), "{err}");
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! P5b: drive the real `astra-core` binary over its stdio protocol.
//!
//! These are black-box tests: they spawn the built executable, write
//! Appendix C frames and read the replies, so the wire shape, the store
//! file and process lifecycle are exercised exactly as the browser host
//! will use them.

use std::io::{BufReader, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use astra_proto::{encode_frame, Envelope, Kind};
use serde_json::{json, Value};

struct Core {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Core {
    fn start(db: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_astra-core"))
            .arg("--db")
            .arg(db)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn astra-core");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
            next_id: 0,
        }
    }

    fn call(&mut self, name: &str, payload: Value) -> Envelope {
        self.next_id += 1;
        let env = Envelope {
            v: astra_proto::PROTOCOL_VERSION,
            id: format!("t-{}", self.next_id),
            kind: Kind::Req,
            name: name.to_owned(),
            seq: None,
            payload,
            error: None,
        };
        self.stdin
            .write_all(&encode_frame(&env))
            .expect("write frame");
        self.stdin.flush().expect("flush");
        self.read()
    }

    fn read(&mut self) -> Envelope {
        let mut head = [0u8; 4];
        self.stdout.read_exact(&mut head).expect("frame header");
        let len = u32::from_be_bytes(head) as usize;
        let mut body = vec![0u8; len];
        self.stdout.read_exact(&mut body).expect("frame body");
        serde_json::from_slice(&body).expect("frame json")
    }

    fn shutdown(mut self) -> i32 {
        let _ = self.call("core.shutdown", json!({}));
        self.child.wait().expect("wait").code().unwrap_or(-1)
    }
}

fn organisation_json() -> String {
    json!({
        "version": 1,
        "name": "organisation",
        "created_at": 1_700_000_000,
        "spaces": [
            {"uuid": "space-a", "name": "Space", "position": 0, "container_ref": null},
            {"uuid": "space-b", "name": "Work", "position": 1, "container_ref": "firefox-container-1"}
        ],
        "folders": [
            {"uuid": "folder-a", "space_uuid": "space-b", "name": "Docs", "position": 0}
        ],
        "windows": [
            {"window_id": "win-1", "focused": true, "title": ""}
        ],
        "tabs": [
            {
                "astra_tab_id": "tab-1",
                "space_uuid": "space-a",
                "url": "https://a.example/",
                "title": "A",
                "pinned": false,
                "position": 0,
                "window_id": "win-1",
                "history": ["https://a.example/"],
                "history_index": 0
            },
            {
                "astra_tab_id": "tab-2",
                "space_uuid": "space-b",
                "folder_uuid": "folder-a",
                "url": "https://b.example/",
                "title": "B",
                "pinned": true,
                "position": 1,
                "window_id": "win-1",
                "history": [],
                "history_index": null
            }
        ],
        "active_tab_id": "tab-1",
        "layout": null
    })
    .to_string()
}

fn canonical(snapshot: &str) -> String {
    astra_core::session::SessionSnapshot::from_json(snapshot)
        .expect("valid snapshot")
        .to_json()
        .expect("serialize")
}

#[test]
fn handshake_reports_protocol_and_schema() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = Core::start(&dir.path().join("core.sqlite"));
    let res = core.call("boot.handshake", json!({"core_version": 1}));
    assert_eq!(res.kind, Kind::Res);
    assert!(res.error.is_none(), "handshake error: {:?}", res.error);
    assert_eq!(res.payload["core_version"], 1);
    assert_eq!(res.payload["protocol"], astra_proto::PROTOCOL_VERSION);
    assert_eq!(res.payload["schema"], astra_store::SCHEMA_VERSION);
    assert_eq!(core.shutdown(), 0);
}

#[test]
fn save_then_load_survives_a_new_process() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.sqlite");
    let snapshot = organisation_json();
    {
        let mut core = Core::start(&db);
        let res = core.call("session.save", json!({"snapshot": snapshot}));
        assert!(res.error.is_none(), "save error: {:?}", res.error);
        assert_eq!(res.payload["saved"], true);
        assert_eq!(core.shutdown(), 0);
    }
    // kill/restart: the row is already durable, so a fresh process reads it.
    {
        let mut core = Core::start(&db);
        let res = core.call("session.load", json!({}));
        assert!(res.error.is_none(), "load error: {:?}", res.error);
        assert_eq!(res.payload["snapshot"], canonical(&snapshot));
        assert!(res.payload["updated_at"].as_i64().unwrap_or(0) > 0);
        assert_eq!(core.shutdown(), 0);
    }
}

#[test]
fn save_rejects_an_invalid_snapshot_and_keeps_the_old_row() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.sqlite");
    let good = organisation_json();
    let mut core = Core::start(&db);
    assert!(core
        .call("session.save", json!({"snapshot": good}))
        .error
        .is_none());

    // A tab pointing at a space that does not exist must never be stored.
    let mut broken: Value = serde_json::from_str(&good).unwrap();
    broken["tabs"][0]["space_uuid"] = json!("space-missing");
    let res = core.call("session.save", json!({"snapshot": broken.to_string()}));
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("invalid_snapshot")
    );

    // A future version fails loudly instead of being silently downgraded.
    let mut future: Value = serde_json::from_str(&good).unwrap();
    future["version"] = json!(99);
    let res = core.call("session.save", json!({"snapshot": future.to_string()}));
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("invalid_snapshot")
    );

    // A missing snapshot is a payload error, not a panic.
    let res = core.call("session.save", json!({}));
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("invalid_payload")
    );

    let res = core.call("session.load", json!({}));
    assert_eq!(res.payload["snapshot"], canonical(&good));
    assert_eq!(core.shutdown(), 0);
}

#[test]
fn load_without_a_row_is_null_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = Core::start(&dir.path().join("empty.sqlite"));
    let res = core.call("session.load", json!({"name": "never-saved"}));
    assert!(res.error.is_none());
    assert!(res.payload["snapshot"].is_null());
    assert!(res.payload["updated_at"].is_null());
    assert_eq!(core.shutdown(), 0);
}

#[test]
fn named_snapshots_are_independent() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("core.sqlite");
    let mut core = Core::start(&db);
    let one = organisation_json();
    let mut two: Value = serde_json::from_str(&one).unwrap();
    two["spaces"][0]["name"] = json!("Personal");
    let two = two.to_string();
    assert!(core
        .call("session.save", json!({"name": "a", "snapshot": one}))
        .error
        .is_none());
    assert!(core
        .call("session.save", json!({"name": "b", "snapshot": two}))
        .error
        .is_none());
    assert_eq!(
        core.call("session.load", json!({"name": "a"})).payload["snapshot"],
        canonical(&one)
    );
    assert_eq!(
        core.call("session.load", json!({"name": "b"})).payload["snapshot"],
        canonical(&two)
    );
    assert_eq!(core.shutdown(), 0);
}

#[test]
fn unknown_commands_and_versions_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = Core::start(&dir.path().join("core.sqlite"));
    let res = core.call("org.magic", json!({}));
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("unknown_command")
    );

    // A mismatched protocol version is refused by the shared gate.
    let env = Envelope {
        v: astra_proto::PROTOCOL_VERSION + 1,
        id: "bad-version".into(),
        kind: Kind::Req,
        name: "boot.handshake".into(),
        seq: None,
        payload: json!({}),
        error: None,
    };
    core.stdin.write_all(&encode_frame(&env)).unwrap();
    core.stdin.flush().unwrap();
    let res = core.read();
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("version_mismatch")
    );
    // A protocol mismatch ends the process by design; the reply is the last
    // frame, so wait for the exit instead of sending another command.
    assert_eq!(core.child.wait().unwrap().code(), Some(1));
}

#[test]
fn stdin_eof_exits_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let mut core = Core::start(&dir.path().join("core.sqlite"));
    drop(core.stdin);
    let status = core.child.wait().expect("wait");
    assert_eq!(status.code(), Some(0));
}

#[test]
fn requires_a_database_path() {
    let status = Command::new(env!("CARGO_BIN_EXE_astra-core"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("spawn without --db");
    assert_eq!(status.code(), Some(2));
}

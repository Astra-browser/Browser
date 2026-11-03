/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! The Astra core sidecar: organisation persistence for the browser host.
//!
//! The browser owns live tabs; this process owns *organisation* — spaces,
//! folders, pins, order and the active tab — in `astra-store`'s SQLite file.
//! It speaks the same Appendix C frames as the Host API (`astra-proto`): a
//! 4-byte big-endian length followed by one UTF-8 JSON envelope.
//!
//! Commands:
//! - `boot.handshake` — protocol and store schema versions.
//! - `session.save`   — `{name?, snapshot}`; validates a `SessionSnapshot`
//!                      and replaces the row. A stale or malformed payload is
//!                      refused, never stored.
//! - `session.load`   — `{name?}` → `{snapshot, updated_at}` or nulls.
//! - `core.shutdown`  — reply, then exit 0. stdin EOF also exits 0, so a
//!                      browser crash cannot leave a zombie holding the file.
//!
//! Durability: every save is one SQLite transaction (WAL + synchronous
//! default), so kill -9 after a `session.save` reply keeps the row.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use astra_core::session::SessionSnapshot;
use astra_proto::{
    check_version, decode_frame, encode_frame, Envelope, Kind, ProtoError, PROTOCOL_VERSION,
};
use astra_store::Store;
use serde_json::{json, Value};

/// Row name for the automatic organisation snapshot.
const ORG_NAME: &str = "organisation";

struct Args {
    db: PathBuf,
}

fn parse_args() -> Result<Args, String> {
    let mut db: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => {
                db = Some(PathBuf::from(args.next().ok_or("--db needs a path")?));
            }
            "--help" | "-h" => {
                return Err("usage: astra-core --db <path-to-sqlite>".to_owned());
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let db = db
        .or_else(|| std::env::var_os("ASTRA_CORE_DB").map(PathBuf::from))
        .ok_or("--db <path-to-sqlite> is required")?;
    Ok(Args { db })
}

fn read_exact_n<R: Read>(r: &mut R, n: usize) -> io::Result<Option<Vec<u8>>> {
    let mut buf = vec![0u8; n];
    let mut off = 0;
    while off < n {
        match r.read(&mut buf[off..])? {
            0 => {
                if off == 0 {
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "eof mid-frame",
                ));
            }
            k => off += k,
        }
    }
    Ok(Some(buf))
}

fn respond(out: &mut impl Write, env: &Envelope) {
    let frame = encode_frame(env);
    if out.write_all(&frame).is_err() || out.flush().is_err() {
        std::process::exit(1);
    }
}

fn ok(env: &Envelope, payload: Value) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: env.id.clone(),
        kind: Kind::Res,
        name: env.name.clone(),
        seq: None,
        payload,
        error: None,
    }
}

fn fail(env: &Envelope, code: &str, message: impl Into<String>) -> Envelope {
    Envelope {
        v: PROTOCOL_VERSION,
        id: env.id.clone(),
        kind: Kind::Res,
        name: env.name.clone(),
        seq: None,
        payload: Value::Null,
        error: Some(ProtoError {
            code: code.to_owned(),
            message: message.into(),
        }),
    }
}

fn name_of(payload: &Value) -> &str {
    payload
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(ORG_NAME)
}

fn handle(store: &Store, env: &Envelope) -> Envelope {
    if let Err(error) = check_version(env) {
        return Envelope {
            v: PROTOCOL_VERSION,
            id: env.id.clone(),
            kind: Kind::Res,
            name: env.name.clone(),
            seq: None,
            payload: Value::Null,
            error: Some(error),
        };
    }
    match env.name.as_str() {
        "boot.handshake" => ok(
            env,
            json!({
                "core_version": 1,
                "protocol": PROTOCOL_VERSION,
                "schema": astra_store::SCHEMA_VERSION,
            }),
        ),
        "session.save" => {
            let name = name_of(&env.payload);
            let Some(snapshot) = env.payload.get("snapshot").and_then(Value::as_str) else {
                return fail(
                    env,
                    "invalid_payload",
                    "session.save needs a snapshot string",
                );
            };
            match SessionSnapshot::from_json(snapshot) {
                Ok(parsed) => {
                    // Keep the caller's canonical JSON only if it is the same
                    // snapshot the validator accepted.
                    let canonical = match parsed.to_json() {
                        Ok(text) => text,
                        Err(e) => return fail(env, "invalid_snapshot", e.to_string()),
                    };
                    match store.session_save(name, &canonical) {
                        Ok(row) => ok(env, json!({"saved": true, "updated_at": row.updated_at})),
                        Err(e) => fail(env, "store_failed", e.to_string()),
                    }
                }
                Err(e) => fail(env, "invalid_snapshot", e.to_string()),
            }
        }
        "session.load" => {
            let name = name_of(&env.payload);
            match store.session_load(name) {
                Ok(Some(row)) => ok(
                    env,
                    json!({"snapshot": row.snapshot, "updated_at": row.updated_at}),
                ),
                Ok(None) => ok(env, json!({"snapshot": null, "updated_at": null})),
                Err(e) => fail(env, "store_failed", e.to_string()),
            }
        }
        "core.shutdown" => ok(env, json!({"shutdown": true})),
        other => fail(env, "unknown_command", format!("unknown command {other}")),
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("astra-core: {message}");
            std::process::exit(2);
        }
    };
    if let Some(parent) = args.db.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("astra-core: cannot create {}: {e}", parent.display());
            std::process::exit(2);
        }
    }
    let store = match Store::open(&args.db) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("astra-core: cannot open {}: {e}", args.db.display());
            std::process::exit(2);
        }
    };
    if let Err(e) = store.migrate() {
        eprintln!("astra-core: cannot migrate {}: {e}", args.db.display());
        std::process::exit(2);
    }
    // One line on stderr so a developer can find the file the browser uses.
    eprintln!("astra-core: store {}", args.db.display());

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut inp = stdin.lock();
    let mut out = stdout.lock();
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let chunk = match read_exact_n(&mut inp, 4) {
            Ok(None) => std::process::exit(0),
            Ok(Some(bytes)) => bytes,
            Err(_) => std::process::exit(1),
        };
        let len = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as usize;
        let body = match read_exact_n(&mut inp, len) {
            Ok(Some(bytes)) => bytes,
            _ => std::process::exit(1),
        };
        pending.extend_from_slice(&chunk);
        pending.extend_from_slice(&body);
        match decode_frame(&mut pending) {
            Ok(Some(env)) => {
                let shutdown = env.name == "core.shutdown";
                respond(&mut out, &handle(&store, &env));
                if shutdown {
                    std::process::exit(0);
                }
            }
            Ok(None) => std::process::exit(1), // unreachable: a full frame was buffered
            Err(error) => {
                eprintln!("astra-core: protocol error {}", error.code);
                let res = Envelope {
                    v: PROTOCOL_VERSION,
                    id: String::new(),
                    kind: Kind::Res,
                    name: String::new(),
                    seq: None,
                    payload: Value::Null,
                    error: Some(error),
                };
                respond(&mut out, &res);
                std::process::exit(1);
            }
        }
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! P1-T09 sidecar spike stub (U-01), now on the `astra-proto` library:
//! reads Appendix C frames on stdin, writes a `res` envelope per request
//! on stdout. Version-gated: requests with `v != PROTOCOL_VERSION` get a
//! `version_mismatch` error response instead of an echo.
//!
//! Shutdown: a request named `core.shutdown` replies then exits 0;
//! stdin EOF also exits 0 (models browser-death cleanup).

use std::io::{self, Read, Write};

use astra_proto::{decode_frame, encode_frame, Envelope, Kind, ProtoError, PROTOCOL_VERSION};

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
    if out.write_all(&frame).is_err() {
        std::process::exit(1);
    }
    if out.flush().is_err() {
        std::process::exit(1);
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut inp = stdin.lock();
    let mut out = stdout.lock();
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let chunk = match read_exact_n(&mut inp, 4) {
            Ok(None) => std::process::exit(0),
            Ok(Some(b)) => b,
            Err(_) => std::process::exit(1),
        };
        let len = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as usize;
        let body = match read_exact_n(&mut inp, len) {
            Ok(Some(b)) => b,
            _ => std::process::exit(1),
        };
        pending.extend_from_slice(&chunk);
        pending.extend_from_slice(&body);
        match decode_frame(&mut pending) {
            Ok(Some(env)) => {
                let shutdown = env.name == "core.shutdown";
                let res = Envelope {
                    v: PROTOCOL_VERSION,
                    id: env.id.clone(),
                    kind: Kind::Res,
                    name: env.name.clone(),
                    seq: None,
                    payload: serde_json::json!({"echo": env.name}),
                    error: None,
                };
                respond(&mut out, &res);
                if shutdown {
                    std::process::exit(0);
                }
            }
            Ok(None) => std::process::exit(1), // cannot happen: full frame buffered
            Err(e) => {
                let res = Envelope {
                    v: PROTOCOL_VERSION,
                    id: String::new(),
                    kind: Kind::Res,
                    name: String::new(),
                    seq: None,
                    payload: serde_json::Value::Null,
                    error: Some(ProtoError {
                        code: e.code,
                        message: e.message,
                    }),
                };
                respond(&mut out, &res);
                std::process::exit(1);
            }
        }
    }
}

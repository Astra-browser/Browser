/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! P1-T09 sidecar spike stub (U-01). Minimal echo core: reads Appendix C
//! frames (4-byte big-endian length + UTF-8 JSON) on stdin, writes a `res`
//! envelope per request on stdout. Stdlib only, no dependencies.
//!
//! Shutdown: `{"...,\"name\":\"core.shutdown\",...}` replies then exits 0;
//! stdin EOF also exits 0 (models browser-death cleanup).

use std::io::{self, Read, Write};

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

fn extract_str_field(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{}\"", key);
    let mut search = body;
    loop {
        let i = search.find(&pat)?;
        let mut rest = search[i + pat.len()..].trim_start();
        if !rest.starts_with(':') {
            search = &search[i + pat.len()..];
            continue;
        }
        rest = rest[1..].trim_start().strip_prefix('"')?;
        let mut out = String::new();
        let mut esc = false;
        for c in rest.chars() {
            if esc {
                out.push(c);
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                return Some(out);
            } else {
                out.push(c);
            }
        }
        return None;
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut inp = stdin.lock();
    let mut out = stdout.lock();

    loop {
        let len_buf = match read_exact_n(&mut inp, 4) {
            Ok(None) => std::process::exit(0),
            Ok(Some(b)) => b,
            Err(_) => std::process::exit(1),
        };
        let len = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
        if len > 16 * 1024 * 1024 {
            std::process::exit(1);
        }
        let body = match read_exact_n(&mut inp, len) {
            Ok(Some(b)) => b,
            _ => std::process::exit(1),
        };
        let text = match String::from_utf8(body) {
            Ok(t) => t,
            Err(_) => std::process::exit(1),
        };
        let id = extract_str_field(&text, "id").unwrap_or_default();
        let name = extract_str_field(&text, "name").unwrap_or_default();
        let resp = format!(
            "{{\"v\":1,\"id\":{:?},\"kind\":\"res\",\"name\":{:?},\"seq\":0,\"payload\":{{\"echo\":{}}}}}",
            id, name, text
        );
        let bytes = resp.as_bytes();
        let n = bytes.len() as u32;
        if out.write_all(&n.to_be_bytes()).is_err() {
            std::process::exit(1);
        }
        if out.write_all(bytes).is_err() {
            std::process::exit(1);
        }
        if out.flush().is_err() {
            std::process::exit(1);
        }
        if name == "core.shutdown" {
            std::process::exit(0);
        }
    }
}

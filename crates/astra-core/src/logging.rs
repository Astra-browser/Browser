/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Structured logging: `tracing` subscriber with a daily rolling file and
//! writer-level redaction of secret material.
//!
//! Redaction happens in the [`io::Write`] path itself ([`RedactingSink`]),
//! so even an accidentally unredacted field never reaches disk in cleartext.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use std::cell::Cell;
use thiserror::Error;
use tracing_subscriber::fmt::MakeWriter;

thread_local! {
    static LOGGING_INITIALISED: Cell<bool> = const { Cell::new(false) };
}

/// Key fragments (case-insensitive) whose values are secret.
const SECRET_MARKERS: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "api_key",
    "apikey",
    "api-key",
    "access_token",
    "refresh_token",
    "session_token",
    "token",
    "bearer",
    "cookie",
    "authorization",
    "private_key",
    "client_secret",
];

/// Replacement for redacted values.
pub const REDACTED: &str = "[REDACTED]";

/// Maximum bytes per daily log file before rolling to a numbered sibling.
pub const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

/// Errors from logging setup.
#[derive(Debug, Error)]
pub enum LoggingError {
    #[error("cannot create log directory {0:?}: {1}")]
    Directory(PathBuf, io::Error),
    #[error("cannot open log file {0:?}: {1}")]
    File(PathBuf, io::Error),
    #[error("logging already initialised on this thread")]
    AlreadyInitialised,
}

/// Returns `true` when `key` looks like it holds a secret (case-insensitive).
///
/// Matches whole markers on ASCII-alphanumeric boundaries, so `tokenizer`
/// is benign while `db_password` and `x-api-key` are secret.
pub fn is_secret_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    let bytes = lower.as_bytes();
    SECRET_MARKERS.iter().any(|m| {
        let mb = m.as_bytes();
        let mut start = 0usize;
        while start + mb.len() <= bytes.len() {
            let rel = lower[start..].find(m);
            let s = match rel {
                Some(r) => start + r,
                None => return false,
            };
            let e = s + mb.len();
            let left_ok = s == 0 || !bytes[s - 1].is_ascii_alphanumeric();
            let right_ok = e == bytes.len() || !bytes[e].is_ascii_alphanumeric();
            if left_ok && right_ok {
                return true;
            }
            start = s + 1;
        }
        false
    })
}

/// Redact the value when `key` is secret, otherwise return it unchanged.
pub fn redact_pair(key: &str, value: &str) -> String {
    if is_secret_key(key) {
        REDACTED.to_owned()
    } else {
        value.to_owned()
    }
}

/// Mask one `key = value` / `key: value` / `Bearer <token>` occurrence.
///
/// Scans `text` for `marker` (already lowercased search), masks the value that
/// follows an `=`/`:` separator, and returns the new string with the number of
/// redactions applied.
fn mask_marker(text: &str, marker: &str) -> (String, usize) {
    let lower = text.to_lowercase();
    let marker_bytes = marker.as_bytes();
    let bytes = text.as_bytes();
    let lower_bytes = lower.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    let mut count = 0usize;

    while i < bytes.len() {
        let hits = lower_bytes[i..].starts_with(marker_bytes)
            && (i == 0 || {
                // Snakes (`db_password`) and kebabs (`x-api-key`) count as
                // boundaries; only ASCII alphanumerics glue to a longer word.
                !lower_bytes[i - 1].is_ascii_alphanumeric()
            });
        if !hits {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        // Peek past the marker: allow spaces/quotes, then require `=`/`:`.
        let mut j = i + marker_bytes.len();
        // Reject if the marker is glued to a longer word on the right
        // (e.g. `tokenizer`, `tokens`): copy one byte and move on.
        if j < bytes.len()
            && (lower_bytes[j].is_ascii_alphanumeric()
                || lower_bytes[j] == b'_'
                || lower_bytes[j] == b'-')
        {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let mut k = j;
        while k < bytes.len()
            && (bytes[k] == b' ' || bytes[k] == b'\t' || bytes[k] == b'"' || bytes[k] == b'\'')
        {
            k += 1;
        }
        // `Bearer <token>` carries its value bare, without a separator.
        let bare_bearer =
            marker == "bearer" && k < bytes.len() && bytes[k] != b'=' && bytes[k] != b':';
        if !bare_bearer && (k >= bytes.len() || (bytes[k] != b'=' && bytes[k] != b':')) {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        if bare_bearer {
            // Copy the marker itself, then mask the token that follows.
            out.extend_from_slice(&bytes[i..k]);
            j = k;
        } else {
            // Copy `marker .. separator` verbatim, then mask the value.
            out.extend_from_slice(&bytes[i..=k]);
            j = k + 1;
        }
        while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
            out.push(bytes[j]);
            j += 1;
        }
        // A `Bearer` scheme word between the separator and the credential
        // belongs to the secret: skip it and mask what follows.
        // (`"Authorization": "Bearer abc"` masks the whole quoted string
        // anyway; this covers the unquoted `key: Bearer abc` shape.)
        if lower.get(j..).is_some_and(|rest| {
            rest.starts_with("bearer")
                && rest[6..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
        }) {
            j += 6;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
        }
        let quoted = j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'');
        let quote = if quoted { bytes[j] } else { 0 };
        if quoted {
            out.push(bytes[j]);
            j += 1;
        }
        out.extend_from_slice(REDACTED.as_bytes());
        count += 1;
        if quoted {
            while j < bytes.len() && bytes[j] != quote {
                j += 1;
            }
            out.push(quote);
            if j < bytes.len() {
                j += 1;
            }
        } else if j < bytes.len() && bytes[j] == b'[' {
            // Already-redacted `[REDACTED]`: consume through `]` so a second
            // pass is a no-op (idempotency).
            while j < bytes.len() && bytes[j] != b']' {
                j += 1;
            }
            if j < bytes.len() {
                j += 1; // consume `]`
            }
        } else {
            while j < bytes.len()
                && !matches!(
                    bytes[j],
                    b' ' | b'\t' | b'\n' | b'\r' | b',' | b'}' | b']' | b';' | b'"' | b'\''
                )
            {
                j += 1;
            }
        }
        i = j;
    }
    (String::from_utf8_lossy(&out).into_owned(), count)
}

/// Redact every secret-looking value in free text.
///
/// Handles `key=value`, `key: value`, JSON `"key": "value"`, and
/// `Bearer <token>` shapes, case-insensitively. Idempotent: applying it to
/// already-redacted text changes nothing.
pub fn redact_text(input: &str) -> String {
    let mut current = input.to_owned();
    // Longest markers first so `refresh_token` wins over `token` (same masking
    // result, but keeps byte ranges stable and the pass count meaningful).
    let mut markers: Vec<&str> = SECRET_MARKERS.to_vec();
    markers.sort_by_key(|m| std::cmp::Reverse(m.len()));
    for marker in markers {
        let (next, _) = mask_marker(&current, marker);
        current = next;
    }
    current
}

/// File name for today's log: `{prefix}.YYYY-MM-DD.log`.
pub fn log_path_for_today(dir: &Path, prefix: &str, days_since_epoch: u64) -> PathBuf {
    // Gregorian civil-date from days-since-epoch (Howard Hinnant's algorithm).
    let z = days_since_epoch as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as i64;
    y += i64::from(m <= 2);
    dir.join(format!("{prefix}.{y:04}-{m:02}-{d:02}.log"))
}

/// Today's log path for `dir`/`prefix` using the system clock.
pub fn today_log_path(dir: &Path, prefix: &str) -> PathBuf {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0);
    log_path_for_today(dir, prefix, days)
}

struct SharedLog {
    dir: PathBuf,
    prefix: String,
    file: File,
    bytes_written: u64,
}

impl SharedLog {
    fn open(dir: &Path, prefix: &str) -> Result<Self, LoggingError> {
        fs::create_dir_all(dir).map_err(|e| LoggingError::Directory(dir.to_owned(), e))?;
        let mut path = today_log_path(dir, prefix);
        let mut bytes_written = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        // Size-based roll: if today's file is already over budget, move to a
        // numbered sibling (`....log.1`, `.2`, ...) and start fresh.
        if bytes_written >= MAX_LOG_BYTES {
            let mut n = 1u32;
            loop {
                let sibling = path.with_extension(format!("log.{n}"));
                let size = fs::metadata(&sibling).map(|m| m.len()).unwrap_or(0);
                if size < MAX_LOG_BYTES {
                    path = sibling;
                    bytes_written = size;
                    break;
                }
                n += 1;
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| LoggingError::File(path.clone(), e))?;
        Ok(Self {
            dir: dir.to_owned(),
            prefix: prefix.to_owned(),
            file,
            bytes_written,
        })
    }

    fn write_redacted(&mut self, buf: &[u8]) -> io::Result<usize> {
        let redacted = redact_text(&String::from_utf8_lossy(buf));
        let bytes = redacted.as_bytes();
        if self.bytes_written + bytes.len() as u64 > MAX_LOG_BYTES {
            // Roll mid-stream: rename current file aside, open a fresh one.
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let done = today_log_path(&self.dir, &self.prefix);
            let sibling = done.with_extension(format!("log.{stamp}"));
            let _ = fs::rename(&done, &sibling);
            self.file = OpenOptions::new().create(true).append(true).open(&done)?;
            self.bytes_written = 0;
        }
        self.file.write_all(bytes)?;
        self.bytes_written += bytes.len() as u64;
        Ok(buf.len())
    }
}

/// Writer factory handed to `tracing_subscriber::fmt`.
#[derive(Clone)]
pub struct RedactingFileWriter {
    shared: Arc<Mutex<SharedLog>>,
}

impl RedactingFileWriter {
    pub fn open(dir: &Path, prefix: &str) -> Result<Self, LoggingError> {
        Ok(Self {
            shared: Arc::new(Mutex::new(SharedLog::open(dir, prefix)?)),
        })
    }
}

impl<'a> MakeWriter<'a> for RedactingFileWriter {
    type Writer = RedactingSink;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingSink {
            shared: self.shared.clone(),
        }
    }
}

/// A `tracing` writer that redacts secret material before touching disk.
pub struct RedactingSink {
    shared: Arc<Mutex<SharedLog>>,
}

impl Write for RedactingSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.shared
            .lock()
            .map_err(|_| io::Error::other("log writer lock poisoned"))?
            .write_redacted(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.shared
            .lock()
            .map_err(|_| io::Error::other("log writer lock poisoned"))?
            .file
            .flush()
    }
}

/// Guard keeping the `tracing` dispatcher alive; uninstalls on drop.
pub struct LoggingGuard {
    _dispatch: tracing::dispatcher::Dispatch,
    _default: tracing::dispatcher::DefaultGuard,
    _writer: RedactingFileWriter,
}

impl Drop for LoggingGuard {
    fn drop(&mut self) {
        LOGGING_INITIALISED.with(|flag| flag.set(false));
    }
}

/// Install a JSON `tracing` subscriber writing redacted events to a daily
/// rolling file under `dir` (`{prefix}.YYYY-MM-DD.log`).
///
/// One guard per thread: calling it twice on the same thread returns
/// [`LoggingError::AlreadyInitialised`] instead of stacking subscribers.
pub fn init_logging(dir: &Path, prefix: &str) -> Result<LoggingGuard, LoggingError> {
    if LOGGING_INITIALISED.with(|flag| flag.get()) {
        return Err(LoggingError::AlreadyInitialised);
    }
    let writer = RedactingFileWriter::open(dir, prefix)?;
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_ansi(false)
        .with_writer(writer.clone())
        .finish();
    let dispatch = tracing::dispatcher::Dispatch::new(subscriber);
    let default = tracing::dispatcher::set_default(&dispatch);
    LOGGING_INITIALISED.with(|flag| flag.set(true));
    Ok(LoggingGuard {
        _dispatch: dispatch,
        _default: default,
        _writer: writer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keys_detected_case_insensitively() {
        assert!(is_secret_key("api_key"));
        assert!(is_secret_key("X-Api-Key"));
        assert!(is_secret_key("Authorization"));
        assert!(is_secret_key("db_PASSWORD"));
        assert!(!is_secret_key("appearance.theme"));
        assert!(!is_secret_key("tokenizer"));
    }

    #[test]
    fn redact_pair_masks_only_secrets() {
        assert_eq!(redact_pair("api_key", "hunter2"), REDACTED);
        assert_eq!(redact_pair("appearance.theme", "dark"), "dark");
    }

    #[test]
    fn redact_text_masks_common_shapes() {
        let cases = [
            ("api_key=hunter2", "api_key=[REDACTED]"),
            ("password: hunter2", "password:[REDACTED]"),
            (
                r#""refresh_token": "abc123""#,
                r#""refresh_token": "[REDACTED]""#,
            ),
            ("Authorization: Bearer abc123", "Authorization: [REDACTED]"),
        ];
        for (input, _) in &cases {
            let out = redact_text(input);
            assert!(
                !out.contains("hunter2") && !out.contains("abc123"),
                "secret leaked for {input:?}: {out:?}"
            );
            assert!(out.contains(REDACTED), "no redaction for {input:?}");
        }
    }

    #[test]
    fn redact_text_leaves_benign_text_alone() {
        let benign = r#"{"theme": "dark", "width": 280}"#;
        assert_eq!(redact_text(benign), benign);
        // Idempotent.
        let once = redact_text("token=abc");
        assert_eq!(redact_text(&once), once);
    }

    #[test]
    fn secrets_never_reach_the_log_file() {
        let dir = std::env::temp_dir().join(format!(
            "astra-log-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _guard = init_logging(&dir, "astra").unwrap();
        let secret = "hunter2-super-secret-value";
        tracing::info!(api_key = secret, theme = "dark", "settings applied");
        tracing::info!("raw message with password={secret}");
        drop(_guard);

        let path = today_log_path(&dir, "astra");
        let content = fs::read_to_string(&path).unwrap();
        assert!(
            !content.contains(secret),
            "secret material reached the log file: {content:?}"
        );
        assert!(content.contains(REDACTED), "expected redaction marker");
        assert!(content.contains("dark"), "benign fields must survive");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_path_rolls_daily() {
        // 2026-01-01 is day 20454 since the epoch.
        let path = log_path_for_today(Path::new("/tmp"), "astra", 20_454);
        assert_eq!(path, PathBuf::from("/tmp/astra.2026-01-01.log"));
        assert_ne!(
            log_path_for_today(Path::new("/tmp"), "astra", 20_454),
            log_path_for_today(Path::new("/tmp"), "astra", 20_455)
        );
    }
}

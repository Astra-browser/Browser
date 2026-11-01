/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Local-only diagnostics bundle: version, build, log tail, and a database
//! integrity check.
//!
//! This module performs **zero network I/O**: it only reads local files and
//! inspects a local database header. A unit test below asserts that no
//! socket/HTTP client tokens appear in this source file.

use crate::logging::{redact_text, today_log_path};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Magic bytes at the start of every SQLite database file.
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";

/// Result of the local database integrity check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DbIntegrity {
    /// No database path was configured.
    NotConfigured,
    /// Header magic present and file non-empty.
    Healthy { path: PathBuf },
    /// File missing, unreadable, or with an unexpected header.
    Corrupt { path: PathBuf, reason: String },
}

/// A self-contained, local-only diagnostics snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsBundle {
    pub version: String,
    pub build: String,
    pub generated_at_unix_secs: u64,
    pub log_tail: Vec<String>,
    pub db: DbIntegrity,
}

/// Check a database file purely by local inspection (header magic + size).
///
/// No database engine is opened and no I/O leaves the machine.
pub fn check_db_integrity(db_path: Option<&Path>) -> DbIntegrity {
    let path = match db_path {
        Some(p) => p.to_owned(),
        None => return DbIntegrity::NotConfigured,
    };
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            return DbIntegrity::Corrupt {
                path,
                reason: format!("unreadable: {e}"),
            };
        }
    };
    if bytes.len() < SQLITE_MAGIC.len() {
        return DbIntegrity::Corrupt {
            path,
            reason: "file too small to be a database".to_owned(),
        };
    }
    if &bytes[..SQLITE_MAGIC.len()] != SQLITE_MAGIC {
        return DbIntegrity::Corrupt {
            path,
            reason: "unrecognised file header".to_owned(),
        };
    }
    DbIntegrity::Healthy { path }
}

/// Read the last `max_lines` of today's log file, redacted.
///
/// Missing log directories or files yield an empty tail, never an error.
pub fn log_tail(log_dir: &Path, log_prefix: &str, max_lines: usize) -> Vec<String> {
    let path = today_log_path(log_dir, log_prefix);
    let content = fs::read_to_string(&path).unwrap_or_default();
    content
        .lines()
        .rev()
        .take(max_lines)
        .map(redact_text)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// Collect a diagnostics bundle from local sources only.
///
/// `db_path` may be `None` when no database is configured.
pub fn collect(
    version: &str,
    build: &str,
    log_dir: &Path,
    log_prefix: &str,
    tail_lines: usize,
    db_path: Option<&Path>,
) -> DiagnosticsBundle {
    DiagnosticsBundle {
        version: version.to_owned(),
        build: build.to_owned(),
        generated_at_unix_secs: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        log_tail: log_tail(log_dir, log_prefix, tail_lines),
        db: check_db_integrity(db_path),
    }
}

impl DiagnosticsBundle {
    /// Serialise the bundle, with a final redaction pass so secret material
    /// can never leak through the export even if a log line evaded the tail
    /// filter.
    pub fn to_redacted_json(&self) -> String {
        let json = serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_owned());
        redact_text(&json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "astra-diag-{tag}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn bundle_carries_version_build_and_db_state() {
        let bundle = collect(
            "1.2.3",
            "test-build",
            Path::new("/nonexistent"),
            "astra",
            10,
            None,
        );
        assert_eq!(bundle.version, "1.2.3");
        assert_eq!(bundle.build, "test-build");
        assert!(bundle.generated_at_unix_secs > 0);
        assert!(bundle.log_tail.is_empty());
        assert_eq!(bundle.db, DbIntegrity::NotConfigured);
        let json = bundle.to_redacted_json();
        assert!(json.contains("1.2.3"));
    }

    #[test]
    fn db_integrity_accepts_sqlite_header_rejects_junk() {
        let dir = unique_dir("db");
        fs::create_dir_all(&dir).unwrap();

        let good = dir.join("good.db");
        let mut header = SQLITE_MAGIC.to_vec();
        header.extend_from_slice(&[0u8; 100]);
        fs::write(&good, &header).unwrap();
        assert_eq!(
            check_db_integrity(Some(&good)),
            DbIntegrity::Healthy { path: good.clone() }
        );

        let junk = dir.join("junk.db");
        fs::write(&junk, b"definitely not a database file.........").unwrap();
        assert!(matches!(
            check_db_integrity(Some(&junk)),
            DbIntegrity::Corrupt { .. }
        ));

        let empty = dir.join("empty.db");
        fs::write(&empty, b"").unwrap();
        assert!(matches!(
            check_db_integrity(Some(&empty)),
            DbIntegrity::Corrupt { .. }
        ));

        assert!(matches!(
            check_db_integrity(Some(&dir.join("missing.db"))),
            DbIntegrity::Corrupt { .. }
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_log_tail_and_json_contain_no_secret_material() {
        let dir = unique_dir("tail");
        fs::create_dir_all(&dir).unwrap();
        let secret = "hunter2-bundle-secret";
        let path = today_log_path(&dir, "astra");
        fs::write(
            &path,
            format!(
                "{{\"msg\":\"boot\",\"theme\":\"dark\"}}\n{{\"msg\":\"login\",\"api_key\":\"{secret}\"}}\n"
            ),
        )
        .unwrap();

        let bundle = collect("0.1.0", "test", &dir, "astra", 50, None);
        assert_eq!(bundle.log_tail.len(), 2);
        for line in &bundle.log_tail {
            assert!(
                !line.contains(secret),
                "secret leaked into log tail: {line:?}"
            );
        }
        assert!(
            bundle.log_tail.iter().any(|l| l.contains("dark")),
            "benign log content must survive"
        );

        let json = bundle.to_redacted_json();
        assert!(!json.contains(secret), "secret leaked into bundle JSON");
        assert!(json.contains("0.1.0"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn diagnostics_performs_zero_network_io() {
        // Tokens are assembled from parts so this very assertion cannot
        // trip itself by containing the forbidden literals verbatim.
        let banned: &[String] = &[
            ["Tcp", "Stream"].concat(),
            ["Udp", "Socket"].concat(),
            ["Tcp", "Listener"].concat(),
            ["Socket", "Addr"].concat(),
            ["req", "west"].concat(),
            ["hy", "per"].concat(),
            ["Http", "Client"].concat(),
            ["connect", "("].concat(),
            ["fetch", "("].concat(),
        ];
        let source = include_str!("diagnostics.rs");
        for token in banned {
            assert!(
                !source.contains(token.as_str()),
                "network token {token:?} found in diagnostics module"
            );
        }
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Append-only, tamper-evident audit log (P6-T04).
//!
//! Every approval checkpoint and every injection denial appends one
//! [`AuditRecord`] to an [`AuditLog`]. Each record chains the SHA-256 hash
//! of its predecessor, so deleting or editing a line breaks [`AuditLog::verify`].
//! [`AuditLog::write_jsonl`] / [`read_jsonl`] persist the chain as one JSON
//! object per line; the `astra-store` `approvals_audit` table owns durable
//! rows, this module owns the portable chain format.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Audit-record format version. Bump on any breaking shape change and keep
/// [`AuditError::VersionMismatch`] so old logs fail loudly.
pub const AUDIT_VERSION: u32 = 1;

/// Hash recorded by the genesis record (no predecessor to chain).
pub const GENESIS_PREV_HASH: &str = "GENESIS";

/// What happened, as one audit event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventKind {
    /// An approval checkpoint was created (ask-the-user).
    ApprovalRequested,
    /// A checkpoint was resolved to allow / allow-always / deny.
    ApprovalDecided,
    /// Injected instruction denied with no approval event.
    InjectionBlocked,
}

/// One auditable occurrence: its kind plus the run/request/action it
/// belongs to and a short human-readable detail. Secrets must never reach
/// `detail` (trust rule §9.2: no credentials, page text, or HTML).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEvent {
    pub kind: AuditEventKind,
    pub run_id: String,
    pub request_id: String,
    pub action: String,
    #[serde(default)]
    pub detail: String,
}

impl AuditEvent {
    /// New event. `detail` must be a short label, never page or tool text.
    pub fn new(
        kind: AuditEventKind,
        run_id: impl Into<String>,
        request_id: impl Into<String>,
        action: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            run_id: run_id.into(),
            request_id: request_id.into(),
            action: action.into(),
            detail: detail.into(),
        }
    }
}

/// One hash-chained line: `hash = sha256(version || seq || prev_hash ||
/// event_json)`, hex-encoded. Recomputing the chain detects any edit,
/// deletion, or reorder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditRecord {
    pub version: u32,
    pub seq: u64,
    pub prev_hash: String,
    pub event_json: String,
    pub hash: String,
}

impl AuditRecord {
    /// Serialize to the one JSON object stored per JSONL line.
    pub fn to_json(&self) -> Result<String, AuditError> {
        serde_json::to_string(self).map_err(|e| AuditError::Json(e.to_string()))
    }

    /// Parse + version-check. Chain linkage is checked by
    /// [`AuditLog::verify`], not here.
    pub fn from_json(json: &str) -> Result<Self, AuditError> {
        let record: Self =
            serde_json::from_str(json).map_err(|e| AuditError::Json(e.to_string()))?;
        if record.version != AUDIT_VERSION {
            return Err(AuditError::VersionMismatch(record.version, AUDIT_VERSION));
        }
        Ok(record)
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum AuditError {
    #[error("unsupported audit version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid audit record: {0}")]
    Invalid(String),
    #[error("audit JSON error: {0}")]
    Json(String),
    #[error("audit I/O error: {0}")]
    Io(String),
    #[error("audit chain broken at seq {seq}: {reason}")]
    ChainBroken { seq: u64, reason: String },
}

/// In-memory append-only audit log.
#[derive(Clone, Debug, Default)]
pub struct AuditLog {
    records: Vec<AuditRecord>,
}

impl AuditLog {
    /// Empty log.
    pub fn new() -> Self {
        Self {
            records: Vec::new(),
        }
    }

    /// Append one event, chaining the previous record's hash. Returns the
    /// stored record.
    pub fn append(&mut self, event: &AuditEvent) -> Result<AuditRecord, AuditError> {
        let event_json =
            serde_json::to_string(event).map_err(|e| AuditError::Json(e.to_string()))?;
        let seq = self.records.len() as u64;
        let prev_hash = self
            .records
            .last()
            .map(|r| r.hash.clone())
            .unwrap_or_else(|| GENESIS_PREV_HASH.to_owned());
        let hash = record_hash(seq, &prev_hash, &event_json);
        let record = AuditRecord {
            version: AUDIT_VERSION,
            seq,
            prev_hash,
            event_json,
            hash,
        };
        self.records.push(record.clone());
        Ok(record)
    }

    /// All records in sequence order.
    pub fn records(&self) -> &[AuditRecord] {
        &self.records
    }

    /// Number of records appended.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// True when nothing has been appended.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Recompute the whole chain: contiguous `seq` from zero, each
    /// `prev_hash` equal to the previous `hash`, each `hash` matching a
    /// recomputation. Any edit, deletion, or reorder fails loudly.
    pub fn verify(&self) -> Result<(), AuditError> {
        verify_records(&self.records)
    }

    /// Persist as JSONL: one [`AuditRecord`] object per line.
    pub fn write_jsonl(&self, path: &std::path::Path) -> Result<(), AuditError> {
        let mut file = std::fs::File::create(path).map_err(|e| AuditError::Io(e.to_string()))?;
        for record in &self.records {
            writeln!(file, "{}", record.to_json()?).map_err(|e| AuditError::Io(e.to_string()))?;
        }
        Ok(())
    }
}

/// Load a JSONL log written by [`AuditLog::write_jsonl`] and verify its
/// chain before returning it. An unverifiable file is an error, never a
/// best-effort load.
pub fn read_jsonl(path: &std::path::Path) -> Result<AuditLog, AuditError> {
    let file = std::fs::File::open(path).map_err(|e| AuditError::Io(e.to_string()))?;
    let reader = std::io::BufReader::new(file);
    let mut records = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| AuditError::Io(e.to_string()))?;
        if line.trim().is_empty() {
            continue;
        }
        let record = AuditRecord::from_json(&line).map_err(|e| match e {
            AuditError::VersionMismatch(got, want) => AuditError::VersionMismatch(got, want),
            other => AuditError::Invalid(format!("line {}: {other}", index + 1)),
        })?;
        records.push(record);
    }
    verify_records(&records)?;
    Ok(AuditLog { records })
}

fn record_hash(seq: u64, prev_hash: &str, event_json: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(AUDIT_VERSION.to_le_bytes());
    hasher.update(seq.to_le_bytes());
    hasher.update(prev_hash.as_bytes());
    hasher.update(event_json.as_bytes());
    hex_encode(&hasher.finalize())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0xf) as usize] as char);
    }
    out
}

fn verify_records(records: &[AuditRecord]) -> Result<(), AuditError> {
    let mut prev_hash = GENESIS_PREV_HASH.to_owned();
    for (index, record) in records.iter().enumerate() {
        let expected_seq = index as u64;
        if record.version != AUDIT_VERSION {
            return Err(AuditError::VersionMismatch(record.version, AUDIT_VERSION));
        }
        if record.seq != expected_seq {
            return Err(AuditError::ChainBroken {
                seq: record.seq,
                reason: format!("expected seq {expected_seq}"),
            });
        }
        if record.prev_hash != prev_hash {
            return Err(AuditError::ChainBroken {
                seq: record.seq,
                reason: "prev_hash does not match previous record".to_owned(),
            });
        }
        let recomputed = record_hash(record.seq, &record.prev_hash, &record.event_json);
        if recomputed != record.hash {
            return Err(AuditError::ChainBroken {
                seq: record.seq,
                reason: "hash does not match recomputed chain hash".to_owned(),
            });
        }
        prev_hash = record.hash.clone();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, kind: AuditEventKind) -> AuditEvent {
        AuditEvent::new(
            kind,
            "run-1",
            format!("req-{seq}"),
            "tab_close",
            format!("checkpoint {seq}"),
        )
    }

    #[test]
    fn append_chains_hashes_and_verifies() {
        let mut log = AuditLog::new();
        assert!(log.is_empty());
        let first = log
            .append(&event(0, AuditEventKind::ApprovalRequested))
            .unwrap();
        assert_eq!(first.seq, 0);
        assert_eq!(first.prev_hash, GENESIS_PREV_HASH);
        let second = log
            .append(&event(1, AuditEventKind::ApprovalDecided))
            .unwrap();
        assert_eq!(second.seq, 1);
        assert_eq!(second.prev_hash, first.hash);
        assert_ne!(first.hash, second.hash);
        assert_eq!(log.len(), 2);
        assert!(log.verify().is_ok());
    }

    #[test]
    fn tampered_event_breaks_verification() {
        let mut log = AuditLog::new();
        log.append(&event(0, AuditEventKind::ApprovalRequested))
            .unwrap();
        log.append(&event(1, AuditEventKind::ApprovalDecided))
            .unwrap();
        log.append(&event(2, AuditEventKind::InjectionBlocked))
            .unwrap();

        // Edit a middle record's payload: hash no longer matches.
        let mut tampered = log.clone();
        tampered.records[1].event_json = tampered.records[1]
            .event_json
            .replace("tab_close", "password_export");
        assert!(matches!(
            tampered.verify(),
            Err(AuditError::ChainBroken { .. })
        ));

        // Drop a record: seq contiguity breaks.
        let mut dropped = log.clone();
        dropped.records.remove(1);
        assert!(dropped.verify().is_err());

        // Reorder records: prev_hash linkage breaks.
        let mut reordered = log.clone();
        reordered.records.swap(0, 1);
        assert!(reordered.verify().is_err());

        // Untouched log still verifies.
        assert!(log.verify().is_ok());
    }

    #[test]
    fn jsonl_writer_round_trip_and_tamper_detection() {
        let dir = std::env::temp_dir().join("astra-audit-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("audit.jsonl");

        let mut log = AuditLog::new();
        log.append(&event(0, AuditEventKind::ApprovalRequested))
            .unwrap();
        log.append(&event(1, AuditEventKind::ApprovalDecided))
            .unwrap();
        log.append(&event(2, AuditEventKind::InjectionBlocked))
            .unwrap();
        log.write_jsonl(&path).unwrap();

        // One JSON object per line.
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 3);

        let loaded = read_jsonl(&path).unwrap();
        assert_eq!(loaded.len(), 3);
        assert!(loaded.verify().is_ok());
        assert_eq!(loaded.records()[2].event_json, log.records()[2].event_json);

        // Tamper with the file on disk: load must fail, never half-load.
        let tampered = text.replace("tab_close", "password_export");
        std::fs::write(&path, tampered).unwrap();
        assert!(read_jsonl(&path).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_version_mismatch_fails_loudly() {
        let mut log = AuditLog::new();
        log.append(&event(0, AuditEventKind::ApprovalRequested))
            .unwrap();
        let mut bad = log.records()[0].clone();
        bad.version = 999;
        assert!(matches!(
            AuditRecord::from_json(&bad.to_json().unwrap()),
            Err(AuditError::VersionMismatch(999, AUDIT_VERSION))
        ));
        assert!(matches!(
            AuditRecord::from_json("{not json"),
            Err(AuditError::Json(_))
        ));
    }
}

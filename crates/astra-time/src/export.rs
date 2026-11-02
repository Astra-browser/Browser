/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Time export/import: sessions plus focus rules as versioned JSON (P5-T05).
//!
//! [`TimeService`] writes through `astra-store` with every path gated on
//! the [`PrivateScope`][astra_core::private::PrivateScope]; the free
//! [`export_time_json`] / [`import_time_json`] functions below are the
//! ungated bulk path, and the [`TimeService`] wrappers apply the same
//! `"time"` gate as every other write (private scope yields `None` without
//! touching the store, mirroring [`TimeService::total_for_host`]).
//!
//! Versioning mirrors the `astra-core` session/layout precedent: the bundle
//! carries `schema_version` ([`astra_store::SCHEMA_VERSION`]) and imports
//! reject anything else with [`ExportError::VersionMismatch`].

use serde::{Deserialize, Serialize};

/// Export format version. Tied to the store schema so a database migration
/// and an export payload can never disagree silently.
pub use astra_store::SCHEMA_VERSION as TIME_EXPORT_VERSION;

/// One time session in an export bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeSessionExport {
    pub uuid: String,
    pub url: String,
    pub host: String,
    pub title: String,
    pub started_at: i64,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub duration_secs: i64,
}

/// One focus rule in an export bundle.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusRuleExport {
    pub uuid: String,
    pub host: String,
    pub mode: String,
}

/// Versioned JSON bundle: every live session plus every live focus rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeBundle {
    pub schema_version: u32,
    pub sessions: Vec<TimeSessionExport>,
    pub focus_rules: Vec<FocusRuleExport>,
}

/// Counts from an import, for tests and progress UI.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TimeImportReport {
    pub sessions: usize,
    pub focus_rules: usize,
}

/// Errors from the time export/import path.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ExportError {
    /// The store failed under an export/import.
    #[error("store error: {0}")]
    Store(String),
    /// The payload is not valid JSON or has the wrong shape.
    #[error("time JSON error: {0}")]
    Json(String),
    /// The payload names an unsupported `schema_version`.
    #[error("unsupported time export version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    /// A row in the payload is invalid.
    #[error("invalid time export: {0}")]
    Invalid(String),
}

impl From<astra_store::StoreError> for ExportError {
    fn from(e: astra_store::StoreError) -> Self {
        ExportError::Store(e.to_string())
    }
}

/// Capture every live session and focus rule (oldest first, by host).
pub fn export_time_bundle(store: &astra_store::Store) -> Result<TimeBundle, ExportError> {
    let sessions = store
        .time_session_list()?
        .into_iter()
        .map(|row| TimeSessionExport {
            uuid: row.uuid,
            url: row.url,
            host: row.host,
            title: row.title,
            started_at: row.started_at,
            ended_at: row.ended_at,
            duration_secs: row.duration_secs,
        })
        .collect();
    let focus_rules = store
        .focus_rule_list()?
        .into_iter()
        .map(|row| FocusRuleExport {
            uuid: row.uuid,
            host: row.host,
            mode: row.mode,
        })
        .collect();
    Ok(TimeBundle {
        schema_version: astra_store::SCHEMA_VERSION,
        sessions,
        focus_rules,
    })
}

/// Serialise [`export_time_bundle`] to pretty JSON.
pub fn export_time_json(store: &astra_store::Store) -> Result<String, ExportError> {
    let bundle = export_time_bundle(store)?;
    serde_json::to_string_pretty(&bundle).map_err(|e| ExportError::Json(e.to_string()))
}

/// Parse a JSON bundle (see [`import_time_bundle`]).
pub fn import_time_json(
    store: &astra_store::Store,
    json: &str,
) -> Result<TimeImportReport, ExportError> {
    let bundle: TimeBundle =
        serde_json::from_str(json).map_err(|e| ExportError::Json(e.to_string()))?;
    import_time_bundle(store, &bundle)
}

/// Merge a bundle: version-checked, sessions upserted by UUID, focus rules
/// upserted by host (their natural key). Unknown hosts are rejected —
/// sessions are always recorded with a canonical host.
pub fn import_time_bundle(
    store: &astra_store::Store,
    bundle: &TimeBundle,
) -> Result<TimeImportReport, ExportError> {
    if bundle.schema_version != astra_store::SCHEMA_VERSION {
        return Err(ExportError::VersionMismatch(
            bundle.schema_version,
            astra_store::SCHEMA_VERSION,
        ));
    }
    for session in &bundle.sessions {
        if session.host.is_empty() {
            return Err(ExportError::Invalid(
                "session host must not be empty".to_owned(),
            ));
        }
        store.time_session_upsert(
            &session.uuid,
            &session.url,
            &session.host,
            &session.title,
            session.started_at,
            session.ended_at,
            session.duration_secs,
        )?;
    }
    for rule in &bundle.focus_rules {
        if rule.host.is_empty() {
            return Err(ExportError::Invalid(
                "focus rule host must not be empty".to_owned(),
            ));
        }
        if rule.mode.is_empty() {
            return Err(ExportError::Invalid(
                "focus rule mode must not be empty".to_owned(),
            ));
        }
        store.focus_rule_upsert(&rule.uuid, &rule.host, &rule.mode)?;
    }
    Ok(TimeImportReport {
        sessions: bundle.sessions.len(),
        focus_rules: bundle.focus_rules.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::TimeService;
    use astra_core::private::PrivateScope;

    fn test_store() -> (tempfile::TempDir, astra_store::Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = astra_store::Store::open(dir.path().join("astra.db")).expect("open store");
        store.migrate().expect("migrate store");
        (dir, store)
    }

    fn seed(store: &astra_store::Store) {
        let public = TimeService::new(store, PrivateScope::public());
        let first = public
            .start_session("https://a.example/x", "X", 100)
            .expect("public scope writes")
            .expect("time_start");
        public
            .end_session(first.id, 160)
            .expect("public writes")
            .expect("time_end");
        public
            .start_session("https://b.example/y", "Y", 200)
            .expect("public scope writes")
            .expect("time_start");
        public
            .set_focus_rule("https://WWW.A.example:443/feed", "block")
            .expect("public scope writes")
            .expect("focus_rule_set");
    }

    #[test]
    fn json_round_trip_preserves_sessions_and_rules() {
        let (_dir, store) = test_store();
        seed(&store);
        let json = export_time_json(&store).unwrap();
        let bundle: TimeBundle = serde_json::from_str(&json).unwrap();
        assert_eq!(bundle.schema_version, astra_store::SCHEMA_VERSION);
        assert_eq!(bundle.sessions.len(), 2);
        assert_eq!(bundle.focus_rules.len(), 1);

        let (_dir2, fresh) = test_store();
        let report = import_time_json(&fresh, &json).unwrap();
        assert_eq!(
            report,
            TimeImportReport {
                sessions: 2,
                focus_rules: 1
            }
        );
        assert_eq!(export_time_bundle(&fresh).unwrap(), bundle);
        assert_eq!(fresh.time_for_host("a.example").unwrap(), 60);

        // Re-importing converges instead of duplicating.
        assert_eq!(import_time_json(&fresh, &json).unwrap(), report);
        assert_eq!(export_time_bundle(&fresh).unwrap(), bundle);
    }

    #[test]
    fn old_versions_and_bad_payloads_fail_loudly() {
        let (_dir, store) = test_store();
        seed(&store);
        let mut bundle = export_time_bundle(&store).unwrap();
        bundle.schema_version = astra_store::SCHEMA_VERSION - 1;
        assert!(matches!(
            import_time_bundle(&store, &bundle),
            Err(ExportError::VersionMismatch(_, _))
        ));
        let bad = serde_json::json!({
            "schema_version": astra_store::SCHEMA_VERSION + 99,
            "sessions": [],
            "focus_rules": [],
        })
        .to_string();
        assert!(matches!(
            import_time_json(&store, &bad),
            Err(ExportError::VersionMismatch(_, _))
        ));
        assert!(matches!(
            import_time_json(&store, "{not json"),
            Err(ExportError::Json(_))
        ));
        let empty_host = TimeBundle {
            schema_version: astra_store::SCHEMA_VERSION,
            sessions: vec![TimeSessionExport {
                uuid: "u".to_owned(),
                url: String::new(),
                host: String::new(),
                title: String::new(),
                started_at: 0,
                ended_at: None,
                duration_secs: 0,
            }],
            focus_rules: Vec::new(),
        };
        assert!(matches!(
            import_time_bundle(&store, &empty_host),
            Err(ExportError::Invalid(_))
        ));
    }

    #[test]
    fn service_wrappers_respect_private_scope() {
        let (_dir, store) = test_store();
        seed(&store);
        let public = TimeService::new(&store, PrivateScope::public());
        // Public scope exports the seeded data…
        let json = public.export_json().expect("public exports").expect("json");
        // …and imports it back.
        let report = public
            .import_json(&json)
            .expect("public imports")
            .expect("report");
        assert_eq!(report.sessions, 2);

        let private = TimeService::new(&store, PrivateScope::private());
        assert!(private.export_json().is_none());
        assert!(private.import_json(&json).is_none());
    }
}

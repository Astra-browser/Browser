/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Approval gate stubs (full engine in P6-T04).
//!
//! Side-effect actions need a user decision before they run: [`classify`]
//! maps a tool call to an [`ActionClass`], read-only calls proceed freely,
//! and everything else becomes an [`ApprovalRequest`] that resolves to an
//! [`ApprovalDecision`]. The decision is audit-logged (the `astra-store`
//! `approvals_audit` table owns the rows; this crate owns the shapes). The
//! prompt-injection suite — pages instructing the agent to exfiltrate data
//! or act — arrives with the engine in P6-T04.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Approval-request format version. Bump on any breaking shape change and
/// keep [`ApprovalError::VersionMismatch`] so old rows fail loudly.
pub const APPROVAL_VERSION: u32 = 1;

/// Side-effect class of one action. The rule is deliberately coarse in the
/// skeleton: only pure reads are free. P6-T04 refines the taxonomy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    /// Pure reads (page text, history search, memory recall): no approval.
    ReadOnly,
    /// State changes the user can undo (tabs, bookmarks, notes drafts).
    SideEffect,
    /// Hard-to-undo or outwardly visible acts (purchases, messages sent,
    /// credential use, data leaving the device): always ask.
    HighRisk,
}

/// User decision on one approval request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    /// Proceed exactly once.
    Allow,
    /// Proceed and remember for equivalent future actions (engine policy).
    AllowAlways,
    /// Refuse this action; the loop must plan around it.
    Deny,
}

impl ApprovalDecision {
    /// True for [`ApprovalDecision::Allow`] and
    /// [`ApprovalDecision::AllowAlways`].
    pub fn is_allowed(self) -> bool {
        matches!(self, Self::Allow | Self::AllowAlways)
    }
}

/// One ask-the-user checkpoint: versioned so the audit log can replay it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub version: u32,
    pub request_id: String,
    pub run_id: String,
    pub action: String,
    pub subject: String,
    pub class: ActionClass,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<ApprovalDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_by: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ApprovalError {
    #[error("unsupported approval version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid approval request: {0}")]
    Invalid(String),
    #[error("approval JSON error: {0}")]
    Json(String),
}

impl ApprovalRequest {
    /// New undecided request.
    pub fn new(
        request_id: impl Into<String>,
        run_id: impl Into<String>,
        action: impl Into<String>,
        subject: impl Into<String>,
        class: ActionClass,
    ) -> Self {
        Self {
            version: APPROVAL_VERSION,
            request_id: request_id.into(),
            run_id: run_id.into(),
            action: action.into(),
            subject: subject.into(),
            class,
            decision: None,
            decided_by: None,
        }
    }

    /// Record the user decision.
    pub fn decide(&mut self, decision: ApprovalDecision, decided_by: impl Into<String>) {
        self.decision = Some(decision);
        self.decided_by = Some(decided_by.into());
    }

    /// Serialize to the string stored in the `approvals_audit` row.
    pub fn to_json(&self) -> Result<String, ApprovalError> {
        serde_json::to_string(self).map_err(|e| ApprovalError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, ApprovalError> {
        let request: Self =
            serde_json::from_str(json).map_err(|e| ApprovalError::Json(e.to_string()))?;
        request.validate()?;
        Ok(request)
    }

    /// Structural validation: version, non-empty ids/action, decided
    /// requests name who decided.
    pub fn validate(&self) -> Result<(), ApprovalError> {
        if self.version != APPROVAL_VERSION {
            return Err(ApprovalError::VersionMismatch(
                self.version,
                APPROVAL_VERSION,
            ));
        }
        if self.request_id.is_empty() {
            return Err(ApprovalError::Invalid(
                "request_id must not be empty".to_owned(),
            ));
        }
        if self.run_id.is_empty() {
            return Err(ApprovalError::Invalid(
                "run_id must not be empty".to_owned(),
            ));
        }
        if self.action.is_empty() {
            return Err(ApprovalError::Invalid(
                "action must not be empty".to_owned(),
            ));
        }
        if self.decision.is_some() && self.decided_by.as_deref().unwrap_or("").is_empty() {
            return Err(ApprovalError::Invalid(
                "decided requests must name who decided".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Skeleton classifier: maps a tool name to its side-effect class.
///
/// Pure reads proceed freely; the small closed set of known mutating
/// browser/profile tools needs approval; anything unknown is
/// [`ActionClass::HighRisk`] (fail closed — the P6-T04 engine refines this
/// into per-tool policies plus the prompt-injection suite).
pub fn classify(tool: &str) -> ActionClass {
    match tool {
        "page_read" | "page_observe" | "history_search" | "memory_recall" | "skill_describe"
        | "model_complete" => ActionClass::ReadOnly,
        "tab_open" | "tab_close" | "bookmark_add" | "note_save" | "canvas_save"
        | "memory_remember" => ActionClass::SideEffect,
        _ => ActionClass::HighRisk,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_reads_are_free_and_unknown_is_high_risk() {
        assert_eq!(classify("page_read"), ActionClass::ReadOnly);
        assert_eq!(classify("history_search"), ActionClass::ReadOnly);
        assert_eq!(classify("memory_recall"), ActionClass::ReadOnly);
        assert_eq!(classify("tab_open"), ActionClass::SideEffect);
        assert_eq!(classify("note_save"), ActionClass::SideEffect);
        // Fail closed: unknown and outwardly-visible tools ask.
        assert_eq!(classify("password_export"), ActionClass::HighRisk);
        assert_eq!(classify("something_new"), ActionClass::HighRisk);
    }

    #[test]
    fn approval_request_json_round_trip() {
        let mut request = ApprovalRequest::new(
            "req-1",
            "run-1",
            "tab_close",
            "https://a.example/",
            ActionClass::SideEffect,
        );
        assert!(request.validate().is_ok());
        request.decide(ApprovalDecision::Allow, "user");
        assert!(request.decision.unwrap().is_allowed());
        let parsed = ApprovalRequest::from_json(&request.to_json().unwrap()).unwrap();
        assert_eq!(parsed, request);
        assert!(!ApprovalDecision::Deny.is_allowed());
    }

    #[test]
    fn approval_version_mismatch_fails_loudly() {
        let mut request =
            ApprovalRequest::new("r", "run", "tab_open", "x", ActionClass::SideEffect);
        request.version = 999;
        assert_eq!(
            request.validate(),
            Err(ApprovalError::VersionMismatch(999, APPROVAL_VERSION))
        );
        assert!(ApprovalRequest::from_json(&request.to_json().unwrap()).is_err());
        assert!(matches!(
            ApprovalRequest::from_json("{not json"),
            Err(ApprovalError::Json(_))
        ));

        let mut bad = ApprovalRequest::new("r", "run", "tab_open", "x", ActionClass::SideEffect);
        bad.decide(ApprovalDecision::Deny, "");
        assert!(bad.validate().is_err());
    }
}

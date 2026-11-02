/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Agent run loop: goal → planned steps → tool calls → terminal state.
//!
//! [`AgentRun`] is the versioned, serializable run record (persisted in the
//! `astra-store` `agent_runs` table; this crate serializes, the store
//! persists — no dependency either way). [`AgentLoop`] is the loop skeleton:
//! it owns the run record, the [`crate::steps::StepStream`], and the budget,
//! and advances one [`LoopOutcome`] at a time. Providers, tools, and the
//! approval gate plug in as traits so P6-T02/T03/T04 can fill them without
//! rewriting the loop.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::steps::{StepEvent, StepStream};

/// Run-record format version. Bump on any breaking shape change and keep
/// [`RunError::VersionMismatch`] so old rows fail loudly, never silently.
pub const RUN_RECORD_VERSION: u32 = 1;

/// Maximum goal text length accepted by [`AgentRun::validate`].
pub const MAX_GOAL_CHARS: usize = 4_000;

/// Maximum steps per run (loop budget). The loop stops with
/// [`LoopOutcome::BudgetExhausted`] instead of running forever.
pub const MAX_STEPS_PER_RUN: u64 = 100;

/// Lifecycle state of one agent run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    /// Created, not yet started.
    Pending,
    /// Actively stepping.
    Running,
    /// Waiting on a user approval (see [`crate::approvals`]).
    AwaitingApproval,
    /// Finished successfully with a summary.
    Succeeded,
    /// Stopped by user cancel or budget exhaustion.
    Cancelled,
    /// Failed with an error description.
    Failed,
}

/// Versioned agent run record. Helpers (P6-T05) are runs whose
/// `parent_run_id` points at the spawning run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRun {
    pub version: u32,
    pub run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    pub goal: String,
    pub status: RunStatus,
    #[serde(default)]
    pub model: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum RunError {
    #[error("unsupported run record version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid run record: {0}")]
    Invalid(String),
    #[error("run JSON error: {0}")]
    Json(String),
    #[error("step stream error: {0}")]
    Steps(String),
    #[error("budget exhausted: run exceeded {0} steps")]
    BudgetExhausted(u64),
}

impl AgentRun {
    /// New pending run.
    pub fn new(run_id: impl Into<String>, goal: impl Into<String>, created_at: i64) -> Self {
        Self {
            version: RUN_RECORD_VERSION,
            run_id: run_id.into(),
            parent_run_id: None,
            goal: goal.into(),
            status: RunStatus::Pending,
            model: String::new(),
            created_at,
            ended_at: None,
            summary: None,
        }
    }

    /// New helper run linked to its spawning run (P6-T05).
    pub fn new_helper(
        run_id: impl Into<String>,
        parent_run_id: impl Into<String>,
        goal: impl Into<String>,
        created_at: i64,
    ) -> Self {
        let mut run = Self::new(run_id, goal, created_at);
        run.parent_run_id = Some(parent_run_id.into());
        run
    }

    /// Serialize to the string stored in the `agent_runs` row.
    pub fn to_json(&self) -> Result<String, RunError> {
        serde_json::to_string(self).map_err(|e| RunError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, RunError> {
        let run: Self = serde_json::from_str(json).map_err(|e| RunError::Json(e.to_string()))?;
        run.validate()?;
        Ok(run)
    }

    /// Structural validation: version, non-empty ids/goal, goal length,
    /// terminal states carry `ended_at`.
    pub fn validate(&self) -> Result<(), RunError> {
        if self.version != RUN_RECORD_VERSION {
            return Err(RunError::VersionMismatch(self.version, RUN_RECORD_VERSION));
        }
        if self.run_id.is_empty() {
            return Err(RunError::Invalid("run_id must not be empty".to_owned()));
        }
        let goal_chars = self.goal.chars().count();
        if self.goal.trim().is_empty() {
            return Err(RunError::Invalid("goal must not be empty".to_owned()));
        }
        if goal_chars > MAX_GOAL_CHARS {
            return Err(RunError::Invalid(format!(
                "goal exceeds {MAX_GOAL_CHARS} chars"
            )));
        }
        if let Some(parent) = &self.parent_run_id {
            if parent.is_empty() || parent == &self.run_id {
                return Err(RunError::Invalid(
                    "parent_run_id must name a different run".to_owned(),
                ));
            }
        }
        match self.status {
            RunStatus::Succeeded | RunStatus::Cancelled | RunStatus::Failed => {
                if self.ended_at.is_none() {
                    return Err(RunError::Invalid(
                        "terminal runs must carry ended_at".to_owned(),
                    ));
                }
            }
            RunStatus::Pending | RunStatus::Running | RunStatus::AwaitingApproval => {}
        }
        Ok(())
    }

    /// True once the run reached a terminal state.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            RunStatus::Succeeded | RunStatus::Cancelled | RunStatus::Failed
        )
    }
}

/// What one loop advance decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoopOutcome {
    /// A step was appended; the run continues.
    Stepped,
    /// The loop needs a user approval before continuing.
    NeedsApproval,
    /// Step budget exhausted; the run was marked cancelled.
    BudgetExhausted,
    /// The run reached a terminal state.
    Done,
}

/// Loop skeleton: owns the run record, the step stream, and the step
/// budget. Real planner/provider/tool wiring arrives in P6-T02/T03; until
/// then [`AgentLoop::advance`] records caller-supplied summaries (assigning
/// sequence numbers itself) so the state machine and budget accounting are
/// testable in isolation.
pub struct AgentLoop {
    run: AgentRun,
    steps: StepStream,
}

impl AgentLoop {
    /// Start a loop around a pending run. Returns an error when the run is
    /// already terminal.
    pub fn start(run: AgentRun) -> Result<Self, RunError> {
        run.validate()?;
        if run.is_terminal() {
            return Err(RunError::Invalid(
                "cannot start a loop around a terminal run".to_owned(),
            ));
        }
        Ok(Self {
            run,
            steps: StepStream::new(),
        })
    }

    /// Borrow the run record.
    pub fn run(&self) -> &AgentRun {
        &self.run
    }

    /// Borrow the step stream.
    pub fn steps(&self) -> &StepStream {
        &self.steps
    }

    /// Record one step and advance. The sequence number is assigned from
    /// the stream length, so callers cannot fork history with a wrong
    /// `seq`. Enforces [`MAX_STEPS_PER_RUN`]: the step that would exceed
    /// the budget is refused and the run is marked cancelled.
    pub fn advance(
        &mut self,
        kind: crate::steps::StepKind,
        summary: impl Into<String>,
    ) -> Result<LoopOutcome, RunError> {
        self.advance_event(StepEvent::new(self.steps.len() as u64, kind, summary))
    }

    /// Record one pre-built step event (e.g. carrying `detail`). The
    /// event's `seq` must continue the stream; gaps and replays are
    /// rejected so history can never silently fork.
    pub fn advance_event(&mut self, event: StepEvent) -> Result<LoopOutcome, RunError> {
        if self.run.is_terminal() {
            return Err(RunError::Invalid(
                "cannot advance a terminal run".to_owned(),
            ));
        }
        if self.steps.len() as u64 >= MAX_STEPS_PER_RUN {
            self.run.status = RunStatus::Cancelled;
            return Err(RunError::BudgetExhausted(MAX_STEPS_PER_RUN));
        }
        if self.run.status == RunStatus::Pending {
            self.run.status = RunStatus::Running;
        }
        self.steps
            .push(event)
            .map_err(|e| RunError::Steps(e.to_string()))?;
        if self.run.is_terminal() {
            Ok(LoopOutcome::Done)
        } else {
            Ok(LoopOutcome::Stepped)
        }
    }

    /// Finish the run with a summary. Only a non-terminal run can finish.
    pub fn finish(&mut self, summary: impl Into<String>, ended_at: i64) -> Result<(), RunError> {
        if self.run.is_terminal() {
            return Err(RunError::Invalid("run is already terminal".to_owned()));
        }
        self.run.status = RunStatus::Succeeded;
        self.run.summary = Some(summary.into());
        self.run.ended_at = Some(ended_at);
        self.run.validate()
    }

    /// Cancel the run (user cancel or budget watchdog).
    pub fn cancel(&mut self, ended_at: i64) -> Result<(), RunError> {
        if self.run.is_terminal() {
            return Err(RunError::Invalid("run is already terminal".to_owned()));
        }
        self.run.status = RunStatus::Cancelled;
        self.run.ended_at = Some(ended_at);
        self.run.validate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_run() -> AgentRun {
        AgentRun::new("run-1", "summarise this page", 1_700_000_000)
    }

    #[test]
    fn run_json_round_trip() {
        let run = pending_run();
        assert!(run.validate().is_ok());
        let json = run.to_json().unwrap();
        assert_eq!(AgentRun::from_json(&json).unwrap(), run);
    }

    #[test]
    fn run_version_mismatch_fails_loudly() {
        let mut run = pending_run();
        run.version = 999;
        assert_eq!(
            run.validate(),
            Err(RunError::VersionMismatch(999, RUN_RECORD_VERSION))
        );
        assert!(AgentRun::from_json(&run.to_json().unwrap()).is_err());
        assert!(matches!(
            AgentRun::from_json("{not json"),
            Err(RunError::Json(_))
        ));
    }

    #[test]
    fn run_validation_rejects_broken_shapes() {
        let mut bad = pending_run();
        bad.run_id.clear();
        assert!(bad.validate().is_err());

        let mut bad = pending_run();
        bad.goal = "   ".to_owned();
        assert!(bad.validate().is_err());

        let mut bad = pending_run();
        bad.goal = "x".repeat(MAX_GOAL_CHARS + 1);
        assert!(bad.validate().is_err());

        let mut bad = pending_run();
        bad.status = RunStatus::Succeeded;
        assert!(bad.validate().is_err());

        let mut bad = pending_run();
        bad.parent_run_id = Some("run-1".to_owned());
        assert!(bad.validate().is_err());
    }

    #[test]
    fn helper_run_links_to_parent() {
        let helper = AgentRun::new_helper("run-child", "run-1", "fetch prices", 42);
        assert!(helper.validate().is_ok());
        assert_eq!(helper.parent_run_id.as_deref(), Some("run-1"));
        let json = helper.to_json().unwrap();
        assert_eq!(AgentRun::from_json(&json).unwrap(), helper);
    }

    #[test]
    fn loop_advance_enforces_budget_and_terminal_states() {
        let mut agent_loop = AgentLoop::start(pending_run()).unwrap();
        assert_eq!(agent_loop.run().status, RunStatus::Pending);
        assert_eq!(
            agent_loop
                .advance(crate::steps::StepKind::Observe, "look")
                .unwrap(),
            LoopOutcome::Stepped
        );
        assert_eq!(agent_loop.run().status, RunStatus::Running);
        // Pre-built events (with detail) go through `advance_event`, which
        // still rejects gaps and replays.
        let detailed = StepEvent::new(1, crate::steps::StepKind::ToolCall, "read text")
            .with_detail(r#"{"tool":"page_read"}"#);
        assert_eq!(
            agent_loop.advance_event(detailed).unwrap(),
            LoopOutcome::Stepped
        );
        assert!(agent_loop
            .advance_event(StepEvent::new(1, crate::steps::StepKind::Observe, "replay"))
            .is_err());
        agent_loop.finish("done", 1_700_000_001).unwrap();
        assert!(agent_loop.run().is_terminal());
        assert!(agent_loop
            .advance(crate::steps::StepKind::Observe, "late")
            .is_err());
    }
}

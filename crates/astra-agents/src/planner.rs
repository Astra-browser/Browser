/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Planner: goal → ordered plan steps (skeleton for P6-T01).
//!
//! [`Plan`] is the versioned, serializable plan record: an ordered list of
//! [`PlanStep`]s with stable ids. The full planner (decomposition, repair,
//! re-planning on tool failure) arrives with the provider layer in P6-T02;
//! this module owns the shape so the loop, canvas (P6-T06), and tasks
//! hand-off can build on it now.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Plan format version. Bump on any breaking shape change and keep
/// [`PlanError::VersionMismatch`] so old payloads fail loudly.
pub const PLAN_VERSION: u32 = 1;

/// Maximum plan steps accepted by [`Plan::validate`].
pub const MAX_PLAN_STEPS: usize = 64;

/// Status of one plan step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    #[default]
    Pending,
    Active,
    Done,
    Skipped,
    Failed,
}

/// One step of a plan: a stable id plus a human-readable description of
/// what the agent intends to do. Tool bindings arrive in P6-T03.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanStep {
    pub step_id: String,
    pub description: String,
    #[serde(default)]
    pub status: PlanStepStatus,
}

/// Versioned, ordered plan for one run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub version: u32,
    pub run_id: String,
    #[serde(default)]
    pub steps: Vec<PlanStep>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum PlanError {
    #[error("unsupported plan version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid plan: {0}")]
    Invalid(String),
    #[error("plan JSON error: {0}")]
    Json(String),
}

impl Plan {
    /// Empty plan for a run.
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            version: PLAN_VERSION,
            run_id: run_id.into(),
            steps: Vec::new(),
        }
    }

    /// Append one step. Ids must be unique within the plan.
    pub fn push(&mut self, step: PlanStep) -> Result<(), PlanError> {
        if self.steps.len() >= MAX_PLAN_STEPS {
            return Err(PlanError::Invalid(format!(
                "plan exceeds {MAX_PLAN_STEPS} steps"
            )));
        }
        if step.step_id.is_empty() {
            return Err(PlanError::Invalid(
                "plan step id must not be empty".to_owned(),
            ));
        }
        if self.steps.iter().any(|s| s.step_id == step.step_id) {
            return Err(PlanError::Invalid(format!(
                "duplicate plan step {}",
                step.step_id
            )));
        }
        self.steps.push(step);
        Ok(())
    }

    /// Serialize to the string stored alongside the run.
    pub fn to_json(&self) -> Result<String, PlanError> {
        serde_json::to_string(self).map_err(|e| PlanError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, PlanError> {
        let plan: Self = serde_json::from_str(json).map_err(|e| PlanError::Json(e.to_string()))?;
        plan.validate()?;
        Ok(plan)
    }

    /// Structural validation: version, non-empty ids, unique step ids.
    pub fn validate(&self) -> Result<(), PlanError> {
        if self.version != PLAN_VERSION {
            return Err(PlanError::VersionMismatch(self.version, PLAN_VERSION));
        }
        if self.run_id.is_empty() {
            return Err(PlanError::Invalid("run_id must not be empty".to_owned()));
        }
        if self.steps.len() > MAX_PLAN_STEPS {
            return Err(PlanError::Invalid(format!(
                "plan exceeds {MAX_PLAN_STEPS} steps"
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for step in &self.steps {
            if step.step_id.is_empty() {
                return Err(PlanError::Invalid(
                    "plan step id must not be empty".to_owned(),
                ));
            }
            if step.description.trim().is_empty() {
                return Err(PlanError::Invalid(format!(
                    "plan step {} needs a description",
                    step.step_id
                )));
            }
            if !seen.insert(step.step_id.as_str()) {
                return Err(PlanError::Invalid(format!(
                    "duplicate plan step {}",
                    step.step_id
                )));
            }
        }
        Ok(())
    }

    /// Next pending step, if any.
    pub fn next_pending(&self) -> Option<&PlanStep> {
        self.steps
            .iter()
            .find(|s| s.status == PlanStepStatus::Pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_round_trip_and_next_pending() {
        let mut plan = Plan::new("run-1");
        plan.push(PlanStep {
            step_id: "s1".to_owned(),
            description: "open the page".to_owned(),
            status: PlanStepStatus::Done,
        })
        .unwrap();
        plan.push(PlanStep {
            step_id: "s2".to_owned(),
            description: "read the price".to_owned(),
            status: PlanStepStatus::Pending,
        })
        .unwrap();
        assert!(plan.validate().is_ok());
        let parsed = Plan::from_json(&plan.to_json().unwrap()).unwrap();
        assert_eq!(parsed, plan);
        assert_eq!(parsed.next_pending().unwrap().step_id, "s2");
    }

    #[test]
    fn plan_rejects_broken_shapes() {
        let mut bad = Plan::new("run-1");
        bad.version = 999;
        assert_eq!(
            bad.validate(),
            Err(PlanError::VersionMismatch(999, PLAN_VERSION))
        );
        assert!(Plan::from_json(&bad.to_json().unwrap()).is_err());
        assert!(matches!(
            Plan::from_json("{not json"),
            Err(PlanError::Json(_))
        ));

        let mut plan = Plan::new("run-1");
        plan.push(PlanStep {
            step_id: "s1".to_owned(),
            description: "x".to_owned(),
            status: PlanStepStatus::Pending,
        })
        .unwrap();
        assert!(plan
            .push(PlanStep {
                step_id: "s1".to_owned(),
                description: "dup".to_owned(),
                status: PlanStepStatus::Pending,
            })
            .is_err());
    }
}

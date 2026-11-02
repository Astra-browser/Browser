/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Helper runtime (P6-T05): parallel sub-agents with own containers.
//!
//! Helpers are runs, not a second concept: [`HelperRun`] links a child run
//! to its parent via `parent_run_id` (mirroring
//! [`crate::run::AgentRun::new_helper`]). This module adds the P6-T05
//! runtime around that link — one container per helper ([`ContainerDriver`]),
//! a visible source pane per helper (`source_pane_id`, placed through the
//! existing `Panes` host module), per-helper cancel, and step/token/wall-time
//! budgets ([`HelperBudget`]).
//!
//! [`HelperPool`] owns the whole fan-out for one parent run: spawning
//! helpers (each gets its own container id and source pane id), accounting
//! steps and tokens, enforcing budgets against an injected [`Clock`] (the
//! [`ManualClock`] fake keeps tests deterministic), and cascading cancel to
//! container teardown so a cancelled helper never leaves an orphan tab
//! behind. The container driver is mocked in-process
//! ([`InMemoryContainerDriver`]) — no real browser needed; the live Gecko
//! binding (`overlay/astra/host/Helpers.sys.mjs`) implements the same
//! create/destroy contract against `Containers` + `Panes`.

use std::cell::Cell;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Helper-record format version. Bump on any breaking shape change and keep
/// [`HelperError::VersionMismatch`] so old rows fail loudly, never silently.
pub const HELPER_VERSION: u32 = 1;

/// Maximum helper goal text length accepted by [`HelperRun::validate`].
pub const MAX_HELPER_GOAL_CHARS: usize = 4_000;

/// Maximum live helpers fanned out from one parent run. The P6-T05 demo runs
/// 3; the cap stays small so one runaway parent cannot flood the tab strip.
pub const MAX_HELPERS_PER_PARENT: usize = 8;

/// Default step budget per helper.
pub const DEFAULT_MAX_STEPS: u64 = 50;
/// Default token budget per helper.
pub const DEFAULT_MAX_TOKENS: u64 = 32_000;
/// Default wall-time budget per helper (5 minutes, in milliseconds).
pub const DEFAULT_MAX_WALL_MS: u64 = 300_000;

/// Which budget a helper exhausted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetKind {
    /// Too many loop steps.
    Steps,
    /// Too many model tokens.
    Tokens,
    /// Ran longer than `max_wall_ms`.
    WallTime,
}

/// Per-helper budgets: step, token, and wall-time caps.
///
/// Every cap is enforced — the helper transitions to
/// [`HelperStatus::BudgetExhausted`] and its container is torn down, never
/// left running past its budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperBudget {
    pub max_steps: u64,
    pub max_tokens: u64,
    /// Maximum wall time in milliseconds from spawn.
    pub max_wall_ms: u64,
}

impl Default for HelperBudget {
    fn default() -> Self {
        Self {
            max_steps: DEFAULT_MAX_STEPS,
            max_tokens: DEFAULT_MAX_TOKENS,
            max_wall_ms: DEFAULT_MAX_WALL_MS,
        }
    }
}

impl HelperBudget {
    /// Structural validation: every cap must be non-zero so a helper can
    /// always make at least one step of progress.
    pub fn validate(&self) -> Result<(), HelperError> {
        if self.max_steps == 0 {
            return Err(HelperError::Invalid(
                "max_steps must be non-zero".to_owned(),
            ));
        }
        if self.max_tokens == 0 {
            return Err(HelperError::Invalid(
                "max_tokens must be non-zero".to_owned(),
            ));
        }
        if self.max_wall_ms == 0 {
            return Err(HelperError::Invalid(
                "max_wall_ms must be non-zero".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Lifecycle state of one helper run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperStatus {
    /// Spawned, container allocated, not yet stepping.
    Pending,
    /// Actively stepping.
    Running,
    /// Finished with its sub-goal done.
    Succeeded,
    /// Stopped by user cancel (or parent cascade).
    Cancelled,
    /// Failed with an error description in `end_reason`.
    Failed,
    /// Stopped by budget enforcement; the container was torn down.
    BudgetExhausted,
}

impl HelperStatus {
    /// True once the helper reached a terminal state.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Cancelled | Self::Failed | Self::BudgetExhausted
        )
    }

    /// True while the helper holds a live container.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Pending | Self::Running)
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum HelperError {
    #[error("unsupported helper version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid helper: {0}")]
    Invalid(String),
    #[error("helper JSON error: {0}")]
    Json(String),
    #[error("unknown helper: {0}")]
    UnknownHelper(String),
    #[error("helper pool full: parent already has {0} helpers")]
    PoolFull(usize),
    #[error("helper budget exhausted: {kind:?} budget exceeded")]
    BudgetExhausted {
        /// Which budget was exceeded.
        kind: BudgetKind,
    },
    #[error("helper container error: {0}")]
    Container(String),
}

/// One helper run: a child run with its own container, source pane, budgets,
/// and usage accounting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelperRun {
    pub version: u32,
    pub helper_id: String,
    pub parent_run_id: String,
    pub goal: String,
    /// Own container id minted by the [`ContainerDriver`] at spawn. Retained
    /// after teardown for audit; liveness is decided by `status`, never by
    /// re-querying the driver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    /// Visible pane showing this helper's live page, placed through the
    /// existing `Panes` host module. Deterministic:
    /// [`pane_id_for`] of the helper id.
    pub source_pane_id: String,
    pub budget: HelperBudget,
    pub status: HelperStatus,
    #[serde(default)]
    pub steps_used: u64,
    #[serde(default)]
    pub tokens_used: u64,
    /// Spawn time in milliseconds since the Unix epoch (from the [`Clock`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
    /// Why a terminal helper stopped (cancel reason, failure, budget kind).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

/// Source pane id for a helper: `helper-pane-<helper_id>`.
pub fn pane_id_for(helper_id: &str) -> String {
    format!("helper-pane-{helper_id}")
}

impl HelperRun {
    /// New pending helper. The container and start time are assigned by
    /// [`HelperPool::spawn`]; this constructor only shapes the record.
    pub fn new(
        helper_id: impl Into<String>,
        parent_run_id: impl Into<String>,
        goal: impl Into<String>,
        budget: HelperBudget,
    ) -> Self {
        let helper_id = helper_id.into();
        let source_pane_id = pane_id_for(&helper_id);
        Self {
            version: HELPER_VERSION,
            helper_id,
            parent_run_id: parent_run_id.into(),
            goal: goal.into(),
            container_id: None,
            source_pane_id,
            budget,
            status: HelperStatus::Pending,
            steps_used: 0,
            tokens_used: 0,
            started_at_ms: None,
            ended_at_ms: None,
            end_reason: None,
        }
    }

    /// Serialize to the string stored alongside the run record.
    pub fn to_json(&self) -> Result<String, HelperError> {
        serde_json::to_string(self).map_err(|e| HelperError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, HelperError> {
        let run: Self = serde_json::from_str(json).map_err(|e| HelperError::Json(e.to_string()))?;
        run.validate()?;
        Ok(run)
    }

    /// Structural validation: version, non-empty ids, goal bounds, the
    /// parent link names a *different* run, terminal states carry `ended_at`.
    pub fn validate(&self) -> Result<(), HelperError> {
        if self.version != HELPER_VERSION {
            return Err(HelperError::VersionMismatch(self.version, HELPER_VERSION));
        }
        if self.helper_id.is_empty() {
            return Err(HelperError::Invalid(
                "helper_id must not be empty".to_owned(),
            ));
        }
        if self.parent_run_id.is_empty() {
            return Err(HelperError::Invalid(
                "parent_run_id must not be empty".to_owned(),
            ));
        }
        if self.parent_run_id == self.helper_id {
            return Err(HelperError::Invalid(
                "parent_run_id must name a different run".to_owned(),
            ));
        }
        if self.goal.trim().is_empty() {
            return Err(HelperError::Invalid("goal must not be empty".to_owned()));
        }
        if self.goal.chars().count() > MAX_HELPER_GOAL_CHARS {
            return Err(HelperError::Invalid(format!(
                "goal exceeds {MAX_HELPER_GOAL_CHARS} chars"
            )));
        }
        if self.source_pane_id.is_empty() {
            return Err(HelperError::Invalid(
                "source_pane_id must not be empty".to_owned(),
            ));
        }
        self.budget.validate()?;
        if self.status.is_terminal() && self.ended_at_ms.is_none() {
            return Err(HelperError::Invalid(
                "terminal helpers must carry ended_at_ms".to_owned(),
            ));
        }
        Ok(())
    }

    /// True once the helper reached a terminal state.
    pub fn is_terminal(&self) -> bool {
        self.status.is_terminal()
    }

    /// True while the helper holds a live container.
    pub fn is_live(&self) -> bool {
        self.status.is_live()
    }

    /// Project this helper onto the shared [`crate::run::AgentRun`] record
    /// (child link via `parent_run_id`) so stores and audit trails keep one
    /// run shape. `BudgetExhausted` maps to `Cancelled` — the loop's
    /// vocabulary has no budget state, and both mean "stopped by the
    /// watchdog, not by the user task".
    pub fn as_agent_run(&self) -> crate::run::AgentRun {
        use crate::run::{AgentRun, RunStatus};
        let started = self.started_at_ms.unwrap_or(0) as i64;
        let mut run = AgentRun::new_helper(
            self.helper_id.clone(),
            self.parent_run_id.clone(),
            self.goal.clone(),
            started,
        );
        run.status = match self.status {
            HelperStatus::Pending => RunStatus::Pending,
            HelperStatus::Running => RunStatus::Running,
            HelperStatus::Succeeded => RunStatus::Succeeded,
            HelperStatus::Cancelled | HelperStatus::BudgetExhausted => RunStatus::Cancelled,
            HelperStatus::Failed => RunStatus::Failed,
        };
        if run.is_terminal() {
            run.ended_at = Some(self.ended_at_ms.unwrap_or(self.started_at_ms.unwrap_or(0)) as i64);
            run.summary = self.end_reason.clone();
        }
        run
    }
}

/// Wall-clock source for budget enforcement. Inject [`ManualClock`] in tests
/// for deterministic time; the pool defaults to [`SystemClock`] live.
pub trait Clock {
    /// Current time in milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;
}

/// Live wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0)
    }
}

/// Deterministic fake clock for tests: time only moves via [`advance`](ManualClock::advance).
#[derive(Clone, Debug, Default)]
pub struct ManualClock {
    now: Cell<u64>,
}

impl ManualClock {
    /// New fake clock pinned at `start_ms`.
    pub fn new(start_ms: u64) -> Self {
        Self {
            now: Cell::new(start_ms),
        }
    }

    /// Move time forward by `delta_ms`.
    pub fn advance(&self, delta_ms: u64) {
        self.now.set(self.now.get().saturating_add(delta_ms));
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
}

/// Container lifecycle for helpers: one isolated container per helper.
///
/// The live Gecko binding implements this against `Containers.create` /
/// `Containers.remove`; tests and non-browser hosts use
/// [`InMemoryContainerDriver`].
pub trait ContainerDriver {
    /// Mint an isolated container for `helper_id`; returns its container id.
    fn create_container(&mut self, helper_id: &str) -> Result<String, HelperError>;
    /// Destroy a container and wipe its site data. Destroying an unknown id
    /// is an error so teardown bugs surface loudly.
    fn destroy_container(&mut self, container_id: &str) -> Result<(), HelperError>;
    /// Container ids still alive in the driver.
    fn live_containers(&self) -> Vec<String>;
}

/// In-process mocked container driver: mints `helper-container-N` ids and
/// tracks liveness in a map. No browser needed; the isolation property the
/// contract cares about is "one helper ↔ one container id, destroyed on
/// teardown", which this mock enforces exactly.
#[derive(Clone, Debug, Default)]
pub struct InMemoryContainerDriver {
    next: u64,
    live: HashMap<String, String>,
}

impl InMemoryContainerDriver {
    /// Empty driver.
    pub fn new() -> Self {
        Self::default()
    }
}

impl ContainerDriver for InMemoryContainerDriver {
    fn create_container(&mut self, helper_id: &str) -> Result<String, HelperError> {
        if helper_id.is_empty() {
            return Err(HelperError::Container(
                "helper_id must not be empty".to_owned(),
            ));
        }
        self.next = self.next.saturating_add(1);
        let id = format!("helper-container-{}", self.next);
        self.live.insert(id.clone(), helper_id.to_owned());
        Ok(id)
    }

    fn destroy_container(&mut self, container_id: &str) -> Result<(), HelperError> {
        self.live
            .remove(container_id)
            .map(|_| ())
            .ok_or_else(|| HelperError::Container(format!("unknown container {container_id}")))
    }

    fn live_containers(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.live.keys().cloned().collect();
        ids.sort();
        ids
    }
}

/// Owns one parent run's helper fan-out: spawning (one container + one
/// source pane per helper), step/token accounting, budget enforcement, and
/// cascading cancel to container teardown.
#[derive(Clone, Debug)]
pub struct HelperPool<C = SystemClock, D = InMemoryContainerDriver> {
    parent_run_id: String,
    default_budget: HelperBudget,
    clock: C,
    driver: D,
    helpers: HashMap<String, HelperRun>,
    order: Vec<String>,
}

impl<C: Clock, D: ContainerDriver> HelperPool<C, D> {
    /// New pool for `parent_run_id` with default budgets.
    pub fn new(parent_run_id: impl Into<String>, clock: C, driver: D) -> Result<Self, HelperError> {
        let parent_run_id = parent_run_id.into();
        if parent_run_id.is_empty() {
            return Err(HelperError::Invalid(
                "parent_run_id must not be empty".to_owned(),
            ));
        }
        Ok(Self {
            parent_run_id,
            default_budget: HelperBudget::default(),
            clock,
            driver,
            helpers: HashMap::new(),
            order: Vec::new(),
        })
    }

    /// Override the budget applied to subsequently spawned helpers.
    pub fn with_budget(mut self, budget: HelperBudget) -> Result<Self, HelperError> {
        budget.validate()?;
        self.default_budget = budget;
        Ok(self)
    }

    /// Parent run this pool fans out from.
    pub fn parent_run_id(&self) -> &str {
        &self.parent_run_id
    }

    /// Borrow the clock (tests advance the fake through this).
    pub fn clock(&self) -> &C {
        &self.clock
    }

    /// Borrow the container driver (tests assert teardown through this).
    pub fn driver(&self) -> &D {
        &self.driver
    }

    /// Spawn one helper: validates the goal, mints its container, assigns
    /// its source pane, and stamps the start time. Rejects duplicates and
    /// enforces [`MAX_HELPERS_PER_PARENT`].
    pub fn spawn(
        &mut self,
        helper_id: impl Into<String>,
        goal: impl Into<String>,
    ) -> Result<&HelperRun, HelperError> {
        self.spawn_with_budget(helper_id, goal, self.default_budget)
    }

    /// Spawn one helper with an explicit budget.
    pub fn spawn_with_budget(
        &mut self,
        helper_id: impl Into<String>,
        goal: impl Into<String>,
        budget: HelperBudget,
    ) -> Result<&HelperRun, HelperError> {
        let helper_id = helper_id.into();
        let goal = goal.into();
        budget.validate()?;
        if helper_id.is_empty() {
            return Err(HelperError::Invalid(
                "helper_id must not be empty".to_owned(),
            ));
        }
        if self.helpers.contains_key(&helper_id) {
            return Err(HelperError::Invalid(format!(
                "helper {helper_id} already spawned"
            )));
        }
        if self.live_count() >= MAX_HELPERS_PER_PARENT {
            return Err(HelperError::PoolFull(MAX_HELPERS_PER_PARENT));
        }
        let mut helper = HelperRun::new(&helper_id, &self.parent_run_id, goal, budget);
        helper.validate()?;
        let container_id = self.driver.create_container(&helper_id)?;
        helper.container_id = Some(container_id);
        helper.started_at_ms = Some(self.clock.now_ms());
        self.order.push(helper_id.clone());
        self.helpers.insert(helper_id.clone(), helper);
        self.helpers
            .get(&helper_id)
            .ok_or(HelperError::UnknownHelper(helper_id))
    }

    /// Borrow one helper by id.
    pub fn get(&self, helper_id: &str) -> Result<&HelperRun, HelperError> {
        self.helpers
            .get(helper_id)
            .ok_or_else(|| HelperError::UnknownHelper(helper_id.to_owned()))
    }

    /// All helpers in spawn order.
    pub fn helpers(&self) -> Vec<&HelperRun> {
        self.order
            .iter()
            .filter_map(|id| self.helpers.get(id))
            .collect()
    }

    /// Helpers still holding live containers, in spawn order.
    pub fn live_helpers(&self) -> Vec<&HelperRun> {
        self.helpers().into_iter().filter(|h| h.is_live()).collect()
    }

    /// Count of helpers still holding live containers.
    pub fn live_count(&self) -> usize {
        self.helpers.values().filter(|h| h.is_live()).count()
    }

    /// Account one loop step (`tokens` model tokens consumed). Transitions
    /// `Pending → Running`; enforces step, token, and wall-time budgets in
    /// that order — the first exceeded budget wins, marks the helper
    /// `BudgetExhausted`, and tears down its container.
    pub fn record_step(
        &mut self,
        helper_id: &str,
        tokens: u64,
    ) -> Result<HelperStatus, HelperError> {
        let now = self.clock.now_ms();
        let helper = self
            .helpers
            .get_mut(helper_id)
            .ok_or_else(|| HelperError::UnknownHelper(helper_id.to_owned()))?;
        if helper.is_terminal() {
            return Err(HelperError::Invalid(format!(
                "helper {helper_id} is already terminal"
            )));
        }
        if helper.status == HelperStatus::Pending {
            helper.status = HelperStatus::Running;
        }
        helper.steps_used = helper.steps_used.saturating_add(1);
        helper.tokens_used = helper.tokens_used.saturating_add(tokens);
        let kind = if helper.steps_used > helper.budget.max_steps {
            Some(BudgetKind::Steps)
        } else if helper.tokens_used > helper.budget.max_tokens {
            Some(BudgetKind::Tokens)
        } else if now.saturating_sub(helper.started_at_ms.unwrap_or(now))
            > helper.budget.max_wall_ms
        {
            Some(BudgetKind::WallTime)
        } else {
            None
        };
        if let Some(kind) = kind {
            let reason = format!("{kind:?} budget exceeded");
            return self.exhaust(helper_id, kind, reason, now);
        }
        self.helpers
            .get(helper_id)
            .map(|h| h.status)
            .ok_or_else(|| HelperError::UnknownHelper(helper_id.to_owned()))
    }

    /// Sweep every live helper against the wall clock: helpers past
    /// `max_wall_ms` transition to `BudgetExhausted` with container
    /// teardown. Returns the exhausted helper ids in spawn order.
    pub fn sweep_timeouts(&mut self) -> Vec<String> {
        let now = self.clock.now_ms();
        let overdue: Vec<String> = self
            .order
            .iter()
            .filter_map(|id| self.helpers.get(id))
            .filter(|h| {
                h.is_live()
                    && now.saturating_sub(h.started_at_ms.unwrap_or(now)) > h.budget.max_wall_ms
            })
            .map(|h| h.helper_id.clone())
            .collect();
        let mut exhausted = Vec::with_capacity(overdue.len());
        for id in overdue {
            let reason = "WallTime budget exceeded".to_owned();
            if self
                .finish(&id, HelperStatus::BudgetExhausted, reason, now)
                .is_ok()
            {
                exhausted.push(id);
            }
        }
        exhausted
    }

    /// Mark a helper succeeded. Tears down its container: a finished helper
    /// keeps its source-pane record for audit but holds no live tab.
    pub fn succeed(
        &mut self,
        helper_id: &str,
        end_reason: impl Into<String>,
    ) -> Result<(), HelperError> {
        let now = self.clock.now_ms();
        self.finish(helper_id, HelperStatus::Succeeded, end_reason.into(), now)
    }

    /// Mark a helper failed with an error description.
    pub fn fail(&mut self, helper_id: &str, error: impl Into<String>) -> Result<(), HelperError> {
        let now = self.clock.now_ms();
        self.finish(helper_id, HelperStatus::Failed, error.into(), now)
    }

    /// Cancel one helper: marks it `Cancelled` and destroys its container so
    /// no orphan tab survives. Cancelling a terminal helper is an error,
    /// never a silent no-op.
    pub fn cancel(
        &mut self,
        helper_id: &str,
        reason: impl Into<String>,
    ) -> Result<(), HelperError> {
        let now = self.clock.now_ms();
        self.finish(helper_id, HelperStatus::Cancelled, reason.into(), now)
    }

    /// Cascade cancel: stops every live helper (parent cancel or shutdown)
    /// and tears down every live container. Returns the cancelled helper ids
    /// in spawn order. After this call [`live_count`](Self::live_count) is 0
    /// and the driver holds no containers for this pool.
    pub fn cancel_all(&mut self, reason: &str) -> Vec<String> {
        let now = self.clock.now_ms();
        let live: Vec<String> = self
            .order
            .iter()
            .filter_map(|id| self.helpers.get(id))
            .filter(|h| h.is_live())
            .map(|h| h.helper_id.clone())
            .collect();
        let mut cancelled = Vec::with_capacity(live.len());
        for id in live {
            if self
                .finish(&id, HelperStatus::Cancelled, reason.to_owned(), now)
                .is_ok()
            {
                cancelled.push(id);
            }
        }
        cancelled
    }

    /// Driver-live containers with no live helper holding them. Must be
    /// empty after any cancel path — the no-orphan invariant.
    pub fn orphan_containers(&self) -> Vec<String> {
        let held: std::collections::HashSet<&str> = self
            .helpers
            .values()
            .filter(|h| h.is_live())
            .filter_map(|h| h.container_id.as_deref())
            .collect();
        let mut orphans: Vec<String> = self
            .driver
            .live_containers()
            .into_iter()
            .filter(|id| !held.contains(id.as_str()))
            .collect();
        orphans.sort();
        orphans
    }

    fn finish(
        &mut self,
        helper_id: &str,
        status: HelperStatus,
        reason: String,
        now: u64,
    ) -> Result<(), HelperError> {
        debug_assert!(status.is_terminal());
        let container_id = {
            let helper = self
                .helpers
                .get_mut(helper_id)
                .ok_or_else(|| HelperError::UnknownHelper(helper_id.to_owned()))?;
            if helper.is_terminal() {
                return Err(HelperError::Invalid(format!(
                    "helper {helper_id} is already terminal"
                )));
            }
            helper.status = status;
            helper.ended_at_ms = Some(now);
            helper.end_reason = Some(reason);
            helper.container_id.clone()
        };
        // Teardown is best-effort against the driver state: the record is
        // already terminal, so a missing container must not resurrect it —
        // but a live leftover must never survive either.
        if let Some(container_id) = container_id {
            if self
                .helpers
                .get(helper_id)
                .is_some_and(|h| h.container_id.as_deref() == Some(container_id.as_str()))
                && self.driver.live_containers().contains(&container_id)
            {
                self.driver.destroy_container(&container_id)?;
            }
        }
        Ok(())
    }

    fn exhaust(
        &mut self,
        helper_id: &str,
        kind: BudgetKind,
        reason: String,
        now: u64,
    ) -> Result<HelperStatus, HelperError> {
        self.finish(helper_id, HelperStatus::BudgetExhausted, reason, now)?;
        Err(HelperError::BudgetExhausted { kind })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_pool() -> HelperPool<ManualClock, InMemoryContainerDriver> {
        HelperPool::new(
            "run-parent",
            ManualClock::new(1_700_000_000_000),
            InMemoryContainerDriver::new(),
        )
        .unwrap()
    }

    #[test]
    fn helper_json_round_trip() {
        let mut pool = test_pool();
        let helper = pool.spawn("helper-1", "fetch prices").unwrap().clone();
        assert!(helper.validate().is_ok());
        assert_eq!(
            helper.source_pane_id, "helper-pane-helper-1",
            "source pane id is deterministic"
        );
        assert!(helper.container_id.is_some());
        let parsed = HelperRun::from_json(&helper.to_json().unwrap()).unwrap();
        assert_eq!(parsed, helper);
    }

    #[test]
    fn helper_version_mismatch_fails_loudly() {
        let mut pool = test_pool();
        let mut helper = pool.spawn("helper-1", "fetch prices").unwrap().clone();
        helper.version = 999;
        assert_eq!(
            helper.validate(),
            Err(HelperError::VersionMismatch(999, HELPER_VERSION))
        );
        assert!(HelperRun::from_json(&helper.to_json().unwrap()).is_err());
        assert!(matches!(
            HelperRun::from_json("{not json"),
            Err(HelperError::Json(_))
        ));
    }

    #[test]
    fn helper_validation_rejects_broken_shapes() {
        let mut pool = test_pool();
        let helper = pool.spawn("helper-1", "fetch prices").unwrap().clone();

        let mut bad = helper.clone();
        bad.helper_id.clear();
        assert!(bad.validate().is_err());

        let mut bad = helper.clone();
        bad.parent_run_id.clear();
        assert!(bad.validate().is_err());

        let mut bad = helper.clone();
        bad.parent_run_id = bad.helper_id.clone();
        assert!(bad.validate().is_err());

        let mut bad = helper.clone();
        bad.goal = "   ".to_owned();
        assert!(bad.validate().is_err());

        let mut bad = helper.clone();
        bad.goal = "x".repeat(MAX_HELPER_GOAL_CHARS + 1);
        assert!(bad.validate().is_err());

        let mut bad = helper.clone();
        bad.budget.max_steps = 0;
        assert!(bad.validate().is_err());

        // Terminal without ended_at fails loudly.
        let mut bad = helper.clone();
        bad.status = HelperStatus::Succeeded;
        assert!(bad.validate().is_err());
    }

    #[test]
    fn spawn_rejects_duplicates_and_pool_cap() {
        let mut pool = test_pool();
        pool.spawn("helper-1", "goal one").unwrap();
        assert!(matches!(
            pool.spawn("helper-1", "goal two"),
            Err(HelperError::Invalid(_))
        ));
        assert!(matches!(
            pool.spawn("", "goal"),
            Err(HelperError::Invalid(_))
        ));
        assert!(pool.spawn("helper-x", "   ").is_err());

        for n in 2..=MAX_HELPERS_PER_PARENT {
            pool.spawn(format!("helper-{n}"), "goal").unwrap();
        }
        assert_eq!(pool.live_count(), MAX_HELPERS_PER_PARENT);
        assert!(matches!(
            pool.spawn("helper-overflow", "goal"),
            Err(HelperError::PoolFull(MAX_HELPERS_PER_PARENT))
        ));
    }

    #[test]
    fn three_helpers_get_own_containers_and_panes() {
        let mut pool = test_pool();
        for n in 1..=3 {
            pool.spawn(format!("helper-{n}"), format!("sub-goal {n}"))
                .unwrap();
        }
        let helpers = pool.helpers();
        assert_eq!(helpers.len(), 3);
        let mut containers: Vec<_> = helpers
            .iter()
            .map(|h| h.container_id.clone().unwrap())
            .collect();
        containers.sort();
        containers.dedup();
        assert_eq!(containers.len(), 3, "one container per helper");
        let mut panes: Vec<_> = helpers.iter().map(|h| h.source_pane_id.clone()).collect();
        panes.sort();
        panes.dedup();
        assert_eq!(panes.len(), 3, "one source pane per helper");
        // Every helper links back to the parent run.
        for helper in helpers {
            let run = helper.as_agent_run();
            assert_eq!(run.parent_run_id.as_deref(), Some("run-parent"));
            assert!(!run.is_terminal());
        }
    }

    #[test]
    fn step_budget_enforced_with_fake_clock() {
        let mut pool = test_pool();
        pool.spawn_with_budget(
            "helper-1",
            "count",
            HelperBudget {
                max_steps: 2,
                ..HelperBudget::default()
            },
        )
        .unwrap();
        assert_eq!(
            pool.record_step("helper-1", 10).unwrap(),
            HelperStatus::Running
        );
        assert_eq!(
            pool.record_step("helper-1", 10).unwrap(),
            HelperStatus::Running
        );
        assert_eq!(
            pool.record_step("helper-1", 10),
            Err(HelperError::BudgetExhausted {
                kind: BudgetKind::Steps
            })
        );
        let helper = pool.get("helper-1").unwrap();
        assert_eq!(helper.status, HelperStatus::BudgetExhausted);
        assert!(helper.is_terminal());
        // Budget kill tears down the container too — no orphan.
        assert!(pool.orphan_containers().is_empty());
        assert!(pool.driver().live_containers().is_empty());
        // Terminal helpers refuse further steps.
        assert!(pool.record_step("helper-1", 1).is_err());
    }

    #[test]
    fn token_budget_enforced() {
        let mut pool = test_pool();
        pool.spawn_with_budget(
            "helper-1",
            "read a long page",
            HelperBudget {
                max_tokens: 100,
                ..HelperBudget::default()
            },
        )
        .unwrap();
        assert!(pool.record_step("helper-1", 60).is_ok());
        assert_eq!(
            pool.record_step("helper-1", 50),
            Err(HelperError::BudgetExhausted {
                kind: BudgetKind::Tokens
            })
        );
        assert_eq!(
            pool.get("helper-1").unwrap().status,
            HelperStatus::BudgetExhausted
        );
        assert!(pool.orphan_containers().is_empty());
    }

    #[test]
    fn wall_budget_enforced_with_fake_clock() {
        let mut pool = test_pool();
        pool.spawn_with_budget(
            "helper-1",
            "slow crawl",
            HelperBudget {
                max_wall_ms: 1_000,
                ..HelperBudget::default()
            },
        )
        .unwrap();
        // Within budget: fine.
        assert!(pool.record_step("helper-1", 1).is_ok());
        // Past the wall budget: the next step trips the watchdog.
        pool.clock().advance(1_001);
        assert_eq!(
            pool.record_step("helper-1", 1),
            Err(HelperError::BudgetExhausted {
                kind: BudgetKind::WallTime
            })
        );
        assert!(pool.orphan_containers().is_empty());
    }

    #[test]
    fn sweep_timeouts_catches_idle_helpers() {
        let mut pool = test_pool();
        pool.spawn_with_budget(
            "helper-idle",
            "stalled",
            HelperBudget {
                max_wall_ms: 500,
                ..HelperBudget::default()
            },
        )
        .unwrap();
        pool.spawn("helper-busy", "quick").unwrap();
        pool.clock().advance(10_000);
        // The default-budget helper is still fine; only the idle one trips.
        let exhausted = pool.sweep_timeouts();
        assert_eq!(exhausted, vec!["helper-idle".to_owned()]);
        assert_eq!(
            pool.get("helper-idle").unwrap().status,
            HelperStatus::BudgetExhausted
        );
        assert!(pool.get("helper-busy").unwrap().is_live());
    }

    #[test]
    fn cancel_tears_down_container_no_orphan() {
        let mut pool = test_pool();
        pool.spawn("helper-1", "fetch prices").unwrap();
        assert_eq!(pool.driver().live_containers().len(), 1);
        pool.cancel("helper-1", "user asked to stop").unwrap();
        let helper = pool.get("helper-1").unwrap();
        assert_eq!(helper.status, HelperStatus::Cancelled);
        assert_eq!(helper.end_reason.as_deref(), Some("user asked to stop"));
        // Container destroyed: no orphan left in the driver.
        assert!(pool.driver().live_containers().is_empty());
        assert!(pool.orphan_containers().is_empty());
        // Cancelling twice is an error, never a silent second cancel.
        assert!(pool.cancel("helper-1", "again").is_err());
        assert!(matches!(
            pool.cancel("helper-missing", "x"),
            Err(HelperError::UnknownHelper(_))
        ));
    }

    #[test]
    fn cancel_all_cascades_no_orphans_demo() {
        // The P6-T05 acceptance shape: 3 helpers in parallel, one parent
        // cancel, zero orphan tabs.
        let mut pool = test_pool();
        for n in 1..=3 {
            pool.spawn(format!("helper-{n}"), format!("sub-goal {n}"))
                .unwrap();
        }
        assert_eq!(pool.driver().live_containers().len(), 3);
        let cancelled = pool.cancel_all("parent run cancelled");
        assert_eq!(cancelled.len(), 3);
        assert_eq!(pool.live_count(), 0);
        assert!(pool.live_helpers().is_empty());
        assert!(pool.driver().live_containers().is_empty());
        assert!(pool.orphan_containers().is_empty());
        for n in 1..=3 {
            let helper = pool.get(&format!("helper-{n}")).unwrap();
            assert_eq!(helper.status, HelperStatus::Cancelled);
            // The child link survives cancel so audit can replay the fan-out.
            assert_eq!(
                helper.as_agent_run().parent_run_id.as_deref(),
                Some("run-parent")
            );
        }
    }

    #[test]
    fn succeed_and_fail_release_containers() {
        let mut pool = test_pool();
        pool.spawn("helper-ok", "quick lookup").unwrap();
        pool.spawn("helper-bad", "broken lookup").unwrap();
        pool.succeed("helper-ok", "found it").unwrap();
        pool.fail("helper-bad", "page unreachable").unwrap();
        assert_eq!(
            pool.get("helper-ok").unwrap().status,
            HelperStatus::Succeeded
        );
        assert_eq!(pool.get("helper-bad").unwrap().status, HelperStatus::Failed);
        assert!(pool.driver().live_containers().is_empty());
        assert!(pool.orphan_containers().is_empty());
    }

    #[test]
    fn agent_run_projection_maps_terminal_states() {
        use crate::run::RunStatus;
        let mut pool = test_pool();
        pool.spawn("helper-1", "goal").unwrap();
        pool.cancel("helper-1", "stop").unwrap();
        let run = pool.get("helper-1").unwrap().as_agent_run();
        assert_eq!(run.status, RunStatus::Cancelled);
        assert!(run.validate().is_ok());
    }
}

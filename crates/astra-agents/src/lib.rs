/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-agents`: agent core skeleton (P6-T01).
//!
//! Pure contracts for the browser agent: the run loop state machine
//! ([`run`]), the planner ([`planner`]), the append-only step stream
//! ([`steps`]), provider and tool interfaces (stubs in [`providers`] and
//! [`tools`], filled in by P6-T02/P6-T03), the approval gate ([`approvals`],
//! engine in P6-T04), memory plus history search ([`memory`], store wiring in
//! P6-T08), and the skill manifest plus loader ([`skills`], port in P6-T07).
//!
//! Persisted shapes are versioned JSON following the `astra-core`
//! session/layout precedent: a `*_VERSION` constant, a `version` field,
//! `to_json` / `from_json` with a loud [`VersionMismatch`]-style error, and
//! `validate`. Helpers (parallel sub-agents, P6-T05) reuse [`run::AgentRun`]
//! with a `parent_run_id` link; see `docs/astra/AGENTS_DESIGN.md`.

#![forbid(unsafe_code)]

pub mod approvals;
pub mod memory;
pub mod planner;
pub mod providers;
pub mod run;
pub mod skills;
pub mod steps;
pub mod tools;

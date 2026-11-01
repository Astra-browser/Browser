/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-time`: device-only time tracking from tab-activity events (P5-T04).
//!
//! The core is pure-sync: activity events in, per-site totals out
//! ([`tracker`]). [`focus`] adds a focus timer whose site blocking is
//! exposed through the [`focus::FocusBlockHook`] verdict trait — the Net
//! hook interface. Live wiring against `astra-blocker` happens in P4-T11;
//! this crate only defines the verdict shape (deliberately mirroring
//! `astra-blocker::Verdict`: allow, or block with the matched host).
//!
//! Every write path goes through [`service::TimeService`], which gates on
//! `astra-core` [`PrivateScope`][astra_core::private::PrivateScope]:
//! `time_start` / `time_end` / `focus_rule_set` never reach the store in
//! private scope, and total reads return zero without touching disk.

pub mod focus;
pub mod host;
pub mod service;
pub mod tracker;

pub use focus::{FocusBlockHook, FocusSession, FocusVerdict};
pub use host::canonical_host;
pub use service::TimeService;
pub use tracker::{ActivityEvent, TimeTracker};

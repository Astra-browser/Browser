/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! `astra-tasks`: tasks domain for P5-T01.
//!
//! Lists, priorities, deadlines, subtasks and linked pages persisted in the
//! `task_lists` / `tasks` / `task_links` tables owned by `astra-store`
//! (created by its migration v3; this crate adds no migrations). Where the
//! store API covers an operation it is reused; the remaining columns the
//! schema already provides (`parent_id`, `notes`, `position`, renames,
//! soft-delete, link listing) are reached through a second connection to the
//! same database file.
//!
//! [`parser`] ports the base snapshot's natural-language reader
//! (`task-language.ts`, vocabulary and trailing-phrase rule intact): only a
//! phrase at the very end of the line is ever consumed, so "Meet the Friday
//! team" keeps its Friday. Due dates are `YYYY-MM-DD` calendar days; a due
//! time is resolved to a UTC timestamp against a caller-supplied zone offset
//! so daylight-saving boundaries cannot shift the day.
//!
//! Time-zone rule: this crate never does wall-clock arithmetic. Calendar-day
//! math runs on date-only values; a local time becomes a timestamp only via
//! an explicit UTC offset that is valid for that date.

mod calendar;
mod domain;
mod export;
mod parser;

pub use calendar::{
    add_days, format_day, next_week, next_weekday, parse_day, week_start_monday, weekday_of,
    WEEKDAY_SATURDAY,
};
pub use domain::{NewTask, Priority, Task, TaskLink, TaskList, TaskNode, Tasks, TasksError};
pub use export::{
    TaskExport, TaskLinkExport, TaskListExport, TasksBundle, TasksImportReport,
    TASKS_EXPORT_VERSION,
};
pub use parser::{
    due_timestamp_utc, parse_capture, parse_capture_with_week_start, parse_time, parse_tokens,
    today_in_zone, Capture, TokenKind, Tokens,
};

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Calendar-day arithmetic for tasks.
//!
//! Every value here is a `YYYY-MM-DD` calendar day. A due date has no time
//! and no zone, so nothing in this module may cross a daylight-saving
//! boundary or local midnight and land a day out: day math runs on
//! date-only values (port of the base snapshot's `task-calendar.ts`).
//!
//! Only the arithmetic core is ported; locale month/weekday *names* and the
//! scheduling-popover grid are presentation concerns that live in the UI.

use chrono::NaiveDate;

/// Saturday in the 0 = Sunday .. 6 = Saturday numbering shared with the parser.
pub const WEEKDAY_SATURDAY: u32 = 6;

/// The default week start (Monday), matching the base snapshot.
pub const fn week_start_monday() -> u32 {
    1
}

/// Parse a strict `YYYY-MM-DD` day. Shapes that parse but are not the day
/// they claim (e.g. `2027-02-29`) are rejected.
pub fn parse_day(day: &str) -> Option<NaiveDate> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = day[0..4].parse().ok()?;
    let month: u32 = day[5..7].parse().ok()?;
    let date: u32 = day[8..10].parse().ok()?;
    let at = NaiveDate::from_ymd_opt(year, month, date)?;
    // Round-trip so `2026-13-01`-style overflow can never slip through.
    if format_day(at) == day {
        Some(at)
    } else {
        None
    }
}

/// Format a date as `YYYY-MM-DD`.
pub fn format_day(at: NaiveDate) -> String {
    at.format("%Y-%m-%d").to_string()
}

/// Weekday number, 0 = Sunday .. 6 = Saturday.
pub fn weekday_of(at: NaiveDate) -> u32 {
    at.format("%w").to_string().parse().unwrap_or(0)
}

/// Add `count` (negative allowed) calendar days.
pub fn add_days(day: &str, count: i64) -> Option<String> {
    let at = parse_day(day)?;
    let shifted = if count >= 0 {
        at.checked_add_days(chrono::Days::new(count as u64))?
    } else {
        at.checked_sub_days(chrono::Days::new(count.unsigned_abs()))?
    };
    Some(format_day(shifted))
}

/// Days from `day` forward to the next occurrence of `weekday`, never zero:
/// asking for Saturday on a Saturday means the next one.
fn forward_to(day: &str, weekday: u32) -> Option<i64> {
    let at = parse_day(day)?;
    let current = weekday_of(at);
    let delta = (weekday + 7 - current) % 7;
    Some(if delta == 0 { 7 } else { delta as i64 })
}

/// The next occurrence of `weekday` (0 = Sunday .. 6 = Saturday) after `day`.
pub fn next_weekday(day: &str, weekday: u32) -> Option<String> {
    add_days(day, forward_to(day, weekday)?)
}

/// The start of the week after this one, for a locale whose weeks start on
/// `starts_on` (0 = Sunday .. 6 = Saturday).
pub fn next_week(day: &str, starts_on: u32) -> Option<String> {
    add_days(day, forward_to(day, starts_on % 7)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_that_parses_is_the_day_it_claims() {
        assert_eq!(
            parse_day("2028-02-29").map(format_day).as_deref(),
            Some("2028-02-29")
        );
        assert_eq!(parse_day("2027-02-29"), None);
        assert_eq!(parse_day("2026-13-01"), None);
        assert_eq!(parse_day("20260101"), None);
        assert_eq!(parse_day("2026-02-31"), None);
    }

    #[test]
    fn adding_days_crosses_months_years_and_leap_day() {
        assert_eq!(add_days("2026-09-20", 1).as_deref(), Some("2026-09-21"));
        assert_eq!(add_days("2026-12-31", 1).as_deref(), Some("2027-01-01"));
        assert_eq!(add_days("2028-02-28", 1).as_deref(), Some("2028-02-29"));
        assert_eq!(add_days("2026-01-01", -1).as_deref(), Some("2025-12-31"));
        // A date in a zone that shifts its clock this day is still one day later:
        // date-only math never touches wall-clock time.
        assert_eq!(add_days("2026-03-29", 1).as_deref(), Some("2026-03-30"));
        assert_eq!(add_days("2026-10-25", 1).as_deref(), Some("2026-10-26"));
    }

    #[test]
    fn next_named_day_is_never_today() {
        // 2026-09-20 is a Sunday.
        assert_eq!(next_weekday("2026-09-20", 0).as_deref(), Some("2026-09-27"));
        assert_eq!(next_weekday("2026-09-20", 6).as_deref(), Some("2026-09-26"));
        assert_eq!(next_week("2026-09-20", 1).as_deref(), Some("2026-09-21"));
    }

    #[test]
    fn sunday_week_start_differs_from_monday() {
        // Locale edge case: with a Sunday week start, "next week" from a
        // Sunday is 7 days out, not 1.
        assert_eq!(next_week("2026-09-20", 0).as_deref(), Some("2026-09-27"));
        assert_eq!(next_week("2026-09-20", 1).as_deref(), Some("2026-09-21"));
    }
}

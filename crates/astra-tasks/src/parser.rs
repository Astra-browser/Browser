/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Natural-language task reader (port of the base snapshot's
//! `task-language.ts`; vocabulary and rules intact, branding removed).
//!
//! The rule that keeps this pleasant rather than infuriating: only a phrase
//! at the very end of the line is ever consumed. That is how people write a
//! task — "Call Anna tomorrow at 3pm" — and it means "Meet the Friday team"
//! keeps its Friday, because the word is in the middle.
//!
//! Nothing here guesses. A phrase either matches the vocabulary exactly, at
//! a word boundary, or the line is left alone. In particular a bare hour
//! with no `am`/`pm` ("Call Anna tomorrow at 3") is *not* a time — the same
//! guess that would read "Check market 5" as a date.
//!
//! Time zones: due dates are zone-free calendar days. A due time becomes a
//! UTC timestamp only through [`due_timestamp_utc`], which takes the UTC
//! offset in effect for that date, so callers that track the zone (and its
//! daylight-saving transitions) resolve the same wall time to the correct
//! instant on either side of a transition.

use chrono::{FixedOffset, NaiveDate, NaiveTime, TimeZone};

use crate::calendar::{add_days, next_week, next_weekday, parse_day, week_start_monday};
use crate::domain::Priority;

/// What the task should be called, with any consumed phrase removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    /// Title with any consumed date/time phrase removed.
    pub title: String,
    /// Consumed calendar day (`YYYY-MM-DD`), if any.
    pub due_date: Option<String>,
    /// Consumed clock time (`HH:MM`), if any.
    pub due_time: Option<String>,
    /// The text that was understood, so a field can show its reading back.
    pub matched: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Priority,
    List,
    Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tokens {
    /// The line with every consumed token removed.
    pub rest: String,
    pub priority: Option<Priority>,
    pub list: Option<i64>,
    /// Estimated duration in minutes.
    pub duration: Option<u32>,
    /// What was consumed, per kind.
    pub matched_priority: Option<String>,
    pub matched_list: Option<String>,
    pub matched_duration: Option<String>,
}

/// A list candidate for `#list` matching.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListRef {
    pub id: i64,
    pub title: String,
}

fn weekday_number(word: &str) -> Option<u32> {
    Some(match word {
        "sunday" | "sun" => 0,
        "monday" | "mon" => 1,
        "tuesday" | "tue" | "tues" => 2,
        "wednesday" | "wed" | "weds" => 3,
        "thursday" | "thu" | "thur" | "thurs" => 4,
        "friday" | "fri" => 5,
        "saturday" | "sat" => 6,
        _ => return None,
    })
}

fn month_number(word: &str) -> Option<u32> {
    Some(match word {
        "january" | "jan" => 1,
        "february" | "feb" => 2,
        "march" | "mar" => 3,
        "april" | "apr" => 4,
        "may" => 5,
        "june" | "jun" => 6,
        "july" | "jul" => 7,
        "august" | "aug" => 8,
        "september" | "sept" | "sep" => 9,
        "october" | "oct" => 10,
        "november" | "nov" => 11,
        "december" | "dec" => 12,
        _ => return None,
    })
}

/// Collapse all whitespace runs (Unicode-aware) to single spaces and trim.
fn normalize(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Byte index where the trailing phrase `tail` starts, requiring a word
/// boundary (start of string or whitespace) before it. `tail` is always an
/// ASCII vocabulary word; the index is computed on `original` (via a
/// boundary-safe slice) so non-ASCII case folding earlier in the line can
/// never shift byte positions.
fn tail_start(original: &str, lower: &str, tail: &str) -> Option<usize> {
    if !lower.ends_with(tail) || original.len() < tail.len() {
        return None;
    }
    let at = original.len() - tail.len();
    let end = original.get(at..)?;
    if !end.eq_ignore_ascii_case(tail) {
        return None;
    }
    if at == 0 || original[..at].ends_with(char::is_whitespace) {
        Some(at)
    } else {
        None
    }
}

/// Strip one trailing connector (`at`, `on`, `by`, `due`, `@`).
fn strip_connector(line: &str) -> &str {
    let lower = line.to_lowercase();
    for word in ["at", "on", "by", "due", "@"] {
        if let Some(at) = tail_start(line, &lower, word) {
            return line[..at].trim_end();
        }
    }
    line
}

fn clock(hour: u32, minute: u32) -> Option<String> {
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(format!("{hour:02}:{minute:02}"))
}

struct Hit {
    value: String,
    rest_len: usize,
}

fn hit(_input: &str, at: usize, value: String) -> Hit {
    Hit {
        value,
        rest_len: at,
    }
}

/// Match a clock time at the very end of `input`.
fn match_time(input: &str) -> Option<Hit> {
    let lower = input.to_lowercase();
    // Named times.
    for word in ["noon", "midday", "midnight"] {
        if let Some(at) = tail_start(input, &lower, word) {
            let value = if word == "midnight" { "00:00" } else { "12:00" };
            return Some(hit(input, at, value.to_owned()));
        }
    }
    // Meridiem: `3pm`, `3:30 pm`, `12 am`.
    if let Some(at) = meridiem_start(input) {
        let tail = input[at..].trim().to_lowercase();
        let ampm = if tail.ends_with("am") { "am" } else { "pm" };
        let digits = tail[..tail.len() - 2].trim();
        let (hour_raw, minute) = match digits.split_once(':') {
            Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
            None => (digits.parse::<u32>().ok()?, 0),
        };
        if (1..=12).contains(&hour_raw) {
            let hour = if ampm == "pm" {
                (hour_raw % 12) + 12
            } else {
                hour_raw % 12
            };
            if let Some(value) = clock(hour, minute) {
                return Some(hit(input, at, value));
            }
            return None;
        }
        return None;
    }
    // 24-hour `HH:MM`.
    if let Some((at, hour, minute)) = clock24_start(input, &lower) {
        if let Some(value) = clock(hour, minute) {
            return Some(hit(input, at, value));
        }
    }
    None
}

/// Start index of a trailing meridiem time, if the tail parses as one.
/// Operates on the original text with ASCII-only suffix math, so non-ASCII
/// earlier in the line cannot shift the byte indices.
fn meridiem_start(input: &str) -> Option<usize> {
    let trimmed = input.trim_end();
    if trimmed.len() < 3 {
        return None;
    }
    let suffix = trimmed.get(trimmed.len() - 2..)?.to_lowercase();
    if suffix != "am" && suffix != "pm" {
        return None;
    }
    let head = trimmed[..trimmed.len() - 2].trim_end();
    // Trailing run of digits/colons is the clock reading.
    let run_start = head
        .rfind(|c: char| !c.is_ascii_digit() && c != ':')
        .map(|i| i + 1)
        .unwrap_or(0);
    let digits = &head[run_start..];
    if digits.is_empty() {
        return None;
    }
    // Digits must form `H{1,2}(:MM)?` exactly.
    let ok = match digits.split_once(':') {
        Some((h, m)) => {
            !h.is_empty()
                && h.len() <= 2
                && m.len() == 2
                && h.bytes().all(|b| b.is_ascii_digit())
                && m.bytes().all(|b| b.is_ascii_digit())
                && !h.contains(':')
        }
        None => digits.len() <= 2 && digits.bytes().all(|b| b.is_ascii_digit()),
    };
    if !ok {
        return None;
    }
    let begin = run_start;
    if begin > 0 && !trimmed[..begin].ends_with(char::is_whitespace) {
        return None;
    }
    Some(begin)
}

/// Start index plus parts of a trailing 24-hour `HH:MM` time.
fn clock24_start(input: &str, lower: &str) -> Option<(usize, u32, u32)> {
    let trimmed = input.trim_end();
    let token = trimmed.rsplit(char::is_whitespace).next()?;
    let (h, m) = token.split_once(':')?;
    if h.len() > 2 || m.len() != 2 {
        return None;
    }
    if !h.bytes().all(|b| b.is_ascii_digit()) || !m.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // A bare colon-word must be exactly the token (guards "12:75:99").
    if token.bytes().filter(|b| *b == b':').count() != 1 {
        return None;
    }
    let at = trimmed.len() - token.len();
    if at > 0 && !trimmed[..at].ends_with(char::is_whitespace) {
        return None;
    }
    let _ = lower;
    Some((at, h.parse().ok()?, m.parse().ok()?))
}

/// An evening word carries its own hour unless one was typed.
const EVENING: &str = "20:00";

struct DateHit {
    value: String,
    implied: Option<String>,
    rest_len: usize,
}

/// Match a calendar day at the very end of `input`.
fn match_date(input: &str, today: &str, week_start: u32) -> Option<DateHit> {
    let lower = input.to_lowercase();
    let last = input
        .trim_end()
        .rsplit(char::is_whitespace)
        .next()
        .unwrap_or("");
    let last_lower = last.to_lowercase();

    // Plain relative words.
    match last_lower.as_str() {
        "today" | "tonight" | "tomorrow" | "tmrw" | "tmr" => {
            let at = input.trim_end().len() - last.len();
            if at > 0 && !input[..at].ends_with(char::is_whitespace) {
                return None;
            }
            let day = if last_lower == "today" || last_lower == "tonight" {
                today.to_owned()
            } else {
                add_days(today, 1)?
            };
            return Some(DateHit {
                value: day,
                implied: if last_lower == "tonight" {
                    Some(EVENING.to_owned())
                } else {
                    None
                },
                rest_len: at,
            });
        }
        _ => {}
    }

    // "next week".
    if let Some(at) = tail_start(input, &lower, "next week") {
        return Some(DateHit {
            value: next_week(today, week_start)?,
            implied: None,
            rest_len: at,
        });
    }
    // "[this|next] weekend" -> the coming Saturday.
    if tail_start(input, &lower, "weekend").is_some()
        || tail_start(input, &lower, "this weekend").is_some()
        || tail_start(input, &lower, "next weekend").is_some()
    {
        let tail = if tail_start(input, &lower, "this weekend").is_some() {
            "this weekend"
        } else if tail_start(input, &lower, "next weekend").is_some() {
            "next weekend"
        } else {
            "weekend"
        };
        let at = tail_start(input, &lower, tail)?;
        return Some(DateHit {
            value: next_weekday(today, 6)?,
            implied: None,
            rest_len: at,
        });
    }
    // "[next] <weekday>".
    if let Some(name) = weekday_tail(&lower) {
        let weekday = weekday_number(name)?;
        let tail = if tail_start(input, &lower, &format!("next {name}")).is_some() {
            format!("next {name}")
        } else {
            name.to_owned()
        };
        let at = tail_start(input, &lower, &tail)?;
        return Some(DateHit {
            value: next_weekday(today, weekday)?,
            implied: None,
            rest_len: at,
        });
    }
    // "in N day(s)/week(s)". A matched shape with an out-of-range count
    // falls through to the calendar checks below, as in the base.
    if let Some((at, days)) = relative_tail(input, &lower) {
        if (1..=3650).contains(&days) {
            return Some(DateHit {
                value: add_days(today, days)?,
                implied: None,
                rest_len: at,
            });
        }
    }
    // ISO day.
    {
        let trimmed = input.trim_end();
        if let Some(token) = trimmed.rsplit(char::is_whitespace).next() {
            if token.len() == 10 && parse_day(token).is_some() {
                let at = trimmed.len() - token.len();
                if at == 0 || trimmed[..at].ends_with(char::is_whitespace) {
                    return Some(DateHit {
                        value: token.to_owned(),
                        implied: None,
                        rest_len: at,
                    });
                }
            }
        }
    }
    // Bare "3 Sep" / "Sep 3": the next one, never one that has passed.
    if let Some((at, day, month)) = month_day_tail(input) {
        let origin = parse_day(today)?;
        let origin_year: i32 = origin.format("%Y").to_string().parse().ok()?;
        for year in [origin_year, origin_year + 1] {
            let value = format!("{year:04}-{month:02}-{day:02}");
            if parse_day(&value).is_some() && value.as_str() >= today {
                return Some(DateHit {
                    value,
                    implied: None,
                    rest_len: at,
                });
            }
        }
    }
    None
}

/// Trailing weekday name, with or without a leading "next ".
fn weekday_tail(lower: &str) -> Option<&str> {
    // Longest names first so "thursday" wins over nothing shorter here (all
    // candidates are full tokens; check each with a boundary).
    for name in [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sun",
        "mon",
        "tue",
        "tues",
        "wed",
        "weds",
        "thu",
        "thur",
        "thurs",
        "fri",
        "sat",
    ] {
        if tail_start(lower, lower, name).is_some() {
            return Some(name);
        }
        let with_next = ["next ", name].concat();
        if tail_start(lower, lower, &with_next).is_some() {
            return Some(name);
        }
    }
    None
}

/// Trailing "in N day(s)/week(s)": (match start, total days).
fn relative_tail(input: &str, lower: &str) -> Option<(usize, i64)> {
    for unit in ["days", "day", "weeks", "week"] {
        if let Some(unit_at) = tail_start(lower, lower, unit) {
            let head = lower[..unit_at].trim_end();
            // Expect "... in <n>".
            let num_token = head.rsplit(char::is_whitespace).next()?;
            let count: i64 = num_token.parse().ok()?;
            if !(1..=999).contains(&count) {
                return None;
            }
            let before = head[..head.len() - num_token.len()].trim_end();
            let in_word = before.rsplit(char::is_whitespace).next()?;
            if in_word != "in" {
                return None;
            }
            let at = before.len() - "in".len();
            if at > 0 && !before[..at].ends_with(char::is_whitespace) {
                return None;
            }
            let days = if unit.starts_with("week") {
                count * 7
            } else {
                count
            };
            // Remap onto the original string (same ASCII tail; length can
            // only differ through non-ASCII case folding earlier in the
            // line, which never shifts these trailing byte positions).
            let orig_trimmed = input.trim_end();
            let orig_unit_at = orig_trimmed.len().checked_sub(unit.len())?;
            let tail_now = orig_trimmed.get(orig_unit_at..)?;
            if !tail_now.eq_ignore_ascii_case(unit) {
                return None;
            }
            // Walk back: unit, spaces, number, spaces, "in".
            let h1 = orig_trimmed[..orig_unit_at].trim_end();
            let n = h1.rsplit(char::is_whitespace).next()?;
            if n != num_token {
                return None;
            }
            let h2 = h1[..h1.len() - n.len()].trim_end();
            if !h2.to_lowercase().ends_with("in") {
                return None;
            }
            let in_at = h2.len() - 2;
            if in_at > 0 && !h2[..in_at].ends_with(char::is_whitespace) {
                return None;
            }
            return Some((in_at, days));
        }
    }
    None
}

fn strip_ordinal(word: &str) -> &str {
    for suffix in ["st", "nd", "rd", "th"] {
        if word.len() > suffix.len() {
            if let Some(num) = word.strip_suffix(suffix) {
                if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                    return num;
                }
            }
        }
    }
    word
}

fn strip_trailing_dot(word: &str) -> &str {
    word.strip_suffix('.').unwrap_or(word)
}

/// Trailing "3 Sep" / "Sep 3" (month words only — a bare trailing number is
/// Trailing "3 Sep" / "Sep 3" (month words only — a bare trailing number is
/// never a date): (match start, day, month). Indices are computed on the
/// original text; words are lowercased only for vocabulary comparison.
fn month_day_tail(input: &str) -> Option<(usize, u32, u32)> {
    let trimmed = input.trim_end();
    let last = trimmed.rsplit(char::is_whitespace).next()?;
    let last_start = trimmed.len() - last.len();
    let head = trimmed[..last_start].trim_end();
    let prev = head.rsplit(char::is_whitespace).next()?;
    if prev.is_empty() || last.is_empty() {
        return None;
    }
    let at = head.len() - prev.len();
    if at > 0 && !head[..at].ends_with(char::is_whitespace) {
        return None;
    }
    let last_lower = last.to_lowercase();
    let prev_lower = prev.to_lowercase();
    let last_word = strip_trailing_dot(&last_lower);
    let prev_word = strip_trailing_dot(&prev_lower);
    // Day-first: "<day> <month>".
    if let Some(month) = month_number(last_word) {
        let stripped = strip_ordinal(prev_word);
        if !stripped.is_empty() && stripped.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(day) = stripped.parse::<u32>() {
                if (1..=31).contains(&day) {
                    return Some((at, day, month));
                }
            }
        }
    }
    // Month-first: "<month> <day>".
    if let Some(month) = month_number(prev_word) {
        let stripped = strip_ordinal(last_word);
        if !stripped.is_empty() && stripped.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(day) = stripped.parse::<u32>() {
                if (1..=31).contains(&day) {
                    return Some((at, day, month));
                }
            }
        }
    }
    None
}

/// Reads the line, consuming at most one date and one time from its tail.
pub fn parse_capture(input: &str, today: &str) -> Capture {
    parse_capture_with_week_start(input, today, week_start_monday())
}

/// [`parse_capture`] with an explicit locale week start (0 = Sunday ..
/// 6 = Saturday) for the "next week" reading.
pub fn parse_capture_with_week_start(input: &str, today: &str, week_start: u32) -> Capture {
    let original = normalize(input);
    let mut rest = original.clone();
    let mut due_date: Option<String> = None;
    let mut due_time: Option<String> = None;
    let mut implied: Option<String> = None;

    // Two passes: either order reads, so "tomorrow at 3pm" and "at 3pm
    // tomorrow" both land. The remainder is trimmed so the connector strip
    // (anchored at the very end) and the next pass both see a clean tail.
    for _ in 0..2 {
        let trimmed = strip_connector(&rest).to_owned();
        if due_time.is_none() {
            if let Some(found) = match_time(&trimmed) {
                due_time = Some(found.value);
                rest = trimmed[..found.rest_len].trim_end().to_owned();
                continue;
            }
        }
        if due_date.is_none() {
            if let Some(found) = match_date(&trimmed, today, week_start % 7) {
                due_date = Some(found.value);
                if found.implied.is_some() {
                    implied = found.implied;
                }
                rest = trimmed[..found.rest_len].trim_end().to_owned();
                continue;
            }
        }
        break;
    }

    let title = strip_connector(&rest).trim().to_owned();
    // Consuming the whole line would leave a task with no name — or with only
    // the connector that introduced the phrase.
    if title.is_empty()
        || ["at", "on", "by", "due", "@"].contains(&title.to_lowercase().as_str())
        || (due_date.is_none() && due_time.is_none())
    {
        return Capture {
            title: original,
            due_date: None,
            due_time: None,
            matched: None,
        };
    }
    // A time needs a day to belong to, which is the contract's rule too.
    if due_date.is_none() {
        due_date = Some(today.to_owned());
    }
    if due_time.is_none() {
        due_time = implied;
    }
    let matched = original[title.len()..].trim();
    Capture {
        title,
        due_date,
        due_time,
        matched: if matched.is_empty() {
            None
        } else {
            Some(matched.to_owned())
        },
    }
}

/// Reads a time on its own, for a field that asks only for one.
pub fn parse_time(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    match_time(trimmed).map(|found| found.value)
}

fn squash(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '_' && *c != '-')
        .collect()
}

/// `#list`: an exact name first, then a prefix only one list starts with.
fn find_list(word: &str, lists: &[ListRef]) -> Option<i64> {
    let wanted = squash(word);
    if wanted.is_empty() {
        return None;
    }
    if let Some(exact) = lists.iter().find(|list| squash(&list.title) == wanted) {
        return Some(exact.id);
    }
    let prefixed: Vec<&ListRef> = lists
        .iter()
        .filter(|list| squash(&list.title).starts_with(&wanted))
        .collect();
    if prefixed.len() == 1 {
        Some(prefixed[0].id)
    } else {
        None
    }
}

fn minutes_of(text: &str) -> Option<u32> {
    let lower = text.to_lowercase();
    // Split optional "<hours>h" head from optional "<mins>m|min" tail.
    let (hours_part, mins_part) = match lower.find('h') {
        Some(h_at) => {
            let (h, rest) = lower.split_at(h_at);
            (Some(h), Some(&rest[1..]))
        }
        None => (None, Some(lower.as_str())),
    };
    let mut total_minutes: Option<f64> = None;
    if let Some(h) = hours_part {
        if h.is_empty() || h.len() > 6 {
            return None;
        }
        // `\d{1,3}(\.\d+)?`
        let (int_part, frac_part) = match h.split_once('.') {
            Some((i, f)) => (i, Some(f)),
            None => (h, None),
        };
        if int_part.len() > 3
            || int_part.is_empty()
            || !int_part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        if let Some(f) = frac_part {
            if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
        }
        total_minutes = Some(h.parse::<f64>().ok()? * 60.0);
    }
    if let Some(m) = mins_part {
        if !m.is_empty() {
            let digits = m.strip_suffix("min").or_else(|| m.strip_suffix('m'))?;
            if digits.len() > 4 || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            let mins: f64 = digits.parse().ok()?;
            total_minutes = Some(total_minutes.unwrap_or(0.0) + mins);
        } else if hours_part.is_none() {
            return None;
        }
    }
    let total = total_minutes?.round() as i64;
    if (1..=7 * 24 * 60).contains(&total) {
        Some(total as u32)
    } else {
        None
    }
}

/// Reads sigil tokens anywhere in the line: `!1`–`!3` (or `!high`), `#list`
/// and `~45m`. A sigil is never ordinary prose, so position does not matter
/// the way it does for dates. The last token of a kind wins; unknown ones
/// stay as text.
pub fn parse_tokens(input: &str, lists: &[ListRef], skip: &[TokenKind]) -> Tokens {
    let mut found = Tokens {
        rest: String::new(),
        priority: None,
        list: None,
        duration: None,
        matched_priority: None,
        matched_list: None,
        matched_duration: None,
    };
    let mut keep: Vec<&str> = Vec::new();
    for word in input.split_whitespace() {
        let mut chars = word.chars();
        let sigil = chars.next();
        let body: String = chars.collect();
        if sigil == Some('!') && !skip.contains(&TokenKind::Priority) {
            if let Some(priority) = Priority::from_token(&body) {
                found.priority = Some(priority);
                found.matched_priority = Some(word.to_owned());
                continue;
            }
        }
        if sigil == Some('#') && !skip.contains(&TokenKind::List) {
            if let Some(id) = find_list(&body, lists) {
                found.list = Some(id);
                found.matched_list = Some(word.to_owned());
                continue;
            }
        }
        if sigil == Some('~') && !skip.contains(&TokenKind::Duration) {
            if let Some(minutes) = minutes_of(&body) {
                found.duration = Some(minutes);
                found.matched_duration = Some(word.to_owned());
                continue;
            }
        }
        keep.push(word);
    }
    found.rest = keep.join(" ");
    found
}

/// The calendar day (`YYYY-MM-DD`) of `now_unix` in a zone `offset_secs`
/// east of UTC — i.e. what "today" means there.
pub fn today_in_zone(now_unix: i64, offset_secs: i32) -> Option<String> {
    let offset = FixedOffset::east_opt(offset_secs)?;
    let naive = chrono::DateTime::from_timestamp(now_unix, 0)?.naive_utc();
    Some(
        offset
            .from_utc_datetime(&naive)
            .date_naive()
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// Resolve a parsed due day plus optional due time to a UTC timestamp.
///
/// * Day only: UTC midnight of that day — zone-independent, so the stored
///   instant never slides across a daylight-saving transition.
/// * Day + time: the wall time interpreted at `offset_secs` (the UTC offset
///   in effect for that date in the user's zone), converted to UTC. Callers
///   must supply the offset valid for the *due date*, not "now": the same
///   wall time maps to different instants across a transition.
pub fn due_timestamp_utc(day: &str, time: Option<&str>, offset_secs: i32) -> Option<i64> {
    let date: NaiveDate = parse_day(day)?;
    match time {
        None => date.and_hms_opt(0, 0, 0)?.and_utc().timestamp().into(),
        Some(clock) => {
            let parsed: NaiveTime = NaiveTime::parse_from_str(clock, "%H:%M").ok()?;
            let naive = date.and_time(parsed);
            let offset = FixedOffset::east_opt(offset_secs)?;
            Some(offset.from_local_datetime(&naive).single()?.timestamp())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A Sunday, so weekday arithmetic is easy to read in the expectations.
    const TODAY: &str = "2026-09-20";
    fn read(input: &str) -> Capture {
        parse_capture(input, TODAY)
    }

    fn lists() -> Vec<ListRef> {
        vec![
            ListRef {
                id: 1,
                title: "Work".to_owned(),
            },
            ListRef {
                id: 2,
                title: "Tasks review".to_owned(),
            },
            ListRef {
                id: 3,
                title: "Reading list".to_owned(),
            },
            ListRef {
                id: 4,
                title: "Research".to_owned(),
            },
        ]
    }

    #[test]
    fn reads_a_day_off_the_end_and_keeps_the_rest_as_title() {
        let got = read("Call Anna tomorrow");
        assert_eq!(got.title, "Call Anna");
        assert_eq!(got.due_date.as_deref(), Some("2026-09-21"));
        assert_eq!(got.due_time, None);
        assert_eq!(got.matched.as_deref(), Some("tomorrow"));

        assert_eq!(
            read("Send the invoice today").due_date.as_deref(),
            Some(TODAY)
        );
        assert_eq!(
            read("Ship the release next week").due_date,
            next_week(TODAY, week_start_monday())
        );
        assert_eq!(
            read("Book the table friday").due_date.as_deref(),
            Some("2026-09-25")
        );
        assert_eq!(
            read("Water the plants in 3 days").due_date.as_deref(),
            Some("2026-09-23")
        );
        assert_eq!(
            read("Renew the domain in 2 weeks").due_date.as_deref(),
            Some("2026-10-04")
        );
    }

    #[test]
    fn reads_a_clock_time_in_either_order_and_drops_the_connector() {
        let both = read("Call Anna tomorrow at 3pm");
        assert_eq!(both.title, "Call Anna");
        assert_eq!(both.due_date.as_deref(), Some("2026-09-21"));
        assert_eq!(both.due_time.as_deref(), Some("15:00"));

        let swapped = read("Call Anna at 3pm tomorrow");
        assert_eq!(swapped.title, "Call Anna");
        assert_eq!(swapped.due_date.as_deref(), Some("2026-09-21"));
        assert_eq!(swapped.due_time.as_deref(), Some("15:00"));

        assert_eq!(read("Standup at 09:30").due_time.as_deref(), Some("09:30"));
        assert_eq!(read("Lunch at noon").due_time.as_deref(), Some("12:00"));
        assert_eq!(
            read("Deploy at midnight").due_time.as_deref(),
            Some("00:00")
        );
        assert_eq!(read("Call at 12am").due_time.as_deref(), Some("00:00"));
        assert_eq!(read("Call at 12pm").due_time.as_deref(), Some("12:00"));
        // A time needs a day to belong to, so a bare time means today.
        assert_eq!(read("Standup at 09:30").due_date.as_deref(), Some(TODAY));
    }

    #[test]
    fn evening_word_carries_its_own_hour_unless_one_was_typed() {
        let tonight = read("Water the plants tonight");
        assert_eq!(tonight.due_date.as_deref(), Some(TODAY));
        assert_eq!(tonight.due_time.as_deref(), Some("20:00"));
        assert_eq!(
            read("Water the plants tonight at 9pm").due_time.as_deref(),
            Some("21:00")
        );
    }

    #[test]
    fn bare_calendar_date_means_the_next_one_not_one_that_has_passed() {
        assert_eq!(
            read("Pay the rent 1 oct").due_date.as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(
            read("Pay the rent oct 1").due_date.as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(
            read("Renew on 3 march").due_date.as_deref(),
            Some("2027-03-03")
        );
        assert_eq!(read("Renew on 3 march").title, "Renew");
        assert_eq!(
            read("Archive 2026-12-24").due_date.as_deref(),
            Some("2026-12-24")
        );
    }

    #[test]
    fn word_in_the_middle_is_never_taken() {
        let friday = read("Meet the Friday team");
        assert_eq!(friday.title, "Meet the Friday team");
        assert_eq!(friday.due_date, None);
        assert_eq!(friday.matched, None);

        assert_eq!(read("Plan tomorrow's standup").due_date, None);
        // The failure mode this parser is built to avoid.
        assert_eq!(read("Check market 5").title, "Check market 5");
        assert_eq!(read("Check market 5").due_date, None);
        assert_eq!(read("Review PR 42").due_date, None);
        assert_eq!(read("Review PR 42").due_time, None);
        assert_eq!(read("Call mom").due_date, None);
        assert_eq!(read("Fix the sat nav").due_date, None);
    }

    #[test]
    fn bare_hour_without_meridiem_is_text_not_a_time() {
        // Faithful to the base: a bare "3" is a guess, and this parser never
        // guesses. "Call Anna tomorrow at 3" keeps its words.
        let got = read("Call Anna tomorrow at 3");
        assert_eq!(got.title, "Call Anna tomorrow at 3");
        assert_eq!(got.due_date, None);
        assert_eq!(got.due_time, None);
        assert_eq!(got.matched, None);
    }

    #[test]
    fn nonsense_times_are_text_not_times() {
        assert_eq!(read("Ship 25:00").due_time, None);
        assert_eq!(read("Ship 12:75").due_time, None);
        assert_eq!(read("Ship 13pm").due_time, None);
    }

    #[test]
    fn line_that_is_only_a_phrase_keeps_its_words() {
        // Otherwise this is a task with no name at all.
        assert_eq!(read("tomorrow").title, "tomorrow");
        assert_eq!(read("tomorrow").due_date, None);
        assert_eq!(read("at 3pm").title, "at 3pm");
        assert_eq!(read("").title, "");
    }

    #[test]
    fn reports_what_it_understood() {
        assert_eq!(
            read("Call Anna tomorrow at 3pm").matched.as_deref(),
            Some("tomorrow at 3pm")
        );
        assert_eq!(
            read("Standup at 09:30").matched.as_deref(),
            Some("at 09:30")
        );
        let spaced = read("Send the report   next   week");
        assert_eq!(spaced.title, "Send the report");
        assert_eq!(spaced.matched.as_deref(), Some("next week"));
    }

    #[test]
    fn sigil_tokens_read_anywhere_and_leave_the_rest_alone() {
        let got = parse_tokens("Ship the draft !1 #tasks ~1h30m tomorrow", &lists(), &[]);
        assert_eq!(got.rest, "Ship the draft tomorrow");
        assert_eq!(got.priority, Some(Priority::High));
        assert_eq!(got.list, Some(2));
        assert_eq!(got.duration, Some(90));
        assert_eq!(got.matched_priority.as_deref(), Some("!1"));
        assert_eq!(got.matched_list.as_deref(), Some("#tasks"));
        assert_eq!(got.matched_duration.as_deref(), Some("~1h30m"));

        // An ambiguous prefix, an unknown word and plain punctuation stay as text.
        assert_eq!(
            parse_tokens("Wow ! #re ~soon", &lists(), &[]).rest,
            "Wow ! #re ~soon"
        );
        let skipped = parse_tokens("Plan #work !low", &lists(), &[TokenKind::List]);
        assert_eq!(skipped.rest, "Plan #work");
        assert_eq!(skipped.priority, Some(Priority::Low));
        assert_eq!(skipped.list, None);
    }

    #[test]
    fn tokens_last_of_a_kind_wins_and_durations_validate() {
        let got = parse_tokens("A !3 !1 ~30m ~2h", &[], &[]);
        assert_eq!(got.priority, Some(Priority::High));
        assert_eq!(got.duration, Some(120));
        assert_eq!(parse_tokens("A ~0m", &[], &[]).duration, None);
        assert_eq!(parse_tokens("A ~999h", &[], &[]).duration, None);
        assert_eq!(parse_tokens("A ~45min", &[], &[]).duration, Some(45));
        assert_eq!(parse_tokens("A ~1.5h", &[], &[]).duration, Some(90));
        assert_eq!(
            parse_tokens("A !MED", &[], &[]).priority,
            Some(Priority::Medium)
        );
    }

    // -- time zones / daylight saving ----------------------------------------

    #[test]
    fn today_in_zone_follows_the_zone_not_utc() {
        // 2026-01-01T00:30:00Z.
        let now = 1_767_227_400;
        assert_eq!(today_in_zone(now, 0).as_deref(), Some("2026-01-01"));
        assert_eq!(today_in_zone(now, 2 * 3600).as_deref(), Some("2026-01-01"));
        // Same instant is still yesterday in New York (UTC-5).
        assert_eq!(today_in_zone(now, -5 * 3600).as_deref(), Some("2025-12-31"));
        // Half-hour zones work too (Mumbai, UTC+5:30).
        assert_eq!(
            today_in_zone(now, 5 * 3600 + 1800).as_deref(),
            Some("2026-01-01")
        );
    }

    #[test]
    fn same_wall_time_maps_to_different_instants_across_spring_forward() {
        // US Eastern springs forward on 2026-03-08 (EST, UTC-5 -> EDT, UTC-4).
        let before = due_timestamp_utc("2026-03-07", Some("09:00"), -5 * 3600).unwrap();
        let after = due_timestamp_utc("2026-03-09", Some("09:00"), -4 * 3600).unwrap();
        // Two calendar days later but only 47 wall-clock hours apart: the
        // lost hour is accounted for instead of shifting the day.
        assert_eq!(after - before, 47 * 3600);
    }

    #[test]
    fn same_wall_time_maps_to_different_instants_across_fall_back() {
        // US Eastern falls back on 2026-11-01 (EDT, UTC-4 -> EST, UTC-5).
        let before = due_timestamp_utc("2026-10-31", Some("09:00"), -4 * 3600).unwrap();
        let after = due_timestamp_utc("2026-11-02", Some("09:00"), -5 * 3600).unwrap();
        // Two calendar days later and 49 real hours apart: the repeated hour
        // is accounted for.
        assert_eq!(after - before, 49 * 3600);
    }

    #[test]
    fn date_only_due_is_zone_stable() {
        // A date with no time resolves to UTC midnight regardless of the
        // caller's offset, so DST can never move it a day.
        let a = due_timestamp_utc("2026-03-08", None, -5 * 3600).unwrap();
        let b = due_timestamp_utc("2026-03-08", None, -4 * 3600).unwrap();
        let c = due_timestamp_utc("2026-03-08", None, 9 * 3600).unwrap();
        assert_eq!(a, b);
        assert_eq!(b, c);
    }

    #[test]
    fn invalid_zone_and_clock_inputs_are_rejected() {
        assert_eq!(today_in_zone(0, 25 * 3600), None);
        assert_eq!(due_timestamp_utc("2027-02-29", None, 0), None);
        assert_eq!(due_timestamp_utc("2026-09-21", Some("24:00"), 0), None);
        assert_eq!(due_timestamp_utc("2026-09-21", Some("9pm"), 0), None);
    }

    // -- locale edge cases ----------------------------------------------------

    #[test]
    fn week_start_locale_changes_next_week() {
        // Sunday 2026-09-20 with a Sunday week start: "next week" is 7 days out.
        let sunday = parse_capture_with_week_start("Ship it next week", TODAY, 0);
        assert_eq!(sunday.due_date.as_deref(), Some("2026-09-27"));
        let monday = parse_capture_with_week_start("Ship it next week", TODAY, 1);
        assert_eq!(monday.due_date.as_deref(), Some("2026-09-21"));
    }

    #[test]
    fn vocabulary_is_case_insensitive_and_ordinal_tolerant() {
        assert_eq!(
            read("Call Anna TOMORROW").due_date.as_deref(),
            Some("2026-09-21")
        );
        assert_eq!(
            read("Book the table FRIDAY").due_date.as_deref(),
            Some("2026-09-25")
        );
        assert_eq!(read("Lunch at NOON").due_time.as_deref(), Some("12:00"));
        assert_eq!(
            read("Pay the rent 1st oct").due_date.as_deref(),
            Some("2026-10-01")
        );
        assert_eq!(
            read("Pay the rent oct. 2").due_date.as_deref(),
            Some("2026-10-02")
        );
        assert_eq!(
            read("Pay the rent 2ND OCT").due_date.as_deref(),
            Some("2026-10-02")
        );
    }

    #[test]
    fn month_first_and_day_first_both_read() {
        // A bare September date before the 20th has passed: next year.
        assert_eq!(
            read("Pay the rent september 5").due_date.as_deref(),
            Some("2027-09-05")
        );
        assert_eq!(
            read("Pay the rent 5 september").due_date.as_deref(),
            Some("2027-09-05")
        );
        // An impossible calendar day is not a date.
        assert_eq!(read("Party 31 february").due_date, None);
    }

    #[test]
    fn parse_time_standalone() {
        assert_eq!(parse_time("3pm").as_deref(), Some("15:00"));
        assert_eq!(parse_time("  09:30 ").as_deref(), Some("09:30"));
        assert_eq!(parse_time("midnight").as_deref(), Some("00:00"));
        assert_eq!(parse_time(""), None);
        assert_eq!(parse_time("3"), None);
    }
}

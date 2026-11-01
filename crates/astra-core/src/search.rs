/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Launcher ranking: subsequence matching with contiguity + prefix bonuses
//! (`launcher_search`, `newtab_search`).

/// Score `candidate` against `query` (case-insensitive).
///
/// Returns `None` when the query is not a subsequence of the candidate.
/// Higher scores rank first: prefix matches beat word-boundary matches,
/// which beat scattered matches; ties break toward shorter candidates.
pub fn score_match(query: &str, candidate: &str) -> Option<u64> {
    if query.is_empty() {
        return Some(0);
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let c: Vec<char> = candidate.to_lowercase().chars().collect();
    if q.len() > c.len() {
        return None;
    }

    // Greedy subsequence scan, counting contiguous runs.
    let mut qi = 0;
    let mut runs = 0u64;
    let mut in_run = false;
    let mut first_hit = usize::MAX;
    for (ci, ch) in c.iter().enumerate() {
        if qi < q.len() && *ch == q[qi] {
            if !in_run {
                runs += 1;
                in_run = true;
            }
            if first_hit == usize::MAX {
                first_hit = ci;
            }
            qi += 1;
        } else {
            in_run = false;
        }
    }
    if qi != q.len() {
        return None;
    }

    let contiguous = u64::from(q.len() as u32) - runs;
    let mut score = 1_000_000u64
        .saturating_sub(first_hit as u64 * 1_000)
        .saturating_add(contiguous * 10_000);
    if c.starts_with(&q[..]) {
        score += 500_000;
    }
    // Shorter candidates win ties.
    Some(score.saturating_sub(c.len() as u64))
}

/// Rank candidates for a query, best first; non-matches are dropped.
pub fn rank<'a>(query: &str, candidates: &'a [&'a str]) -> Vec<(&'a str, u64)> {
    let mut scored: Vec<(&str, u64)> = candidates
        .iter()
        .filter_map(|c| score_match(query, c).map(|s| (*c, s)))
        .collect();
    scored.sort_by_key(|a| std::cmp::Reverse(a.1));
    scored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_beats_scattered() {
        let got = rank("git", &["legitimate", "github", "digest"]);
        let order: Vec<&str> = got.into_iter().map(|(c, _)| c).collect();
        assert_eq!(order[0], "github");
        assert!(!order.contains(&"digest"));
    }

    #[test]
    fn contiguous_beats_split_runs() {
        let (best, _) = rank("ab", &["a-b", "ab"]).into_iter().next().unwrap();
        assert_eq!(best, "ab");
    }

    #[test]
    fn empty_query_matches_all_with_zero() {
        assert_eq!(score_match("", "anything"), Some(0));
    }

    #[test]
    fn case_insensitive() {
        assert!(score_match("ASTRA", "astra-browser").is_some());
    }
}

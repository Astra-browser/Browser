/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! History query shapes and pure filtering (`history_*`).

use serde::{Deserialize, Serialize};

/// One history visit.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    /// Unix seconds.
    pub visited_at: i64,
}

/// Query parameters for a history lookup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HistoryFilter<'a> {
    pub query: &'a str,
    pub limit: usize,
}

/// Case-insensitive substring filter over URL + title, most-recent-first.
pub fn filter_history<'a>(
    entries: &'a [HistoryEntry],
    filter: &HistoryFilter<'_>,
) -> Vec<&'a HistoryEntry> {
    let needle = filter.query.to_lowercase();
    let mut out: Vec<&HistoryEntry> = entries
        .iter()
        .filter(|e| {
            needle.is_empty()
                || e.url.to_lowercase().contains(&needle)
                || e.title.to_lowercase().contains(&needle)
        })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.visited_at));
    out.truncate(filter.limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<HistoryEntry> {
        vec![
            HistoryEntry {
                url: "https://example.com/docs".to_owned(),
                title: "Docs".to_owned(),
                visited_at: 3,
            },
            HistoryEntry {
                url: "https://other.test/".to_owned(),
                title: "Other".to_owned(),
                visited_at: 5,
            },
            HistoryEntry {
                url: "https://example.com/blog".to_owned(),
                title: "Blog".to_owned(),
                visited_at: 4,
            },
        ]
    }

    #[test]
    fn filters_and_orders_most_recent_first() {
        let entries = sample();
        let got = filter_history(&entries, &HistoryFilter { query: "EXAMPLE", limit: 10 });
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].visited_at, 4);
        assert_eq!(got[1].visited_at, 3);
    }

    #[test]
    fn limit_applies() {
        let entries = sample();
        let got = filter_history(&entries, &HistoryFilter { query: "", limit: 1 });
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].visited_at, 5);
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Title extraction for notes: the first Markdown heading wins, rendered
//! as plain text. Anything without a heading falls back to the file stem.

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

/// Longest title kept; headings are one line, but hostile files are not.
pub const MAX_TITLE_CHARS: usize = 200;

/// Plain-text title of `markdown`, or `fallback` when no heading exists.
///
/// Only the first heading is read, so a large note costs one parse pass
/// that stops early. Inline markup (emphasis, code, links) contributes its
/// literal text; the shape of the markup is dropped.
pub fn extract_title(markdown: &str, fallback: &str) -> String {
    let mut in_heading = false;
    let mut started = false;
    let mut text = String::new();
    for event in Parser::new(markdown) {
        match event {
            Event::Start(Tag::Heading { .. }) => {
                if started {
                    break;
                }
                started = true;
                in_heading = true;
            }
            Event::End(TagEnd::Heading(_)) => break,
            Event::Text(code) | Event::Code(code) if in_heading => {
                text.push_str(&code);
            }
            _ => {}
        }
    }
    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        fallback.to_owned()
    } else {
        let mut short: String = title.chars().take(MAX_TITLE_CHARS).collect();
        if short.len() < title.len() {
            short.push('…');
        }
        short
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_heading_wins_and_markup_is_flattened() {
        let title = extract_title("# Hello *wide* `world`\n\n# Second\n", "note");
        assert_eq!(title, "Hello wide world");
    }

    #[test]
    fn no_heading_falls_back_to_stem() {
        assert_eq!(extract_title("just *text*\n", "shopping"), "shopping");
        assert_eq!(extract_title("", "empty"), "empty");
    }

    #[test]
    fn heading_whitespace_collapses_and_long_titles_clip() {
        assert_eq!(
            extract_title("#  a   b\nc\n", "x"),
            "a b",
            "soft-wrapped heading text joins with spaces"
        );
        let long = format!("# {}\n", "w".repeat(300));
        let title = extract_title(&long, "x");
        assert!(title.chars().count() <= MAX_TITLE_CHARS + 1);
        assert!(title.ends_with('…'));
    }
}

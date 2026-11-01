/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Host canonicalization for time tracking and focus blocking.
//!
//! All per-site keys (totals, focus rules, block verdicts) go through
//! [`canonical_host`] so trivial URL tricks cannot bypass focus mode:
//! case, a `www.` prefix, an explicit port, userinfo, a trailing dot,
//! and scheme/path/query/fragment noise all collapse to one key.
//! IPv6 literals (`[::1]`) keep their brackets.

/// Canonical per-site key for a URL or bare host.
///
/// - trims whitespace, lower-cases
/// - strips any `scheme://` prefix
/// - drops path, query, and fragment
/// - drops `userinfo@`
/// - drops `:port` (IPv6 `[..]` literals exempt)
/// - strips one trailing `.` (FQDN root) and one leading `www.` label
///
/// Returns `""` when nothing host-like remains.
pub fn canonical_host(input: &str) -> String {
    let mut s = input.trim().to_lowercase();
    if s.is_empty() {
        return String::new();
    }
    if let Some(idx) = s.find("://") {
        s = s[idx + 3..].to_string();
    }
    // Authority is everything before the first path/query/fragment delimiter.
    let end = s.find(['/', '?', '#']).unwrap_or(s.len());
    let mut auth = s[..end].to_string();
    // Drop userinfo.
    if let Some(idx) = auth.rfind('@') {
        auth = auth[idx + 1..].to_string();
    }
    // Drop port, unless this is an IPv6 literal.
    let mut host = if auth.starts_with('[') {
        match auth.find(']') {
            Some(close) => auth[..=close].to_string(),
            None => auth,
        }
    } else if let Some(idx) = auth.rfind(':') {
        // A second colon means a bare (unbracketed) IPv6 literal: keep it.
        if auth[..idx].contains(':') {
            auth
        } else {
            auth[..idx].to_string()
        }
    } else {
        auth
    };
    host = host.trim_end_matches('.').to_string();
    if let Some(rest) = host.strip_prefix("www.") {
        if !rest.is_empty() {
            host = rest.to_string();
        }
    }
    host
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalization_collapses_bypass_variants() {
        let expected = "example.com";
        for variant in [
            "https://example.com/page?q=1#f",
            "https://EXAMPLE.COM/other",
            "https://www.example.com/",
            "https://WWW.Example.COM:443/x",
            "http://example.com:8080/x",
            "http://user:pass@example.com/x",
            "example.com",
            "  Example.COM.  ",
            "www.example.com",
        ] {
            assert_eq!(canonical_host(variant), expected, "variant: {variant}");
        }
    }

    #[test]
    fn ipv6_and_empty_inputs() {
        assert_eq!(canonical_host("http://[::1]:8080/x"), "[::1]");
        assert_eq!(canonical_host(""), "");
        assert_eq!(canonical_host("   "), "");
        assert_eq!(canonical_host("https://"), "");
    }
}

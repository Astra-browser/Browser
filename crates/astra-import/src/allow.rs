/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Navigation allow-list for imported URLs: only `http(s)` pages (and
//! `about:blank`) may be imported. Blocks `file:`, `javascript:`, internal
//! and external app schemes, over-long URLs, credentials-bearing URLs and
//! reserved internal pseudo-hosts. Mirrors the base browser's navigation
//! policy so bounding keeps exactly what the browser itself would open.

use url::Url;

const MAX_URL_BYTES: usize = 8 * 1024;
const RESERVED_HOSTS: &[&str] = &["asset.localhost", "ipc.localhost"];

/// Whether a resolved URL may be kept as an import.
pub fn is_allowed(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    matches!(url.scheme(), "http" | "https")
        && url.as_str().len() <= MAX_URL_BYTES
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .host_str()
            .is_some_and(|host| !RESERVED_HOSTS.contains(&host))
}

/// String gate used when bounding imported trees.
pub fn is_allowed_str(url: &str) -> bool {
    Url::parse(url)
        .map(|parsed| is_allowed(&parsed))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_web_pages_pass() {
        assert!(is_allowed_str("https://example.com/docs"));
        assert!(is_allowed_str("http://example.com/"));
        assert!(!is_allowed_str("javascript:alert(1)"));
        assert!(!is_allowed_str("file:///C:/notes.txt"));
        assert!(!is_allowed_str("chrome://settings/"));
        assert!(!is_allowed_str("edge://favorites/"));
        assert!(!is_allowed_str("about:config"));
        assert!(!is_allowed_str("https://user:secret@example.com/"));
        assert!(!is_allowed_str("not a url"));
    }
}

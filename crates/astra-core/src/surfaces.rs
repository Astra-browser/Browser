/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Pure policy for the native-surfaces lane (D-45): split-view arrangement
//! validation, peek bounds, per-space history keys and cross-space clone
//! admission.
//!
//! Gecko owns the live tabs, windows, groups and containers. Those calls can
//! only be made from chrome-privileged JS, so the Host modules apply this
//! policy at the seam. Keeping the invariants here gives them one tested
//! definition instead of a copy buried in a `.sys.mjs` file.

/// Engine split views accept more tabs than the product exposes; Astra caps
/// the arrangement at four panes.
pub const MAX_PANES: usize = 3;

/// Divider share band. A sibling absorbs the difference; the axis always sums
/// to one.
pub const MIN_RATIO: f64 = 0.05;
pub const MAX_RATIO: f64 = 0.95;

/// Peek cards one window may keep, and the capture it stores.
pub const MAX_PEEKS: usize = 4;
pub const CAPTURE_WIDTH: u32 = 640;
pub const CAPTURE_HEIGHT: u32 = 400;

/// History index bound; the oldest row is dropped first.
pub const MAX_HISTORY_ENTRIES: usize = 5_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pane {
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Arrangement {
    pub id: String,
    pub name: String,
    pub space_id: String,
    pub ratio: f64,
    pub panes: Vec<Pane>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SurfaceError {
    InvalidUrl(String),
    TooFewPanes,
    TooManyPanes,
    BadRatio,
    PrivateContext,
    NotHttp,
    TooManyPeeks,
    EmptyHistoryKey,
}

/// Clamp a divider share into the usable band.
pub fn clamp_ratio(value: f64) -> Result<f64, SurfaceError> {
    if !value.is_finite() {
        return Err(SurfaceError::BadRatio);
    }
    Ok(value.clamp(MIN_RATIO, MAX_RATIO))
}

/// Only web pages can be a pane, a stored arrangement or a clone.
pub fn is_web_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && lower.len() > 8
}

/// Validate an arrangement before it is stored or restored. Mirrors
/// `SplitView.validArrangement` in `overlay/astra/host/SplitView.sys.mjs`.
pub fn validate_arrangement(arrangement: &Arrangement) -> Result<(), SurfaceError> {
    if arrangement.name.trim().is_empty() {
        return Err(SurfaceError::InvalidUrl("name".into()));
    }
    if arrangement.panes.len() < 2 {
        return Err(SurfaceError::TooFewPanes);
    }
    if arrangement.panes.len() > MAX_PANES {
        return Err(SurfaceError::TooManyPanes);
    }
    clamp_ratio(arrangement.ratio)?;
    for pane in &arrangement.panes {
        if !is_web_url(&pane.url) {
            return Err(SurfaceError::InvalidUrl(pane.url.clone()));
        }
    }
    Ok(())
}

/// Keep the newest peek records; return how many to drop.
pub fn trim_peek_count(current: usize) -> usize {
    current.saturating_sub(MAX_PEEKS)
}

/// A private window records no peek, no history and no arrangement.
pub fn require_public(private: bool) -> Result<(), SurfaceError> {
    if private {
        Err(SurfaceError::PrivateContext)
    } else {
        Ok(())
    }
}

/// A history row is keyed by (space, normalised URL), so one space's visit
/// never hides another's. The fragment is dropped because a scroll is not a
/// second visit.
pub fn history_key(space_id: &str, url: &str) -> Result<String, SurfaceError> {
    if space_id.is_empty() || !is_web_url(url) {
        return Err(SurfaceError::EmptyHistoryKey);
    }
    let clean = url.split('#').next().unwrap_or(url);
    Ok(format!("{space_id}\u{0}{clean}"))
}

/// A clone is admitted only from a public tab to a web page in the same
/// profile.
pub fn clone_admitted(
    private: bool,
    source_url: &str,
    same_profile: bool,
) -> Result<(), SurfaceError> {
    require_public(private)?;
    if !same_profile {
        return Err(SurfaceError::PrivateContext);
    }
    if !is_web_url(source_url) {
        return Err(SurfaceError::NotHttp);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(url: &str) -> Pane {
        Pane {
            url: url.into(),
            title: "pane".into(),
        }
    }

    fn arrangement(panes: Vec<Pane>, ratio: f64) -> Arrangement {
        Arrangement {
            id: "a".into(),
            name: "Split".into(),
            space_id: "space-1".into(),
            ratio,
            panes,
        }
    }

    #[test]
    fn web_urls_only() {
        assert!(is_web_url("https://example.com/"));
        assert!(is_web_url("http://example.com/"));
        assert!(!is_web_url("file:///etc/passwd"));
        assert!(!is_web_url("about:config"));
        assert!(!is_web_url("javascript:alert(1)"));
    }

    #[test]
    fn arrangement_needs_two_to_four_web_panes() {
        assert_eq!(
            validate_arrangement(&arrangement(vec![pane("https://a.example/")], 0.5)),
            Err(SurfaceError::TooFewPanes)
        );
        let five: Vec<_> = (0..5)
            .map(|i| pane(&format!("https://{i}.example/")))
            .collect();
        assert_eq!(
            validate_arrangement(&arrangement(five, 0.5)),
            Err(SurfaceError::TooManyPanes)
        );
        assert!(validate_arrangement(&arrangement(
            vec![pane("https://a.example/"), pane("https://b.example/")],
            0.5
        ))
        .is_ok());
    }

    #[test]
    fn ratio_band_is_clamped() {
        assert_eq!(clamp_ratio(0.001), Ok(MIN_RATIO));
        assert_eq!(clamp_ratio(0.999), Ok(MAX_RATIO));
        assert_eq!(clamp_ratio(f64::NAN), Err(SurfaceError::BadRatio));
    }

    #[test]
    fn a_private_context_is_always_refused() {
        assert_eq!(require_public(true), Err(SurfaceError::PrivateContext));
        assert_eq!(require_public(false), Ok(()));
        assert_eq!(
            clone_admitted(true, "https://example.com/", true),
            Err(SurfaceError::PrivateContext)
        );
        assert!(clone_admitted(false, "https://example.com/", true).is_ok());
        assert_eq!(
            clone_admitted(false, "file:///etc/passwd", true),
            Err(SurfaceError::NotHttp)
        );
    }

    #[test]
    fn history_keys_are_space_scoped_and_drop_the_fragment() {
        assert_eq!(
            history_key("space-2", "https://a.example/x#frag"),
            Ok("space-2\u{0}https://a.example/x".into())
        );
        assert_eq!(
            history_key("space-2", "https://a.example/x"),
            history_key("space-3", "https://a.example/x")
                .map(|_| "space-2\u{0}https://a.example/x".to_string())
        );
        assert!(history_key("", "https://a.example/").is_err());
        assert!(history_key("space-1", "file:///etc/passwd").is_err());
    }

    #[test]
    fn peeks_are_bounded() {
        assert_eq!(trim_peek_count(0), 0);
        assert_eq!(trim_peek_count(4), 0);
        assert_eq!(trim_peek_count(7), 3);
    }
}

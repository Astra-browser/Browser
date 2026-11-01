/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Fixture corpus for `astra-blocker` (P4-T01).
//!
//! The fixtures encode the base snapshot's blocked-request semantics in
//! EasyList syntax: basic blocks, exceptions, `$important` overrides,
//! `$third-party` / `$domain` / resource-type scoping, and cosmetic
//! hide/exception rules. They must keep passing against the real seed lists
//! (see `seed_smoke` below), which pins behavioral parity.

use astra_blocker::{Blocker, BlockerError, ListSource, ListUpdateError, NetworkRequest, Verdict};

const FIXTURE_LIST: &str = r#"
[Adblock Plus 2.0]
! network fixtures
||ads.fixture.invalid^
||tracker.thirdtest.com^$third-party
||scoped.fixture.invalid^$domain=shop.fixture.invalid
||typed.fixture.invalid/banner.js$script
@@||allow.fixture.invalid^
||mixed.fixture.invalid^
@@||mixed.fixture.invalid^$domain=news.fixture.invalid
||stern.fixture.invalid^
@@||stern.fixture.invalid^
||stern.fixture.invalid^$important
! cosmetic fixtures
shop.fixture.invalid##.sponsored-card
shop.fixture.invalid##.sidebar-ad
##.generic-fixture-ad
news.fixture.invalid#@#.generic-fixture-ad
"#;

fn fixture_blocker() -> Blocker {
    Blocker::from_lists(&[ListSource::new("fixtures", FIXTURE_LIST.to_string())])
        .expect("fixture list must compile")
}

fn check(blocker: &Blocker, url: &str, source: &str, kind: &str) -> Verdict {
    blocker.check(&NetworkRequest::new(url, source, kind))
}

#[test]
fn basic_block_and_unlisted_allow() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://ads.fixture.invalid/pixel.gif",
            "https://shop.fixture.invalid/",
            "image"
        ),
        Verdict::Block
    );
    assert_eq!(
        check(
            &blocker,
            "https://cdn.fixture.invalid/app.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Allow
    );
}

#[test]
fn third_party_option_scope() {
    let blocker = fixture_blocker();
    // First-party embedding is allowed …
    // (third-party detection needs a public-suffix-list TLD, hence .com).
    assert_eq!(
        check(
            &blocker,
            "https://tracker.thirdtest.com/t.js",
            "https://tracker.thirdtest.com/page",
            "script"
        ),
        Verdict::Allow
    );
    // … third-party embedding is blocked.
    assert_eq!(
        check(
            &blocker,
            "https://tracker.thirdtest.com/t.js",
            "https://shop.fixtureshop.com/",
            "script"
        ),
        Verdict::Block
    );
}

#[test]
fn domain_option_scope() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://scoped.fixture.invalid/a.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Block
    );
    assert_eq!(
        check(
            &blocker,
            "https://scoped.fixture.invalid/a.js",
            "https://other.fixture.invalid/",
            "script"
        ),
        Verdict::Allow
    );
}

#[test]
fn resource_type_scope() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://typed.fixture.invalid/banner.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Block
    );
    assert_eq!(
        check(
            &blocker,
            "https://typed.fixture.invalid/banner.js",
            "https://shop.fixture.invalid/",
            "image"
        ),
        Verdict::Allow
    );
}

#[test]
fn exception_overrides_block() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://allow.fixture.invalid/x.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Allow
    );
    // Scoped exception: only the listed document domain is spared.
    assert_eq!(
        check(
            &blocker,
            "https://mixed.fixture.invalid/x.js",
            "https://news.fixture.invalid/",
            "script"
        ),
        Verdict::Allow
    );
    assert_eq!(
        check(
            &blocker,
            "https://mixed.fixture.invalid/x.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Block
    );
}

#[test]
fn important_overrides_exception() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://stern.fixture.invalid/x.js",
            "https://shop.fixture.invalid/",
            "script"
        ),
        Verdict::Block
    );
}

#[test]
fn unparseable_requests_allow() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(&blocker, "not a url", "also not a url", "script"),
        Verdict::Allow
    );
}

#[test]
fn document_type_requests_check() {
    let blocker = fixture_blocker();
    assert_eq!(
        check(
            &blocker,
            "https://ads.fixture.invalid/landing",
            "https://ads.fixture.invalid/landing",
            "document"
        ),
        Verdict::Block
    );
}

#[test]
fn cosmetic_specific_and_generic_selectors() {
    let blocker = fixture_blocker();
    // Observed page classes/ids drive the generic rule lookup.
    let selectors = blocker.cosmetic_selectors(
        "https://shop.fixture.invalid/item",
        &["sponsored-card", "sidebar-ad", "generic-fixture-ad"],
        &[],
    );
    assert!(selectors.contains(&".sponsored-card".to_string()));
    assert!(selectors.contains(&".sidebar-ad".to_string()));
    assert!(selectors.contains(&".generic-fixture-ad".to_string()));
}

#[test]
fn cosmetic_exception_hides_generic_rule() {
    let blocker = fixture_blocker();
    let selectors = blocker.cosmetic_selectors(
        "https://news.fixture.invalid/article",
        &["generic-fixture-ad"],
        &[],
    );
    assert!(
        !selectors.contains(&".generic-fixture-ad".to_string()),
        "news exception must suppress the generic selector, got {selectors:?}"
    );
}

#[test]
fn cosmetic_empty_for_unknown_page() {
    let blocker = fixture_blocker();
    // No hostname-specific rules exist here, but the generic rule still
    // applies to every page once the class is observed …
    let selectors = blocker.cosmetic_selectors(
        "https://plain.fixture.invalid/",
        &["generic-fixture-ad"],
        &[],
    );
    assert!(selectors.contains(&".generic-fixture-ad".to_string()));
    // … while unlisted classes yield nothing.
    assert!(blocker
        .cosmetic_selectors("https://plain.fixture.invalid/", &["no-such-class"], &[])
        .is_empty());
}

#[test]
fn global_toggle_disables_everything() {
    let mut blocker = fixture_blocker();
    blocker.set_enabled(false);
    assert!(!blocker.is_enabled());
    assert!(!blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
    assert!(blocker
        .cosmetic_selectors(
            "https://shop.fixture.invalid/item",
            &["sponsored-card"],
            &[]
        )
        .is_empty());
    blocker.set_enabled(true);
    assert!(blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
}

#[test]
fn per_site_toggle_pauses_one_host() {
    let mut blocker = fixture_blocker();
    blocker.set_site_enabled("shop.fixture.invalid", false);
    assert!(!blocker.is_site_enabled("shop.fixture.invalid"));
    assert!(!blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
    assert!(blocker
        .cosmetic_selectors(
            "https://shop.fixture.invalid/item",
            &["sponsored-card"],
            &[]
        )
        .is_empty());
    // Other sites are unaffected …
    assert!(blocker.is_site_enabled("news.fixture.invalid"));
    assert!(blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://news.fixture.invalid/",
        "image"
    ));
    // … and host matching is case-insensitive.
    blocker.set_site_enabled("SHOP.FIXTURE.INVALID", true);
    assert!(blocker.is_site_enabled("shop.fixture.invalid"));
}

#[test]
fn site_controls_round_trip_through_serde() {
    let mut blocker = fixture_blocker();
    blocker.set_site_enabled("paused.fixture.invalid", false);
    let json = serde_json::to_string(blocker.site_controls()).expect("controls must serialize");
    let restored: astra_blocker::SiteControls =
        serde_json::from_str(&json).expect("controls must deserialize");
    assert!(!restored.is_site_enabled("paused.fixture.invalid"));
    assert!(restored.is_site_enabled("other.fixture.invalid"));
    let mut second = fixture_blocker();
    second.set_site_controls(restored);
    assert!(!second.is_site_enabled("paused.fixture.invalid"));
}

#[test]
fn update_rejects_empty_candidate() {
    let mut blocker = fixture_blocker();
    let before = blocker.rule_count();
    let err = blocker.update_lists(&[]).expect_err("empty must fail");
    assert!(matches!(err, BlockerError::Update(ListUpdateError::Empty)));
    assert_eq!(blocker.rule_count(), before);
}

#[test]
fn update_rejects_bad_ids_and_oversize() {
    let mut blocker = fixture_blocker();
    assert!(matches!(
        blocker
            .update_lists(&[ListSource::new("", "||a.invalid^".to_string())])
            .expect_err("empty id must fail"),
        BlockerError::Update(ListUpdateError::BadId(_))
    ));
    let dup = || ListSource::new("dup", "||a.invalid^".to_string());
    assert!(matches!(
        blocker
            .update_lists(&[dup(), dup()])
            .expect_err("duplicate id must fail"),
        BlockerError::Update(ListUpdateError::BadId(_))
    ));
    assert!(matches!(
        blocker
            .update_lists(&[ListSource::new("big", String::new())])
            .expect_err("empty text must fail"),
        BlockerError::Update(ListUpdateError::BadLength(_, _))
    ));
}

#[test]
fn update_rejects_suspicious_shrinkage_and_keeps_working_engine() {
    let mut blocker = fixture_blocker();
    let tiny = vec![ListSource::new("tiny", "||one.invalid^\n".to_string())];
    let err = blocker
        .update_lists(&tiny)
        .expect_err("collapsed corpus must fail");
    assert!(matches!(
        err,
        BlockerError::Update(ListUpdateError::Shrinkage(_, _))
    ));
    // The previous engine is still installed.
    assert!(blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
}

#[test]
fn update_swaps_engine_on_success() {
    let mut blocker = fixture_blocker();
    // The replacement must stay above the shrinkage floor (50 % of 14).
    let replacement = (0..8)
        .map(|index| format!("||fresh{index}.fixture.invalid^"))
        .collect::<Vec<_>>()
        .join("\n");
    let report = blocker
        .update_lists(&[ListSource::new("replacement", replacement)])
        .expect("replacement above the shrinkage floor must be accepted");
    assert_eq!(report.total_rules, 8);
    assert_eq!(report.lists.len(), 1);
    assert_eq!(report.lists[0].id, "replacement");
    assert!(!blocker.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
    assert!(blocker.should_block(
        "https://fresh3.fixture.invalid/x.js",
        "https://shop.fixture.invalid/",
        "script"
    ));
    assert!(!blocker.active_lists().is_empty());
}

#[test]
fn snapshot_serialize_restore_round_trip() {
    let blocker = fixture_blocker();
    let bytes = blocker.serialize();
    assert!(!bytes.is_empty());
    let mut restored = Blocker::new();
    restored
        .restore_snapshot(&bytes)
        .expect("snapshot must restore");
    assert!(restored.should_block(
        "https://ads.fixture.invalid/pixel.gif",
        "https://shop.fixture.invalid/",
        "image"
    ));
    assert!(!restored.should_block(
        "https://cdn.fixture.invalid/app.js",
        "https://shop.fixture.invalid/",
        "script"
    ));
}

#[test]
fn snapshot_restore_rejects_garbage() {
    let mut blocker = fixture_blocker();
    assert!(restored_is_err(&mut blocker));
}

fn restored_is_err(blocker: &mut Blocker) -> bool {
    blocker
        .restore_snapshot(b"definitely not a compiled engine")
        .is_err()
}

#[test]
fn seed_lists_load_and_block_consistently() {
    let sources = astra_blocker::seed_lists().expect("seed must load");
    assert_eq!(sources.len(), 2);
    assert_eq!(sources[0].id, "easylist");
    assert_eq!(sources[1].id, "easyprivacy");

    // Self-consistent spot check: take the first `||domain^` rule from the
    // seed and require the engine to block that domain. This pins parity
    // with the seed content without hardcoding third-party hosts.
    let seed_text = sources[0].text.clone();
    let probe = seed_text
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("||") && line.contains('^'))
        .find(|line| {
            !line.contains('$') && !line.contains('*') && !line.contains(',') && !line.contains('/')
        })
        .expect("seed must contain a plain blocking rule");
    let domain = probe.trim_start_matches("||").split('^').next().unwrap();

    let blocker = Blocker::from_lists(&sources).expect("seed must compile");
    assert!(
        blocker.rule_count() > 50_000,
        "seed rule count unexpectedly small: {}",
        blocker.rule_count()
    );
    assert!(
        blocker.should_block(
            &format!("https://{domain}/ads.js"),
            "https://shop.fixture.invalid/",
            "script"
        ),
        "seed rule {probe} did not block"
    );
    assert!(!blocker.should_block(
        "https://cdn.fixture.invalid/app.js",
        "https://shop.fixture.invalid/",
        "script"
    ));
}

#[test]
fn seed_attribution_files_present() {
    for file in [
        "seed/v1/NOTICE",
        "seed/v1/LICENSE-CC-BY-SA-3.0.txt",
        "seed/v1/catalog.json",
        "seed/v1/release-seed.json",
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
        assert!(path.is_file(), "missing seed attribution file {file}");
    }
    let notice = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("seed/v1/NOTICE"),
    )
    .expect("NOTICE must be readable");
    assert!(notice.contains("EasyList"));
    assert!(notice.contains("CC BY-SA"));
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Regression cover for the public benchmark inventories.
//!
//! `blocker/lists/astra-telemetry.txt` carries the hand-maintained heuristics
//! plus the generated strict sections; this test compiles the real packaged
//! seed and proves the shape the public tests use:
//!
//!   * a `fetch(no-cors)` beacon to every inventoried host is blocked, for
//!     every request type, not just `script` or `image`;
//!   * the local script baits (`/advertisement.js`, `/analytics.js`) are
//!     blocked as scripts while a nested `assets/analytics.js` is not;
//!   * the class/id cosmetic baits resolve for a document that only has the
//!     name in hand — the shape a node inserted after load produces.
//!
//! The host list is read from the reviewed inventory, so a host that is added
//! to the benchmark without a rule fails here instead of only on the live site.

use astra_blocker::{Blocker, ListSource, NetworkRequest, Verdict};
use flate2::read::GzDecoder;
use std::io::Read;
use std::path::PathBuf;

const TELEMETRY_GZ: &[u8] = include_bytes!("../../../blocker/seed/astra-telemetry.txt.gz");
// Every request type the channel hook can hand to the engine. The probes use
// a fetch, which Gecko labels `xmlhttprequest`; a beacon or an image pixel
// must hit the same rule.
const REQUEST_TYPES: [&str; 6] = [
    "xmlhttprequest",
    "other",
    "image",
    "script",
    "ping",
    "subdocument",
];
const PAGE: &str = "https://adblocktester.pages.dev/";

fn telemetry_blocker() -> Blocker {
    let mut text = String::new();
    GzDecoder::new(TELEMETRY_GZ)
        .read_to_string(&mut text)
        .expect("packaged telemetry seed must decompress");
    Blocker::from_lists(&[ListSource::new("astra-telemetry", text)])
        .expect("packaged telemetry seed must compile")
}

fn inventory() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../blocker/lists/adblocktester-hosts.json");
    let bytes = std::fs::read(&path).expect("Adblock Tester inventory must exist");
    serde_json::from_slice(&bytes).expect("Adblock Tester inventory must be valid JSON")
}

fn blocked(blocker: &Blocker, url: &str, request_type: &str) -> bool {
    blocker.check(&NetworkRequest::new(url, PAGE, request_type)) == Verdict::Block
}

#[test]
fn every_inventoried_host_is_blocked_for_every_request_type() {
    let blocker = telemetry_blocker();
    let inventory = inventory();
    let mut failures = Vec::new();
    for entry in inventory["hosts"].as_array().expect("hosts array") {
        let host = entry["host"].as_str().expect("host string");
        for request_type in REQUEST_TYPES {
            let url = format!("https://{host}/favicon.ico?adblocktester=1");
            if !blocked(&blocker, &url, request_type) {
                failures.push(format!("{host} ({request_type})"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "reachable benchmark hosts: {failures:?}"
    );
}

#[test]
fn local_script_baits_are_blocked_and_nested_scripts_are_not() {
    let blocker = telemetry_blocker();
    for file in ["advertisement.js", "analytics.js", "ads.js", "pagead.js"] {
        let url = format!("https://adblocktester.pages.dev/{file}");
        assert!(
            blocked(&blocker, &url, "script"),
            "/{file} bait must be blocked as a script"
        );
    }
    // The rules match by file name, so an unlisted script name under the same
    // directory is untouched.
    for url in [
        "https://adblocktester.pages.dev/assets/index.js",
        "https://adblocktester.pages.dev/js/myanalytics.js",
        "https://adblocktester.pages.dev/assets/analytics.min.js",
    ] {
        assert!(
            !blocked(&blocker, url, "script"),
            "{url} must not be caught by the bait heuristic"
        );
    }
}

#[test]
fn cosmetic_baits_resolve_from_a_bare_name() {
    let blocker = telemetry_blocker();
    let page = "https://hop.fixture.invalid/";
    for class in ["adsbox", "ad-banner", "adsbygoogle", "google-ad"] {
        let selectors = blocker.cosmetic_selectors(page, &[class], &[]);
        assert!(
            selectors.iter().any(|selector| selector.contains(class)),
            "class bait {class} must resolve to a selector, got {selectors:?}"
        );
    }
    let selectors = blocker.cosmetic_selectors(page, &[], &["ad-container"]);
    assert!(
        selectors
            .iter()
            .any(|selector| selector.contains("ad-container")),
        "id bait ad-container must resolve to a selector, got {selectors:?}"
    );
}

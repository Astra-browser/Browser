/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! blocker-probe: in-process microbench for the `astra-blocker` engine.
//!
//! P4-T10 requires the blocker overhead number to come from `astra-blocker`
//! called directly in-process (not through a browser or a proxy), so this
//! tiny binary links the crate by path and times `Blocker::check()` over a
//! deterministic synthetic corpus. Driven by `../bench_blocker.py`, which
//! runs it 3x and takes the median p95. Stdout is one JSON object.

use astra_blocker::{Blocker, NetworkRequest};
use std::time::Instant;

const MEASURE_ITERS: usize = 30_000;
const WARMUP_ITERS: usize = 2_000;

// Deterministic corpus: known ad/tracker patterns (expected Block) mixed
// with benign first-party-looking URLs (expected Allow). Hosts are inline so
// the probe needs no network and no fixture server.
const AD_PATTERNS: &[(&str, &str)] = &[
    ("https://ads.doubleclick.net/gpt/pubads_impl.js", "script"),
    ("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", "script"),
    ("https://connect.facebook.net/en_US/fbevents.js", "script"),
    ("https://www.google-analytics.com/analytics.js", "script"),
    ("https://stats.g.doubleclick.net/collect?v=1", "image"),
    ("https://tracker.example-tracker-01.com/pixel.gif", "image"),
    ("https://cdn.example-tracker-02.com/beacon.min.js", "script"),
    ("https://ads.example-adnet-03.com/banner/300x250?id=9", "image"),
    ("https://metrics.example-metrics-04.net/track?e=pageview", "xmlhttprequest"),
    ("https://sync.example-sync-05.com/usersync?pid=3", "xmlhttprequest"),
];

const BENIGN_HOSTS: &[&str] = &[
    "news.example.com",
    "docs.example.org",
    "mail.example.net",
    "code.example.dev",
];

fn build_corpus() -> Vec<NetworkRequest> {
    let mut corpus = Vec::with_capacity(4_000);
    for (url, kind) in AD_PATTERNS {
        corpus.push(NetworkRequest::new(url, "https://news.example.com/", kind));
    }
    for i in 0..3_990 {
        let host = BENIGN_HOSTS[i % BENIGN_HOSTS.len()];
        let kind = match i % 4 {
            0 => "script",
            1 => "image",
            2 => "xmlhttprequest",
            _ => "document",
        };
        corpus.push(NetworkRequest::new(
            &format!("https://{host}/assets/app-{i}.js"),
            &format!("https://{host}/articles/{}", i % 500),
            kind,
        ));
    }
    corpus
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn main() {
    let t0 = Instant::now();
    let blocker = match Blocker::from_seed() {
        Ok(b) => b,
        Err(e) => {
            println!(
                "{{\"status\":\"FAIL\",\"error\":\"seed load failed: {}\"}}",
                e.to_string().replace('"', "'")
            );
            std::process::exit(1);
        }
    };
    let seed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let rule_count = blocker.rule_count();

    let corpus = build_corpus();
    for i in 0..WARMUP_ITERS {
        let _ = blocker.check(&corpus[i % corpus.len()]);
    }

    let mut samples: Vec<u64> = Vec::with_capacity(MEASURE_ITERS);
    let mut blocked = 0usize;
    let wall = Instant::now();
    for i in 0..MEASURE_ITERS {
        let req = &corpus[i % corpus.len()];
        let t = Instant::now();
        let verdict = blocker.check(req);
        samples.push(t.elapsed().as_nanos() as u64);
        if verdict == astra_blocker::Verdict::Block {
            blocked += 1;
        }
    }
    let wall_ms = wall.elapsed().as_secs_f64() * 1000.0;
    samples.sort_unstable();

    let mean = samples.iter().sum::<u64>() as f64 / samples.len() as f64;
    println!(
        concat!(
            "{{",
            "\"status\":\"PASS\",",
            "\"rule_count\":{},",
            "\"corpus_size\":{},",
            "\"iters\":{},",
            "\"blocked_hits\":{},",
            "\"seed_load_ms\":{:.2},",
            "\"wall_ms\":{:.1},",
            "\"mean_ns\":{:.1},",
            "\"p50_ns\":{},",
            "\"p95_ns\":{},",
            "\"p99_ns\":{},",
            "\"max_ns\":{}",
            "}}"
        ),
        rule_count,
        corpus.len(),
        MEASURE_ITERS,
        blocked,
        seed_ms,
        wall_ms,
        mean,
        percentile(&samples, 50.0),
        percentile(&samples, 95.0),
        percentile(&samples, 99.0),
        samples[samples.len() - 1],
    );
}

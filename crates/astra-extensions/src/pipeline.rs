/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Inspect and stage. The two entry points the sidecar exposes.
//!
//! `inspect` is read-only. `stage` re-reads the source, writes an adapted XPI
//! into a fresh directory, and returns the report the Host API binds the
//! install to. Nothing is installed here; only `AddonManager` can do that.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use ring::digest;
use serde_json::{json, Value};

use crate::compat;
use crate::crx::{self, Crx, CrxError};
use crate::manifest::{self, ManifestError};
use crate::package::{self, PackageError, PackageScan};
use crate::security;
use crate::types::{
    ApiSupport, Compatibility, Identity, IdentityKind, PackageFormat, PackageReport,
    PackageSummary, SecurityLevel, SignatureStatus, Source, StagedPackage, Verdict,
};

#[derive(Debug, thiserror::Error)]
pub enum ExtensionsError {
    #[error("cannot read the package: {0}")]
    Io(String),
    #[error("CRX: {0}")]
    Crx(#[from] CrxError),
    #[error("package: {0}")]
    Package(#[from] PackageError),
    #[error("manifest: {0}")]
    Manifest(#[from] ManifestError),
    #[error("stage: {0}")]
    Stage(String),
    #[error("a staged package already exists at {0}")]
    Exists(String),
}

impl From<std::io::Error> for ExtensionsError {
    fn from(value: std::io::Error) -> Self {
        ExtensionsError::Io(value.to_string())
    }
}

struct Analysis {
    report: PackageReport,
    /// Original container bytes (CRX/ZIP). None for a directory.
    bytes: Option<Vec<u8>>,
    directory: Option<PathBuf>,
    /// Files rewritten by the adapter (importScripts expansion).
    rewrites: BTreeMap<String, Vec<u8>>,
    compat_prelude: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = digest::digest(&digest::SHA256, bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn chrome_id_from_key(key: &[u8]) -> String {
    let digest = digest::digest(&digest::SHA256, key);
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest.as_ref()[..16]);
    crx::chrome_id(&id)
}

fn gecko_id_from_chrome_id(chrome_id: &str) -> String {
    format!("{chrome_id}@chrome.astra")
}

fn path_id(path: &Path) -> String {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    chrome_id_from_key(canonical.to_string_lossy().as_bytes())
}

fn manifest_gecko_id(manifest: &Value) -> Option<String> {
    manifest
        .get("browser_specific_settings")
        .or_else(|| manifest.get("applications"))
        .and_then(|value| value.get("gecko"))
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn manifest_key(manifest: &Value) -> Option<String> {
    manifest
        .get("key")
        .and_then(Value::as_str)
        .and_then(crx::decode_base64)
        .map(|_| {
            manifest
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        })
}

fn identity_for(crx_id: Option<&str>, manifest: &Value, source: Source, path: &Path) -> Identity {
    if let Some(chrome_id) = crx_id {
        return Identity {
            install_id: gecko_id_from_chrome_id(chrome_id),
            chrome_id: Some(chrome_id.to_string()),
            kind: IdentityKind::ChromeKey,
        };
    }
    // A Chrome package may ship a Firefox-shaped `browser_specific_settings`
    // (Privacy Badger, Wappalyzer, NordPass and others do). The Chrome build
    // is not that Firefox add-on; keep the Chrome-derived id so the two can
    // coexist and the record matches the manifest Astra writes. Only an
    // explicit Firefox source keeps the author's id.
    if source != Source::Chrome {
        if let Some(gecko_id) = manifest_gecko_id(manifest) {
            let chrome_id = manifest_key(manifest)
                .and_then(|key| crx::decode_base64(&key))
                .map(|key| chrome_id_from_key(&key));
            return Identity {
                install_id: gecko_id,
                chrome_id,
                kind: IdentityKind::GeckoId,
            };
        }
    }
    if let Some(key) = manifest_key(manifest).and_then(|key| crx::decode_base64(&key)) {
        let chrome_id = chrome_id_from_key(&key);
        return Identity {
            install_id: gecko_id_from_chrome_id(&chrome_id),
            chrome_id: Some(chrome_id),
            kind: IdentityKind::ChromeKey,
        };
    }
    // No declared identity. Chrome derives an unpacked id from the absolute
    // path; do the same so a reinstall of the same folder replaces the same
    // add-on instead of piling up ids. It is labelled as path-derived.
    let chrome_id = if source == Source::Chrome || source == Source::File {
        path_id(path)
    } else {
        let digest = digest::digest(&digest::SHA256, manifest.to_string().as_bytes());
        let mut id = [0u8; 16];
        id.copy_from_slice(&digest.as_ref()[..16]);
        crx::chrome_id(&id)
    };
    Identity {
        install_id: gecko_id_from_chrome_id(&chrome_id),
        chrome_id: Some(chrome_id),
        kind: IdentityKind::ChromePath,
    }
}

fn read_manifest_dir(dir: &Path) -> Result<Vec<u8>, ExtensionsError> {
    let path = dir.join("manifest.json");
    let metadata = fs::metadata(&path)?;
    if metadata.len() > package::MAX_MANIFEST {
        return Err(PackageError::ManifestTooLarge.into());
    }
    Ok(fs::read(path)?)
}

fn scan_directory(dir: &Path) -> Result<PackageScan, ExtensionsError> {
    let manifest = read_manifest_dir(dir)?;
    let mut summary = PackageSummary::default();
    let mut scan = BTreeMap::new();
    let mut truncated = Vec::new();
    let mut rule_candidates = Vec::new();
    let mut total = 0u64;
    let mut scan_total = 0u64;

    #[allow(clippy::too_many_arguments)]
    fn walk(
        root: &Path,
        dir: &Path,
        summary: &mut PackageSummary,
        total: &mut u64,
        scan: &mut BTreeMap<String, Vec<u8>>,
        rule_candidates: &mut Vec<(String, Vec<u8>)>,
        scan_total: &mut u64,
        truncated: &mut Vec<String>,
    ) -> Result<(), ExtensionsError> {
        let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(Result::ok).collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PackageError::UnsafePath(path.display().to_string()))?;
            let name = relative
                .to_str()
                .ok_or_else(|| PackageError::UnsafePath(path.display().to_string()))?;
            package::safe_name(name)?;
            if metadata.file_type().is_symlink() {
                return Err(PackageError::Symlink(name.into()).into());
            }
            if metadata.is_dir() {
                walk(
                    root,
                    &path,
                    summary,
                    total,
                    scan,
                    rule_candidates,
                    scan_total,
                    truncated,
                )?;
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let size = metadata.len();
            if size > package::MAX_ENTRY {
                return Err(PackageError::EntryTooLarge(name.into()).into());
            }
            *total = total.saturating_add(size);
            if *total > package::MAX_UNCOMPRESSED {
                return Err(PackageError::TooLarge(*total).into());
            }
            summary.entries += 1;
            summary.files += 1;
            summary.uncompressed_bytes = summary.uncompressed_bytes.saturating_add(size);
            summary.largest_entry = summary.largest_entry.max(size);
            if name == "manifest.json" {
                continue;
            }
            let lower = name.to_ascii_lowercase();
            let candidate = lower.ends_with(".js")
                || lower.ends_with(".mjs")
                || lower.ends_with(".cjs")
                || lower.ends_with(".html")
                || lower.ends_with(".htm");
            let rule = lower.ends_with(".json");
            if !candidate && !rule {
                continue;
            }
            if *scan_total >= package::MAX_SCAN_TOTAL {
                truncated.push(name.to_string());
                continue;
            }
            let take = size
                .min(package::MAX_SCAN_FILE)
                .min(package::MAX_SCAN_TOTAL - *scan_total);
            if take == 0 {
                truncated.push(name.to_string());
                continue;
            }
            let bytes = fs::read(&path)?;
            let bytes = if bytes.len() as u64 > take {
                bytes[..take as usize].to_vec()
            } else {
                bytes
            };
            if (bytes.len() as u64) < size {
                truncated.push(name.to_string());
            }
            *scan_total += bytes.len() as u64;
            if rule {
                rule_candidates.push((name.to_string(), bytes));
            } else {
                scan.insert(name.to_string(), bytes);
            }
        }
        Ok(())
    }

    walk(
        dir,
        dir,
        &mut summary,
        &mut total,
        &mut scan,
        &mut rule_candidates,
        &mut scan_total,
        &mut truncated,
    )?;
    let text = String::from_utf8_lossy(&manifest);
    let rule_resources = rule_candidates
        .into_iter()
        .filter(|(name, _)| text.contains(name))
        .collect();
    Ok(PackageScan {
        summary,
        manifest,
        scan,
        truncated,
        rule_resources,
    })
}

/// Expand static `importScripts("a.js")` calls into ordered background
/// scripts, because an engine event page has no worker global.
fn expand_imports(
    scripts: &mut Vec<String>,
    scan: &BTreeMap<String, Vec<u8>>,
) -> (BTreeMap<String, Vec<u8>>, Vec<String>) {
    let mut rewrites: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    let mut notes = Vec::new();
    let mut ordered: Vec<String> = Vec::new();
    let mut visiting: BTreeSet<String> = BTreeSet::new();

    fn process(
        name: &str,
        scan: &BTreeMap<String, Vec<u8>>,
        ordered: &mut Vec<String>,
        visiting: &mut BTreeSet<String>,
        rewrites: &mut BTreeMap<String, Vec<u8>>,
        notes: &mut Vec<String>,
    ) {
        if ordered.iter().any(|item| item == name) {
            return;
        }
        if !visiting.insert(name.to_string()) {
            notes.push(format!(
                "`importScripts` cycle at {name}; the cycle is not expanded"
            ));
            return;
        }
        let Some(source) = scan.get(name) else {
            notes.push(format!("`{name}` is not in the package"));
            visiting.remove(name);
            ordered.push(name.to_string());
            return;
        };
        let text = String::from_utf8_lossy(source).into_owned();
        let (calls, dynamic) = find_import_scripts(&text);
        if dynamic {
            notes.push(format!(
                "`{name}` calls `importScripts` with a non-literal argument; the engine cannot load it and the background script will throw there"
            ));
        }
        let mut rewritten = text.clone();
        for call in calls.iter().rev() {
            for import in &call.imports {
                match resolve_import(name, import) {
                    Some(resolved) => {
                        process(&resolved, scan, ordered, visiting, rewrites, notes)
                    }
                    None => notes.push(format!(
                        "`{name}` imports `{import}`, which is remote or outside the package; the engine cannot load it"
                    )),
                }
            }
            let mut replacement = String::with_capacity(call.end - call.start);
            for ch in rewritten[call.start..call.end].chars() {
                replacement.push(if ch == '\n' { '\n' } else { ' ' });
            }
            rewritten.replace_range(call.start..call.end, &replacement);
        }
        if rewritten != text {
            rewrites.insert(name.to_string(), rewritten.into_bytes());
        }
        visiting.remove(name);
        ordered.push(name.to_string());
    }

    // Chrome accepts an extension-root path with a leading slash; the ZIP
    // keys and the engine's extension URLs are relative.
    let normalized: Vec<String> = scripts
        .iter()
        .map(|script| script.trim_start_matches('/').to_string())
        .collect();
    for script in &normalized {
        process(
            script,
            scan,
            &mut ordered,
            &mut visiting,
            &mut rewrites,
            &mut notes,
        );
    }
    *scripts = ordered;
    (rewrites, notes)
}

struct ImportCall {
    start: usize,
    end: usize,
    imports: Vec<String>,
}

fn find_import_scripts(source: &str) -> (Vec<ImportCall>, bool) {
    let bytes = source.as_bytes();
    let lower = source.to_ascii_lowercase();
    let mut calls = Vec::new();
    let mut dynamic = false;
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("importscripts") {
        let start = from + rel;
        let mut cursor = start + "importscripts".len();
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'(' {
            from = cursor;
            continue;
        }
        let Some(end) = matching_paren(bytes, cursor) else {
            from = cursor + 1;
            continue;
        };
        let inner = &source[cursor + 1..end];
        let mut imports = Vec::new();
        let mut ok = true;
        for part in split_args(inner) {
            match parse_string_literal(part.trim()) {
                Some(value) => imports.push(value),
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok || imports.is_empty() {
            dynamic = true;
        } else {
            calls.push(ImportCall {
                start,
                end: end + 1,
                imports,
            });
        }
        from = end + 1;
    }
    (calls, dynamic)
}

/// Resolve a worker-relative or extension-root-relative script path.
/// Remote URLs are refused (the engine's CSP would refuse them too).
fn resolve_import(from: &str, import: &str) -> Option<String> {
    if import.starts_with("http://") || import.starts_with("https://") || import.starts_with("//") {
        return None;
    }
    let mut parts: Vec<&str> = if import.starts_with('/') {
        Vec::new()
    } else {
        from.rsplit_once('/')
            .map(|(dir, _)| dir.split('/').filter(|part| !part.is_empty()).collect())
            .unwrap_or_default()
    };
    for part in import.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn matching_paren(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote = 0u8;
    let mut escaped = false;
    let mut i = open;
    while i < bytes.len() {
        let byte = bytes[i];
        if quote != 0 {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' || byte == b'`' {
            quote = byte;
        } else if byte == b'(' {
            depth += 1;
        } else if byte == b')' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn split_args(inner: &str) -> Vec<&str> {
    let bytes = inner.as_bytes();
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote = 0u8;
    let mut escaped = false;
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if quote != 0 {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == quote {
                quote = 0;
            }
            continue;
        }
        match *byte {
            b'"' | b'\'' | b'`' => quote = *byte,
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&inner[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    if start < inner.len() || !inner.is_empty() {
        parts.push(&inner[start..]);
    }
    parts
}

fn parse_string_literal(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let quote = bytes[0];
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    if bytes[bytes.len() - 1] != quote {
        return None;
    }
    let inner = &input[1..input.len() - 1];
    if inner.contains('\\') || inner.contains('\n') || inner.contains('\r') {
        return None;
    }
    Some(inner.to_string())
}

fn analyze(path: &Path, source: Source) -> Result<Analysis, ExtensionsError> {
    let metadata = fs::metadata(path)?;
    let (bytes, directory, scan, crx_info) = if metadata.is_dir() {
        (None, Some(path.to_path_buf()), scan_directory(path)?, None)
    } else {
        if metadata.len() > package::MAX_UNCOMPRESSED {
            return Err(PackageError::TooLarge(metadata.len()).into());
        }
        let bytes = fs::read(path)?;
        if Crx::is_crx(&bytes) {
            let (zip_range, chrome_id, signature) = {
                let crx = Crx::parse(&bytes)?;
                let start = 12 + crx.header_len;
                (
                    start..bytes.len(),
                    crx.extension_id(),
                    crx.signature_status(),
                )
            };
            let scan = package::scan_zip(&bytes[zip_range])?;
            (Some(bytes), None, scan, Some((chrome_id, signature)))
        } else {
            let scan = package::scan_zip(&bytes)?;
            (Some(bytes), None, scan, None)
        }
    };

    let manifest_bytes = scan.manifest.clone();
    let parsed = manifest::parse(&manifest_bytes, source)?;
    let identity = identity_for(
        crx_info.as_ref().map(|(id, _)| id.as_str()),
        &parsed.value,
        source,
        path,
    );

    let apis = compat::scan_apis(&scan.scan);
    let api_findings = compat::findings(&apis);
    let needs_prelude = compat::needs_prelude(
        parsed.kind,
        &apis,
        parsed.summary.has_sidebar || apis.iter().any(|u| u.namespace == "sidePanel"),
    );

    let (mut adapted, adaptations) = manifest::adapt(&parsed, &identity, needs_prelude);

    // Expand static importScripts before the manifest lists scripts.
    let mut rewrites = BTreeMap::new();
    let mut import_notes = Vec::new();
    if let Some(background) = adapted.get_mut("background").and_then(Value::as_object_mut) {
        if let Some(list) = background.get_mut("scripts").and_then(Value::as_array_mut) {
            let mut scripts: Vec<String> = list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            let (new_rewrites, notes) = expand_imports(&mut scripts, &scan.scan);
            rewrites = new_rewrites;
            import_notes = notes;
            *list = scripts.into_iter().map(Value::String).collect();
        }
    }

    if needs_prelude {
        manifest::attach_compat(&mut adapted);
    }

    let manifest_summary = {
        // Re-summarize the adapted manifest so the review reflects what the
        // engine will actually see.
        let text = serde_json::to_vec(&adapted).expect("manifest serializes");
        manifest::parse(&text, source)
            .map(|parsed| parsed.summary)
            .unwrap_or_else(|_| parsed.summary.clone())
    };

    let security = security::scan(&scan.scan, &adapted);
    let mut limitations: Vec<String> = adaptations
        .iter()
        .filter(|note| note.limitation)
        .map(|note| note.detail.clone())
        .collect();
    limitations.extend(import_notes);
    let mut unsupported_by_namespace: BTreeMap<String, (Vec<String>, String)> = BTreeMap::new();
    for finding in &api_findings {
        if matches!(
            finding.support,
            ApiSupport::Unsupported | ApiSupport::Unknown
        ) {
            let entry = unsupported_by_namespace
                .entry(finding.namespace.clone())
                .or_insert_with(|| (Vec::new(), finding.reason.clone()));
            if let Some(member) = &finding.member {
                if !entry.0.contains(member) {
                    entry.0.push(member.clone());
                }
            }
        }
    }
    for (namespace, (members, reason)) in &unsupported_by_namespace {
        if members.is_empty() {
            limitations.push(format!("`{namespace}`: {reason}"));
        } else {
            limitations.push(format!("`{namespace}` ({}): {reason}", members.join(", ")));
        }
    }
    if scan.truncated.len() <= 3 {
        for truncated in &scan.truncated {
            limitations.push(format!("`{truncated}` was not fully scanned (size limit)"));
        }
    } else if !scan.truncated.is_empty() {
        limitations.push(format!(
            "{} files were not fully scanned (size limit); the result is based on the scanned portion",
            scan.truncated.len()
        ));
    }
    limitations.sort();
    limitations.dedup();

    let unsupported: Vec<String> = unsupported_by_namespace
        .iter()
        .map(|(namespace, (members, reason))| {
            if members.is_empty() {
                format!("{namespace}: {reason}")
            } else {
                format!("{namespace} ({}): {reason}", members.join(", "))
            }
        })
        .collect();

    let signature = crx_info
        .as_ref()
        .map(|(_, signature)| signature.clone())
        .unwrap_or(SignatureStatus::NotPresent);

    let verdict = if security.blocked {
        Verdict::Blocked
    } else if !unsupported.is_empty() {
        Verdict::Limited
    } else if !limitations.is_empty() {
        Verdict::Adapted
    } else {
        Verdict::Full
    };

    let mut warnings = Vec::new();
    if security.level >= SecurityLevel::Medium {
        warnings.push(security.summary.clone());
    }
    match &signature {
        SignatureStatus::Verified => {}
        SignatureStatus::NotPresent if source == Source::Chrome => {
            warnings.push(
                "This package is not signed. Its files are checked for path escapes and analysed, but nothing proves who built it."
                    .into(),
            );
        }
        SignatureStatus::Invalid(reason) => {
            warnings.push(format!("The CRX signature is invalid: {reason}"))
        }
        SignatureStatus::Unsupported(reason) => {
            warnings.push(format!("The CRX signature cannot be verified: {reason}"))
        }
        _ => {}
    }
    if verdict == Verdict::Limited {
        warnings.push("Some browser APIs this extension calls are not implemented by this engine. See the limitations.".into());
    }
    if matches!(signature, SignatureStatus::NotPresent) && source == Source::File {
        warnings.push("This is a local package. Astra did not verify a store signature.".into());
    }

    let package = scan.summary.clone();
    let package_sha256 = match (&bytes, &directory) {
        (Some(bytes), _) => sha256_hex(bytes),
        (None, Some(dir)) => {
            let mut hasher_input = manifest_bytes.clone();
            for (name, data) in &scan.scan {
                hasher_input.extend_from_slice(name.as_bytes());
                hasher_input.extend_from_slice(data);
            }
            let _ = dir;
            sha256_hex(&hasher_input)
        }
        _ => String::new(),
    };

    let report = PackageReport {
        source,
        format: if crx_info.is_some() {
            PackageFormat::Crx3
        } else if directory.is_some() {
            PackageFormat::Directory
        } else {
            PackageFormat::Zip
        },
        identity,
        signature,
        package_sha256,
        manifest: manifest_summary,
        compatibility: Compatibility {
            verdict,
            manifest_version: parsed.summary.manifest_version,
            adaptations: adaptations
                .iter()
                .map(|note| format!("{}: {}", note.kind, note.detail))
                .collect(),
            limitations,
            unsupported,
            apis: api_findings,
            compat_prelude: needs_prelude,
        },
        security,
        package,
        warnings,
        adapted_manifest: adapted,
        store_name: None,
        store_url: None,
    };

    Ok(Analysis {
        report,
        bytes,
        directory,
        rewrites,
        compat_prelude: needs_prelude,
    })
}

/// Read a package and return the review. No files are written.
pub fn inspect(path: &Path, source: Source) -> Result<PackageReport, ExtensionsError> {
    analyze(path, source).map(|analysis| analysis.report)
}

fn write_all(path: &Path, bytes: &[u8]) -> Result<(), ExtensionsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Re-read, adapt, and write `dest/package.xpi` plus `dest/report.json`.
/// `dest` must not exist; the caller uses a fresh per-review directory.
pub fn stage(path: &Path, source: Source, dest: &Path) -> Result<StagedPackage, ExtensionsError> {
    if dest.exists() {
        return Err(ExtensionsError::Exists(dest.display().to_string()));
    }
    let analysis = analyze(path, source)?;
    let parent = dest
        .parent()
        .ok_or_else(|| ExtensionsError::Stage("destination has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        dest.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("stage"),
        std::process::id()
    ));
    if temp.exists() {
        fs::remove_dir_all(&temp)?;
    }
    let unpacked = temp.join("unpacked");
    fs::create_dir_all(&unpacked)?;

    if let Some(bytes) = &analysis.bytes {
        if Crx::is_crx(bytes) {
            let crx = Crx::parse(bytes)?;
            package::extract_zip(crx.zip, &unpacked)?;
        } else {
            package::extract_zip(bytes, &unpacked)?;
        }
    } else if let Some(dir) = &analysis.directory {
        package::copy_directory(dir, &unpacked)?;
    } else {
        return Err(ExtensionsError::Stage("no package data".into()));
    }

    let manifest_bytes = serde_json::to_vec_pretty(&analysis.report.adapted_manifest)
        .map_err(|e| ExtensionsError::Stage(e.to_string()))?;
    write_all(&unpacked.join("manifest.json"), &manifest_bytes)?;

    if analysis.compat_prelude {
        write_all(
            &unpacked.join(manifest::COMPAT_SCRIPT),
            compat::PRELUDE.as_bytes(),
        )?;
    }
    for (name, data) in &analysis.rewrites {
        package::safe_name(name)?;
        write_all(&unpacked.join(name), data)?;
    }

    let xpi = temp.join("package.xpi");
    package::write_xpi(&unpacked, &xpi)?;
    let xpi_bytes = fs::read(&xpi)?;
    let xpi_sha256 = sha256_hex(&xpi_bytes);
    write_all(
        &temp.join("report.json"),
        serde_json::to_vec_pretty(&analysis.report)
            .map_err(|e| ExtensionsError::Stage(e.to_string()))?
            .as_slice(),
    )?;
    fs::remove_dir_all(&unpacked)?;
    fs::rename(&temp, dest)?;

    Ok(StagedPackage {
        report: analysis.report,
        xpi_path: dest.join("package.xpi").display().to_string(),
        xpi_sha256,
        work_dir: dest.display().to_string(),
    })
}

/// A small JSON summary used by `astra-core` when it wants to show that the
/// pipeline is available without reading a package.
pub fn engine_capabilities() -> Value {
    json!({
        "engine": manifest::ENGINE_VERSION,
        "service_workers": false,
        "manifest_versions": [2, 3],
        "declarative_net_request": true,
        "scripting": true,
        "web_request": true,
        "sidebar_action": true,
        "side_panel": false,
        "native_messaging": true,
        "crx": ["crx3"],
        "max_package_bytes": package::MAX_UNCOMPRESSED,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_imports_are_expanded_and_stripped() {
        let mut scan = BTreeMap::new();
        scan.insert(
            "sw.js".to_string(),
            b"importScripts('a.js', \"b.js\");\nconsole.log('sw');".to_vec(),
        );
        scan.insert("a.js".to_string(), b"console.log('a');".to_vec());
        scan.insert("b.js".to_string(), b"console.log('b');".to_vec());
        let mut scripts = vec!["sw.js".to_string()];
        let (rewrites, notes) = expand_imports(&mut scripts, &scan);
        assert_eq!(scripts, vec!["a.js", "b.js", "sw.js"]);
        let rewritten = String::from_utf8(rewrites["sw.js"].clone()).unwrap();
        assert!(!rewritten.contains("importScripts"));
        assert!(rewritten.contains("console.log('sw')"));
        assert!(notes.is_empty());
    }

    #[test]
    fn a_dynamic_import_is_reported() {
        let mut scan = BTreeMap::new();
        scan.insert(
            "sw.js".to_string(),
            b"const p = 'a.js'; importScripts(p);".to_vec(),
        );
        let mut scripts = vec!["sw.js".to_string()];
        let (_, notes) = expand_imports(&mut scripts, &scan);
        assert!(notes.iter().any(|note| note.contains("non-literal")));
    }

    #[test]
    fn string_literals_are_parsed_conservatively() {
        assert_eq!(parse_string_literal("\"a.js\""), Some("a.js".into()));
        assert_eq!(parse_string_literal("'a.js'"), Some("a.js".into()));
        assert_eq!(parse_string_literal("a.js"), None);
        assert_eq!(parse_string_literal("\"a\\nb\""), None);
    }
}

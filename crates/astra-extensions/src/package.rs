/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Bounded, traversal-safe package access.
//!
//! Every number here is a refusal limit, not a target. A package that exceeds
//! one is rejected before any file is written; extraction never relies on the
//! ZIP's own declared sizes alone.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::types::PackageSummary;

pub const MAX_ENTRIES: usize = 20_000;
pub const MAX_UNCOMPRESSED: u64 = 256 * 1024 * 1024;
pub const MAX_ENTRY: u64 = 64 * 1024 * 1024;
pub const MAX_MANIFEST: u64 = 2 * 1024 * 1024;
/// Files whose text the analyzers read (JS/HTML). The rest is only extracted.
pub const MAX_SCAN_TOTAL: u64 = 24 * 1024 * 1024;
pub const MAX_SCAN_FILE: u64 = 3 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PackageError {
    #[error("not a ZIP package")]
    NotZip,
    #[error("package has too many entries ({0})")]
    TooManyEntries(usize),
    #[error("package is too large uncompressed ({0} bytes)")]
    TooLarge(u64),
    #[error("entry {0} is too large")]
    EntryTooLarge(String),
    #[error("entry {0} has a suspicious compression ratio")]
    SuspiciousRatio(String),
    #[error("entry path is unsafe: {0}")]
    UnsafePath(String),
    #[error("duplicate entry: {0}")]
    Duplicate(String),
    #[error("entry {0} is a symbolic link")]
    Symlink(String),
    #[error("package has no manifest.json")]
    NoManifest,
    #[error("manifest.json is larger than the limit")]
    ManifestTooLarge,
    #[error("io: {0}")]
    Io(String),
    #[error("zip: {0}")]
    Zip(String),
}

impl From<zip::result::ZipError> for PackageError {
    fn from(value: zip::result::ZipError) -> Self {
        PackageError::Zip(value.to_string())
    }
}

impl From<std::io::Error> for PackageError {
    fn from(value: std::io::Error) -> Self {
        PackageError::Io(value.to_string())
    }
}

/// The parts of a package the analyzers need. `scan` is bounded; files over
/// the per-file limit are read up to the limit and marked truncated.
pub struct PackageScan {
    pub summary: PackageSummary,
    pub manifest: Vec<u8>,
    /// `.js`, `.mjs`, `.cjs`, `.html`, `.htm` files, bounded.
    pub scan: BTreeMap<String, Vec<u8>>,
    pub truncated: Vec<String>,
    /// `.json` rule resources (declarative_net_request), bounded.
    pub rule_resources: Vec<(String, Vec<u8>)>,
}

impl PackageScan {
    pub fn manifest_text(&self) -> String {
        String::from_utf8_lossy(&self.manifest).into_owned()
    }
}

fn is_scan_candidate(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [".js", ".mjs", ".cjs", ".html", ".htm"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Validate one central-directory name and return it unchanged.
pub fn safe_name(name: &str) -> Result<String, PackageError> {
    if name.is_empty() || name.len() > 1024 {
        return Err(PackageError::UnsafePath(name.into()));
    }
    if name.contains('\0') || name.contains('\\') {
        return Err(PackageError::UnsafePath(name.into()));
    }
    if name.starts_with('/') || name.starts_with('~') {
        return Err(PackageError::UnsafePath(name.into()));
    }
    if name.as_bytes().get(1) == Some(&b':') {
        return Err(PackageError::UnsafePath(name.into()));
    }
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(PackageError::UnsafePath(name.into()));
        }
    }
    Ok(name.to_string())
}

fn looks_like_symlink(mode: Option<u32>) -> bool {
    matches!(mode, Some(mode) if mode & 0o170000 == 0o120000)
}

/// Read a ZIP from memory, enforce every structural limit, and keep only the
/// bounded set of files the analyzers need.
pub fn scan_zip(bytes: &[u8]) -> Result<PackageScan, PackageError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    if archive.len() > MAX_ENTRIES {
        return Err(PackageError::TooManyEntries(archive.len()));
    }

    let mut summary = PackageSummary {
        entries: archive.len(),
        ..Default::default()
    };
    let mut names = std::collections::HashSet::new();
    let mut manifest: Option<Vec<u8>> = None;
    let mut scan = BTreeMap::new();
    let mut truncated = Vec::new();
    let mut rule_resources = Vec::new();
    let mut json_candidates: Vec<(String, Vec<u8>)> = Vec::new();
    let mut scan_total = 0u64;
    let mut uncompressed_total = 0u64;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let raw_name = entry.name()?.into_owned();
        if entry.is_dir() {
            let trimmed = raw_name.trim_end_matches('/');
            if !trimmed.is_empty() {
                safe_name(trimmed)?;
            }
            continue;
        }
        let name = safe_name(&raw_name)?;
        if !names.insert(name.clone()) {
            return Err(PackageError::Duplicate(name));
        }
        if looks_like_symlink(entry.unix_mode()) {
            return Err(PackageError::Symlink(name));
        }
        let size = entry.size();
        let compressed = entry.compressed_size();
        if size > MAX_ENTRY {
            return Err(PackageError::EntryTooLarge(name));
        }
        uncompressed_total = uncompressed_total.saturating_add(size);
        if uncompressed_total > MAX_UNCOMPRESSED {
            return Err(PackageError::TooLarge(uncompressed_total));
        }
        if size > 1024 * 1024 && compressed > 0 && size / compressed.max(1) > 500 {
            return Err(PackageError::SuspiciousRatio(name));
        }
        summary.files += 1;
        summary.compressed_bytes = summary.compressed_bytes.saturating_add(compressed);
        summary.uncompressed_bytes = summary.uncompressed_bytes.saturating_add(size);
        summary.largest_entry = summary.largest_entry.max(size);

        if name == "manifest.json" {
            if size > MAX_MANIFEST {
                return Err(PackageError::ManifestTooLarge);
            }
            let mut data = Vec::with_capacity(size as usize);
            entry.read_to_end(&mut data)?;
            manifest = Some(data);
            continue;
        }

        let candidate = is_scan_candidate(&name);
        let rule = name.to_ascii_lowercase().ends_with(".json");
        if !candidate && !rule {
            continue;
        }
        if scan_total >= MAX_SCAN_TOTAL {
            truncated.push(name);
            continue;
        }
        let take = size.min(MAX_SCAN_FILE).min(MAX_SCAN_TOTAL - scan_total);
        if take == 0 {
            truncated.push(name);
            continue;
        }
        let mut data = Vec::with_capacity(take as usize);
        entry.by_ref().take(take).read_to_end(&mut data)?;
        if (data.len() as u64) < size {
            truncated.push(name.clone());
        }
        scan_total += data.len() as u64;
        if rule {
            json_candidates.push((name, data));
        } else {
            scan.insert(name, data);
        }
    }

    let manifest = manifest.ok_or(PackageError::NoManifest)?;
    let manifest_text = String::from_utf8_lossy(&manifest);
    for (name, data) in json_candidates {
        // Only JSON the manifest names (DNR rulesets, native messaging hosts)
        // is analyzed; unrelated data files stay data.
        if manifest_text.contains(&name) {
            rule_resources.push((name, data));
        }
    }
    Ok(PackageScan {
        summary,
        manifest,
        scan,
        truncated,
        rule_resources,
    })
}

/// Extract every regular file under `dest`. Paths are validated first; the
/// destination is created by the caller and is disposable on failure.
pub fn extract_zip(bytes: &[u8], dest: &Path) -> Result<PackageSummary, PackageError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)?;
    if archive.len() > MAX_ENTRIES {
        return Err(PackageError::TooManyEntries(archive.len()));
    }
    let mut summary = PackageSummary {
        entries: archive.len(),
        ..Default::default()
    };
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let raw_name = entry.name()?.into_owned();
        if entry.is_dir() {
            let trimmed = raw_name.trim_end_matches('/');
            if !trimmed.is_empty() {
                let name = safe_name(trimmed)?;
                fs::create_dir_all(dest.join(name))?;
            }
            continue;
        }
        let name = safe_name(&raw_name)?;
        if !names.insert(name.clone()) {
            return Err(PackageError::Duplicate(name));
        }
        if looks_like_symlink(entry.unix_mode()) {
            return Err(PackageError::Symlink(name));
        }
        let size = entry.size();
        if size > MAX_ENTRY {
            return Err(PackageError::EntryTooLarge(name));
        }
        total = total.saturating_add(size);
        if total > MAX_UNCOMPRESSED {
            return Err(PackageError::TooLarge(total));
        }
        summary.files += 1;
        summary.compressed_bytes = summary
            .compressed_bytes
            .saturating_add(entry.compressed_size());
        summary.uncompressed_bytes = summary.uncompressed_bytes.saturating_add(size);
        summary.largest_entry = summary.largest_entry.max(size);

        let path = dest.join(&name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::File::create(&path)?;
        let mut limited = (&mut entry).take(size);
        std::io::copy(&mut limited, &mut file)?;
        file.flush()?;
    }
    Ok(summary)
}

/// Write a deterministic ZIP/XPI from a directory. Sorted names, fixed
/// timestamps and deflate keep the same input hashable.
pub fn write_xpi(dir: &Path, dest: &Path) -> Result<(), PackageError> {
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files)?;
    files.sort();
    if !files.iter().any(|p| p == Path::new("manifest.json")) {
        return Err(PackageError::NoManifest);
    }
    let file = fs::File::create(dest)?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .last_modified_time(zip::DateTime::default());
    let mut buffer = Vec::new();
    for relative in files {
        let name = relative
            .to_str()
            .ok_or_else(|| PackageError::UnsafePath(relative.display().to_string()))?;
        safe_name(name)?;
        let mut input = fs::File::open(dir.join(&relative))?;
        buffer.clear();
        input.read_to_end(&mut buffer)?;
        writer.start_file(name, options)?;
        writer.write_all(&buffer)?;
    }
    writer.finish()?;
    Ok(())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), PackageError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = entry.metadata()?;
        if metadata.file_type().is_symlink() {
            return Err(PackageError::Symlink(path.display().to_string()));
        }
        if metadata.is_dir() {
            collect_files(root, &path, out)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PackageError::UnsafePath(path.display().to_string()))?;
            out.push(relative.to_path_buf());
        }
    }
    Ok(())
}

/// Copy an unpacked directory into `dest`, validating every relative path.
pub fn copy_directory(source: &Path, dest: &Path) -> Result<PackageSummary, PackageError> {
    let mut files = Vec::new();
    collect_files(source, source, &mut files)?;
    if files.len() > MAX_ENTRIES {
        return Err(PackageError::TooManyEntries(files.len()));
    }
    let mut summary = PackageSummary {
        entries: files.len(),
        files: files.len(),
        ..Default::default()
    };
    let mut total = 0u64;
    for relative in files {
        let name = relative
            .to_str()
            .ok_or_else(|| PackageError::UnsafePath(relative.display().to_string()))?;
        safe_name(name)?;
        let from = source.join(&relative);
        let size = fs::metadata(&from)?.len();
        if size > MAX_ENTRY {
            return Err(PackageError::EntryTooLarge(name.into()));
        }
        total = total.saturating_add(size);
        if total > MAX_UNCOMPRESSED {
            return Err(PackageError::TooLarge(total));
        }
        summary.uncompressed_bytes = summary.uncompressed_bytes.saturating_add(size);
        summary.largest_entry = summary.largest_entry.max(size);
        let to = dest.join(&relative);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&from, &to)?;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_names_are_refused() {
        for name in [
            "../evil.js",
            "a/../../evil.js",
            "/etc/passwd",
            "C:/windows/x",
            "a\\b.js",
            "a//b.js",
            "./a.js",
            "",
        ] {
            assert!(safe_name(name).is_err(), "{name} should be refused");
        }
        assert!(safe_name("js/background.js").is_ok());
        assert!(safe_name("manifest.json").is_ok());
    }

    #[test]
    fn an_entry_with_a_dot_dot_segment_is_refused() {
        let mut bytes = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut bytes));
            writer
                .start_file("../escape.js", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
            writer.finish().unwrap();
        }
        assert!(matches!(scan_zip(&bytes), Err(PackageError::UnsafePath(_))));
    }
}

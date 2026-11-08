/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Wire types shared by the sidecar and the Host API.
//!
//! Names are snake_case because the sidecar protocol (Appendix C) is JSON and
//! every other Astra command uses snake_case.

use serde::{Deserialize, Serialize};

/// Where a package came from. Provenance is part of the install record and is
/// shown to the person; it is never inferred from the file extension alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// addons.mozilla.org or another signed XPI.
    Firefox,
    /// Chromium package: CRX3, unpacked ZIP or a Chrome Web Store listing.
    Chrome,
    /// A local file of unknown provenance.
    File,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Firefox => "firefox",
            Source::Chrome => "chrome",
            Source::File => "file",
        }
    }
}

/// Container format actually read from the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    Crx3,
    Crx2,
    Zip,
    Directory,
}

impl PackageFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            PackageFormat::Crx3 => "crx3",
            PackageFormat::Crx2 => "crx2",
            PackageFormat::Zip => "zip",
            PackageFormat::Directory => "directory",
        }
    }
}

/// How the package identity was established.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdentityKind {
    /// Chrome extension id derived from the CRX signing key (or manifest key).
    ChromeKey,
    /// Chrome id derived from the canonical unpacked directory path.
    ChromePath,
    /// A Firefox `browser_specific_settings.gecko.id`.
    GeckoId,
    /// The package carries no stable identity.
    Unverified,
}

/// Result of the CRX signature check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    /// CRX3 RSA proof verified against the ZIP digest.
    Verified,
    /// Not a CRX (ZIP/directory). The engine verifies signed XPIs.
    NotPresent,
    /// CRX2 uses SHA-1, which this build does not verify. Honest refusal.
    Unsupported(String),
    /// A proof was present but did not verify.
    Invalid(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    /// The stable id Astra/Gecko will install under.
    pub install_id: String,
    /// The Chrome extension id when the package has one (32 chars, a-p).
    pub chrome_id: Option<String>,
    pub kind: IdentityKind,
}

/// The engine-visible manifest summary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSummary {
    pub manifest_version: u32,
    pub name: String,
    pub version: String,
    pub description: String,
    pub permissions: Vec<String>,
    pub host_permissions: Vec<String>,
    pub optional_permissions: Vec<String>,
    pub optional_host_permissions: Vec<String>,
    pub has_background: bool,
    pub background_kind: String,
    pub has_content_scripts: bool,
    pub content_script_count: usize,
    pub has_action: bool,
    pub has_browser_action: bool,
    pub has_page_action: bool,
    pub has_sidebar: bool,
    pub has_options: bool,
    pub has_declarative_net_request: bool,
    pub has_native_messaging: bool,
    pub has_externally_connectable: bool,
    pub overrides_new_tab: bool,
    pub commands: Vec<String>,
}

/// One API family the package uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiUse {
    pub namespace: String,
    /// Members seen, bounded and sorted. Empty means the namespace is used
    /// dynamically (for example `chrome[ns]`).
    pub members: Vec<String>,
    pub files: Vec<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiSupport {
    Supported,
    /// Implemented, but with a specific difference the person should know.
    Partial,
    /// Adapted by the compatibility prelude (for example callback style).
    Adapted,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiFinding {
    pub namespace: String,
    pub member: Option<String>,
    pub support: ApiSupport,
    pub reason: String,
}

/// The compatibility verdict shown in the review. `verdict` is deliberately
/// one of five states; a package is never called "supported" because its
/// manifest parsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Full,
    Limited,
    Adapted,
    Unsupported,
    Blocked,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Compatibility {
    pub verdict: Verdict,
    pub manifest_version: u32,
    /// What Astra changed in the manifest or added to the package.
    pub adaptations: Vec<String>,
    /// What cannot work exactly as written.
    pub limitations: Vec<String>,
    /// APIs that are missing outright.
    pub unsupported: Vec<String>,
    /// Bounded API inventory.
    pub apis: Vec<ApiFinding>,
    /// True when the compatibility prelude was added to background/content
    /// scripts.
    pub compat_prelude: bool,
}

impl Default for Verdict {
    fn default() -> Self {
        Verdict::Unsupported
    }
}

/// One security signal. `id` is stable so the UI and tests can name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityFinding {
    pub id: String,
    pub category: String,
    pub level: SecurityLevel,
    pub file: Option<String>,
    pub line: Option<usize>,
    /// Bounded excerpt; never the whole file.
    pub evidence: String,
    pub explanation: String,
}

/// How the install should be handled. `None`..`Low` install normally with a
/// notice; `Medium`/`High` ask for an explicit confirmation; `Critical`
/// asks with a stronger warning; `Blocked` refuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityLevel {
    None,
    Info,
    Low,
    Medium,
    High,
    Critical,
    Blocked,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityReport {
    pub level: SecurityLevel,
    /// Recommendations that resemble malicious behaviour but are common in
    /// legitimate extensions (minified code, password managers).
    pub findings: Vec<SecurityFinding>,
    /// Set when installation must be refused automatically.
    pub blocked: bool,
    pub summary: String,
}

impl Default for SecurityLevel {
    fn default() -> Self {
        SecurityLevel::None
    }
}

/// Bounded package inventory.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageSummary {
    pub entries: usize,
    pub files: usize,
    pub compressed_bytes: u64,
    pub uncompressed_bytes: u64,
    /// Largest single entry (uncompressed).
    pub largest_entry: u64,
}

/// Everything the review and the install record need. No field is guessed:
/// absent information stays empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageReport {
    pub source: Source,
    pub format: PackageFormat,
    pub identity: Identity,
    pub signature: SignatureStatus,
    /// SHA-256 of the original container bytes.
    pub package_sha256: String,
    pub manifest: ManifestSummary,
    pub compatibility: Compatibility,
    pub security: SecurityReport,
    pub package: PackageSummary,
    /// Human-readable warnings. The first is the broadest one.
    pub warnings: Vec<String>,
    /// The manifest the engine will actually see (adapted). Kept for review
    /// and for tests; the UI does not render it.
    pub adapted_manifest: serde_json::Value,
    /// One line for the manager row.
    pub store_name: Option<String>,
    pub store_url: Option<String>,
}

/// Result of `stage`: the adapted XPI plus the report the install is bound to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StagedPackage {
    pub report: PackageReport,
    pub xpi_path: String,
    pub xpi_sha256: String,
    /// Directory that holds the staged XPI and its report (not an unpacked
    /// tree; the tree is removed after the XPI is written).
    pub work_dir: String,
}

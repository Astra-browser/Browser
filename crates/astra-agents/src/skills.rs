/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Skills interface and loader stubs (bundled-skill port in P6-T07).
//!
//! A skill is a named capability bundle: a [`SkillManifest`] (name,
//! description, tool allow-list) plus Markdown instructions loaded from a
//! `SKILL.md` file. This module owns the manifest shape, its validation,
//! and the [`SkillLoader`] stub the loop will consult; P6-T07 ports the
//! bundled skills and adds signature/permission checks.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Skill-manifest format version. Bump on any breaking shape change and
/// keep [`SkillError::VersionMismatch`] so old payloads fail loudly.
pub const SKILL_VERSION: u32 = 1;

/// Maximum skill instructions length accepted by [`SkillManifest::validate`].
pub const MAX_SKILL_DOC_CHARS: usize = 32_000;

/// Versioned skill manifest: identity plus the tools the skill may use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillManifest {
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_path: Option<String>,
    #[serde(default = "default_skill_enabled")]
    pub enabled: bool,
}

fn default_skill_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SkillError {
    #[error("unsupported skill version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid skill: {0}")]
    Invalid(String),
    #[error("skill JSON error: {0}")]
    Json(String),
    #[error("skill not found: {0}")]
    NotFound(String),
}

impl SkillManifest {
    /// New enabled manifest.
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        tools: Vec<String>,
    ) -> Self {
        Self {
            version: SKILL_VERSION,
            name: name.into(),
            description: description.into(),
            tools,
            content_path: None,
            enabled: true,
        }
    }

    /// Serialize for the registry / `skills` table seed.
    pub fn to_json(&self) -> Result<String, SkillError> {
        serde_json::to_string(self).map_err(|e| SkillError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, SkillError> {
        let manifest: Self =
            serde_json::from_str(json).map_err(|e| SkillError::Json(e.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// Structural validation: version, kebab-case name, no empty tool
    /// entries, no duplicate tools.
    pub fn validate(&self) -> Result<(), SkillError> {
        if self.version != SKILL_VERSION {
            return Err(SkillError::VersionMismatch(self.version, SKILL_VERSION));
        }
        if !is_skill_name(&self.name) {
            return Err(SkillError::Invalid(format!(
                "skill name {:?} must be kebab-case (a-z, 0-9, dashes)",
                self.name
            )));
        }
        let mut seen = std::collections::HashSet::new();
        for tool in &self.tools {
            if tool.is_empty() {
                return Err(SkillError::Invalid(
                    "skill tool names must not be empty".to_owned(),
                ));
            }
            if !seen.insert(tool.as_str()) {
                return Err(SkillError::Invalid(format!("duplicate skill tool {tool}")));
            }
        }
        Ok(())
    }
}

/// True for kebab-case names (`research`, `plan-my-day`).
fn is_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

/// Loader interface stub: lists manifests and resolves one by name.
/// P6-T07 adds directory scanning, `SKILL.md` front-matter parsing, and
/// signature/permission checks behind this trait.
pub trait SkillLoader {
    /// All known manifests (enabled and disabled).
    fn list(&self) -> Vec<SkillManifest>;

    /// Resolve one skill by name.
    fn load(&self, name: &str) -> Result<SkillManifest, SkillError> {
        self.list()
            .into_iter()
            .find(|skill| skill.name == name)
            .ok_or_else(|| SkillError::NotFound(name.to_owned()))
    }
}

/// In-memory loader for tests and early loop wiring.
#[derive(Clone, Debug, Default)]
pub struct StaticSkillLoader {
    skills: Vec<SkillManifest>,
}

impl StaticSkillLoader {
    /// New loader over a fixed set of manifests.
    pub fn new(skills: Vec<SkillManifest>) -> Self {
        Self { skills }
    }
}

impl SkillLoader for StaticSkillLoader {
    fn list(&self) -> Vec<SkillManifest> {
        self.skills.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_manifest_json_round_trip() {
        let manifest = SkillManifest::new(
            "research",
            "answer from current sources",
            vec!["web_search".to_owned(), "web_fetch".to_owned()],
        );
        assert!(manifest.validate().is_ok());
        let parsed = SkillManifest::from_json(&manifest.to_json().unwrap()).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn skill_names_must_be_kebab_case() {
        for bad in [
            "",
            "Research",
            "plan_my_day",
            "-lead",
            "trail-",
            "has space",
        ] {
            let manifest = SkillManifest::new(bad, "d", vec![]);
            assert!(manifest.validate().is_err(), "name {bad:?} passed");
        }
        assert!(SkillManifest::new("plan-my-day", "d", vec![])
            .validate()
            .is_ok());
    }

    #[test]
    fn skill_version_mismatch_fails_loudly() {
        let mut manifest = SkillManifest::new("research", "d", vec![]);
        manifest.version = 999;
        assert_eq!(
            manifest.validate(),
            Err(SkillError::VersionMismatch(999, SKILL_VERSION))
        );
        assert!(SkillManifest::from_json(&manifest.to_json().unwrap()).is_err());
        assert!(matches!(
            SkillManifest::from_json("{not json"),
            Err(SkillError::Json(_))
        ));

        let dup = SkillManifest::new("research", "d", vec!["t".to_owned(), "t".to_owned()]);
        assert!(dup.validate().is_err());
    }

    #[test]
    fn static_loader_lists_and_resolves() {
        let loader = StaticSkillLoader::new(vec![
            SkillManifest::new("research", "d", vec![]),
            SkillManifest::new("trip-planning", "d", vec![]),
        ]);
        assert_eq!(loader.list().len(), 2);
        assert_eq!(loader.load("research").unwrap().name, "research");
        assert_eq!(
            loader.load("ghost"),
            Err(SkillError::NotFound("ghost".to_owned()))
        );
    }
}

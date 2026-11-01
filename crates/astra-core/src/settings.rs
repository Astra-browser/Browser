/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Settings registry: known keys, defaults, and value validation.
//!
//! Persistence lives in `astra-store`; the host applies values at `Boot`.
//! This module is the pure contract both sides share.

use thiserror::Error;

/// Value shape a setting accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingKind {
    Bool,
    Integer { min: i64, max: i64 },
    Text { max_len: usize },
    Choice(&'static [&'static str]),
}

/// A known setting key with its default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettingDef {
    pub key: &'static str,
    pub default: &'static str,
    pub kind: SettingKind,
}

/// Registry of settings ported from the `setting_*` / `keymap_*` surface.
pub static KNOWN_SETTINGS: &[SettingDef] = &[
    SettingDef {
        key: "appearance.theme",
        default: "system",
        kind: SettingKind::Choice(&["system", "light", "dark"]),
    },
    SettingDef {
        key: "sidebar.width",
        default: "280",
        kind: SettingKind::Integer { min: 200, max: 480 },
    },
    SettingDef {
        key: "sidebar.hidden",
        default: "false",
        kind: SettingKind::Bool,
    },
    SettingDef {
        key: "launcher.double_tap",
        default: "disabled",
        kind: SettingKind::Choice(&["disabled", "command", "command_shift"]),
    },
    SettingDef {
        key: "blocker.enabled",
        default: "true",
        kind: SettingKind::Bool,
    },
    SettingDef {
        key: "history.retention_days",
        default: "90",
        kind: SettingKind::Integer { min: 0, max: 3650 },
    },
    SettingDef {
        key: "search.engine",
        default: "default",
        kind: SettingKind::Text { max_len: 64 },
    },
    SettingDef {
        key: "onboarding.completed",
        default: "false",
        kind: SettingKind::Bool,
    },
];

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum SettingsError {
    #[error("unknown setting key: {0}")]
    UnknownKey(String),
    #[error("invalid value {1:?} for {0}: {2}")]
    InvalidValue(String, String, &'static str),
}

/// Default value for a known key, or `None` for unknown keys.
pub fn default_for(key: &str) -> Option<&'static str> {
    KNOWN_SETTINGS
        .iter()
        .find(|def| def.key == key)
        .map(|def| def.default)
}

/// Validate `value` against the registry entry for `key`.
pub fn validate(key: &str, value: &str) -> Result<(), SettingsError> {
    let def = KNOWN_SETTINGS
        .iter()
        .find(|def| def.key == key)
        .ok_or_else(|| SettingsError::UnknownKey(key.to_owned()))?;
    match def.kind {
        SettingKind::Bool => match value {
            "true" | "false" => Ok(()),
            _ => Err(SettingsError::InvalidValue(
                key.to_owned(),
                value.to_owned(),
                "expected \"true\" or \"false\"",
            )),
        },
        SettingKind::Integer { min, max } => match value.parse::<i64>() {
            Ok(n) if (min..=max).contains(&n) => Ok(()),
            _ => Err(SettingsError::InvalidValue(
                key.to_owned(),
                value.to_owned(),
                "expected an integer in range",
            )),
        },
        SettingKind::Text { max_len } => {
            if value.len() <= max_len {
                Ok(())
            } else {
                Err(SettingsError::InvalidValue(
                    key.to_owned(),
                    value.to_owned(),
                    "text too long",
                ))
            }
        }
        SettingKind::Choice(options) => {
            if options.contains(&value) {
                Ok(())
            } else {
                Err(SettingsError::InvalidValue(
                    key.to_owned(),
                    value.to_owned(),
                    "not one of the allowed choices",
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_registry() {
        assert_eq!(default_for("appearance.theme"), Some("system"));
        assert_eq!(default_for("sidebar.width"), Some("280"));
        assert_eq!(default_for("nope"), None);
    }

    #[test]
    fn bool_and_choice_validation() {
        assert!(validate("sidebar.hidden", "true").is_ok());
        assert!(validate("sidebar.hidden", "yes").is_err());
        assert!(validate("appearance.theme", "dark").is_ok());
        assert!(validate("appearance.theme", "neon").is_err());
    }

    #[test]
    fn integer_range_validation() {
        assert!(validate("sidebar.width", "200").is_ok());
        assert!(validate("sidebar.width", "199").is_err());
        assert!(validate("sidebar.width", "wide").is_err());
    }

    #[test]
    fn unknown_key_rejected() {
        assert_eq!(
            validate("nope", "x"),
            Err(SettingsError::UnknownKey("nope".to_owned()))
        );
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Manifest parsing and Chrome-to-Gecko adaptation for the pinned Gecko build.
//!
//! The engine already implements most of the Chrome manifest shape. The gaps
//! this module closes are the ones inspected in `engine/toolkit/components/
//! extensions`:
//!
//! - `background.service_worker` is refused unless the (locked-off)
//!   `extensions.backgroundServiceWorker.enabled` pref is set, so a Chrome MV3
//!   worker becomes `background.scripts` and runs as the engine's event page.
//! - `side_panel` has no Gecko implementation; it becomes `sidebar_action`
//!   and the compatibility prelude maps `chrome.sidePanel` onto
//!   `browser.sidebarAction`.
//! - MV3 `chrome.*` is a promise-only alias of `browser.*`, so callback-style
//!   Chrome calls need the prelude.
//! - Chrome-only permissions the engine cannot grant are removed and listed;
//!   they are never silently kept or silently dropped.
//!
//! Everything else is passed through untouched: `declarativeNetRequest`,
//! `scripting`, `webRequest`, `action`, `host_permissions` and the MV3 CSP
//! object are implemented by this engine.

use serde_json::{Map, Value};

use crate::types::{Identity, ManifestSummary, Source};

pub const ENGINE_VERSION: &str = "160.0.1";

/// Chrome permissions this Gecko build cannot grant. Removing them narrows
/// the package and is always reported.
const UNSUPPORTED_PERMISSIONS: &[&str] = &[
    "sidePanel",
    "offscreen",
    "tabCapture",
    "desktopCapture",
    "gcm",
    "webstore",
    "fileSystem",
    "fileBrowserHandler",
    "platformKeys",
    "enterprise.deviceAttributes",
    "enterprise.hardwarePlatform",
    "enterprise.networkingAttributes",
    "enterprise.platformKeys",
    "system.cpu",
    "system.memory",
    "system.storage",
    "system.display",
    "system.network",
    "tts",
    "ttsEngine",
    "fontSettings",
    "processes",
    "printingMetrics",
    "loginState",
    "vpnProvider",
    "wallpaper",
    "certificateProvider",
    "accessibilityFeatures.read",
    "accessibilityFeatures.modify",
    "autotestPrivate",
];

/// Chrome manifest keys this engine does not implement. Keeping them is
/// harmless (they are "unrecognized"), but the review must say so.
const UNSUPPORTED_KEYS: &[(&str, &str)] = &[
    (
        "externally_connectable",
        "external web pages cannot connect to the extension",
    ),
    (
        "side_panel",
        "chrome.sidePanel is adapted to the engine sidebar",
    ),
    (
        "oauth2",
        "chrome.identity.getAuthToken is not implemented by this engine",
    ),
    (
        "requirements",
        "Chrome runtime requirements are not evaluated",
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestKind {
    ChromeMv2,
    ChromeMv3,
    Firefox,
}

impl ManifestKind {
    pub fn is_chrome(self) -> bool {
        !matches!(self, ManifestKind::Firefox)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adaptation {
    pub kind: String,
    pub detail: String,
    /// True when the change means the package will behave differently from
    /// its original browser, not merely differently on disk.
    pub limitation: bool,
}

#[derive(Debug, Clone)]
pub struct ParsedManifest {
    pub value: Value,
    pub kind: ManifestKind,
    pub summary: ManifestSummary,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest.json is not a JSON object")]
    NotObject,
    #[error("manifest.json is not valid JSON: {0}")]
    Json(String),
    #[error("manifest_version must be 2 or 3 (got {0})")]
    UnsupportedVersion(u32),
    #[error("manifest is missing {0}")]
    Missing(&'static str),
}

pub fn parse(bytes: &[u8], source: Source) -> Result<ParsedManifest, ManifestError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| ManifestError::Json(e.to_string()))?;
    let object = value.as_object().ok_or(ManifestError::NotObject)?;
    let manifest_version = object
        .get("manifest_version")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;
    if manifest_version != 2 && manifest_version != 3 {
        return Err(ManifestError::UnsupportedVersion(manifest_version));
    }
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .ok_or(ManifestError::Missing("name"))?
        .to_string();
    let version = object
        .get("version")
        .and_then(Value::as_str)
        .ok_or(ManifestError::Missing("version"))?
        .to_string();
    if name.is_empty() || version.is_empty() {
        return Err(ManifestError::Missing("name or version"));
    }
    // A Chrome-sourced package stays a Chrome package even when it ships a
    // Firefox-shaped `browser_specific_settings` (several do). Otherwise the
    // id the Host API looks for and the id written into the XPI diverge.
    let firefox_shape =
        object.contains_key("browser_specific_settings") || object.contains_key("applications");
    let chrome = match source {
        Source::Chrome => true,
        Source::Firefox => false,
        Source::File => !firefox_shape,
    };
    let kind = if chrome {
        if manifest_version == 3 {
            ManifestKind::ChromeMv3
        } else {
            ManifestKind::ChromeMv2
        }
    } else {
        ManifestKind::Firefox
    };

    let summary = summarize(object, manifest_version, name, version);
    Ok(ParsedManifest {
        value,
        kind,
        summary,
    })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn summarize(
    object: &Map<String, Value>,
    manifest_version: u32,
    name: String,
    version: String,
) -> ManifestSummary {
    let permissions = strings(object.get("permissions"));
    let host_permissions = strings(object.get("host_permissions"));
    let background = object.get("background").and_then(Value::as_object);
    let background_kind = if background.is_some_and(|bg| bg.contains_key("service_worker")) {
        "service_worker"
    } else if background.is_some_and(|bg| bg.contains_key("page")) {
        "page"
    } else if background.is_some_and(|bg| bg.contains_key("scripts")) {
        if manifest_version == 2
            && background
                .and_then(|bg| bg.get("persistent"))
                .and_then(Value::as_bool)
                == Some(true)
        {
            "persistent"
        } else {
            "event_page"
        }
    } else {
        "none"
    };
    let content_scripts = object
        .get("content_scripts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_sidebar = object.contains_key("sidebar_action") || object.contains_key("side_panel");
    let commands = object
        .get("commands")
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();

    ManifestSummary {
        manifest_version,
        name,
        version,
        description: object
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        permissions,
        host_permissions,
        optional_permissions: strings(object.get("optional_permissions")),
        optional_host_permissions: strings(object.get("optional_host_permissions")),
        has_background: background.is_some(),
        background_kind: background_kind.to_string(),
        has_content_scripts: !content_scripts.is_empty(),
        content_script_count: content_scripts.len(),
        has_action: object.contains_key("action"),
        has_browser_action: object.contains_key("browser_action"),
        has_page_action: object.contains_key("page_action"),
        has_sidebar,
        has_options: object.contains_key("options_ui") || object.contains_key("options_page"),
        has_declarative_net_request: object.contains_key("declarative_net_request"),
        has_native_messaging: object
            .get("permissions")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|p| p.as_str() == Some("nativeMessaging"))),
        has_externally_connectable: object.contains_key("externally_connectable"),
        overrides_new_tab: object
            .get("chrome_url_overrides")
            .and_then(Value::as_object)
            .is_some_and(|map| map.contains_key("newtab")),
        commands,
    }
}

/// Rewrite the manifest for the engine and report every change. The returned
/// value is what the XPI contains; `adaptations` is what the review shows.
pub fn adapt(
    parsed: &ParsedManifest,
    identity: &Identity,
    needs_callback_prelude: bool,
) -> (Value, Vec<Adaptation>) {
    let mut value = parsed.value.clone();
    let Some(object) = value.as_object_mut() else {
        return (value, vec![]);
    };
    let mut adaptations = Vec::new();

    // Stable identity: the engine requires one, and the same Chrome package
    // must reinstall over itself rather than beside itself.
    let gecko = object
        .entry("browser_specific_settings")
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(gecko) = gecko.as_object_mut() {
        let id = gecko
            .entry("gecko")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(id) = id.as_object_mut() {
            let current = id.get("id").and_then(Value::as_str).map(str::to_string);
            let force = parsed.kind.is_chrome();
            if (force || current.is_none())
                && current.as_deref() != Some(identity.install_id.as_str())
            {
                let had_id = current.is_some();
                id.insert("id".into(), Value::String(identity.install_id.clone()));
                adaptations.push(Adaptation {
                    kind: "identity".into(),
                    detail: if force && had_id {
                            format!(
                                "installed under the Chrome-derived id {} (the package's Firefox id is not used for the Chrome build)",
                                identity.install_id
                            )
                        } else {
                            format!(
                                "installed under the stable id {} derived from the package",
                                identity.install_id
                            )
                        },
                        limitation: false,
                    });
            }
            if !id.contains_key("strict_min_version") {
                id.insert("strict_min_version".into(), Value::String("115.0".into()));
            }
        }
    }

    // MV2 Chrome `action` is not a manifest key the engine knows; MV2 uses
    // `browser_action`.
    if parsed.kind == ManifestKind::ChromeMv2 && object.contains_key("action") {
        if !object.contains_key("browser_action") {
            if let Some(action) = object.remove("action") {
                object.insert("browser_action".into(), action);
                adaptations.push(Adaptation {
                    kind: "action".into(),
                    detail: "MV2 `action` mapped to `browser_action`".into(),
                    limitation: false,
                });
            }
        } else {
            object.remove("action");
        }
    }

    // Service workers are locked off in this engine; event pages are the
    // documented equivalent. Worker-only globals are shimmed in the prelude.
    if parsed.summary.background_kind == "service_worker" {
        if let Some(background) = object.get_mut("background").and_then(Value::as_object_mut) {
            let worker = background
                .get("service_worker")
                .and_then(Value::as_str)
                .map(|path| path.trim_start_matches('/').to_string());
            let module = background.get("type").and_then(Value::as_str) == Some("module");
            if let Some(worker) = worker {
                background.remove("service_worker");
                let scripts = background
                    .entry("scripts")
                    .or_insert_with(|| Value::Array(Vec::new()));
                if let Some(list) = scripts.as_array_mut() {
                    if !list.iter().any(|s| s.as_str() == Some(worker.as_str())) {
                        list.push(Value::String(worker.clone()));
                    }
                }
                background.insert("persistent".into(), Value::Bool(false));
                adaptations.push(Adaptation {
                    kind: "background".into(),
                    detail: format!(
                        "service worker `{worker}` runs as the engine's{} event page",
                        if module { " module" } else { "" }
                    ),
                    limitation: true,
                });
            }
        }
    }

    // Chrome `side_panel` has no engine API; the engine's sidebar does.
    if let Some(panel) = object.remove("side_panel") {
        let path = panel
            .get("default_path")
            .and_then(Value::as_str)
            .unwrap_or("sidepanel.html")
            .to_string();
        if !object.contains_key("sidebar_action") {
            let mut sidebar = Map::new();
            sidebar.insert("default_panel".into(), Value::String(path.clone()));
            if let Some(title) = panel.get("default_title").and_then(Value::as_str) {
                sidebar.insert("default_title".into(), Value::String(title.to_string()));
            }
            if let Some(icon) = panel.get("default_icon").cloned() {
                sidebar.insert("default_icon".into(), icon);
            }
            object.insert("sidebar_action".into(), Value::Object(sidebar));
        }
        adaptations.push(Adaptation {
            kind: "sidebar".into(),
            detail: format!("`side_panel` mapped to the engine sidebar (`{path}`)"),
            limitation: true,
        });
    }

    // Chrome-only permissions this engine cannot grant. Removing them is
    // honest narrowing; the list is reported and shown before install.
    let mut removed_permissions = Vec::new();
    for key in ["permissions", "optional_permissions"] {
        if let Some(list) = object.get_mut(key).and_then(Value::as_array_mut) {
            list.retain(|item| {
                let keep = item
                    .as_str()
                    .map(|name| !UNSUPPORTED_PERMISSIONS.contains(&name))
                    .unwrap_or(true);
                if !keep {
                    if let Some(name) = item.as_str() {
                        removed_permissions.push(name.to_string());
                    }
                }
                keep
            });
        }
    }
    if !removed_permissions.is_empty() {
        adaptations.push(Adaptation {
            kind: "permissions".into(),
            detail: format!(
                "removed permissions this engine cannot grant: {}",
                removed_permissions.join(", ")
            ),
            limitation: true,
        });
    }

    for (key, reason) in UNSUPPORTED_KEYS {
        if *key == "side_panel" {
            continue; // handled above
        }
        if object.contains_key(*key) {
            adaptations.push(Adaptation {
                kind: (*key).into(),
                detail: (*reason).into(),
                limitation: true,
            });
        }
    }

    // Chrome accepts extension-root paths with a leading slash; the engine's
    // ExtensionURL validation and ZIP lookups expect a relative path.
    normalize_manifest_paths(object);

    // Chrome provenance keys. `key` is used for identity before this point;
    // the engine installs by add-on id, not by the Chrome key.
    object.remove("key");
    object.remove("update_url");
    object.remove("minimum_chrome_version");

    // A Chrome MV3 package may carry `sidePanel` in its permission list after
    // the removal above; ensure the engine does not see it twice.
    if needs_callback_prelude {
        adaptations.push(Adaptation {
            kind: "compat".into(),
            detail: "added the callback/sidePanel compatibility prelude".into(),
            limitation: false,
        });
    }

    (value, adaptations)
}

fn strip_root(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

fn normalize_value(value: &mut Value) {
    if let Some(path) = value.as_str() {
        let stripped = strip_root(path);
        if stripped != path {
            *value = Value::String(stripped);
        }
    }
}

fn normalize_array(list: &mut Value) {
    if let Some(items) = list.as_array_mut() {
        for item in items {
            normalize_value(item);
        }
    }
}

fn normalize_object_paths(value: &mut Value) {
    if let Some(map) = value.as_object_mut() {
        for item in map.values_mut() {
            normalize_value(item);
        }
    }
}

fn normalize_action(object: &mut Map<String, Value>, key: &str) {
    let Some(action) = object.get_mut(key).and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(value) = action.get_mut("default_popup") {
        normalize_value(value);
    }
    if let Some(icon) = action.get_mut("default_icon") {
        if icon.is_object() {
            normalize_object_paths(icon);
        } else {
            normalize_value(icon);
        }
    }
}

/// Chrome lets a WAR entry expose resources to another extension with
/// `matches: ["chrome-extension://<id>/*"]`. Gecko's MatchPattern has no
/// `chrome-extension` scheme and rejects the manifest; the equivalent Gecko
/// shape is `extension_ids: ["<id>"]`.
fn adapt_war_matches(map: &mut Map<String, Value>) {
    if let Some(ids) = map.get_mut("extension_ids").and_then(Value::as_array_mut) {
        for value in ids.iter_mut() {
            if let Some(id) = value.as_str() {
                *value = Value::String(gecko_extension_id(id));
            }
        }
    }
    let Some(matches) = map.get_mut("matches").and_then(Value::as_array_mut) else {
        return;
    };
    let mut kept = Vec::new();
    let mut extension_ids = Vec::new();
    for value in matches.drain(..) {
        let Some(pattern) = value.as_str() else {
            continue;
        };
        if let Some(rest) = pattern.strip_prefix("chrome-extension://") {
            let id = rest.split('/').next().unwrap_or("");
            if !id.is_empty() {
                extension_ids.push(Value::String(id.to_string()));
            }
            continue;
        }
        if pattern == "<all_urls>"
            || pattern.starts_with("http://")
            || pattern.starts_with("https://")
            || pattern.starts_with("ws://")
            || pattern.starts_with("wss://")
            || pattern.starts_with("ftp://")
            || pattern.starts_with("file://")
        {
            kept.push(Value::String(pattern.to_string()));
        }
    }
    *matches = kept;
    if extension_ids.is_empty() {
        return;
    }
    let list = map
        .entry("extension_ids")
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(list) = list.as_array_mut() {
        for id in extension_ids {
            let id = match id {
                Value::String(id) => Value::String(gecko_extension_id(&id)),
                other => other,
            };
            if !list.contains(&id) {
                list.push(id);
            }
        }
    }
}

/// A Chrome extension id is not a Gecko add-on id. Astra installs a Chrome
/// package under `<chrome-id>@chrome.astra`, so a WAR reference to another
/// Chrome extension must use that same shape.
fn gecko_extension_id(id: &str) -> String {
    if id == "*" || id.starts_with('{') || id.contains('@') {
        id.to_string()
    } else {
        format!("{id}@chrome.astra")
    }
}

fn normalize_manifest_paths(object: &mut Map<String, Value>) {
    for key in ["options_page", "devtools_page"] {
        if let Some(value) = object.get_mut(key) {
            normalize_value(value);
        }
    }
    if let Some(options) = object.get_mut("options_ui").and_then(Value::as_object_mut) {
        if let Some(page) = options.get_mut("page") {
            normalize_value(page);
        }
    }
    if let Some(background) = object.get_mut("background").and_then(Value::as_object_mut) {
        if let Some(page) = background.get_mut("page") {
            normalize_value(page);
        }
        if let Some(scripts) = background.get_mut("scripts") {
            normalize_array(scripts);
        }
    }
    if let Some(groups) = object
        .get_mut("content_scripts")
        .and_then(Value::as_array_mut)
    {
        for group in groups {
            if let Some(group) = group.as_object_mut() {
                for field in ["js", "css"] {
                    if let Some(list) = group.get_mut(field) {
                        normalize_array(list);
                    }
                }
            }
        }
    }
    for key in ["action", "browser_action", "page_action"] {
        normalize_action(object, key);
    }
    if let Some(sidebar) = object
        .get_mut("sidebar_action")
        .and_then(Value::as_object_mut)
    {
        if let Some(panel) = sidebar.get_mut("default_panel") {
            normalize_value(panel);
        }
        if let Some(icon) = sidebar.get_mut("default_icon") {
            if icon.is_object() {
                normalize_object_paths(icon);
            } else {
                normalize_value(icon);
            }
        }
    }
    if let Some(overrides) = object
        .get_mut("chrome_url_overrides")
        .and_then(Value::as_object_mut)
    {
        for value in overrides.values_mut() {
            normalize_value(value);
        }
    }
    if let Some(icons) = object.get_mut("icons").and_then(Value::as_object_mut) {
        for value in icons.values_mut() {
            normalize_value(value);
        }
    }
    if let Some(resources) = object.get_mut("web_accessible_resources") {
        match resources {
            Value::Array(items) => {
                for item in items {
                    if item.is_array() {
                        normalize_array(item);
                    } else if item.is_string() {
                        normalize_value(item);
                    } else if let Some(map) = item.as_object_mut() {
                        if let Some(list) = map.get_mut("resources") {
                            normalize_array(list);
                        }
                        adapt_war_matches(map);
                    }
                }
            }
            Value::Object(map) => {
                if let Some(list) = map.get_mut("resources") {
                    normalize_array(list);
                }
                adapt_war_matches(map);
            }
            _ => {}
        }
    }
    if let Some(dnr) = object
        .get_mut("declarative_net_request")
        .and_then(Value::as_object_mut)
    {
        if let Some(rules) = dnr.get_mut("rule_resources").and_then(Value::as_array_mut) {
            for rule in rules {
                if let Some(path) = rule.get_mut("path") {
                    normalize_value(path);
                }
            }
        }
    }
}

/// Files the adapter needs to write, relative to the package root.
pub const COMPAT_SCRIPT: &str = "astra-compat.js";

/// Prepend the prelude to background scripts and to every content script.
pub fn attach_compat(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if let Some(background) = object.get_mut("background").and_then(Value::as_object_mut) {
        let scripts = background
            .entry("scripts")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(list) = scripts.as_array_mut() {
            for value in list.iter_mut() {
                if let Some(path) = value.as_str() {
                    *value = Value::String(path.trim_start_matches('/').to_string());
                }
            }
            if !list.iter().any(|s| s.as_str() == Some(COMPAT_SCRIPT)) {
                list.insert(0, Value::String(COMPAT_SCRIPT.into()));
            }
        }
    }
    if let Some(groups) = object
        .get_mut("content_scripts")
        .and_then(Value::as_array_mut)
    {
        for group in groups {
            let Some(group) = group.as_object_mut() else {
                continue;
            };
            let js = group
                .entry("js")
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(list) = js.as_array_mut() {
                for value in list.iter_mut() {
                    if let Some(path) = value.as_str() {
                        *value = Value::String(path.trim_start_matches('/').to_string());
                    }
                }
                if !list.iter().any(|s| s.as_str() == Some(COMPAT_SCRIPT)) {
                    list.insert(0, Value::String(COMPAT_SCRIPT.into()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Identity, IdentityKind};

    fn identity() -> Identity {
        Identity {
            install_id: "abcdefghijklmnopabcdefghijklmnop@chrome.astra".into(),
            chrome_id: Some("abcdefghijklmnopabcdefghijklmnop".into()),
            kind: IdentityKind::ChromeKey,
        }
    }

    #[test]
    fn a_service_worker_becomes_an_event_page_script() {
        let value = serde_json::json!({
            "manifest_version": 3,
            "name": "Worker",
            "version": "1.0",
            "background": { "service_worker": "sw.js", "type": "module" },
            "permissions": ["storage"],
        });
        let parsed = parse(value.to_string().as_bytes(), Source::Chrome).expect("parses");
        let (adapted, notes) = adapt(&parsed, &identity(), false);
        let background = &adapted["background"];
        assert_eq!(background["scripts"][0], "sw.js");
        assert_eq!(background["type"], "module");
        assert!(background.get("service_worker").is_none());
        assert_eq!(
            adapted["browser_specific_settings"]["gecko"]["id"],
            "abcdefghijklmnopabcdefghijklmnop@chrome.astra"
        );
        assert!(notes.iter().any(|n| n.kind == "background" && n.limitation));
    }

    #[test]
    fn side_panel_becomes_sidebar_action_and_removes_unsupported_permission() {
        let value = serde_json::json!({
            "manifest_version": 3,
            "name": "Panel",
            "version": "1.0",
            "side_panel": { "default_path": "panel.html", "default_title": "Panel" },
            "permissions": ["sidePanel", "storage"],
        });
        let parsed = parse(value.to_string().as_bytes(), Source::Chrome).expect("parses");
        let (adapted, notes) = adapt(&parsed, &identity(), true);
        assert!(adapted.get("side_panel").is_none());
        assert_eq!(adapted["sidebar_action"]["default_panel"], "panel.html");
        assert_eq!(adapted["permissions"], serde_json::json!(["storage"]));
        assert!(notes.iter().any(|n| n.detail.contains("sidePanel")));
    }

    #[test]
    fn content_scripts_get_the_prelude_first() {
        let mut value = serde_json::json!({
            "manifest_version": 3,
            "name": "CS",
            "version": "1.0",
            "background": { "scripts": ["bg.js"] },
            "content_scripts": [{ "matches": ["<all_urls>"], "js": ["cs.js"] }],
        });
        attach_compat(&mut value);
        assert_eq!(value["background"]["scripts"][0], COMPAT_SCRIPT);
        assert_eq!(value["content_scripts"][0]["js"][0], COMPAT_SCRIPT);
        attach_compat(&mut value);
        assert_eq!(
            value["content_scripts"][0]["js"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn a_chrome_package_with_a_firefox_id_keeps_the_chrome_id() {
        let value = serde_json::json!({
            "manifest_version": 3,
            "name": "Sibling",
            "version": "1.0",
            "browser_specific_settings": { "gecko": { "id": "jid1-sibling@jetpack" } },
        });
        let parsed = parse(value.to_string().as_bytes(), Source::Chrome).expect("parses");
        assert_eq!(parsed.kind, ManifestKind::ChromeMv3);
        let (adapted, notes) = adapt(&parsed, &identity(), false);
        assert_eq!(
            adapted["browser_specific_settings"]["gecko"]["id"],
            "abcdefghijklmnopabcdefghijklmnop@chrome.astra"
        );
        assert!(notes
            .iter()
            .any(|note| note.kind == "identity" && note.detail.contains("Firefox id")));
    }

    #[test]
    fn chrome_extension_war_matches_become_gecko_extension_ids() {
        let value = serde_json::json!({
            "manifest_version": 3,
            "name": "WAR",
            "version": "1.0",
            "web_accessible_resources": [{
                "matches": ["<all_urls>", "chrome-extension://ocpdpnakdghopjcifldjidbdmfobmmoi/*"],
                "resources": ["images/*.svg"],
            }],
        });
        let parsed = parse(value.to_string().as_bytes(), Source::Chrome).expect("parses");
        let (adapted, _) = adapt(&parsed, &identity(), false);
        let war = &adapted["web_accessible_resources"][0];
        assert_eq!(war["matches"], serde_json::json!(["<all_urls>"]));
        assert_eq!(
            war["extension_ids"],
            serde_json::json!(["ocpdpnakdghopjcifldjidbdmfobmmoi@chrome.astra"])
        );
    }

    #[test]
    fn a_firefox_manifest_is_not_rewritten() {
        let value = serde_json::json!({
            "manifest_version": 2,
            "name": "FF",
            "version": "1.0",
            "browser_specific_settings": { "gecko": { "id": "ff@example.com" } },
        });
        let parsed = parse(value.to_string().as_bytes(), Source::Firefox).expect("parses");
        assert_eq!(parsed.kind, ManifestKind::Firefox);
        let (adapted, notes) = adapt(&parsed, &identity(), false);
        assert_eq!(
            adapted["browser_specific_settings"]["gecko"]["id"],
            "ff@example.com"
        );
        assert!(notes.is_empty());
    }
}

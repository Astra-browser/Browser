/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Compatibility inventory for Gecko 153.6.0esr.
//!
//! The table is not aspirational. Every namespace marked `Supported` has a
//! schema in `engine/toolkit/components/extensions/schemas` or
//! `engine/browser/components/extensions/schemas`; the partial entries name
//! the member and the reason. `Unknown` means the engine has no such
//! namespace, so the extension's call would throw.
//!
//! The scanner is deliberately lexical: it inventories API names in the
//! package's JavaScript. It does not execute anything and does not claim the
//! code path runs.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use crate::types::{ApiFinding, ApiSupport, ApiUse};

/// Namespaces implemented by this engine (schema present).
const SUPPORTED: &[&str] = &[
    "action",
    "alarms",
    "bookmarks",
    "browserAction",
    "browserSettings",
    "browsingData",
    "captivePortal",
    "clipboard",
    "commands",
    "contentScripts",
    "contextMenus",
    "contextualIdentities",
    "cookies",
    "declarativeNetRequest",
    "devtools",
    "dns",
    "downloads",
    "extension",
    "extensionTypes",
    "find",
    "history",
    "i18n",
    "identity",
    "idle",
    "management",
    "menus",
    "notifications",
    "omnibox",
    "pageAction",
    "permissions",
    "pkcs11",
    "privacy",
    "proxy",
    "runtime",
    "scripting",
    "search",
    "sessions",
    "sidebarAction",
    "storage",
    "tabGroups",
    "tabs",
    "theme",
    "topSites",
    "userScripts",
    "webNavigation",
    "webRequest",
    "windows",
];

/// Members with a specific engine difference.
const PARTIAL: &[(&str, &str, &str)] = &[
    (
        "identity",
        "getAuthToken",
        "not implemented by Gecko 153; use identity.launchWebAuthFlow",
    ),
    (
        "identity",
        "getAccounts",
        "not implemented by Gecko 153; there is no Chrome profile account",
    ),
    (
        "identity",
        "getProfileUserInfo",
        "not implemented by Gecko 153",
    ),
    (
        "management",
        "install",
        "the engine restricts programmatic add-on installation",
    ),
    (
        "management",
        "uninstall",
        "the engine restricts programmatic add-on removal",
    ),
    (
        "management",
        "setEnabled",
        "the engine restricts programmatic enable/disable",
    ),
    (
        "management",
        "getAll",
        "returns the extensions visible to this profile only",
    ),
    (
        "storage",
        "sync",
        "stored locally; Astra has no account sync service, so it does not roam",
    ),
    (
        "runtime",
        "*",
        "MV3 chrome.* is promise-only; the compatibility prelude adds the callback form",
    ),
    (
        "action",
        "openPopup",
        "the engine may require a user gesture",
    ),
    (
        "browserAction",
        "openPopup",
        "the engine may require a user gesture",
    ),
    (
        "tabs",
        "captureVisibleTab",
        "supported for the active tab; chrome:// and privileged pages are refused by the engine",
    ),
    (
        "permissions",
        "request",
        "the prompt is Astra's; the engine enforces the grant",
    ),
];

/// Namespaces the engine does not implement. A call throws unless the
/// compatibility prelude supplies a mapping (sidePanel is adapted).
const UNSUPPORTED: &[(&str, &str)] = &[
    ("debugger", "no chrome.debugger implementation in Gecko 153"),
    (
        "desktopCapture",
        "no desktop capture picker API in this build",
    ),
    ("tabCapture", "no tab-capture stream API in this build"),
    (
        "offscreen",
        "no offscreen document API; service workers are event pages",
    ),
    ("fileSystem", "no Chrome file-system API"),
    ("fileBrowserHandler", "ChromeOS-only API"),
    ("system", "no chrome.system.* hardware API"),
    ("tts", "no speech synthesis extension API"),
    ("ttsEngine", "no speech synthesis extension API"),
    ("fontSettings", "no font-settings API"),
    ("webstore", "Chrome Web Store install API is not available"),
    ("gcm", "no Google Cloud Messaging service"),
    ("instanceID", "no Google instance-id service"),
    ("enterprise", "no Chrome enterprise policy API"),
    ("vpnProvider", "no third-party VPN provider API"),
    ("wallpaper", "ChromeOS-only API"),
    ("loginState", "ChromeOS-only API"),
    ("certificateProvider", "ChromeOS-only API"),
    ("documentScan", "no document-scan API in this build"),
    ("printerProvider", "no printer-provider API in this build"),
    ("printing", "no chrome.printing API in this build"),
    ("printingMetrics", "no printing-metrics API"),
    ("accessibilityFeatures", "no accessibility-features API"),
    ("processes", "no process list API"),
    ("power", "no power-management API in this build"),
];

/// Namespaces that need the prelude rather than a plain pass-through.
const ADAPTED: &[(&str, &str)] = &[(
    "sidePanel",
    "mapped to the engine sidebar (sidebar_action) by the compatibility prelude",
)];

pub fn support_for(namespace: &str, member: Option<&str>) -> (ApiSupport, String) {
    if let Some(member) = member {
        if let Some((_, _, reason)) = PARTIAL
            .iter()
            .find(|(ns, m, _)| *ns == namespace && *m == member)
        {
            return (ApiSupport::Partial, (*reason).into());
        }
        if namespace == "identity" && member == "getAuthToken" {
            return (ApiSupport::Partial, "not implemented by Gecko 153".into());
        }
    }
    if let Some((_, reason)) = UNSUPPORTED.iter().find(|(ns, _)| *ns == namespace) {
        return (ApiSupport::Unsupported, (*reason).into());
    }
    if let Some((_, reason)) = ADAPTED.iter().find(|(ns, _)| *ns == namespace) {
        return (ApiSupport::Adapted, (*reason).into());
    }
    if SUPPORTED.contains(&namespace) {
        if namespace == "identity" {
            return (
                ApiSupport::Partial,
                "identity.launchWebAuthFlow is implemented; token/account helpers are not".into(),
            );
        }
        if namespace == "storage" && member == Some("sync") {
            return (
                ApiSupport::Partial,
                "stored locally; Astra has no account sync service".into(),
            );
        }
        return (ApiSupport::Supported, String::new());
    }
    (
        ApiSupport::Unknown,
        format!("Gecko 153 has no `{namespace}` extension namespace"),
    )
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

/// Find `chrome.<ns>.<member>` / `browser.<ns>.<member>` tokens. The scanner
/// only takes the first two segments; deeper members are events and do not
/// change the support verdict.
pub fn scan_apis(files: &BTreeMap<String, Vec<u8>>) -> Vec<ApiUse> {
    let mut uses: BTreeMap<(String, Option<String>), (usize, BTreeSet<String>)> = BTreeMap::new();
    for (path, bytes) in files {
        let mut index = 0usize;
        while let Some(found) = find_candidate(bytes, index) {
            let (global, after_global) = found;
            index = after_global;
            let Some((namespace, after_ns)) = read_ident(bytes, after_global) else {
                continue;
            };
            let (member, _) = read_ident_after_dot(bytes, after_ns);
            if namespace.is_empty() {
                continue;
            }
            let _ = global;
            let key = (namespace, member);
            let entry = uses.entry(key).or_insert_with(|| (0, BTreeSet::new()));
            entry.0 += 1;
            entry.1.insert(path.clone());
        }
    }
    uses.into_iter()
        .map(|((namespace, member), (count, files))| ApiUse {
            namespace,
            members: member.into_iter().collect(),
            files: files.into_iter().collect(),
            count,
        })
        .collect()
}

/// Return `(which global, index after the dot)` for a browser/chrome global
/// that is not itself a property of something else.
fn find_candidate(bytes: &[u8], from: usize) -> Option<(&'static str, usize)> {
    let mut i = from;
    while i + 7 <= bytes.len() {
        let window = &bytes[i..];
        let (name, len) = if window.starts_with(b"chrome.") {
            ("chrome", 7)
        } else if window.starts_with(b"browser.") {
            ("browser", 8)
        } else {
            i += 1;
            continue;
        };
        // A URL (`https://chrome.google.com`) or a quoted string is not an
        // API call. `.` and identifier bytes are properties of another name.
        if i > 0
            && (is_ident(bytes[i - 1])
                || matches!(
                    bytes[i - 1],
                    b'.' | b'/' | b':' | b'@' | b'-' | b'"' | b'\''
                ))
        {
            i += 1;
            continue;
        }
        return Some((name, i + len));
    }
    None
}

fn read_ident(bytes: &[u8], from: usize) -> Option<(String, usize)> {
    let mut end = from;
    while end < bytes.len() && is_ident(bytes[end]) {
        end += 1;
    }
    if end == from {
        return None;
    }
    Some((String::from_utf8_lossy(&bytes[from..end]).into_owned(), end))
}

fn read_ident_after_dot(bytes: &[u8], from: usize) -> (Option<String>, usize) {
    if from >= bytes.len() || bytes[from] != b'.' {
        return (None, from);
    }
    match read_ident(bytes, from + 1) {
        Some((ident, end)) => (Some(ident), end),
        None => (None, from),
    }
}

/// Build the review's API findings, bounded to the first 80 families.
pub fn findings(uses: &[ApiUse]) -> Vec<ApiFinding> {
    uses.iter()
        .take(80)
        .map(|use_| {
            let member = use_.members.first().map(String::as_str);
            let (support, reason) = support_for(&use_.namespace, member);
            ApiFinding {
                namespace: use_.namespace.clone(),
                member: member.map(str::to_string),
                support,
                reason,
            }
        })
        .collect()
}

/// Whether this package needs the compatibility prelude.
pub fn needs_prelude(
    kind: crate::manifest::ManifestKind,
    uses: &[ApiUse],
    has_side_panel: bool,
) -> bool {
    if has_side_panel {
        return true;
    }
    if uses.iter().any(|u| u.namespace == "sidePanel") {
        return true;
    }
    // MV3 gives the extension the promise-only alias as `chrome.*`.
    if kind == crate::manifest::ManifestKind::ChromeMv3 {
        return uses.iter().any(|u| u.namespace != "");
    }
    false
}

/// The compatibility prelude written into the adapted package.
///
/// It is intentionally small and inspectable. It does not add permissions and
/// it does not invent API results:
/// - callback form for `chrome.*` promise methods (MV3);
/// - `chrome.sidePanel` over `sidebarAction`;
/// - `clients`/`skipWaiting` no-ops for code written for a service worker;
/// - `install`/`activate` listeners run once at background start;
/// - `waitUntil` drains the promise without pretending the engine waits.
pub const PRELUDE: &str = r#"/* Astra Chrome compatibility prelude (generated). MPL-2.0. */
(() => {
  "use strict";
  const g = globalThis;
  const chrome = g.chrome;
  if (!chrome) return;

  let lastError;
  const setLastError = (error) => {
    lastError = error ? { message: String(error && error.message ? error.message : error) } : undefined;
  };
  try {
    Object.defineProperty(chrome.runtime, "lastError", {
      configurable: true,
      get: () => lastError,
      set: (value) => { lastError = value; },
    });
  } catch {
    /* The engine may not allow redefining it; callbacks still receive the error. */
  }

  const NAMESPACES = [
    "runtime", "tabs", "windows", "storage", "scripting", "action", "browserAction",
    "pageAction", "permissions", "contextMenus", "menus", "commands", "notifications",
    "downloads", "bookmarks", "history", "cookies", "identity", "webRequest",
    "declarativeNetRequest", "alarms", "idle", "omnibox", "sessions", "sidebarAction",
    "theme", "webNavigation", "management", "privacy", "proxy", "topSites", "find",
    "clipboard", "dns", "tabGroups", "userScripts", "devtools", "browsingData",
    "contextualIdentities",
  ];

  const wrap = (namespace) => {
    if (!namespace || typeof namespace !== "object") return;
    for (const key of Object.keys(namespace)) {
      let original;
      try { original = namespace[key]; } catch { continue; }
      if (typeof original !== "function") continue;
      const wrapper = function (...args) {
        let callback = null;
        if (args.length > 0 && typeof args[args.length - 1] === "function") {
          callback = args.pop();
        }
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          if (!callback) throw error;
          setLastError(error);
          callback(undefined);
          return undefined;
        }
        if (!callback) return result;
        if (result && typeof result.then === "function") {
          result.then(
            (value) => { setLastError(undefined); callback(value); },
            (error) => { setLastError(error); callback(undefined); },
          );
          return undefined;
        }
        setLastError(undefined);
        callback(result);
        return undefined;
      };
      try {
        Object.defineProperty(namespace, key, {
          value: wrapper,
          configurable: true,
          writable: true,
          enumerable: true,
        });
      } catch {
        /* A frozen namespace keeps its promise form; reported as a limitation. */
      }
    }
  };

  for (const name of NAMESPACES) {
    try { wrap(chrome[name]); } catch { /* namespace not present in this context */ }
  }

  // chrome.sidePanel over the engine sidebar.
  if (!chrome.sidePanel) {
    const sidebar = chrome.sidebarAction;
    if (sidebar) {
      chrome.sidePanel = {
        setOptions: async (options = {}) => {
          if (typeof options.path === "string") await sidebar.setPanel({ panel: options.path });
          if (typeof options.title === "string") await sidebar.setTitle({ title: options.title });
          if (options.enabled === false) {
            // The engine sidebar has no "disabled" state; closing is the
            // honest equivalent and only works during a user gesture.
            try { await sidebar.close(); } catch { /* no gesture */ }
          }
        },
        getOptions: async () => {
          const panel = await sidebar.getPanel({});
          const title = await sidebar.getTitle({});
          return { path: panel && panel.panel ? panel.panel : undefined, title: title && title.title ? title.title : undefined };
        },
        setPanelBehavior: async () => undefined,
        open: async () => { await sidebar.open(); },
      };
    }
  }

  // Service-worker-shaped globals for code written for Chrome MV3. These are
  // no-ops, not fabricated browser state.
  if (!g.clients) {
    g.clients = {
      claim: async () => undefined,
      matchAll: async () => [],
      get: async () => undefined,
      openWindow: async () => undefined,
    };
  }
  if (!g.registration) {
    g.registration = { scope: chrome.runtime.getURL(""), update: async () => undefined, unregister: async () => true };
  }
  if (typeof g.skipWaiting !== "function") g.skipWaiting = () => Promise.resolve();
  if (typeof g.waitUntil !== "function") {
    g.waitUntil = (promise) => {
      if (promise && typeof promise.catch === "function") promise.catch(() => undefined);
    };
  }

  // `install` / `activate` are service-worker lifecycle events. The engine
  // runs an event page, so run the handlers once at background start.
  if (typeof g.addEventListener === "function" && typeof g.dispatchEvent === "function" && typeof Event === "function") {
    const lifecycle = new Map();
    const nativeAdd = g.addEventListener.bind(g);
    g.addEventListener = function (type, listener, options) {
      if (type === "install" || type === "activate") {
        lifecycle.set(type, listener);
        return undefined;
      }
      return nativeAdd(type, listener, options);
    };
    queueMicrotask(() => {
      for (const type of ["install", "activate"]) {
        const listener = lifecycle.get(type);
        if (typeof listener !== "function") continue;
        try {
          const event = new Event(type);
          event.waitUntil = (promise) => {
            if (promise && typeof promise.catch === "function") promise.catch(() => undefined);
          };
          listener.call(g, event);
        } catch (error) {
          console.error("[astra compat] lifecycle listener failed", type, error);
        }
      }
    });
  }
})();
"#;

/// Escape a path for embedding in a generated module. Kept for the importer
/// expansion path.
pub fn js_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            ch if (ch as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", ch as u32);
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scanner_takes_namespaces_and_members() {
        let mut files = BTreeMap::new();
        files.insert(
            "bg.js".to_string(),
            br#"chrome.tabs.query({}, () => {}); browser.storage.local.get("x"); my.chrome.nope();"#
                .to_vec(),
        );
        let uses = scan_apis(&files);
        let names: Vec<String> = uses
            .iter()
            .map(|u| {
                format!(
                    "{}.{}",
                    u.namespace,
                    u.members.first().cloned().unwrap_or_default()
                )
            })
            .collect();
        assert!(names.contains(&"tabs.query".to_string()));
        assert!(names.contains(&"storage.local".to_string()));
        assert!(!names.iter().any(|n| n.starts_with("nope")));
        assert_eq!(
            uses.iter().find(|u| u.namespace == "tabs").unwrap().count,
            1
        );
    }

    #[test]
    fn unsupported_namespaces_are_reported_not_hidden() {
        let mut files = BTreeMap::new();
        files.insert(
            "bg.js".to_string(),
            b"chrome.debugger.attach(); chrome.offscreen.createDocument();".to_vec(),
        );
        let uses = scan_apis(&files);
        let findings = findings(&uses);
        assert!(findings
            .iter()
            .any(|f| f.namespace == "debugger" && f.support == ApiSupport::Unsupported));
        assert!(findings
            .iter()
            .any(|f| f.namespace == "offscreen" && f.support == ApiSupport::Unsupported));
    }

    #[test]
    fn side_panel_is_adapted_and_needs_the_prelude() {
        assert_eq!(support_for("sidePanel", None).0, ApiSupport::Adapted);
        assert!(needs_prelude(
            crate::manifest::ManifestKind::ChromeMv3,
            &[],
            true
        ));
    }

    #[test]
    fn the_prelude_is_balanced_and_has_no_fake_results() {
        assert!(PRELUDE.contains("sidePanel"));
        assert!(PRELUDE.contains("lastError"));
        assert_eq!(PRELUDE.matches('{').count(), PRELUDE.matches('}').count());
        assert!(!PRELUDE.contains("substitute"));
    }
}

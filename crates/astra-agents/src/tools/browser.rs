/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Browser tools (P6-T03): open, read, snapshot, screenshot, click, type,
//! scroll.
//!
//! The Rust side owns names, JSON Schemas, argument validation, and the
//! approval hook (which calls into [`crate::approvals::classify`]). Page
//! access itself goes through the Host API `ContentTools` module
//! (`overlay/astra/host/ContentTools.sys.mjs`): open/read resolve through
//! the tabs model, read/snapshot return the readability text plus the
//! accessibility tree, and screenshots capture the live `<browser>`.
//! When the in-content path is unavailable (no mounted browser, detached
//! actor), the shell falls back to WebDriver BiDi
//! (`browsingContext.captureScreenshot`, `Accessibility.getTree`) — see
//! `docs/astra/TOOLS.md` for the fallback contract. This crate never
//! touches the wire: every tool here drives a [`BrowserDriver`] seam, so
//! unit tests inject [`FakeBrowser`] and no test needs a live browser.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::{parse_args, AgentTool, ToolCall, ToolError, ToolResult};

/// What `browser_read` returns: the readability text plus the a11y snapshot
/// reference the model cites. Screenshots are reported by `browser_screenshot`
/// as metadata (bytes + size); raw pixels never enter logs or evals.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageRead {
    pub url: String,
    pub title: String,
    pub text: String,
    pub snapshot_ref: String,
}

impl PageRead {
    /// Truncate `text` to `max_chars` for output-cap compliance.
    pub fn capped(mut self, max_chars: usize) -> Self {
        if self.text.chars().count() > max_chars {
            let capped: String = self.text.chars().take(max_chars).collect();
            self.text = format!("{capped}…[truncated]");
        }
        self
    }
}

/// Driver seam: one method per Host API `ContentTools` operation. The live
/// shell implements this over `ContentTools.sys.mjs`; tests use
/// [`FakeBrowser`]. All methods take plain values and return plain values
/// so fakes stay trivial and the BiDi fallback stays behind the seam.
pub trait BrowserDriver: Send + Sync {
    /// Navigate the selected tab to `url`.
    fn open(&self, url: &str) -> Result<String, String>;
    /// Readability text + title for the current page.
    fn read(&self) -> Result<PageRead, String>;
    /// Accessibility snapshot (JSON string) for the current page.
    fn snapshot(&self) -> Result<String, String>;
    /// Screenshot capture; returns `(png_bytes, width, height)`.
    fn screenshot(&self) -> Result<(Vec<u8>, u32, u32), String>;
    /// Click the element referenced by `target` (a11y ref or selector).
    fn click(&self, target: &str) -> Result<String, String>;
    /// Type `text` into the element referenced by `target`.
    fn type_text(&self, target: &str, text: &str, submit: bool) -> Result<String, String>;
    /// Scroll by (`dx`, `dy`) CSS pixels (or to `target` when given).
    fn scroll(&self, dx: i32, dy: i32, target: Option<&str>) -> Result<String, String>;
}

/// In-memory fake driver: scripted pages plus an event log. Backs every
/// browser unit test — no live browser, no network.
#[derive(Clone, Debug, Default)]
pub struct FakeBrowser {
    inner: Arc<Mutex<FakeState>>,
}

#[derive(Debug, Default)]
struct FakeState {
    pages: HashMap<String, PageRead>,
    current: Option<String>,
    events: Vec<String>,
}

impl FakeBrowser {
    /// Empty fake with no pages loaded.
    pub fn new() -> Self {
        Self::default()
    }

    /// Script one page the fake will serve.
    pub fn with_page(mut self, page: PageRead) -> Self {
        self.add_page(page);
        self
    }

    /// Add a scripted page.
    pub fn add_page(&mut self, page: PageRead) {
        let mut state = self.inner.lock().expect("fake browser lock");
        if state.current.is_none() {
            state.current = Some(page.url.clone());
        }
        state.pages.insert(page.url.clone(), page);
    }

    /// Currently open URL, if any.
    pub fn current_url(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("fake browser lock")
            .current
            .clone()
    }

    /// Driver calls observed so far (open/click/type/…).
    pub fn events(&self) -> Vec<String> {
        self.inner.lock().expect("fake browser lock").events.clone()
    }
}

impl BrowserDriver for FakeBrowser {
    fn open(&self, url: &str) -> Result<String, String> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("invalid_url: browser_open requires an http(s) URL".to_owned());
        }
        let mut state = self.inner.lock().expect("fake browser lock");
        state.events.push(format!("open {url}"));
        state.current = Some(url.to_owned());
        Ok(url.to_owned())
    }

    fn read(&self) -> Result<PageRead, String> {
        let state = self.inner.lock().expect("fake browser lock");
        let url = state
            .current
            .clone()
            .ok_or_else(|| "no_page: browser_read with no page open".to_owned())?;
        state
            .pages
            .get(&url)
            .cloned()
            .ok_or_else(|| format!("no_page: no scripted page for {url}"))
    }

    fn snapshot(&self) -> Result<String, String> {
        let state = self.inner.lock().expect("fake browser lock");
        let url = state
            .current
            .clone()
            .ok_or_else(|| "no_page: browser_snapshot with no page open".to_owned())?;
        let page = state
            .pages
            .get(&url)
            .ok_or_else(|| format!("no_page: no scripted page for {url}"))?;
        Ok(serde_json::json!({
            "url": page.url,
            "root": { "role": "WebArea", "name": page.title, "children": [] },
        })
        .to_string())
    }

    fn screenshot(&self) -> Result<(Vec<u8>, u32, u32), String> {
        let state = self.inner.lock().expect("fake browser lock");
        if state.current.is_none() {
            return Err("no_page: browser_screenshot with no page open".to_owned());
        }
        // Minimal 1x1 PNG stand-in; tests assert metadata, never pixels.
        Ok((vec![0x89, b'P', b'N', b'G'], 1, 1))
    }

    fn click(&self, target: &str) -> Result<String, String> {
        if target.trim().is_empty() {
            return Err("invalid_target: browser_click requires a target".to_owned());
        }
        let mut state = self.inner.lock().expect("fake browser lock");
        state.events.push(format!("click {target}"));
        Ok(target.to_owned())
    }

    fn type_text(&self, target: &str, text: &str, submit: bool) -> Result<String, String> {
        if target.trim().is_empty() {
            return Err("invalid_target: browser_type requires a target".to_owned());
        }
        let mut state = self.inner.lock().expect("fake browser lock");
        state
            .events
            .push(format!("type {target} len={} submit={submit}", text.len()));
        Ok(target.to_owned())
    }

    fn scroll(&self, dx: i32, dy: i32, target: Option<&str>) -> Result<String, String> {
        let mut state = self.inner.lock().expect("fake browser lock");
        state.events.push(format!(
            "scroll {dx},{dy} target={}",
            target.unwrap_or("viewport")
        ));
        Ok(format!("scrolled {dx},{dy}"))
    }
}

/// Shared behaviour for the seven browser tools.
fn fail(call_id: &str, err: String) -> Result<ToolResult, ToolError> {
    Ok(ToolResult::err(call_id, err))
}

macro_rules! browser_tool {
    ($tool:ident, $tool_name:literal, $desc:literal, $schema:expr) => {
        /// Browser tool driving one [`BrowserDriver`] operation.
        #[derive(Clone, Debug)]
        pub struct $tool<D: BrowserDriver> {
            driver: Arc<D>,
            /// Output cap for page text (chars). Defaults to 8_000.
            pub max_text_chars: usize,
        }

        impl<D: BrowserDriver> $tool<D> {
            /// New tool over `driver`.
            pub fn new(driver: D) -> Self {
                Self {
                    driver: Arc::new(driver),
                    max_text_chars: 8_000,
                }
            }
        }

        impl<D: BrowserDriver> AgentTool for $tool<D> {
            fn name(&self) -> &str {
                $tool_name
            }

            fn description(&self) -> &str {
                $desc
            }

            fn schema(&self) -> serde_json::Value {
                $schema
            }

            fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
                self.run(call)
            }
        }
    };
}

browser_tool!(
    BrowserOpen,
    "browser_open",
    "Navigate the selected tab to an http(s) URL (Host API ContentTools.open).",
    serde_json::json!({
        "type": "object",
        "properties": { "url": { "type": "string", "description": "http(s) URL to open" } },
        "required": ["url"],
        "additionalProperties": false,
    })
);

#[derive(Deserialize)]
struct OpenArgs {
    url: String,
}

impl<D: BrowserDriver> BrowserOpen<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: OpenArgs = parse_args(call)?;
        match self.driver.open(&args.url) {
            Ok(url) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "url": url }).to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserRead,
    "browser_read",
    "Read the current page as readability text (Host API ContentTools.read).",
    serde_json::json!({
        "type": "object",
        "properties": { "max_chars": { "type": "integer", "minimum": 1 } },
        "additionalProperties": false,
    })
);

#[derive(Deserialize)]
struct ReadArgs {
    #[serde(default)]
    max_chars: Option<usize>,
}

impl<D: BrowserDriver> BrowserRead<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: ReadArgs = parse_args(call)?;
        let cap = args.max_chars.unwrap_or(self.max_text_chars);
        match self.driver.read() {
            Ok(page) => {
                let page = page.capped(cap);
                serde_json::to_string(&page)
                    .map(|output| ToolResult::ok(&call.call_id, output))
                    .map_err(|e| ToolError::Failed(e.to_string()))
            }
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserSnapshot,
    "browser_snapshot",
    "Capture the accessibility tree snapshot of the current page.",
    serde_json::json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
);

impl<D: BrowserDriver> BrowserSnapshot<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        call.validate()?;
        match self.driver.snapshot() {
            Ok(tree) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "snapshot": tree }).to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserScreenshot,
    "browser_screenshot",
    "Capture a screenshot of the current page (metadata only; pixels stay out of logs).",
    serde_json::json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false,
    })
);

impl<D: BrowserDriver> BrowserScreenshot<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        call.validate()?;
        match self.driver.screenshot() {
            Ok((bytes, width, height)) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({
                    "bytes": bytes.len(), "width": width, "height": height,
                })
                .to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserClick,
    "browser_click",
    "Click an element by accessibility ref or CSS selector.",
    serde_json::json!({
        "type": "object",
        "properties": { "target": { "type": "string" } },
        "required": ["target"],
        "additionalProperties": false,
    })
);

#[derive(Deserialize)]
struct TargetArgs {
    target: String,
}

impl<D: BrowserDriver> BrowserClick<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: TargetArgs = parse_args(call)?;
        match self.driver.click(&args.target) {
            Ok(target) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "clicked": target }).to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserType,
    "browser_type",
    "Type text into an element by accessibility ref or CSS selector.",
    serde_json::json!({
        "type": "object",
        "properties": {
            "target": { "type": "string" },
            "text": { "type": "string" },
            "submit": { "type": "boolean" },
        },
        "required": ["target", "text"],
        "additionalProperties": false,
    })
);

#[derive(Deserialize)]
struct TypeArgs {
    target: String,
    text: String,
    #[serde(default)]
    submit: bool,
}

impl<D: BrowserDriver> BrowserType<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: TypeArgs = parse_args(call)?;
        match self.driver.type_text(&args.target, &args.text, args.submit) {
            Ok(target) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "typed": target, "submit": args.submit }).to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

browser_tool!(
    BrowserScroll,
    "browser_scroll",
    "Scroll the viewport (or one element) by CSS-pixel deltas.",
    serde_json::json!({
        "type": "object",
        "properties": {
            "dx": { "type": "integer" },
            "dy": { "type": "integer" },
            "target": { "type": "string" },
        },
        "additionalProperties": false,
    })
);

#[derive(Deserialize)]
struct ScrollArgs {
    #[serde(default)]
    dx: i32,
    #[serde(default)]
    dy: i32,
    #[serde(default)]
    target: Option<String>,
}

impl<D: BrowserDriver> BrowserScroll<D> {
    fn run(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: ScrollArgs = parse_args(call)?;
        match self.driver.scroll(args.dx, args.dy, args.target.as_deref()) {
            Ok(moved) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "scrolled": moved }).to_string(),
            )),
            Err(message) => fail(&call.call_id, message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::classify;
    use crate::tools::ToolCall;

    fn scripted() -> FakeBrowser {
        FakeBrowser::new().with_page(PageRead {
            url: "https://a.example/".to_owned(),
            title: "Example".to_owned(),
            text: "hello world".to_owned(),
            snapshot_ref: "snap-1".to_owned(),
        })
    }

    fn call(tool: &str, args: &str) -> ToolCall {
        ToolCall::new(tool, "c1", args)
    }

    #[test]
    fn open_read_snapshot_screenshot_round_trip() {
        let fake = scripted();
        let open = BrowserOpen::new(fake.clone());
        let ok = open
            .execute(&call("browser_open", r#"{"url":"https://a.example/"}"#))
            .unwrap();
        assert!(ok.is_ok());

        let read = BrowserRead::new(fake.clone());
        let ok = read.execute(&call("browser_read", "{}")).unwrap();
        assert!(ok.is_ok());
        let page: PageRead = serde_json::from_str(ok.output_json.as_deref().unwrap()).unwrap();
        assert_eq!(page.title, "Example");

        let snap = BrowserSnapshot::new(fake.clone());
        let ok = snap.execute(&call("browser_snapshot", "{}")).unwrap();
        assert!(ok.output_json.unwrap().contains("WebArea"));

        let shot = BrowserScreenshot::new(fake.clone());
        let ok = shot.execute(&call("browser_shot", "{}")).unwrap();
        assert!(ok.is_ok());
    }

    #[test]
    fn click_type_scroll_drive_the_fake() {
        let fake = scripted();
        BrowserClick::new(fake.clone())
            .execute(&call("browser_click", r#"{"target":"ref-3"}"#))
            .unwrap();
        BrowserType::new(fake.clone())
            .execute(&call(
                "browser_type",
                r#"{"target":"ref-4","text":"hi","submit":true}"#,
            ))
            .unwrap();
        BrowserScroll::new(fake.clone())
            .execute(&call("browser_scroll", r#"{"dx":0,"dy":100}"#))
            .unwrap();
        let events = fake.events();
        assert!(events.iter().any(|e| e.starts_with("click ref-3")));
        assert!(events.iter().any(|e| e.contains("submit=true")));
        assert!(events.iter().any(|e| e.starts_with("scroll 0,100")));
    }

    #[test]
    fn browser_tools_reject_bad_input() {
        let fake = scripted();
        let open = BrowserOpen::new(fake);
        // Non-http URL is a tool failure, not a crash.
        let denied = open
            .execute(&call("browser_open", r#"{"url":"file:///etc/passwd"}"#))
            .unwrap();
        assert!(!denied.is_ok());
        // Missing required arg is Invalid.
        assert!(matches!(
            open.execute(&call("browser_open", "{}")),
            Err(ToolError::Invalid(_))
        ));
        // Empty click target fails through the driver.
        let click = BrowserClick::new(scripted());
        let failed = click
            .execute(&call("browser_click", r#"{"target":""}"#))
            .unwrap();
        assert!(!failed.is_ok());
        // Reading with nothing open fails loudly.
        let read = BrowserRead::new(FakeBrowser::new());
        let failed = read.execute(&call("browser_read", "{}")).unwrap();
        assert!(!failed.is_ok());
    }

    #[test]
    fn read_output_is_capped() {
        let fake = FakeBrowser::new().with_page(PageRead {
            url: "https://a.example/".to_owned(),
            title: "Long".to_owned(),
            text: "x".repeat(500),
            snapshot_ref: "s".to_owned(),
        });
        let read = BrowserRead::new(fake);
        let ok = read
            .execute(&call("browser_read", r#"{"max_chars":10}"#))
            .unwrap();
        let page: PageRead = serde_json::from_str(ok.output_json.as_deref().unwrap()).unwrap();
        assert!(page.text.contains("[truncated]"));
    }

    #[test]
    fn every_browser_tool_has_schema_and_approval_hook() {
        let fake = scripted();
        let tools: Vec<(&str, serde_json::Value, crate::approvals::ActionClass)> = vec![
            (
                "browser_open",
                BrowserOpen::new(fake.clone()).schema(),
                BrowserOpen::new(fake.clone()).action_class(),
            ),
            (
                "browser_read",
                BrowserRead::new(fake.clone()).schema(),
                BrowserRead::new(fake.clone()).action_class(),
            ),
            (
                "browser_snapshot",
                BrowserSnapshot::new(fake.clone()).schema(),
                BrowserSnapshot::new(fake.clone()).action_class(),
            ),
            (
                "browser_screenshot",
                BrowserScreenshot::new(fake.clone()).schema(),
                BrowserScreenshot::new(fake.clone()).action_class(),
            ),
            (
                "browser_click",
                BrowserClick::new(fake.clone()).schema(),
                BrowserClick::new(fake.clone()).action_class(),
            ),
            (
                "browser_type",
                BrowserType::new(fake.clone()).schema(),
                BrowserType::new(fake.clone()).action_class(),
            ),
            (
                "browser_scroll",
                BrowserScroll::new(fake.clone()).schema(),
                BrowserScroll::new(fake.clone()).action_class(),
            ),
        ];
        for (name, schema, class) in tools {
            assert_eq!(schema["type"], serde_json::json!("object"), "{name}");
            // The hook delegates to approvals::classify — never reimplemented.
            assert_eq!(class, classify(name), "{name}");
        }
    }
}

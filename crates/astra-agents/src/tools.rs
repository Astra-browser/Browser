/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tool layer (P6-T03).
//!
//! Tools are how the agent touches the world: browser tools (open, read,
//! click, type, scroll, screenshot) through the Host API (`ContentTools`),
//! the scoped filesystem (root-jailed), the command runner (allow-listed),
//! the MCP client (JSON-RPC over stdio), and CLI wrappers (`gh`).
//! This module owns the interface — [`AgentTool`] plus versioned
//! [`ToolCall`]/[`ToolResult`] — the [`ToolRegistry`] dispatch point, and
//! the local-only [`ToolCallLedger`] (the provider `UsageLedger` pattern
//! reused for tool-call accounting). Each tool family lives in `tools/`:
//! [`browser`], [`fs`], [`command`], [`mcp`], [`cli`].

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;

use crate::approvals::{classify, ActionClass};

pub mod browser;
pub mod cli;
pub mod command;
pub mod fs;
pub mod mcp;

/// Tool-call format version. Bump on any breaking shape change and keep
/// [`ToolError::VersionMismatch`] so old payloads fail loudly.
pub const TOOL_CALL_VERSION: u32 = 1;

/// Maximum tool argument payload accepted by [`ToolCall::validate`].
pub const MAX_TOOL_ARGS_CHARS: usize = 64_000;

/// One tool invocation: which tool, which call, and the JSON arguments.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub version: u32,
    pub tool: String,
    pub call_id: String,
    #[serde(default)]
    pub args_json: String,
}

impl ToolCall {
    /// New call with JSON-encoded arguments.
    pub fn new(
        tool: impl Into<String>,
        call_id: impl Into<String>,
        args_json: impl Into<String>,
    ) -> Self {
        Self {
            version: TOOL_CALL_VERSION,
            tool: tool.into(),
            call_id: call_id.into(),
            args_json: args_json.into(),
        }
    }

    /// Serialize for the step stream / audit log.
    pub fn to_json(&self) -> Result<String, ToolError> {
        serde_json::to_string(self).map_err(|e| ToolError::Json(e.to_string()))
    }

    /// Parse + version-check + validate.
    pub fn from_json(json: &str) -> Result<Self, ToolError> {
        let call: Self = serde_json::from_str(json).map_err(|e| ToolError::Json(e.to_string()))?;
        call.validate()?;
        Ok(call)
    }

    /// Structural validation: version, non-empty names, args valid JSON
    /// within bounds.
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.version != TOOL_CALL_VERSION {
            return Err(ToolError::VersionMismatch(self.version, TOOL_CALL_VERSION));
        }
        if self.tool.is_empty() {
            return Err(ToolError::Invalid("tool name must not be empty".to_owned()));
        }
        if self.call_id.is_empty() {
            return Err(ToolError::Invalid("call_id must not be empty".to_owned()));
        }
        if self.args_json.chars().count() > MAX_TOOL_ARGS_CHARS {
            return Err(ToolError::Invalid(format!(
                "args exceed {MAX_TOOL_ARGS_CHARS} chars"
            )));
        }
        serde_json::from_str::<serde_json::Value>(&self.args_json)
            .map_err(|e| ToolError::Invalid(format!("args are not JSON: {e}")))?;
        Ok(())
    }
}

/// One tool result: the call it answers plus either output or an error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResult {
    pub version: u32,
    pub call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_json: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ToolResult {
    /// Successful result.
    pub fn ok(call_id: impl Into<String>, output_json: impl Into<String>) -> Self {
        Self {
            version: TOOL_CALL_VERSION,
            call_id: call_id.into(),
            output_json: Some(output_json.into()),
            error: None,
        }
    }

    /// Failed result.
    pub fn err(call_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            version: TOOL_CALL_VERSION,
            call_id: call_id.into(),
            output_json: None,
            error: Some(error.into()),
        }
    }

    /// True when the tool reported success.
    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ToolError {
    #[error("unsupported tool call version {0} (expected {1})")]
    VersionMismatch(u32, u32),
    #[error("invalid tool call: {0}")]
    Invalid(String),
    #[error("tool JSON error: {0}")]
    Json(String),
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    /// The tool ran and failed (command exit, driver fault, MCP error).
    /// Carries the tool-visible message; never secrets or page text.
    #[error("tool execution failed: {0}")]
    Failed(String),
    /// The tool exceeded its time budget and was stopped.
    #[error("tool timed out after {0}ms")]
    Timeout(u64),
    /// The call was refused by policy (allow-list, permissions, root-jail).
    #[error("tool denied by policy: {0}")]
    Denied(String),
}

/// Tool interface. Every tool exposes a JSON-Schema descriptor for its
/// arguments ([`AgentTool::schema`]) so the planner and provider layer can
/// offer it to the model, and an approval hook ([`AgentTool::action_class`])
/// that delegates to [`classify`](crate::approvals::classify) — tools never
/// reimplement the read/side-effect/high-risk taxonomy.
pub trait AgentTool {
    /// Stable tool name referenced by [`ToolCall::tool`].
    fn name(&self) -> &str;

    /// One-line description for the planner and the approval prompt.
    fn description(&self) -> &str;

    /// JSON Schema (draft-07 object schema) for this tool's `args_json`.
    /// Defaults to "no arguments"; every real tool overrides it.
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "additionalProperties": false })
    }

    /// Approval class for this tool. Default — and required — behaviour is
    /// to call into `approvals::classify` so the P6-T04 gate stays the
    /// single owner of the taxonomy.
    fn action_class(&self) -> ActionClass {
        classify(self.name())
    }

    /// Execute one validated call.
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError>;
}

/// Decode `call.args_json` into `T`, mapping failures to [`ToolError`].
/// Every tool routes argument parsing through here so malformed-argument
/// errors are uniform.
pub fn parse_args<'a, T: serde::de::Deserialize<'a>>(call: &'a ToolCall) -> Result<T, ToolError> {
    call.validate()?;
    serde_json::from_str::<T>(&call.args_json)
        .map_err(|e| ToolError::Invalid(format!("arguments do not match schema: {e}")))
}

/// Local-only tool-call accounting. Mirrors the provider [`UsageLedger`]
/// pattern (`record` / `get` / `total`): per-tool invocation counts kept
/// on-device, never sent anywhere.
#[derive(Clone, Debug, Default)]
pub struct ToolCallLedger {
    counts: HashMap<String, u64>,
}

impl ToolCallLedger {
    /// Empty ledger.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one executed call of `tool`.
    pub fn record(&mut self, tool: &str) {
        *self.counts.entry(tool.to_owned()).or_default() = self
            .counts
            .get(tool)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
    }

    /// Calls recorded for `tool`, if any.
    pub fn get(&self, tool: &str) -> Option<u64> {
        self.counts.get(tool).copied()
    }

    /// Calls recorded across all tools.
    pub fn total(&self) -> u64 {
        self.counts.values().copied().sum()
    }
}

/// The P6-T03 tool registry: every shipped tool behind one dispatch point.
/// The loop validates the call, routes by `call.tool`, and accounts the
/// dispatch in an optional [`ToolCallLedger`].
#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn AgentTool>>,
}

impl ToolRegistry {
    /// Empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register one tool under its [`AgentTool::name`].
    pub fn register(&mut self, tool: Box<dyn AgentTool>) {
        self.tools.insert(tool.name().to_owned(), tool);
    }

    /// Registered tool names, sorted.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }

    /// Provider-layer definitions (`name` / `description` / JSON-Schema
    /// parameters) for every registered tool.
    pub fn definitions(&self) -> Vec<crate::providers::ToolDefinition> {
        let mut defs: Vec<crate::providers::ToolDefinition> = self
            .tools
            .values()
            .map(|tool| {
                crate::providers::ToolDefinition::new(
                    tool.name(),
                    tool.description(),
                    tool.schema(),
                )
            })
            .collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        defs
    }

    /// Validate `call` and run it against the named tool.
    pub fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        call.validate()?;
        match self.tools.get(&call.tool) {
            Some(tool) => tool.execute(call),
            None => Err(ToolError::UnknownTool(call.tool.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopTool;

    impl AgentTool for NoopTool {
        fn name(&self) -> &str {
            "noop"
        }

        fn description(&self) -> &str {
            "does nothing, for tests"
        }

        fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
            call.validate()?;
            Ok(ToolResult::ok(&call.call_id, "{}"))
        }
    }

    #[test]
    fn tool_call_json_round_trip() {
        let call = ToolCall::new("page_read", "call-1", r#"{"url":"https://a.example/"}"#);
        assert!(call.validate().is_ok());
        assert_eq!(ToolCall::from_json(&call.to_json().unwrap()).unwrap(), call);
    }

    #[test]
    fn tool_call_rejects_broken_shapes() {
        let mut bad = ToolCall::new("t", "c", "{}");
        bad.version = 999;
        assert_eq!(
            bad.validate(),
            Err(ToolError::VersionMismatch(999, TOOL_CALL_VERSION))
        );
        assert!(ToolCall::from_json(&bad.to_json().unwrap()).is_err());

        assert!(ToolCall::new("", "c", "{}").validate().is_err());
        assert!(ToolCall::new("t", "", "{}").validate().is_err());
        assert!(ToolCall::new("t", "c", "{nope").validate().is_err());
        assert!(matches!(
            ToolCall::from_json("{not json"),
            Err(ToolError::Json(_))
        ));
    }

    #[test]
    fn tool_stub_executes_and_reports() {
        let tool = NoopTool;
        assert_eq!(tool.name(), "noop");
        let ok = tool.execute(&ToolCall::new("noop", "c1", "{}")).unwrap();
        assert!(ok.is_ok());
        let err = ToolResult::err("c1", "boom");
        assert!(!err.is_ok());
    }

    #[test]
    fn registry_dispatches_and_accounts() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(NoopTool));
        assert_eq!(registry.names(), vec!["noop".to_owned()]);
        let defs = registry.definitions();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "noop");

        let ok = registry
            .execute(&ToolCall::new("noop", "c1", "{}"))
            .unwrap();
        assert!(ok.is_ok());
        let unknown = registry.execute(&ToolCall::new("missing", "c2", "{}"));
        assert_eq!(unknown, Err(ToolError::UnknownTool("missing".to_owned())));

        let mut ledger = ToolCallLedger::new();
        ledger.record("noop");
        ledger.record("noop");
        ledger.record("fs_read");
        assert_eq!(ledger.get("noop"), Some(2));
        assert_eq!(ledger.get("nothing"), None);
        assert_eq!(ledger.total(), 3);
    }

    #[test]
    fn default_hooks_call_into_approvals_classify() {
        use crate::approvals::classify;
        let tool = NoopTool;
        assert_eq!(tool.action_class(), classify(tool.name()));
        // No-arg default schema is a closed object schema.
        let schema = tool.schema();
        assert_eq!(schema["type"], serde_json::json!("object"));
    }
}

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Tool layer stubs (full schemas and implementations in P6-T03).
//!
//! Tools are how the agent touches the world: browser tools (open, read,
//! click, type, scroll, screenshot) through the Host API, the scoped
//! filesystem, the command runner, the MCP client, and CLI wrappers.
//! This module owns the interface — [`AgentTool`] plus versioned
//! [`ToolCall`]/[`ToolResult`] — so the loop and the approval gate can
//! build on stable shapes before any tool is implemented.

use serde::{Deserialize, Serialize};
use thiserror::Error;

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
}

/// Tool interface stub. P6-T03 adds JSON-Schema descriptors plus the real
/// browser, filesystem, command, MCP, and CLI tools behind this trait.
pub trait AgentTool {
    /// Stable tool name referenced by [`ToolCall::tool`].
    fn name(&self) -> &str;

    /// One-line description for the planner and the approval prompt.
    fn description(&self) -> &str;

    /// Execute one validated call.
    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError>;
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
}

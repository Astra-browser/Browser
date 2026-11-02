/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! MCP client tools (P6-T03): `mcp_list_tools`, `mcp_call`.
//!
//! JSON-RPC 2.0 over stdio (newline-delimited, the MCP stdio transport):
//! each request is one JSON object per line on the server child's stdin,
//! each response one JSON object per line on stdout. [`StdioMcpChannel`]
//! spawns the server process; [`FakeChannel`] scripts canned replies for
//! unit tests, and one test below runs a real stdio round-trip against a
//! mock MCP server written in shell/`sed` (stdlib only, no fixtures).
//! Per-server permissions ([`McpPermissions`]) gate `tools/call` by tool
//! name before anything is spawned. The approval hook calls into
//! [`crate::approvals::classify`] (`mcp_*` are high-risk fail-closed).

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{parse_args, AgentTool, ToolCall, ToolError, ToolResult};

/// JSON-RPC protocol version we speak.
pub const JSONRPC_VERSION: &str = "2.0";
/// Per-request read timeout for the stdio channel.
pub const MCP_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Per-server permissions: which remote tools this server may serve.
/// `allowed_tools: None` permits every tool the server lists; `Some(list)`
/// permits exactly `list`.
#[derive(Clone, Debug, Default)]
pub struct McpPermissions {
    pub allowed_tools: Option<Vec<String>>,
}

impl McpPermissions {
    /// Permit every tool.
    pub fn all() -> Self {
        Self {
            allowed_tools: None,
        }
    }

    /// Permit exactly `tools`.
    pub fn only(tools: Vec<String>) -> Self {
        Self {
            allowed_tools: Some(tools),
        }
    }

    /// Whether `tool` may be called.
    pub fn allows(&self, tool: &str) -> bool {
        match &self.allowed_tools {
            None => true,
            Some(list) => list.iter().any(|allowed| allowed == tool),
        }
    }
}

/// One JSON-RPC request envelope.
#[derive(Clone, Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

/// Channel seam: one JSON-RPC round-trip. The live channel spawns the
/// server; tests script [`FakeChannel`].
pub trait McpChannel: Send + Sync {
    /// Send `method`/`params` with `id` and return the `result`.
    /// JSON-RPC `error` replies surface as [`ToolError::Failed`].
    fn request(
        &self,
        id: u64,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ToolError>;
}

/// Live stdio channel: spawns `program args` per request, writes one
/// newline-delimited JSON-RPC request, reads one response line.
#[derive(Clone, Debug)]
pub struct StdioMcpChannel {
    program: String,
    args: Vec<String>,
}

impl StdioMcpChannel {
    /// New channel spawning `program` with `args`.
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
        }
    }
}

impl McpChannel for StdioMcpChannel {
    fn request(
        &self,
        id: u64,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ToolError> {
        let body = serde_json::to_string(&JsonRpcRequest {
            jsonrpc: JSONRPC_VERSION,
            id,
            method: method.to_owned(),
            params,
        })
        .map_err(|e| ToolError::Failed(e.to_string()))?;
        let mut child = std::process::Command::new(&self.program)
            .args(&self.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| ToolError::Failed(format!("cannot start MCP server: {e}")))?;
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| ToolError::Failed("MCP server stdin unavailable".to_owned()))?;
        writeln!(stdin, "{body}").map_err(|e| ToolError::Failed(e.to_string()))?;
        // Read one reply line on a helper thread so the main thread can
        // bound the wait with `recv_timeout` (stdlib only, no polling on
        // raw fds). On expiry the child is killed and Timeout surfaces.
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ToolError::Failed("MCP server stdout unavailable".to_owned()))?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let outcome = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send((outcome, line));
        });
        let (outcome, line) = rx.recv_timeout(MCP_READ_TIMEOUT).map_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
            ToolError::Timeout(MCP_READ_TIMEOUT.as_millis() as u64)
        })?;
        let _ = child.wait();
        match outcome {
            Ok(0) | Ok(_) if line.trim().is_empty() => {
                Err(ToolError::Failed("MCP server closed stdout".to_owned()))
            }
            Ok(_) => parse_response(id, &line),
            Err(e) => Err(ToolError::Failed(e.to_string())),
        }
    }
}

/// Validate one JSON-RPC response line: version, matching id, result/error.
fn parse_response(expected_id: u64, line: &str) -> Result<serde_json::Value, ToolError> {
    #[derive(Deserialize)]
    struct RpcResponse {
        #[allow(dead_code)]
        jsonrpc: String,
        id: serde_json::Value,
        #[serde(default)]
        result: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<RpcError>,
    }
    #[derive(Deserialize)]
    struct RpcError {
        code: i64,
        message: String,
    }
    let response: RpcResponse = serde_json::from_str(line.trim())
        .map_err(|e| ToolError::Failed(format!("bad MCP reply: {e}")))?;
    let id_ok = match &response.id {
        serde_json::Value::Number(n) => n.as_u64() == Some(expected_id),
        serde_json::Value::String(s) => s == &expected_id.to_string(),
        _ => false,
    };
    if !id_ok {
        return Err(ToolError::Failed("MCP reply id mismatch".to_owned()));
    }
    if let Some(err) = response.error {
        return Err(ToolError::Failed(format!(
            "MCP error {}: {}",
            err.code, err.message
        )));
    }
    response
        .result
        .ok_or_else(|| ToolError::Failed("MCP reply has neither result nor error".to_owned()))
}

/// Scripted fake channel: queued results plus observed calls. Backs the
/// MCP unit tests — no processes.
#[derive(Debug, Default)]
pub struct FakeChannel {
    results: std::sync::Mutex<VecDeque<Result<serde_json::Value, ToolError>>>,
    seen: std::sync::Mutex<Vec<(u64, String)>>,
}

impl FakeChannel {
    /// Empty fake (every request fails closed until scripted).
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue one reply for the next request.
    pub fn push(&self, result: Result<serde_json::Value, ToolError>) {
        self.results.lock().expect("fake lock").push_back(result);
    }

    /// Requests observed so far (`id`, `method`).
    pub fn seen(&self) -> Vec<(u64, String)> {
        self.seen.lock().expect("fake lock").clone()
    }
}

impl McpChannel for FakeChannel {
    fn request(
        &self,
        id: u64,
        method: &str,
        _params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ToolError> {
        self.seen
            .lock()
            .expect("fake lock")
            .push((id, method.to_owned()));
        self.results
            .lock()
            .expect("fake lock")
            .pop_front()
            .unwrap_or_else(|| {
                Err(ToolError::Failed(
                    "fake channel: no scripted reply".to_owned(),
                ))
            })
    }
}

/// List the tools one MCP server offers (`tools/list`).
#[derive(Debug)]
pub struct McpListTools<C: McpChannel> {
    channel: C,
}

impl<C: McpChannel> McpListTools<C> {
    /// New tool over `channel`.
    pub fn new(channel: C) -> Self {
        Self { channel }
    }
}

impl<C: McpChannel> AgentTool for McpListTools<C> {
    fn name(&self) -> &str {
        "mcp_list_tools"
    }

    fn description(&self) -> &str {
        "List the tools offered by one MCP server (JSON-RPC tools/list over stdio)."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "cursor": { "type": "string" } },
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        call.validate()?;
        let params = serde_json::from_str::<serde_json::Value>(&call.args_json)
            .map_err(|e| ToolError::Invalid(format!("arguments are not JSON: {e}")))?;
        let result = self.channel.request(1, "tools/list", Some(params))?;
        Ok(ToolResult::ok(&call.call_id, result.to_string()))
    }
}

#[derive(Deserialize)]
struct CallArgs {
    tool: String,
    #[serde(default)]
    arguments: Option<serde_json::Value>,
}

/// Call one MCP tool (`tools/call`), gated by [`McpPermissions`].
#[derive(Debug)]
pub struct McpCallTool<C: McpChannel> {
    channel: C,
    permissions: McpPermissions,
}

impl<C: McpChannel> McpCallTool<C> {
    /// New tool over `channel` with `permissions`.
    pub fn new(channel: C, permissions: McpPermissions) -> Self {
        Self {
            channel,
            permissions,
        }
    }
}

impl<C: McpChannel> AgentTool for McpCallTool<C> {
    fn name(&self) -> &str {
        "mcp_call"
    }

    fn description(&self) -> &str {
        "Call one MCP server tool (JSON-RPC tools/call over stdio; permission-gated)."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "tool": { "type": "string", "description": "remote tool name" },
                "arguments": { "type": "object" },
            },
            "required": ["tool"],
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: CallArgs = parse_args(call)?;
        if args.tool.trim().is_empty() {
            return Err(ToolError::Invalid("tool must not be empty".to_owned()));
        }
        if !self.permissions.allows(&args.tool) {
            return Err(ToolError::Denied(format!(
                "MCP tool is not permitted: {}",
                args.tool
            )));
        }
        let params = serde_json::json!({
            "name": args.tool,
            "arguments": args.arguments.unwrap_or(serde_json::json!({})),
        });
        let result = self.channel.request(2, "tools/call", Some(params))?;
        Ok(ToolResult::ok(&call.call_id, result.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::classify;
    use crate::tools::ToolCall;

    #[test]
    fn list_and_call_round_trip_over_fake() {
        let fake = FakeChannel::new();
        fake.push(Ok(serde_json::json!({ "tools": [{ "name": "search" }] })));
        let list = McpListTools::new(fake);
        let ok = list
            .execute(&ToolCall::new("mcp_list_tools", "c1", "{}"))
            .unwrap();
        assert!(ok.output_json.unwrap().contains("search"));

        let fake = FakeChannel::new();
        fake.push(Ok(
            serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] }),
        ));
        let call = McpCallTool::new(fake, McpPermissions::all());
        let ok = call
            .execute(&ToolCall::new(
                "mcp_call",
                "c2",
                r#"{"tool":"search","arguments":{"q":"x"}}"#,
            ))
            .unwrap();
        assert!(ok.is_ok());
    }

    #[test]
    fn permissions_gate_calls_before_spawn() {
        let fake = FakeChannel::new();
        let call = McpCallTool::new(fake, McpPermissions::only(vec!["search".to_owned()]));
        assert!(matches!(
            call.execute(&ToolCall::new(
                "mcp_call",
                "c1",
                r#"{"tool":"delete_everything"}"#
            )),
            Err(ToolError::Denied(_))
        ));
    }

    #[test]
    fn server_errors_surface_as_failed() {
        let fake = FakeChannel::new();
        fake.push(Err(ToolError::Failed(
            "MCP error -32601: Method not found".to_owned(),
        )));
        let list = McpListTools::new(fake);
        assert!(matches!(
            list.execute(&ToolCall::new("mcp_list_tools", "c1", "{}")),
            Err(ToolError::Failed(_))
        ));
    }

    #[test]
    fn response_parsing_validates_id_and_error() {
        let ok = parse_response(1, r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(ok, serde_json::json!({ "tools": [] }));
        assert!(parse_response(1, r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).is_err());
        assert!(parse_response(
            1,
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"nope"}}"#
        )
        .is_err());
    }

    #[test]
    fn stdio_round_trip_against_shell_mock_server() {
        // Mock MCP server in stdlib only: `sh` reads request lines and echoes
        // a JSON-RPC reply with the request's id spliced back via `sed`.
        // Speaks enough of the protocol to prove the framing end to end.
        let script = r#"while IFS= read -r line; do id=$(printf '%s' "$line" | sed 's/.*"id"[ ]*:[ ]*\([0-9][0-9]*\).*/\1/'); printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":$id,\"result\":{\"echo\":true}}"; done"#;
        let channel = StdioMcpChannel::new("sh", vec!["-c".to_owned(), script.to_owned()]);
        let result = channel
            .request(41, "tools/list", Some(serde_json::json!({})))
            .expect("mock server round-trip");
        assert_eq!(result, serde_json::json!({ "echo": true }));
    }

    #[test]
    fn schemas_and_approval_hooks() {
        let list = McpListTools::new(FakeChannel::new());
        let call = McpCallTool::new(FakeChannel::new(), McpPermissions::all());
        assert_eq!(list.schema()["type"], serde_json::json!("object"));
        assert_eq!(call.schema()["type"], serde_json::json!("object"));
        assert!(call.schema()["properties"]["tool"].is_object());
        assert_eq!(list.action_class(), classify("mcp_list_tools"));
        assert_eq!(call.action_class(), classify("mcp_call"));
    }
}

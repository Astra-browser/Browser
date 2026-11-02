/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Command runner tool (P6-T03): `command_run`.
//!
//! The agent may run only allow-listed programs (exact executable name or
//! absolute path match — no shell, no `PATH` search games, no shell
//! metacharacters smuggled through arguments). Every run carries a timeout
//! (polled `try_wait`, child killed on expiry) and an output cap (stdout +
//! stderr truncated with a marker). The approval hook calls into
//! [`crate::approvals::classify`]; `command_run` is high-risk by the
//! fail-closed rule. Unit tests inject [`FakeRunner`]: no real processes.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde::Deserialize;

use super::{parse_args, AgentTool, ToolCall, ToolError, ToolResult};

/// Default per-run timeout.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Maximum captured output bytes (stdout + stderr combined).
pub const MAX_OUTPUT_BYTES: usize = 128 * 1024;

/// One finished process run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandOutput {
    /// Process exit code (`None` when killed by timeout — but timeouts
    /// surface as [`ToolError::Timeout` before an output is built).
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    /// True when stdout/stderr were cut at [`MAX_OUTPUT_BYTES`].
    pub truncated: bool,
}

impl CommandOutput {
    /// Cap combined output, marking truncation.
    pub fn capped(status: i32, stdout: String, stderr: String) -> Self {
        let mut combined = stdout.len() + stderr.len();
        let mut truncated = false;
        let mut stdout = stdout;
        let mut stderr = stderr;
        if combined > MAX_OUTPUT_BYTES {
            truncated = true;
            let mut budget = MAX_OUTPUT_BYTES;
            if stdout.len() > budget {
                stdout.truncate(budget);
                stderr.clear();
            } else {
                budget -= stdout.len();
                stderr.truncate(budget);
            }
            combined = stdout.len() + stderr.len();
            let _ = combined;
        }
        Self {
            status,
            stdout,
            stderr,
            truncated,
        }
    }
}

/// Execution policy: exact-match program allow-list plus budgets. No shell
/// is ever involved: the live runner spawns the program directly.
#[derive(Clone, Debug)]
pub struct CommandPolicy {
    /// Allowed programs: exact executable names (`"ls"`) or absolute paths.
    pub allowlist: Vec<String>,
    /// Per-run timeout.
    pub timeout: Duration,
}

impl CommandPolicy {
    /// New policy with the default timeout.
    pub fn new(allowlist: Vec<String>) -> Self {
        Self {
            allowlist,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
        }
    }

    /// Whether `program` is exactly allow-listed.
    pub fn allows(&self, program: &str) -> bool {
        self.allowlist.iter().any(|allowed| allowed == program)
    }
}

/// Executor seam: the live runner spawns processes; tests inject fakes.
pub trait CommandExecutor: Send + Sync {
    /// Run `program` with `args`, killing it after `timeout`.
    fn run(
        &self,
        program: &str,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, ToolError>;
}

/// Live executor: direct spawn (no shell), polled `try_wait`, kill on
/// expiry, output capped at [`MAX_OUTPUT_BYTES`].
#[derive(Clone, Debug, Default)]
pub struct LiveExecutor;

impl LiveExecutor {
    /// New live executor.
    pub fn new() -> Self {
        Self
    }
}

impl CommandExecutor for LiveExecutor {
    fn run(
        &self,
        program: &str,
        args: &[String],
        timeout: Duration,
    ) -> Result<CommandOutput, ToolError> {
        let mut child = std::process::Command::new(program)
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| ToolError::Failed(format!("cannot start {program}: {e}")))?;
        let start = Instant::now();
        loop {
            match child
                .try_wait()
                .map_err(|e| ToolError::Failed(e.to_string()))?
            {
                Some(status) => {
                    let output = child
                        .wait_with_output()
                        .map_err(|e| ToolError::Failed(e.to_string()))?;
                    return Ok(CommandOutput::capped(
                        status.code().unwrap_or(-1),
                        String::from_utf8_lossy(&output.stdout).into_owned(),
                        String::from_utf8_lossy(&output.stderr).into_owned(),
                    ));
                }
                None => {
                    if start.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(ToolError::Timeout(timeout.as_millis() as u64));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

/// Scripted fake executor: queued outputs, observed invocations. Backs the
/// command unit tests — no real processes.
#[derive(Debug, Default)]
pub struct FakeRunner {
    outputs: std::sync::Mutex<VecDeque<Result<CommandOutput, ToolError>>>,
    seen: std::sync::Mutex<Vec<(String, Vec<String>)>>,
}

impl FakeRunner {
    /// Empty fake (every run fails closed until scripted).
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue one result for the next run.
    pub fn push(&self, output: Result<CommandOutput, ToolError>) {
        self.outputs.lock().expect("fake lock").push_back(output);
    }

    /// Invocations observed so far.
    pub fn seen(&self) -> Vec<(String, Vec<String>)> {
        self.seen.lock().expect("fake lock").clone()
    }
}

impl CommandExecutor for FakeRunner {
    fn run(
        &self,
        program: &str,
        args: &[String],
        _timeout: Duration,
    ) -> Result<CommandOutput, ToolError> {
        self.seen
            .lock()
            .expect("fake lock")
            .push((program.to_owned(), args.to_vec()));
        self.outputs
            .lock()
            .expect("fake lock")
            .pop_front()
            .unwrap_or_else(|| {
                Err(ToolError::Failed(
                    "fake runner: no scripted output".to_owned(),
                ))
            })
    }
}

#[derive(Deserialize)]
struct RunArgs {
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

/// Run one allow-listed program with a timeout and output caps.
#[derive(Clone, Debug)]
pub struct CommandRunTool<E: CommandExecutor> {
    policy: CommandPolicy,
    executor: E,
}

impl<E: CommandExecutor> CommandRunTool<E> {
    /// New tool with `policy`, executing through `executor`.
    pub fn new(policy: CommandPolicy, executor: E) -> Self {
        Self { policy, executor }
    }
}

impl<E: CommandExecutor> AgentTool for CommandRunTool<E> {
    fn name(&self) -> &str {
        "command_run"
    }

    fn description(&self) -> &str {
        "Run an allow-listed program (no shell) with a timeout and output caps."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "program": { "type": "string", "description": "exact allow-listed executable name or path" },
                "args": { "type": "array", "items": { "type": "string" } },
            },
            "required": ["program"],
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: RunArgs = parse_args(call)?;
        if args.program.trim().is_empty() {
            return Err(ToolError::Invalid("program must not be empty".to_owned()));
        }
        if !self.policy.allows(&args.program) {
            return Err(ToolError::Denied(format!(
                "program is not allow-listed: {}",
                args.program
            )));
        }
        let output = self
            .executor
            .run(&args.program, &args.args, self.policy.timeout)?;
        if output.status != 0 {
            return Ok(ToolResult::err(
                &call.call_id,
                format!("exit {}: {}", output.status, output.stderr),
            ));
        }
        serde_json::to_string(&serde_json::json!({
            "program": args.program,
            "status": output.status,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "truncated": output.truncated,
        }))
        .map(|body| ToolResult::ok(&call.call_id, body))
        .map_err(|e| ToolError::Failed(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::classify;
    use crate::tools::ToolCall;

    fn policy() -> CommandPolicy {
        CommandPolicy {
            allowlist: vec!["ls".to_owned(), "/bin/echo".to_owned()],
            timeout: Duration::from_millis(1_000),
        }
    }

    #[test]
    fn allowlist_permit_and_deny() {
        let fake = FakeRunner::new();
        fake.push(Ok(CommandOutput::capped(
            0,
            "ok\n".to_owned(),
            String::new(),
        )));
        let tool = CommandRunTool::new(policy(), fake);
        let ok = tool
            .execute(&ToolCall::new(
                "command_run",
                "c1",
                r#"{"program":"ls","args":["-la"]}"#,
            ))
            .unwrap();
        assert!(ok.is_ok());

        let fake = FakeRunner::new();
        let tool = CommandRunTool::new(policy(), fake);
        assert!(matches!(
            tool.execute(&ToolCall::new(
                "command_run",
                "c2",
                r#"{"program":"rm","args":["-rf","/"]}"#
            )),
            Err(ToolError::Denied(_))
        ));
    }

    #[test]
    fn nonzero_exit_is_a_tool_failure_not_a_crash() {
        let fake = FakeRunner::new();
        fake.push(Ok(CommandOutput::capped(
            1,
            String::new(),
            "boom".to_owned(),
        )));
        let tool = CommandRunTool::new(policy(), fake);
        let failed = tool
            .execute(&ToolCall::new("command_run", "c1", r#"{"program":"ls"}"#))
            .unwrap();
        assert!(!failed.is_ok());
    }

    #[test]
    fn output_is_capped_with_marker() {
        let big = "z".repeat(MAX_OUTPUT_BYTES + 16);
        let capped = CommandOutput::capped(0, big, String::new());
        assert!(capped.truncated);
        assert!(capped.stdout.len() <= MAX_OUTPUT_BYTES);
    }

    #[test]
    fn timeout_surfaces_as_timeout() {
        let fake = FakeRunner::new();
        fake.push(Err(ToolError::Timeout(7)));
        let tool = CommandRunTool::new(policy(), fake);
        assert_eq!(
            tool.execute(&ToolCall::new("command_run", "c1", r#"{"program":"ls"}"#)),
            Err(ToolError::Timeout(7))
        );
    }

    #[test]
    fn schema_and_approval_hook() {
        let tool = CommandRunTool::new(policy(), FakeRunner::new());
        assert_eq!(tool.schema()["type"], serde_json::json!("object"));
        assert!(tool.schema()["properties"]["program"].is_object());
        // Delegates to approvals::classify (fail-closed high-risk).
        assert_eq!(tool.action_class(), classify("command_run"));
    }
}

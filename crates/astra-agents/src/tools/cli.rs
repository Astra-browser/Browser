/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! CLI wrapper tools (P6-T03): `gh` as the worked example.
//!
//! The pattern: one tool per wrapped binary, a read-only subcommand
//! allow-list enforced before anything spawns, a [`CliRunner`] seam so
//! unit tests inject [`FakeCli`] while one test runs the live runner
//! against a mocked `gh` binary (a temp shell script speaking just enough
//! `gh` to prove argv plumbing end to end). No shell is ever involved.
//! The approval hook calls into [`crate::approvals::classify`].

use serde::Deserialize;

use super::{parse_args, AgentTool, ToolCall, ToolError, ToolResult};

/// Read-only `gh` subcommands the wrapper permits: `gh <group> <action>`
/// where group and action are both allow-listed. Anything else — writes,
/// auth, raw API — is denied before spawn.
const GH_GROUPS: &[&str] = &["issue", "pr"];
const GH_ISSUE_ACTIONS: &[&str] = &["list", "view", "status"];
const GH_PR_ACTIONS: &[&str] = &["list", "view", "status"];

/// Runner seam: argv in, stdout out. The live runner spawns the binary
/// directly (no shell); tests inject fakes or a mocked script.
pub trait CliRunner: Send + Sync {
    /// Run the binary with `args`, returning stdout on success.
    fn run(&self, args: &[String]) -> Result<String, ToolError>;
}

/// Live runner: spawns `program` directly with the validated argv.
#[derive(Clone, Debug)]
pub struct LiveCliRunner {
    program: String,
}

impl LiveCliRunner {
    /// New runner for `program` (default `"gh"`; tests point it at a mock).
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }
}

impl CliRunner for LiveCliRunner {
    fn run(&self, args: &[String]) -> Result<String, ToolError> {
        let output = std::process::Command::new(&self.program)
            .args(args)
            .output()
            .map_err(|e| ToolError::Failed(format!("cannot start {}: {e}", self.program)))?;
        if !output.status.success() {
            return Err(ToolError::Failed(format!(
                "{} exited {}: {}",
                self.program,
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr).trim(),
            )));
        }
        String::from_utf8(output.stdout)
            .map_err(|_| ToolError::Failed("CLI output is not valid UTF-8".to_owned()))
    }
}

/// Scripted fake runner: queued outputs, observed argv. Backs the CLI unit
/// tests — no processes.
#[derive(Debug, Default)]
pub struct FakeCli {
    outputs: std::sync::Mutex<std::collections::VecDeque<Result<String, ToolError>>>,
    seen: std::sync::Mutex<Vec<Vec<String>>>,
}

impl FakeCli {
    /// Empty fake (every run fails closed until scripted).
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue one result for the next run.
    pub fn push(&self, result: Result<String, ToolError>) {
        self.outputs.lock().expect("fake lock").push_back(result);
    }

    /// Argv vectors observed so far.
    pub fn seen(&self) -> Vec<Vec<String>> {
        self.seen.lock().expect("fake lock").clone()
    }
}

impl CliRunner for FakeCli {
    fn run(&self, args: &[String]) -> Result<String, ToolError> {
        self.seen.lock().expect("fake lock").push(args.to_vec());
        self.outputs
            .lock()
            .expect("fake lock")
            .pop_front()
            .unwrap_or_else(|| Err(ToolError::Failed("fake CLI: no scripted output".to_owned())))
    }
}

#[derive(Deserialize)]
struct GhArgs {
    #[serde(default)]
    args: Vec<String>,
}

/// `gh` wrapper: read-only issue/PR subcommands through the runner seam.
#[derive(Debug)]
pub struct GhTool<R: CliRunner> {
    runner: R,
}

impl<R: CliRunner> GhTool<R> {
    /// New wrapper over `runner`.
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    /// Whether `args` (`[group, action, ...]`) is allow-listed.
    pub fn allows(args: &[String]) -> bool {
        let (Some(group), Some(action)) = (args.first(), args.get(1)) else {
            return false;
        };
        if !GH_GROUPS.contains(&group.as_str()) {
            return false;
        }
        let actions = if group == "issue" {
            GH_ISSUE_ACTIONS
        } else {
            GH_PR_ACTIONS
        };
        if !actions.contains(&action.as_str()) {
            return false;
        }
        // Flags that smuggle writes/auth past the subcommand gate stay out.
        !args.iter().any(|arg| {
            matches!(
                arg.as_str(),
                "--write"
                    | "--delete"
                    | "--apply"
                    | "--merge"
                    | "--close"
                    | "--reopen"
                    | "-X"
                    | "--method"
            )
        })
    }
}

impl<R: CliRunner> AgentTool for GhTool<R> {
    fn name(&self) -> &str {
        "gh"
    }

    fn description(&self) -> &str {
        "Read-only gh wrapper: `gh issue/pr list|view|status` only."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "args": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "argv after `gh`, e.g. [\"issue\",\"list\"]",
                },
            },
            "required": ["args"],
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: GhArgs = parse_args(call)?;
        if !Self::allows(&args.args) {
            return Err(ToolError::Denied(format!(
                "gh subcommand is not allow-listed: {}",
                args.args.join(" ")
            )));
        }
        match self.runner.run(&args.args) {
            Ok(stdout) => Ok(ToolResult::ok(
                &call.call_id,
                serde_json::json!({ "stdout": stdout }).to_string(),
            )),
            Err(ToolError::Failed(message)) => Ok(ToolResult::err(&call.call_id, message)),
            Err(other) => Err(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::classify;
    use crate::tools::ToolCall;

    #[test]
    fn allowlisted_reads_pass_writes_denied() {
        let fake = FakeCli::new();
        fake.push(Ok("[]\n".to_owned()));
        let tool = GhTool::new(fake);
        let ok = tool
            .execute(&ToolCall::new("gh", "c1", r#"{"args":["issue","list"]}"#))
            .unwrap();
        assert!(ok.is_ok());

        for denied in [
            r#"{"args":["issue","create"]}"#,
            r#"{"args":["pr","merge"]}"#,
            r#"{"args":["auth","login"]}"#,
            r#"{"args":["issue","view","--close"]}"#,
            r#"{"args":["issue"]}"#,
            r#"{"args":[]}"#,
        ] {
            let fake = FakeCli::new();
            let tool = GhTool::new(fake);
            assert!(
                matches!(
                    tool.execute(&ToolCall::new("gh", "c", denied)),
                    Err(ToolError::Denied(_))
                ),
                "{denied}"
            );
        }
    }

    #[test]
    fn runner_failures_are_tool_results() {
        let fake = FakeCli::new();
        fake.push(Err(ToolError::Failed("gh exited 1: Not Found".to_owned())));
        let tool = GhTool::new(fake);
        let failed = tool
            .execute(&ToolCall::new("gh", "c1", r#"{"args":["pr","view","9"]}"#))
            .unwrap();
        assert!(!failed.is_ok());
    }

    #[test]
    fn live_runner_against_mocked_gh_binary() {
        // Mocked `gh`: a temp executable shell script echoing its argv as
        // JSON. Proves argv plumbing through the real spawn path.
        let dir = std::env::temp_dir().join(format!(
            "astra-gh-mock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mock dir");
        let bin = dir.join("gh");
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf 'mock-gh:'; printf ' %s' \"$@\"; printf '\\n'",
        )
        .expect("mock gh");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&bin).expect("meta").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&bin, perms).expect("chmod");
        }
        let tool = GhTool::new(LiveCliRunner::new(bin.to_string_lossy().to_string()));
        let ok = tool
            .execute(&ToolCall::new("gh", "c1", r#"{"args":["issue","list"]}"#))
            .unwrap();
        let body = ok.output_json.unwrap();
        assert!(body.contains("mock-gh: issue list"), "{body}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_and_approval_hook() {
        let tool = GhTool::new(FakeCli::new());
        assert_eq!(tool.schema()["type"], serde_json::json!("object"));
        assert!(tool.schema()["properties"]["args"].is_object());
        assert_eq!(tool.action_class(), classify("gh"));
    }
}

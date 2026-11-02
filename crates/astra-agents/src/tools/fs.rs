/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Scoped filesystem tools (P6-T03): `fs_read`, `fs_write`, `fs_list`.
//!
//! Every path resolves inside a root jail: the tool joins the request path
//! onto the workspace root, canonicalizes (following symlinks), and refuses
//! anything that escapes the root. Symlink escapes — a link inside the root
//! pointing outside — fail the same check, and the suite below pins both.
//! Reads are output-capped; writes are size-capped and refuse to create
//! files outside the jail (parent directories are canonicalized before the
//! join is re-checked).

use std::fs;
use std::path::{Component, PathBuf};

use serde::Deserialize;

use super::{parse_args, AgentTool, ToolCall, ToolError, ToolResult};

/// Maximum bytes returned by `fs_read` before truncation.
pub const MAX_READ_BYTES: usize = 256 * 1024;
/// Maximum bytes accepted by `fs_write`.
pub const MAX_WRITE_BYTES: usize = 256 * 1024;
/// Maximum directory entries returned by `fs_list`.
pub const MAX_LIST_ENTRIES: usize = 1_000;

/// A root-jailed filesystem view. Cloneable so tools can share one jail.
#[derive(Clone, Debug)]
pub struct ScopedFs {
    root: PathBuf,
}

impl ScopedFs {
    /// New jail rooted at `root`. The root must exist: it is canonicalized
    /// once so later `starts_with` checks compare exact paths.
    pub fn new(root: PathBuf) -> Result<Self, ToolError> {
        let canonical = root
            .canonicalize()
            .map_err(|e| ToolError::Invalid(format!("scoped-fs root is not a directory: {e}")))?;
        if !canonical.is_dir() {
            return Err(ToolError::Invalid(
                "scoped-fs root is not a directory".to_owned(),
            ));
        }
        Ok(Self { root: canonical })
    }

    /// Jail root (canonicalized).
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Resolve `request` inside the jail. Rejects absolute paths, `..`
    /// escapes that survive the join, and — via canonicalization — symlink
    /// escapes. Parent components are resolved for paths that do not exist
    /// yet (writes), so `jail/new-file` checks the jailed parent.
    fn resolve(&self, request: &str) -> Result<PathBuf, ToolError> {
        if request.trim().is_empty() {
            return Err(ToolError::Invalid("fs path must not be empty".to_owned()));
        }
        let rel = std::path::Path::new(request);
        if rel.is_absolute()
            || rel.components().any(|c| {
                matches!(
                    c,
                    Component::Prefix(_) | Component::RootDir | Component::ParentDir
                )
            })
        {
            return Err(ToolError::Denied(format!(
                "path escapes the workspace root: {request}"
            )));
        }
        let joined = self.root.join(rel);
        // Canonicalize what exists: the full path for reads, the parent for
        // writes-to-new-files. Both must stay inside the root afterwards,
        // which is what catches symlink escapes.
        let probe = if joined.exists() {
            joined.canonicalize()
        } else {
            let parent = joined.parent().ok_or_else(|| {
                ToolError::Denied(format!("path escapes the workspace root: {request}"))
            })?;
            if !parent.exists() {
                // Missing parents: lexically re-check the join instead of
                // inventing directories.
                if !joined.starts_with(&self.root) {
                    return Err(ToolError::Denied(format!(
                        "path escapes the workspace root: {request}"
                    )));
                }
                return Ok(joined);
            }
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| ToolError::Failed(format!("cannot resolve parent directory: {e}")))?;
            let name = joined
                .file_name()
                .ok_or_else(|| ToolError::Invalid("fs path names no file".to_owned()))?;
            Ok(canonical_parent.join(name))
        }
        .map_err(|e| ToolError::Failed(format!("cannot resolve path: {e}")))?;
        if !probe.starts_with(&self.root) {
            return Err(ToolError::Denied(format!(
                "path escapes the workspace root: {request}"
            )));
        }
        Ok(probe)
    }

    fn read_capped(&self, path: &std::path::Path) -> Result<String, ToolError> {
        let bytes = fs::read(path).map_err(|e| ToolError::Failed(e.to_string()))?;
        if bytes.len() > MAX_READ_BYTES {
            let capped = String::from_utf8_lossy(&bytes[..MAX_READ_BYTES]).into_owned();
            Ok(format!(
                "{capped}…[truncated {} bytes]",
                bytes.len() - MAX_READ_BYTES
            ))
        } else {
            String::from_utf8(bytes)
                .map_err(|_| ToolError::Failed("file is not valid UTF-8".to_owned()))
        }
    }
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

/// Read one file inside the jail (output-capped, UTF-8 only).
#[derive(Clone, Debug)]
pub struct FsReadTool {
    fs: ScopedFs,
}

impl FsReadTool {
    /// New tool over `fs`.
    pub fn new(fs: ScopedFs) -> Self {
        Self { fs }
    }
}

impl AgentTool for FsReadTool {
    fn name(&self) -> &str {
        "fs_read"
    }

    fn description(&self) -> &str {
        "Read a UTF-8 text file inside the workspace root (output-capped)."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "workspace-relative file path" } },
            "required": ["path"],
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: PathArgs = parse_args(call)?;
        let path = self.fs.resolve(&args.path)?;
        if path.is_dir() {
            return Err(ToolError::Invalid(
                "fs_read needs a file, not a directory".to_owned(),
            ));
        }
        let content = self.fs.read_capped(&path)?;
        Ok(ToolResult::ok(
            &call.call_id,
            serde_json::json!({ "path": args.path, "content": content }).to_string(),
        ))
    }
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

/// Write (create or replace) one file inside the jail (size-capped).
#[derive(Clone, Debug)]
pub struct FsWriteTool {
    fs: ScopedFs,
}

impl FsWriteTool {
    /// New tool over `fs`.
    pub fn new(fs: ScopedFs) -> Self {
        Self { fs }
    }
}

impl AgentTool for FsWriteTool {
    fn name(&self) -> &str {
        "fs_write"
    }

    fn description(&self) -> &str {
        "Write a UTF-8 text file inside the workspace root (size-capped)."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "workspace-relative file path" },
                "content": { "type": "string" },
            },
            "required": ["path", "content"],
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        let args: WriteArgs = parse_args(call)?;
        if args.content.len() > MAX_WRITE_BYTES {
            return Err(ToolError::Invalid(format!(
                "content exceeds {MAX_WRITE_BYTES} bytes"
            )));
        }
        let path = self.fs.resolve(&args.path)?;
        if path.is_dir() {
            return Err(ToolError::Invalid(
                "fs_write needs a file path, not a directory".to_owned(),
            ));
        }
        fs::write(&path, &args.content).map_err(|e| ToolError::Failed(e.to_string()))?;
        Ok(ToolResult::ok(
            &call.call_id,
            serde_json::json!({ "path": args.path, "bytes": args.content.len() }).to_string(),
        ))
    }
}

/// List one directory inside the jail (entry-capped, sorted).
#[derive(Clone, Debug)]
pub struct FsListTool {
    fs: ScopedFs,
}

impl FsListTool {
    /// New tool over `fs`.
    pub fn new(fs: ScopedFs) -> Self {
        Self { fs }
    }
}

impl AgentTool for FsListTool {
    fn name(&self) -> &str {
        "fs_list"
    }

    fn description(&self) -> &str {
        "List a directory inside the workspace root (entry-capped, sorted)."
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "path": { "type": "string", "description": "workspace-relative directory (default \".\")" } },
            "additionalProperties": false,
        })
    }

    fn execute(&self, call: &ToolCall) -> Result<ToolResult, ToolError> {
        #[derive(Deserialize)]
        struct ListArgs {
            #[serde(default = "dot")]
            path: String,
        }
        fn dot() -> String {
            ".".to_owned()
        }
        let args: ListArgs = parse_args(call)?;
        let path = self.fs.resolve(&args.path)?;
        if !path.is_dir() {
            return Err(ToolError::Invalid("fs_list needs a directory".to_owned()));
        }
        let mut entries: Vec<String> = fs::read_dir(&path)
            .map_err(|e| ToolError::Failed(e.to_string()))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        entries.sort();
        let truncated = entries.len() > MAX_LIST_ENTRIES;
        entries.truncate(MAX_LIST_ENTRIES);
        Ok(ToolResult::ok(
            &call.call_id,
            serde_json::json!({ "path": args.path, "entries": entries, "truncated": truncated })
                .to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::classify;
    use crate::tools::ToolCall;

    fn test_jail() -> (tempfile_guard::Guard, ScopedFs) {
        let dir = std::env::temp_dir().join(format!(
            "astra-fs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("test jail");
        let guard = tempfile_guard::Guard(dir.clone());
        let scoped = ScopedFs::new(dir).expect("jail");
        (guard, scoped)
    }

    /// Minimal tempdir guard without a new dependency: removes the dir on drop.
    mod tempfile_guard {
        use std::path::PathBuf;
        pub struct Guard(pub PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn read_write_list_round_trip() {
        let (_guard, scoped) = test_jail();
        let write = FsWriteTool::new(scoped.clone());
        let ok = write
            .execute(&ToolCall::new(
                "fs_write",
                "c1",
                r#"{"path":"note.md","content":"hello"}"#,
            ))
            .unwrap();
        assert!(ok.is_ok());

        let read = FsReadTool::new(scoped.clone());
        let ok = read
            .execute(&ToolCall::new("fs_read", "c2", r#"{"path":"note.md"}"#))
            .unwrap();
        assert!(ok.output_json.unwrap().contains("hello"));

        let list = FsListTool::new(scoped);
        let ok = list
            .execute(&ToolCall::new("fs_list", "c3", r#"{"path":"."}"#))
            .unwrap();
        assert!(ok.output_json.unwrap().contains("note.md"));
    }

    #[test]
    fn root_jail_blocks_dotdot_and_absolute_escapes() {
        let (_guard, scoped) = test_jail();
        let read = FsReadTool::new(scoped.clone());
        for evil in [
            r#"{"path":"../outside.txt"}"#,
            r#"{"path":"/etc/hostname"}"#,
            r#"{"path":"sub/../../outside.txt"}"#,
        ] {
            assert!(
                matches!(
                    read.execute(&ToolCall::new("fs_read", "c", evil)),
                    Err(ToolError::Denied(_))
                ),
                "{evil}"
            );
        }
        let write = FsWriteTool::new(scoped);
        assert!(matches!(
            write.execute(&ToolCall::new(
                "fs_write",
                "c",
                r#"{"path":"../evil.txt","content":"x"}"#
            )),
            Err(ToolError::Denied(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_denied() {
        use std::os::unix::fs::symlink;
        let (_guard, scoped) = test_jail();
        let outside = std::env::temp_dir().join(format!(
            "astra-fs-outside-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::write(&outside, "secret").expect("outside file");
        symlink(&outside, scoped.root().join("link.txt")).expect("symlink");
        let read = FsReadTool::new(scoped);
        let result = read.execute(&ToolCall::new("fs_read", "c", r#"{"path":"link.txt"}"#));
        assert!(matches!(result, Err(ToolError::Denied(_))), "{result:?}");
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn write_size_cap_and_schemas_and_hooks() {
        let (_guard, scoped) = test_jail();
        let write = FsWriteTool::new(scoped.clone());
        let big = "y".repeat(MAX_WRITE_BYTES + 1);
        let args = serde_json::json!({ "path": "big.txt", "content": big }).to_string();
        assert!(matches!(
            write.execute(&ToolCall::new("fs_write", "c", &args)),
            Err(ToolError::Invalid(_))
        ));
        for tool in [
            FsReadTool::new(scoped.clone()).schema(),
            FsWriteTool::new(scoped.clone()).schema(),
            FsListTool::new(scoped.clone()).schema(),
        ] {
            assert_eq!(tool["type"], serde_json::json!("object"));
        }
        assert_eq!(
            FsReadTool::new(scoped.clone()).action_class(),
            classify("fs_read")
        );
        assert_eq!(
            FsWriteTool::new(scoped.clone()).action_class(),
            classify("fs_write")
        );
        assert_eq!(FsListTool::new(scoped).action_class(), classify("fs_list"));
    }
}

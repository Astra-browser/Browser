# Hand-off to Claude Code / Codex (P6-T09)

The agent delegates a coding task to an external CLI (`claude` or `codex`)
by spawning it as a child process. Implementation:
`crates/astra-agents/src/handoff.rs`; mocked-binary tests:
`crates/astra-agents/tests/handoff_mocked.rs`.

## Contract

- **Explicit binaries only.** `HandoffConfig` carries absolute paths per
  target (`claude_code_bin`, `codex_bin`). Unconfigured → `NotConfigured`;
  relative → `Denied`. The runner never consults `PATH` (the command-runner
  precedent in `tools/command.rs`, stricter: no allow-listed bare names).
- **Approval is mandatory.** `approval_class()` delegates to
  `approvals::classify("handoff")`, which fails closed to high-risk.
  `HandoffRunner::run` takes an `Option<ApprovalDecision>` and refuses
  (`Denied`, no spawn) unless it is `Allow`/`AllowAlways`. Injected
  instructions in the proposal context deny via `propose()` with no
  approval event created.
- **Scoped dirs enforced pre-spawn.** `ScopedGrant { dirs, read_only }`
  names absolute dirs; the request workdir must sit inside them (lexically
  normalized, so `<dir>/../escape` is denied). Any violation is `Denied`
  with no child spawned. Granted dirs plus `--read-only` are also passed
  as argv flags (`--scope-dir <dir> … [--read-only]`) so the child knows
  its scope.
- **Piped stdio, streamed lines, caps.** stdout/stderr are pumped on
  threads into `HandoffOutput { status, stdout_lines, stderr_lines,
  truncated }` under shared caps (`MAX_OUTPUT_BYTES = 128 KiB`,
  `MAX_OUTPUT_LINES = 2000`, same byte budget as `command_run`). Each
  collected line is also delivered to the `on_line` callback.
- **Timeout kill + kill on drop.** The wait loop polls `try_wait` and
  kills on expiry (`HandoffError::Timeout`). `HandoffChild` kills on drop,
  so an abandoned hand-off never outlives its handle.
- **Transient-busy spawn retry.** A just-written or just-replaced binary
  can refuse `exec` with `ETXTBSY` while the writer's close settles;
  that error alone is retried briefly (5 × 5ms), everything else fails
  fast.

## Argv shape

`[<prompt>, --scope-dir <dir>…, (--read-only)?, ...extra_args]`, spawned
with `current_dir(workdir)` and `HANDOFF_TARGET` set to
`claude-code | codex`. No shell is ever involved.

## Approval flow

```
propose(run_id, request_id, subject, untrusted) -> GateOutcome
  clean      -> NeedsApproval (high-risk; user allows in UI)
  injected   -> Denied, no approval event
run(request, Some(Allow | AllowAlways), on_line) -> HandoffOutput
run(request, None | Some(Deny), _)               -> Denied, no spawn
```

`HandoffError::to_tool_error()` maps the outcome onto `ToolError` for the
run loop (`Denied → Denied`, `Timeout → Timeout`, rest → `Failed`).

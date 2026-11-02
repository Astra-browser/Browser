# Tool layer — `astra-agents` (P6-T03)

Every tool the agent can call: names, schemas, safety rails, and the Host API
contract behind the browser tools. Read with `AGENTS_DESIGN.md` §8
(approvals) and §9 (trust rules).

## Registry

`ToolRegistry` (`crates/astra-agents/src/tools.rs`) maps names to tools and
is the loop's single dispatch point: validate the `ToolCall`, route by
`call.tool` (`UnknownTool` for anything unregistered), run, and account the
dispatch in `ToolCallLedger` — per-tool counts kept on-device, mirroring the
provider `UsageLedger` pattern (`record` / `get` / `total`). `definitions()`
hands the planner/provider layer every tool's name, description, and JSON
Schema. No tool is reachable unless registered.

## Tool catalogue

| Tool | Family | What it does |
|---|---|---|
| `browser_open` | browser | Navigate the selected tab to an http(s) URL |
| `browser_read` | browser | Current page as readability text + title (capped) |
| `browser_snapshot` | browser | Accessibility tree snapshot (JSON) |
| `browser_screenshot` | browser | Screenshot metadata (bytes + size; pixels stay out) |
| `browser_click` | browser | Click by a11y ref or CSS selector |
| `browser_type` | browser | Type into an element, optional submit |
| `browser_scroll` | browser | Scroll viewport/element by CSS-pixel deltas |
| `fs_read` | scoped fs | Read a UTF-8 file in the workspace root (capped) |
| `fs_write` | scoped fs | Write a UTF-8 file in the workspace root (size-capped) |
| `fs_list` | scoped fs | List a workspace directory (entry-capped, sorted) |
| `command_run` | command | Run an allow-listed program, no shell, timeout + caps |
| `mcp_list_tools` | MCP | `tools/list` over stdio JSON-RPC |
| `mcp_call` | MCP | `tools/call` over stdio JSON-RPC, permission-gated |
| `gh` | CLI | Read-only `gh issue/pr list\|view\|status` |

Every tool ships a draft-07 object JSON Schema (`AgentTool::schema`) and
unit tests (`src/tools/*.rs`).

## Approval hooks

`AgentTool::action_class` defaults to — and every tool keeps — a direct
call into `approvals::classify`. Tools never reimplement the taxonomy; the
P6-T04 gate stays the single owner. Fail-closed: anything the classifier
does not know (`command_run`, `mcp_*`, `gh`, `fs_write`, …) is high-risk.

## Browser tools → Host API `ContentTools`

Rust owns names/schemas/validation; page access lives in
`overlay/astra/host/ContentTools.sys.mjs` (registered in `jar.mn` next to
`Content.sys.mjs`). Conventions match the other Host modules: `request_id`
echo, `HOST_API_VERSION`, `{ request_id, host_api_version, … }` envelopes,
`{ …, error: { code, message } }` failures.

Two paths, one envelope:

1. **In-content (primary):** the mounted `<browser>` from `Content.sys.mjs`.
   The shell injects a `driver` (`setDriver`) implementing
   open/read/snapshot/screenshot/click/type/scroll over the live document.
2. **WebDriver BiDi fallback:** when no browser is mounted (detached actor,
   headless harness), the shell injects `setBidiFallback` with the same
   function names, driven over the BiDi session
   (`browsingContext.captureScreenshot`, `Accessibility.getTree`). Only
   `no_page` faults fall through to BiDi; every other driver fault belongs
   to the backend that raised it.

Screenshot envelopes carry metadata only — raw pixels never enter logs,
step details, or evals (trust rule §9.2).

## Safety rails

- **Scoped fs** (`tools/fs.rs`): root jail. Absolute paths and `..` are
  rejected lexically; the resolved path is canonicalized (following
  symlinks) and must stay under the root — symlink escapes fail the same
  check. `MAX_READ_BYTES` / `MAX_WRITE_BYTES` 256 KiB, `MAX_LIST_ENTRIES`
  1 000.
- **Command runner** (`tools/command.rs`): exact-match program allow-list,
  direct spawn (no shell), polled `try_wait` with kill on expiry (default
  30 s), stdout+stderr capped at 128 KiB with a truncation marker. Non-zero
  exits are tool failures (`ToolResult::err`), not crashes.
- **MCP client** (`tools/mcp.rs`): JSON-RPC 2.0 over stdio, one object per
  line; id-match checked, server `error` replies surface as `Failed`.
  `McpPermissions` gates `tools/call` by remote tool name before anything
  spawns (`only(...)` vs `all()`). Reads bound by `MCP_READ_TIMEOUT` (10 s).
- **CLI wrapper** (`tools/cli.rs`): `gh` allows `issue/pr list|view|status`
  only; write/auth verbs (`create`, `merge`, `auth`, …) and smuggled flags
  (`--close`, `--method`, …) are denied pre-spawn. Non-zero exits are tool
  failures. Adding a binary = one tool + one allow-list + one runner.

## Adding a tool

1. New struct in `src/tools/<family>.rs` implementing `AgentTool`
   (`name`, `description`, `schema`, `execute`; keep the inherited
   `action_class` delegation).
2. JSON Schema + unit tests in the same file (schema shape, happy path,
   every denial path).
3. Register in the loop wiring; confirm `classify(name)` returns the
   intended class.

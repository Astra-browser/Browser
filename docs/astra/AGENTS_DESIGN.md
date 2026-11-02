# Agent design — `astra-agents` (P6-T01)

Port of the agent architecture from the reference snapshot inventory
(`docs/astra/INVENTORY.md`: agent-controller, agentic, agent-model-catalog,
agent-provider-transport, agent-runtime crates; `eval/agentic-browsing`
harness; 25 bundled skills) into Astra's own `astra-agents` crate.
Rebranded throughout: no reference-snapshot names, no carried-over model
or provider labels.

## 1. Loop

One run is one `AgentRun` (`crates/astra-agents/src/run.rs`): a versioned
record (`RUN_RECORD_VERSION`, `to_json` / `from_json`, loud
`VersionMismatch` — the `astra-core` session/layout precedent) persisted in
the `astra-store` `agent_runs` table. States:

`pending → running ⇄ awaiting-approval → {succeeded | cancelled | failed}`

`AgentLoop::advance` appends exactly one `StepEvent` per turn and enforces
the step budget (`MAX_STEPS_PER_RUN`): the call that would exceed it marks
the run `cancelled` and returns `BudgetExhausted` instead of running
forever. Terminal runs must carry `ended_at`; starting or advancing a
terminal run is an error, never a silent no-op.

Reference mapping: the snapshot's runtime lifecycle (admission, scoped
bindings, staged stop, terminal-claim proofs) collapses to this state
machine for P6-T01. The move-only shutdown proofs and terminal-settlement
machinery are out of scope until the runtime lands; the loop guarantees
the weaker but testable invariant — every run ends in exactly one terminal
state with its step history intact.

## 2. Planner

`Plan` (`src/planner.rs`) is the versioned, ordered step list for one run:
stable `step_id`s, human-readable descriptions, per-step status
(`pending | active | done | skipped | failed`), `MAX_PLAN_STEPS` cap,
duplicate-id rejection. `next_pending` gives the loop its next unit of
work.

The full planner — decomposition of a goal into steps, repair on tool
failure, re-planning mid-run — arrives with the provider layer (P6-T02),
which is when model output first exists to propose plans. Until then the
shape is stable so the loop, the canvas (P6-T06), and plan→tasks hand-off
can build on it.

## 3. Steps stream

`StepEvent` / `StepStream` (`src/steps.rs`): the append-only event log of a
run. Kinds: `observe | message | tool-call | tool-result | approval |
plan | done`. Each event is versioned JSON (`STEP_EVENT_VERSION`); the
stream enforces contiguous `seq` from zero, so a dropped or reordered
event fails loudly (`OutOfOrder`) instead of silently forking history.

Durable persistence reuses the `astra-store` `agent_steps` table
(`run_id`, `seq`, `kind`, `summary`, `detail`) with the `(run_id, seq)`
index; `StepStream` is the in-memory skeleton and the ordering contract
the store writer must preserve.

## 4. Helpers (parallel sub-agents, P6-T05 preview)

Helpers are runs, not a second concept: `AgentRun::new_helper` links a
child run to its parent via `parent_run_id` (validated: names a *different*
run). The P6-T05 runtime adds the rest — one container per helper, visible
panes, a source pane, cancel, and time/token/step budgets — but the record
shape already supports "3 helpers in parallel" as three child runs fanning
out from one parent, each with its own loop, plan, and step stream.
Cancellation of a parent must cascade to children (P6-T05 acceptance:
no orphan tabs).

## 5. Memory hooks

`MemoryItem` (`src/memory.rs`): versioned record (`MEMORY_VERSION`),
`global | site | ephemeral` scope, site-scoped items name their host.
Persisted in `astra-store` `memory_items`; deletion there actually removes
the row (P6-T08 tests this — user controls to view/edit/delete are a hard
requirement, not polish).

`MemoryHook` is the loop's filing interface: `on_run_end` files a finished
run's summary back into memory, `recall` surfaces items for a hint. The
skeleton ships `NullMemoryHook` (files nothing); P6-T08 decides the
keep-policy. Nothing is recalled into a prompt without provenance — see §9.

## 6. History search

`HistoryQuery` (`src/memory.rs`): free-text query plus a capped `limit`
(1–100, default 20). The loop searches through the store's existing
`history_search` API (URL/title match, most-recent-first); this crate owns
the request shape, the store owns the rows. History is read-only from the
agent's side — recalling a visit never deletes or mutates it — and
private-window visits are never in the index (session precedent).

## 7. Skills interface

`SkillManifest` + `SkillLoader` (`src/skills.rs`): a skill is a name
(kebab-case, validated), a description, a tool allow-list, an optional
content path, and an enabled flag — versioned JSON (`SKILL_VERSION`) so
the registry can seed the `astra-store` `skills` table. The bundled set
(25 skills in the snapshot: research, trip-planning, meeting-prep,
inbox-triage, …) is ported — instructions rewritten, tool names rebound
to the P6-T03 tool registry — in P6-T07, which also adds directory
scanning, `SKILL.md` front-matter parsing, and signature/permission
checks. The loader trait (`list` / `load`) is what the loop consults;
`StaticSkillLoader` covers tests and early wiring. Each ported skill gets
a smoke eval in P6-T07.

## 8. Approvals interface

`classify` + `ApprovalRequest` + `ApprovalDecision` (`src/approvals.rs`):
every tool call maps to an `ActionClass` — `read-only` (page reads,
history/memory/skill recall: proceed), `side-effect` (tabs, bookmarks,
note drafts: ask by default), `high-risk` (anything unknown, anything
outwardly visible or hard to undo: always ask). Unknown tools fail closed
to `high-risk`.

An ask becomes an `ApprovalRequest` (versioned, `APPROVAL_VERSION`)
resolved to `allow | allow-always | deny` with `decided_by` recorded for
the `approvals_audit` table. Deny means the loop plans around the refusal,
never retries the same call hoping for a different answer. The full gate
engine — per-tool policies, audit-log writer, and the prompt-injection
test suite (pages instructing the agent to exfiltrate data or act: no
side effect without an approval event) — is P6-T04.

## 9. Trust rules (apply to every phase)

1. Page and model content is data, never instruction. Only the user's
   goal, the plan, and approval decisions steer the loop.
2. Secrets (provider keys) live in the OS keychain, never in the store,
   logs, evals, or step details. Committed evidence must never contain
   credentials, page text, HTML, screenshots, or provider responses
   (eval-harness precedent).
3. Local-only stays local: usage accounting is kept on-device, and local
   endpoints (`ProviderKind::Local`) never report off-device.
4. Old payloads fail loudly: every versioned shape keeps its
   `VersionMismatch` error; no silent migration, no best-effort parse.

## Phase map

| Phase | Work | Lands in |
|---|---|---|
| P6-T02 | Provider layer + streaming/tool-calls/retries | `providers.rs` trait impls |
| P6-T03 | Tool schemas + implementations, MCP client | `tools.rs` impls |
| P6-T04 | Approval engine + injection suite | `approvals.rs` engine |
| P6-T05 | Helper runtime (containers, panes, cancel) | `run.rs` parent/child |
| P6-T06 | Canvas (tables, charts, plans, code, docs) | plan → tasks, save → notes |
| P6-T07 | Skill port + user-skill loader | `skills.rs` loader |
| P6-T08 | Memory/history store wiring + deletion | `memory.rs` hooks |
| P6-T09 | Hand-off to external coding agents | process spawn, scoped dirs |
| P6-T10 | Eval port onto local fixture sites | `tests/eval/` |

## 10. Provider layer (P6-T02)

Seven backends behind one `ModelProvider` trait
(`crates/astra-agents/src/providers.rs` + `src/providers/`):

| Backend | `ProviderKind` | Endpoint | Key | Wire format |
|---|---|---|---|---|
| Anthropic | `Anthropic` | `api.anthropic.com/v1/messages` | keychain → `x-api-key` + `anthropic-version: 2023-06-01` | messages API; SSE `message_start` / `content_block_delta` (`text_delta`, `input_json_delta`) / `message_delta` |
| OpenAI | `OpenAI` | `api.openai.com/v1/chat/completions` | keychain → `Authorization: Bearer` | chat completions; SSE `choices[0].delta` + `data: [DONE]`, `stream_options.include_usage` |
| Gemini | `Gemini` | `generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (`:streamGenerateContent?alt=sse`) | keychain → `?key=` query (API contract) | `contents[{role, parts}]`, `functionCall{name, args}`; one response JSON per SSE event |
| DeepSeek | `DeepSeek` | `api.deepseek.com/chat/completions` | keychain → Bearer | OpenAI-compatible (shared parser in `providers/openai.rs`) |
| OpenRouter | `OpenRouter` | `openrouter.ai/api/v1/chat/completions` | keychain → Bearer + static `HTTP-Referer`/`X-Title` | OpenAI-compatible (shared parser) |
| Ollama | `Local` | `http://localhost:11434/api/chat` | none (keyless) | `{message: {content, tool_calls?}}`; streaming is NDJSON, one object per line |
| LM Studio | `Local` | `http://localhost:1234/v1/chat/completions` (configurable) | none by default (optional gateway key) | OpenAI-compatible (shared parser) |

Shared machinery (all in `providers.rs`):

- **Transport seam** (`HttpTransport`): live code uses `UreqTransport`
  (blocking `ureq`, `http_status_as_error(false)` so 401/403/429 map to
  typed errors instead of transport faults); tests inject
  `recording::RecordingTransport` with scripted responses/faults. No
  network in tests.
- **Streaming**: `SseAssembler` (incremental, `\n\n`-framed, skips
  comments), `stream_sse_reader` (feeds any `BufRead` — live socket or
  fixture bytes), `ToolCallAssembler` (folds OpenAI `tool_calls` index
  deltas into whole `ToolCall`s). Unary `complete_request` retries;
  `complete_stream` is single-attempt (retrying a half-emitted chunk
  sequence would double-emit) — documented in code.
- **Retries**: `send_with_retry` + `RetryPolicy` (default 3 retries,
  200 ms base, 5 s cap, exponential). Retried: transport faults, 429,
  5xx. Never retried: 401/403 (`Auth`), 400s, parse errors, missing
  keys. Sleep is injected so tests assert exact backoff delays.
- **Usage**: `UsageLedger` (per-provider totals, `record`/`get`/`total`);
  local-only by construction — nothing is ever sent. Local backends
  report zero token counts and take no auth header (asserted).
- **Catalogue**: `catalog()` advisory model ids per backend.

Keychain choice: **`keyring` v4** (docs.rs-verified: maintained
`open-source-cooperative/keyring-rs`, cross-platform — macOS Keychain,
Windows Credential Manager, Linux Secret Service via default `v1`
feature; `keyring-core` + per-store crates would be more code for this
phase's single `Entry(service, account)` use). Only `OsKeychainStore`
touches it; `MemoryKeyStore` is tests-only. Every provider config
redacts its key in `Debug` (`ApiKey(REDACTED)`); request builders are
asserted key-free in bodies; `ApiKey::expose` exists solely to build
one auth header. Opt-in live smokes (`ASTRA_LIVE_SMOKE=1`,
`tests/providers_conformance.rs`) read real keys from the OS keychain
and SKIP when unset or when an entry/daemon is absent.

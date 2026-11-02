# Approval gate engine — `astra-agents` (P6-T04)

How the agent asks before it acts: the fail-closed classifier, the
request/decision flow with idempotency keys, the tamper-evident audit log,
and the prompt-injection screen. Parent design: `docs/astra/AGENTS_DESIGN.md`
§8 (approvals interface) and §9 (trust rules).

## 1. Taxonomy

Every tool call maps to one `ActionClass` (`src/approvals.rs::classify`):

| Class | Meaning | Gate behavior |
|---|---|---|
| `read-only` | Pure reads: page text, history/memory/skill recall | Proceeds, no approval |
| `side-effect` | Reversible local state: tabs, bookmarks, note drafts | Ask by default |
| `high-risk` | Hard-to-undo or outwardly visible: purchases, messages, credentials, data leaving the device | Always ask |

The read-only set is an explicit allowlist (`page_read`, `page_observe`,
`history_search`, `memory_recall`, `skill_describe`, `model_complete`); the
side-effect set is closed too. **Anything unknown classifies high-risk**
(fail closed): tools added by P6-T03 or plugins ask until they are
deliberately classified. Case, whitespace, or look-alike variants of
allowlisted names do not match — they ask.

## 2. Request / decision flow

An ask is an `ApprovalRequest` (versioned, `APPROVAL_VERSION`): `request_id`,
`run_id`, `action`, `subject`, `class`, plus the decision once made
(`allow` | `allow-always` | `deny`, with `decided_by`).

`ApprovalGate` is the in-memory intake:

- `submit(run_id, action, subject)` classifies and creates the checkpoint.
- **Idempotency:** the checkpoint key (`idempotency_key`, a stable
  `run_id + action + subject` hash) replays the pending request on retry
  instead of creating a second checkpoint — `SubmitOutcome.replayed`
  tells the caller which happened.
- `resolve(key, decision, decided_by)` records the decision exactly once.
  Deciding twice, or deciding an unknown key, is an error — never a silent
  no-op. `deny` means the loop plans around the refusal, never re-asks the
  same checkpoint.
- `allow-always` becomes standing policy for the action
  (`is_preapproved`): future equivalent actions arrive pre-decided, still
  recorded so the audit trail shows one checkpoint per action instance.

Shapes serialize with `to_json` / `from_json` plus a loud `VersionMismatch`
error, following the `astra-core` session/layout precedent. Rows written
before the idempotency key existed get the derived key backfilled on parse
(it is a pure function of the other fields).

## 3. Audit log

Every checkpoint and every injection denial appends one record to the
append-only log (`src/audit.rs::AuditLog`); the store `approvals_audit`
table owns durable rows, this module owns the portable chain format.

- `AuditEvent`: `requested | decided | injection-blocked`, with run,
  request, action, and a short label. Event detail must never carry
  secrets, page text, HTML, or provider output (trust rule §9.2).
- `AuditRecord`: `seq`, `prev_hash`, `event_json`, and `hash =
  sha256(version || seq || prev_hash || event_json)`.
- `verify()` recomputes the whole chain: any edit, deletion, or reorder
  fails loudly (`ChainBroken`). `write_jsonl` / `read_jsonl` persist one
  JSON object per line; loading verifies before returning, never
  best-effort.

## 4. Prompt-injection screen

Trust rule §9.1: page and model content is data, never instruction. Before
any approval is requested, `evaluate()` screens the untrusted context
(page text, tool output) with `screen_untrusted`:

- **Exfiltration** — move data off-device (passwords, keys, third-party
  URLs, webhooks, paste sites).
- **Privilege escalation** — gain capability (ignore system rules,
  developer/admin/root mode, disable safety, override instructions).
- **Approval bypass** — skip the gate (fake or replayed approvals,
  pre-approval claims, "don't ask" directives).

Any hit resolves to `GateOutcome::Denied`: the action is dropped and **no
approval request is created**, so there is no approval event to
social-engineer or replay — not even for pure reads. Clean side effects
resolve to `NeedsApproval` carrying the request; clean reads to `Proceed`.

The screen is a coarse substring matcher (dependency-free, greppable
signal tables), deliberately fail-open-to-deny: anything flagged is denied
outright, and anything missed still needs approval for non-read actions
via the fail-closed classifier. The 12-case adversarial suite lives inline
in `approvals.rs` (direct, indirect, disguised-tip, tool-output, fake
replay, escalation, system-role claim, hidden comment, polite no-ask,
webhook exfil, pre-approval claim, combined attack), plus benign-content
negatives against false positives.

## 5. Testing

All tests live inline (`#[cfg(test)]` in `approvals.rs` / `audit.rs` —
never under `tests/`, owned by the P6-T03 worker):

- classifier allowlist + fail-closed unknowns,
- request JSON round-trip, version mismatch, legacy key backfill,
- gate idempotent submit, single-use resolve, allow-always policy,
- `evaluate` proceed / ask / deny paths,
- 12 adversarial injection cases + benign negatives,
- audit chain append/verify, tamper (edit/drop/reorder) detection, JSONL
  writer round-trip with on-disk tamper rejection.

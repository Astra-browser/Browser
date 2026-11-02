/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of this file was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

# Memory + history recall (P6-T08)

User-visible agent memory: the agent files run outcomes back into the
store, recalls them (and browsing history) for later runs, and the user
can view, edit, and delete everything kept. Deletion actually removes
data — that is the hard requirement this phase proves.

## Shape

`MemoryItem` (`crates/astra-agents/src/memory.rs`, `MEMORY_VERSION = 1`):
`global | site | ephemeral` scope, site-scoped items name their host.
Versioned JSON with loud `VersionMismatch`, following the `astra-core`
session/layout precedent. Cap: `MAX_MEMORY_CHARS = 16_000`.

`HistoryQuery`: free-text query plus a capped `limit` (1–100, default
20). The agent owns the shape; the store owns the rows.

## Storage

`memory_items` (created by the store v4 migration, like every migration:
additive, never destructive). The P6-T08 layer
(`crates/astra-store/src/memory.rs`, re-exported from the crate root)
adds, all idempotent and versioned via `MEMORY_SCHEMA_VERSION` tracked
in `schema_meta` (`memory_schema_version`), applied by
`Store::ensure_memory_schema()`:

- `idx_memory_items_scope_updated (scope, updated_at DESC)` — scoped
  listing without a full scan.
- `idx_memory_items_updated (updated_at DESC)` — global listing order.

No FTS tables by design: FTS5 shadow tables would leak into
`export_json` table dumps (every `sqlite_master` table is exported).
Search stays `LIKE`-based over plain rows, so export/import round-trips
are unaffected and legacy v4 rows (`memory_put`) read through the new
API untouched.

CRUD: `memory_create` / `memory_get` / `memory_list` / `memory_update` /
`memory_delete`, plus `memory_vacuum`. Validation (non-empty scope and
content, 16k cap) fails loudly with `StoreError::Import`.

## Search ranking (documented)

Candidates are selected with `LIKE '%escaped%'` (query `%`, `_`, `\`
are escaped, so a literal `%` never becomes a wildcard), then ranked in
Rust:

```text
memory:  rank = 10 * occurrences(query in content)
              +  2 * occurrences(query in scope)
              +  recency tiebreak (updated_at scaled by 1e-12)
history: rank = 10 * occurrences(query in title)
              +  3 * occurrences(query in url)
              +  recency tiebreak (visit_time scaled by 1e-12)
```

Title matches outrank URL-only matches; among equal text scores the
newer row wins. The UI panel (`searchMemories`) mirrors the memory
formula so client-side filtering agrees with the store.

## Deletion really deletes

`memory_delete(uuid)` runs a physical `DELETE` — no tombstone (the v4
`deleted_at` column is left for the legacy soft-delete path and is never
set by this module). Verified by
`memory::tests::memory_delete_actually_removes_data` (write → delete →
assert):

- API: `memory_get`, `memory_list`, and `memory_search` no longer
  return the row.
- Raw SQL: `SELECT COUNT(*) FROM memory_items WHERE uuid = ?` is 0.
- Index: SQLite maintains the B-tree indexes in the same `DELETE`
  statement, so no separate invalidation step exists or is needed.
- File bytes: freed pages sit on the SQLite freelist until reused, so a
  raw-bytes sweep can still see the content. `memory_vacuum()` runs
  `VACUUM` (rebuilds the file, drops the freelist — the test asserts
  `freelist_count = 0` afterwards). It is manual, not per-delete:
  `VACUUM` rewrites the whole file and would stall the UI on every
  delete. Call it after user-initiated deletes when the bytes must leave
  the file now.

`export_json` dumps include live memory rows only; deleted rows are gone
from exports too (nothing to resurrect on import).

## Private-scope exclusion

Private windows persist nothing (P4-T07/P5-T04, `docs/astra/PRIVATE.md`).
Memory follows the same contract, split across the dependency boundary
(the store cannot depend on `astra-core`):

- Callers gate writes: the agent hook is constructed non-persisting in
  private scope (`StoreMemoryHook::private` — files, lists, and recalls
  nothing), and `astra-core`'s `memory_ext` facade offers
  `memory_allowed` / `gate_memory_write(&scope, || …)` on the `"memory"`
  write path (unknown action names default to the private-safe master
  switch, so this path is blocked in private scope by construction).
- Defence in depth: `Store::memory_create` itself rejects the literal
  scope `"private"`, so a private row can never persist even if a caller
  forgets the gate.

History recall is read-only: recalling a visit never deletes or mutates
it, and private-window visits are never indexed (callers gate
`history_add` on `PrivateScope`, P4-T07).

## Agent wiring

`crates/astra-agents/src/memory.rs` (store wiring for the `MemoryHook` /
listing / deletion side; the store crate itself is never modified from
here — the trait below only *calls* the store API):

- `MemoryStore` trait: `memory_save` / `memory_load` / `memory_list` /
  `memory_search` / `memory_update` / `memory_delete` /
  `history_recall`. The real adapter lives at the wiring layer; tests
  use `InMemoryMemoryStore`.
- `StoreMemoryHook<S: MemoryStore>`: implements `MemoryHook` with the
  keep-policy — file a trimmed, non-empty summary (truncated to the
  cap, never dropped), skip empty summaries, stay best-effort (a store
  failure never fails the run). Recall delegates to the ranked search;
  blank hints recall nothing.
- User controls on the hook: `list`, `search_memories`,
  `update_memory`, `delete_memory` (returns `true` only when a row was
  actually removed).

## UI panel

`ui/app/src/features/work/memory/` (new subdir only; no wiring into the
work index — host integration is a follow-up):

- `memory.ts`: `MemoryEntry`, `searchMemories` (store-mirroring rank),
  `scopeLabel`. Unit-tested (`tests/memory.test.ts`, unit project).
- `components/MemoryPanel.svelte`: list / search / edit (Save/Cancel) / delete
  with an explicit two-step confirm (`Delete` arms an inline
  “Delete this memory? This cannot be undone.” prompt; only `Confirm
  delete` fires `ondelete`). Component-tested
  (`tests/MemoryPanel.component.test.ts`, component project).
- `index.ts`: small public barrel (`MemoryPanel`, ranking helpers).

## Tests

- `cargo test -p astra-store -p astra-core` (workspace green; the
  `astra-agents` crate itself does not compile on this checkout — the
  P6-T02 worker's `providers.rs` WIP references submodules that do not
  exist yet — so the agents memory tests run in an isolated scratch
  crate with identical `serde`/`serde_json`/`thiserror` deps: 9/9 pass).
- `cargo clippy -p astra-store -p astra-core`, `rustfmt --check` on
  touched files, `bun vitest run --project unit
  src/features/work/memory/memory.test.ts`, component project for the
  panel test, `tools/brand-lint.sh`.

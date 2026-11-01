/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

# Private windows (P4-T07)

Private windows persist **nothing** through core. `astra-core` owns the
guard; the store owns the bytes.

## Guard

`crates/astra-core/src/private.rs` — `PrivateScope`:

- `PrivateScope::public()` persists; `PrivateScope::private()` skips
  every write. `with_private_windows(is_private, ids)` adds per-window
  checks for snapshot filtering across windows.
- One-line call-site guard: `scope.gate("history", || …)` runs the
  write only in public scope (returns `None` when skipped).
- Per-path predicates: `history_allowed`, `session_allowed`,
  `favicon_allowed`, `time_allowed` — all equal the master switch, so a
  new path gated on `check(name)` defaults to private-safe.

## Call-site wiring (no existing core file modified)

All four subsystems are gated from the new module; the only edit to an
existing file is the `pub mod private;` line in
`crates/astra-core/src/lib.rs`. Callers insert one guard line each:

| Subsystem | Write path | Guard line |
|---|---|---|
| history | `Store::history_add` / `history_add_in_space` | `scope.gate("history", \|\| store.history_add(…))` |
| sessions | `Store::session_save` (capture already drops private windows/tabs via `SessionSnapshot::capture`) | `scope.gate("session", \|\| store.session_save(…))` |
| favicons | `Store::favicon_upsert` | `scope.gate("favicon", \|\| store.favicon_upsert(…))` |
| time | `Store::time_start` / `time_end` | `scope.gate("time", \|\| store.time_start(…))` |

`SessionSnapshot::capture` (pre-existing) filters private window ids and
clears a dangling private `active_tab_id`; `snapshot_contains_private`
is the pre-save assert, `forensic_scan_snapshot_json` the test scanner.

## Wiring status (orchestrator note, 2026-11-02)

Enforced today: host seam (`Session.describe`/`restore` exclude private),
`SessionSnapshot::capture` filter, and the guard itself (unit + forensic
tests prove it blocks all four paths *when used*). NOT yet enforced:
no live caller passes window privacy into the store writes yet, so the
`gate(…)` lines above are the contract for upcoming lanes, not wired
call sites. Follow-ups: `@astra/bridge` routes must thread window
privacy when they call history/session/favicon/time writes; P5-T04
(time tracking) must gate its writes; P2-T09 session persistence must
gate `session_save`. Until then, treat private mode as host-excluded
but not store-guaranteed.

## Forensic acceptance

`private::tests::forensic_private_writes_leave_no_rows` drives all four
writes through the guard in private mode, reopens the profile DB file
with a fresh handle, and asserts zero private rows (history search,
session snapshot text, favicon fetch, time totals) plus a raw-bytes
sweep of `astra.db` (`-wal`/`-shm` included) for the private marker.
Public-mode writes in the same test persist, proving the guard is
scope-selective rather than a global kill switch.

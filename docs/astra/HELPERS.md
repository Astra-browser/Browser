# Helpers — parallel sub-agents (P6-T05)

One parent run fans out to parallel helpers. Helpers are runs, not a second
concept: each helper is a child run linked by `parent_run_id`, with **its own
container**, **its own visible source pane**, **its own budgets**, and
**per-helper cancel**.

## Acceptance (from docs/planning/PLAN.md)

3 helpers in parallel demo; cancellation leaves no orphan tabs.

## Runtime (`crates/astra-agents/src/helpers.rs`)

| Piece | Shape |
|---|---|
| `HelperRun` | Versioned record (`HELPER_VERSION`, `to_json` / `from_json`, loud `VersionMismatch`, `validate` — the crate precedent). Carries `helper_id`, `parent_run_id`, `goal`, `container_id`, `source_pane_id` (`helper-pane-<id>`, deterministic), `HelperBudget`, usage counters, start/end times, end reason. Projects onto `run::AgentRun` via `as_agent_run` (`BudgetExhausted` maps to `Cancelled` — both mean "stopped by the watchdog"). |
| `HelperBudget` | `max_steps` (default 50) · `max_tokens` (default 32,000) · `max_wall_ms` (default 5 min). Every cap non-zero; the first exceeded cap wins. |
| `HelperPool` | Owns one parent's fan-out: `spawn` (mint container, assign pane, stamp start), `record_step` (Pending→Running, then step/token/wall enforcement), `sweep_timeouts` (wall-clock sweep for idle helpers), `succeed` / `fail` / `cancel`, `cancel_all` (parent cascade). Cap: `MAX_HELPERS_PER_PARENT` (8). |
| `Clock` | `SystemClock` live; `ManualClock` fake for deterministic tests. Time only enters through this seam. |
| `ContainerDriver` | `create_container` / `destroy_container` / `live_containers`. `InMemoryContainerDriver` mints `helper-container-N` — the no-browser mock. |

### Cancel semantics (the no-orphan invariant)

- `cancel(helper)` marks it `Cancelled` and **destroys its container**.
- `cancel_all` stops every live helper and tears down every live container.
- `orphan_containers()` — driver-live containers with no live helper — must be
  empty after any cancel path. Budget kills (`BudgetExhausted`) tear down too.
- Cancelling a terminal or unknown helper is an error, never a silent no-op.

Tests (in-module): JSON round-trip, validation, duplicates + pool cap,
3-helper fan-out (own containers/panes/parent links), step/token/wall budgets
against the fake clock, cancel → container destroyed, `cancel_all` cascade with
zero orphans, succeed/fail release, terminal-state projection.

## Host bridge (`overlay/astra/host/Helpers.sys.mjs`)

Read-only over the **existing** `Panes` and `Containers` modules — no changes
to either. `spawn` mints an ephemeral container (`helper-<id>`) then attaches
+ shows `helper-pane-<id>` in the `work.helper` slot (rollback on pane
failure, so spawn never orphans). `cancel` detaches + hides the pane, then
removes the container (`forgetData: true`). `cancelAll` cascades per parent.
Packaging: one additive line in `overlay/astra/jar.mn`.

## UI (`ui/app/src/features/work/helpers/`)

- `helpers.ts` — entry model + pure list helpers (`liveHelpers`, `budgetLabel`,
  `usageLabel`, `statusLabel`, `helperPaneId`); unit-tested.
- `HelperList.svelte` — the run's helpers in spawn order, each row anchored to
  its source pane, each live helper with its own **Cancel** button.
- `HelperSourcePane.svelte` — one helper's source pane: goal, status, usage vs
  budget, container anchor, the `.hole` the shell fills with the live page,
  and pane-local **Cancel**.
- Component tests assert rows/panes/cancel wiring and the empty state.

## Demo

Parent run spawns `helper-1/2/3` (Rust pool test + Node host check): three
containers, three source panes. Parent cancel → `cancel_all`: 0 live helpers,
0 live containers, panes detached + hidden.

## Trust rules

Page/model content stays data, never instruction (AGENTS_DESIGN.md §9).
No secrets in records; usage accounting stays on-device.

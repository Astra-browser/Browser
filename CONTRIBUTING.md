# Contributing to Astra (P0-T10)

## The one rule

`docs/planning/PLAN.md` is the source of truth. Read §1 (operating rules, lanes,
orchestration §1.5) before touching anything. If the plan and this file
disagree, the plan wins.

## Workflow (enforced, not suggested)

1. **Claim a task** in `docs/astra/STATE.md` first: status `doing`, your agent
   name, your `agent/<task>-<slug>` branch. Commit that row before starting.
2. **Work only on your branch**, only on your task's files. Never touch a
   row, file, or branch locked by another agent.
3. **Test before you report done**: the task's acceptance test exists, passes
   locally, and passes in CI. Brand-lint (`./tools/brand-lint.sh`) and
   `python3 tools/state-check.py` must be green.
4. **Push your branch and report** tests + diff summary. Only the orchestrator
   verifies and merges to `main`. No direct pushes to `main` by workers.

## Commit rules

- One logical change per commit; commit every change (no batching).
- Prefixes: `feat:`, `fix:`, `refactor:`, `patch:`, `test:`, `ci:`, `docs:`,
  `chore:`. Scoped forms are allowed (`fix(tabs):`).
- Upstream patches carry the header in plan §6.3 and stay ≤ footprint budget.

## Brand and license

- Never introduce the previous product name anywhere except `LICENSE`,
  `NOTICE`, `docs/astra/PROVENANCE.md`, and MPL headers. CI fails otherwise.
- Every new file carries the MPL-2.0 header. New dependencies must be
  license-clean (`cargo-about` / Bun scan) — unknown licenses block merge.

## Definitions of Ready/Done

Plan §1.4. A task is done only when: merged, tests green, STATE updated, no
new lint/brand/license violations, upstream-footprint budget still met.

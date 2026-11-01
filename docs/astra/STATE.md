# Astra task state (§1.2, §1.5) — the task-lock registry. Update + commit on every transition.

Legend: `todo` · `doing` (locked) · `blocked` · `done`. A `doing` row's Agent+Branch
lock it: no other agent may touch that task, its files, or its branch.

## Phase 0 — Discovery, inventory, scaffolding

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P0-T01 | Machine/toolchain check (Linux) | done | orchestrator | main | DEV_SETUP.md facts + ESR 153.6.0 verified in UPSTREAM.md; build-reqs check deferred to P1-T04 |
| P0-T02 | Clean repo + record base snapshot | done | orchestrator | main | Repo on `main`, 14 commits; base = `folder_context` snapshot, see `PROVENANCE.md` |
| P0-T03 | Full inventory (crates, IPC, UI, storage, skills) | done | orchestrator | main | INVENTORY.md + ipc-surface.md (267/35) + PARITY.md; subs T03a/T03b merged |
| P0-T03a | IPC surface: every command/event + payloads | done | worker-1 | agent/P0-T03a-ipc-surface | Merged 2026-11-01; 267 cmds + 35 events, zero mismatches |
| P0-T03b | PARITY.md (README claims vs code) | done | worker-1 | agent/P0-T03b-parity | Merged 2026-11-01; no new deviations beyond X-01…X-06 |
| P0-T04 | KEEP/ADAPT/DROP + `BrowserHost` trait | done | worker-1 | agent/P0-T04-porting | Merged 2026-11-01; groups mapped to Host API modules |
| P0-T05 | Rebrand tooling + `brand-lint` | done | worker-1 | agent/P0-T05-rebrand | Merged 2026-11-01; lint exits 0 clean / 1 dirty |
| P0-T06 | License/provenance | done | worker-1 | agent/P0-T06-license | Merged 2026-11-01; MPL LICENSE + NOTICE + 25/25 permissive |
| P0-T07 | Golden capture harness | todo | — | — | Blocked on UI port + rebrand completion |
| P1-T01 | `upstream.toml` + `forge fetch` (ESR 153.6.0, U-10 resolved) | done | worker-1 | agent/P1-T01-fetch | Merged 2026-11-01; sig OK via release key, engine extracted, baseline ee0912e |
| P3-T01 | UI into `ui/` Bun workspace (standalone track) | done | worker-2 | agent/P3-T01-ui | Merged 2026-11-01; typecheck 0 errs, tests 1062 pass, vite build exit 0 |
| P0-T08 | CI skeleton | done | worker-1 | agent/P0-T08-ci | Merged 2026-11-01; ci-fast (brand-lint/state-check/plan-check) green locally |
| P0-T09 | Spike briefs for U-01…U-13 | done | orchestrator | main | Index in `docs/astra/spikes/README.md`; spikes execute in Phase 1 |
| P0-T10 | Repo hygiene docs | done | worker-1 | agent/P0-T10-hygiene | Merged 2026-11-01; SECURITY/CONTRIBUTING/CODEOWNERS added |

## Phase 1 — Forge and skeleton (Linux)

All `todo` — gated on P0 exit.

## Later phases

All `todo` — see `plan.md` §§8–11.

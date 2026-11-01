# Astra task state (§1.2, §1.5) — the task-lock registry. Update + commit on every transition.

Legend: `todo` · `doing` (locked) · `blocked` · `done`. A `doing` row's Agent+Branch
lock it: no other agent may touch that task, its files, or its branch.

## Phase 0 — Discovery, inventory, scaffolding

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P0-T01 | Machine/toolchain check (Linux) | doing | orchestrator | main | Initial facts in `docs/astra/DEV_SETUP.md`; `mach` absent, Firefox build reqs unverified |
| P0-T02 | Clean repo + record base snapshot | doing | orchestrator | main | Repo initialised; base = `folder_context` snapshot (no VCS metadata), see `PROVENANCE.md` |
| P0-T03 | Full inventory (crates, IPC, UI, storage, skills) | doing | orchestrator | main | First cut in `docs/astra/INVENTORY.md`; sub-rows below |
| P0-T03a | IPC surface: every command/event + payloads | done | worker-1 | agent/P0-T03a-ipc-surface | Merged 2026-11-01; 267 cmds + 35 events, zero mismatches |
| P0-T03b | PARITY.md (README claims vs code) | done | worker-1 | agent/P0-T03b-parity | Merged 2026-11-01; no new deviations beyond X-01…X-06 |
| P0-T04 | KEEP/ADAPT/DROP + `BrowserHost` trait | done | worker-1 | agent/P0-T04-porting | Merged 2026-11-01; groups mapped to Host API modules |
| P0-T05 | Rebrand tooling + `brand-lint` | done | worker-1 | agent/P0-T05-rebrand | Merged 2026-11-01; lint exits 0 clean / 1 dirty |
| P0-T06 | License/provenance | doing | worker-1 | agent/P0-T06-license | Locked 2026-11-01; fetching MPL text + dep inventory |
| P0-T07 | Golden capture harness | todo | — | — | Blocked on UI port + rebrand completion |
| P0-T08 | CI skeleton | todo | — | — | — |
| P0-T09 | Spike briefs for U-01…U-13 | doing | orchestrator | main | Index in `docs/astra/spikes/README.md` |
| P0-T10 | Repo hygiene docs | doing | orchestrator | main | STATE (lock registry) + DECISIONS + OWNER_QUESTIONS created; orchestration rules added to plan |

## Phase 1 — Forge and skeleton (Linux)

All `todo` — gated on P0 exit.

## Later phases

All `todo` — see `plan.md` §§8–11.

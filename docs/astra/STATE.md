# Astra task state (P0-T10, §1.2) — update on every task transition

Legend: `todo` · `doing` · `blocked` · `done`

## Phase 0 — Discovery, inventory, scaffolding

| ID | Task | Status | Notes |
|---|---|---|---|
| P0-T01 | Machine/toolchain check (Linux) | doing | Initial facts in `docs/astra/DEV_SETUP.md`; `mach` absent, Firefox build reqs unverified |
| P0-T02 | Clean repo + record base snapshot | doing | Repo initialised; base = `folder_context` snapshot (no VCS metadata), see `PROVENANCE.md` |
| P0-T03 | Full inventory (crates, IPC, UI, storage, skills) | doing | First cut in `docs/astra/INVENTORY.md`; needs deep pass |
| P0-T04 | KEEP/ADAPT/DROP + `BrowserHost` trait | todo | Draft in `docs/astra/PORTING_MAP.md` |
| P0-T05 | Rebrand tooling + `brand-lint` | doing | `plan.md` cleaned of previous product name; `tools/rebrand` spec pending |
| P0-T06 | License/provenance | doing | `PROVENANCE.md` drafted; `cargo-about`/Bun license scan pending |
| P0-T07 | Golden capture harness | todo | Blocked on UI port + rebrand completion |
| P0-T08 | CI skeleton | todo | — |
| P0-T09 | Spike briefs for U-01…U-13 | doing | Index in `docs/astra/spikes/README.md` |
| P0-T10 | Repo hygiene docs | doing | This file + DECISIONS + OWNER_QUESTIONS created |

## Phase 1 — Forge and skeleton (Linux)

All `todo` — gated on P0 exit.

## Later phases

All `todo` — see `plan.md` §§8–11.

# Session handoff — Astra (written 2026-11-01, updated as work proceeds)

Read this first in a new session, then `docs/astra/STATE.md` for task locks
and `plan.md` §1.5 for the workflow rules.

## Goal

Build Astra: Gecko/Firefox-ESR-based browser + work environment, ported from
the reference snapshot at `folder_context/` (git-ignored). Platform order now
**Linux → Windows** (macOS deferred, D-25). Releases deferred until it runs.

## Where we are

**Phase 0 done** (11/12; T07 goldens blocked until UI port exists). `main`
clean, all merged via `--no-ff`, gates green (`brand-lint.sh`, `state-check.py`).

Key artifacts: `ipc-surface.md` (267 cmds ↔ 267 bindings, 0 mismatches),
`PARITY.md`, `PORTING_MAP.md` (+group→module map), `UPSTREAM.md` (ESR 153.6.0
verified), `LICENSE` (MPL), `NOTICE`, `LICENSES.md` (25/25 permissive),
`ci-fast.yml`, `tools/{brand-lint.sh,state-check.py,rebrand-SPEC.md}`,
`SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, `branding/astra.toml`
(all OWNER_DECISION placeholders), `upstream.toml` (URL/checksum TBD).

## Standing rules (owner-set, do not relax)

- `plan.md` is Astra-only: 0 occurrences of the previous product name (any
  case). Only `NOTICE` + `docs/astra/PROVENANCE.md` may name it (allow-listed).
- One task, one agent, one `agent/<task>-<slug>` branch; STATE.md is the lock
  registry; only the orchestrator merges; commit every change (§1.5, D-23/24).
- Reference source = `folder_context/` snapshot only; never the external copy.
- Owner P0-review gate waived; owner questions deferred (D-25).

## Active work (Phase 1 → UI port)

1. **P1-T01 engine fetch (worker-1, `agent/P1-T01-fetch`)**: tarball URL
   verified HTTP 200 + `.asc` sig; `forge/astra-forge` written (zero-dep Rust:
   `fetch`, `doctor`), `doctor` all green (incl. bun 1.4.4). Fetch round 1
   downloaded the tarball but GPG verify failed (no key). Round 2: imported
   `release@mozilla.com` master `14F2 6682 D091 6CDD 81E3 7B6D 61B7 B526
   D98F 0353` (created 2015-07-17, matches long-published release key; UID
   email verified by keys.openpgp.org), signing subkey `827E … 7AA3`
   (2026-08-06, expires 2028-08-05). Old ESRs (115/140) signed by previous
   subkey `5ECB…20256` — rotation, same master lineage. Rerun in background:
   verify + extract to `engine/` + git baseline.
2. **P3-T01 UI port (worker-2, `agent/P3-T01-ui`)**: `folder_context/frame`
   → `ui/app`, Bun workspace (`ui/package.json`, `bun.lock`), 214 files
   rebranded (~2900 replacements, report in `docs/astra/REBRAND-ui.md`),
   generated `bindings.ts` excluded (regenerated P2-T02). `bun install` clean
   (456 pkgs; `@hugeicons/svelte` postinstall trusted). `bun run typecheck`
   running in background; then unit tests, then `vite build` standalone.
3. **Context-length duty (owner direction)**: if this session passes ~35–40%
   context, compact and announce; SESSION.md is the carry-over.

## Open doubts / deferred

- GPG key for `.asc` verification (Mozilla release key; fetch from keyserver
  at implementation, document fingerprint).
- Firefox Linux build prerequisites for ESR 153 (`mach bootstrap` equivalents;
  verify from official docs in P1-T04, not from memory).
- `mach build faster` + artifact-build assumptions (U-02/U-03) untested.
- Bun migration of the Svelte app (snapshot uses pnpm 11 + Node ≥24).
- Owner questions deferred EXCEPT anything blocking Linux/Windows builds.

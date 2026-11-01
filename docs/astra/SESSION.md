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

1. **P1-T01 engine fetch (U-10 resolved)**: tarball URL layout confirmed live —
   `https://archive.mozilla.org/pub/firefox/releases/153.6.0esr/source/firefox-153.6.0esr.source.tar.xz`
   (HTTP 200) + `.asc` GPG signature (no SHA256SUMS file; verify via GPG).
   Next: `forge fetch` downloads + verifies + extracts to `engine/`.
2. **`forge/` skeleton**: Rust CLI (`fetch`, `import`, `overlay`, `config`,
   `build`, `test`, `package`, `export`, `bump`, `doctor`); `fetch` first.
3. **UI port (P3-T01 track)**: copy `folder_context/frame` → `ui/` (minus
   `node_modules`), Bun workspace, rebrand text, standalone mock-mode build.
   Depends on nothing from the engine for the standalone pass.

## Open doubts / deferred

- GPG key for `.asc` verification (Mozilla release key; fetch from keyserver
  at implementation, document fingerprint).
- Firefox Linux build prerequisites for ESR 153 (`mach bootstrap` equivalents;
  verify from official docs in P1-T04, not from memory).
- `mach build faster` + artifact-build assumptions (U-02/U-03) untested.
- Bun migration of the Svelte app (snapshot uses pnpm 11 + Node ≥24).
- Owner questions deferred EXCEPT anything blocking Linux/Windows builds.

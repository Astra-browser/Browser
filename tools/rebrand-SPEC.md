# tools/rebrand — spec (P0-T05)

Bulk rename for the port: applies the §3.2 table (previous product name, all
case variants, crate names `prev-*` → `astra-*`, env/prefs, profile IDs, URLs)
to file/dir names *and* contents, with `--dry-run` diff report first.

## Rules

- Operates on the *ported* trees (`crates/`, `ui/`, `overlay/`), never on
  `folder_context/` (reference snapshot stays pristine).
- Skips allow-list: `LICENSE`, `NOTICE`, `docs/astra/PROVENANCE.md`, MPL
  header/copyright lines of derived files.
- Brand assets are real as of D-38 (`branding/assets/` masters, generated
  `overlay/astra/branding/*`); the release gate still fails on any remaining
  `OWNER_DECISION` (see `branding/astra.toml` + `OWNER_QUESTIONS.md`).
- Every run ends with `tools/brand-lint.sh` green; CI enforces it (§3.4).

## Implementation (scheduled with P3-T01, when `ui/` + `crates/` exist)

Rust CLI in `forge/` (or `xtask`): walk, case-variant match, rewrite, report.
Until then, `docs/planning/PLAN.md` + all Phase 0 docs are maintained by hand under the
same rule — verified by the lint above.

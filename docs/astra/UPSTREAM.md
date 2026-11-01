# Upstream Firefox base (P0-T01 verified, §1.2)

- **Channel:** esr · **Version: 153.6.0** (released 2026-10-27)
- Verified 2026-11-01 against `https://endoflife.date/api/firefox.json`:
  cycle 153 has `lts: true`, latest `153.6.0`. Rapid train at 159.0; ESR 140
  EOL 2026-09-29 as expected. Confirms plan F-04.
- **Still UNVERIFIED (U-10, P1-T01):** source tarball URL layout, checksum,
  signature scheme for 153.6.0. `forge fetch` must resolve these from
  official Mozilla release artifacts — never guess.
- No engine source materialised yet (`engine/` absent, correctly so).
- Patch health: no patches yet (Phase 1 writes the first: ASTRA-0001…).
- Next ESR 175 planned 2027-06-29 (annual jump project, §11.2).

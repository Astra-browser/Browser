# Upstream Firefox base (P0-T01 verified, §1.2)

- **Channel:** esr · **Version: 153.6.0** (released 2026-10-27)
- Verified 2026-11-01 against `https://endoflife.date/api/firefox.json`:
  cycle 153 has `lts: true`, latest `153.6.0`. Rapid train at 159.0; ESR 140
  EOL 2026-09-29 as expected. Confirms plan F-04.
- **U-10 resolved (P1-T01):** tarball URL verified HTTP 200 + `.asc` signature
  via Mozilla release key; `engine/` extracted; baseline commit `ee0912e`.
- Next ESR 175 planned 2027-06-29 (annual jump project, §11.2).

## Patch health (Phase 1)

| Patch | Tier | Upstream files touched | Status |
|---|---|---|---|
| ASTRA-0001 `patches/ASTRA-0001-astra-dir-hook.patch` | P2 (3 added lines) | `browser/app.mozbuild` | `clean` — applied by `forge overlay`; `forge lint` green; configure passes with `/astra` in `DIRS` |

- Footprint budget: 3 upstream lines touched (budget ≤ 1,500), 1 patch (≤ 60), 0 P3. Headroom intact.
- **Full-build proof (P1-T04, 2026-11-01):** `obj-astra-linux/dist/bin/firefox`
  → `Mozilla Firefox 153.6.0esr`; `chrome/astra.manifest` registers
  `content`+`resource astra`; `hello.html` + `HostAPI.sys.mjs` packaged
  (GUI-verified); overlay chrome files land as symlinks, so
  `mach build faster` after an overlay edit is ~2 s (U-02 closed, see
  `docs/astra/BUILD_TIMES.md`).
- `engine/` workspace state (git-ignored in this repo): baseline `ee0912e` +
  `forge overlay` output (`astra/`, `browser/app.mozbuild` hook). Reproduce
  with `forge fetch && forge overlay`.
- Full-build proof of the overlay is P1-T04's gate (`./mach build`).

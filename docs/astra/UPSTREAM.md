# Upstream Firefox base (P0-T01 verified, §1.2)

- **Channel:** esr · **Version: 153.6.0** (released 2026-10-27)
- Verified 2026-11-01 against `https://endoflife.date/api/firefox.json`:
  cycle 153 has `lts: true`, latest `153.6.0`. Rapid train at 159.0; ESR 140
  EOL 2026-09-29 as expected. Confirms plan F-04.
- **U-10 resolved (P1-T01):** tarball URL verified HTTP 200 + `.asc` signature
  via Mozilla release key; `engine/` extracted; baseline commit `61e41ec4`.
- Next ESR 175 planned 2027-06-29 (annual jump project, §11.2).

## Patch health (Phase 1)

| Patch | Tier | Upstream files touched | Status |
|---|---|---|---|
| ASTRA-0001 `patches/ASTRA-0001-astra-dir-hook.patch` | P2 (3 added lines) | `browser/app.mozbuild` | `clean` — applied by `forge overlay`; `forge lint` green; configure passes with `/astra` in `DIRS` · via `forge import` 2026-11-02 |
| ASTRA-0002 `patches/ASTRA-0002-shell-mount.patch` | P2 (7 added lines) | `browser/base/content/browser.xhtml` | `clean` — `#astra-root` + `resource://` CSS/module mount; `tests/contract/p1t08-shell.py` 5/5 PASS; "Hello Tab" GUI-verified, no Firefox chrome · via `forge import` 2026-11-02 |

- **Branding active (P1-T03, 2026-11-01):** `out/mozconfig.linux` renders
  `--with-branding=astra/branding`; `brandShortName=Astra Nightly` in the
  packaged build, placeholder art + `astra.desktop` staged, window title
  GUI-verified. Dev defaults stand in for all `OWNER_DECISION` values
  (see `docs/astra/RELEASE_CHECKLIST.md`).
- Footprint budget: 688 upstream lines touched (budget ≤ 1,500), 5 patches (≤ 60), 0 P3.
- **Full-build proof (P1-T04, 2026-11-01):** `obj-astra-linux/dist/bin/firefox`
  → `Mozilla Firefox 153.6.0esr`; `chrome/astra.manifest` registers
  `content`+`resource astra`; `hello.html` + `HostAPI.sys.mjs` packaged
  (GUI-verified); overlay chrome files land as symlinks, so
  `mach build faster` after an overlay edit is ~2 s (U-02 closed, see
  `docs/astra/BUILD_TIMES.md`).
- `engine/` workspace state (git-ignored in this repo): branch `astra/esr153`
  on top of baseline `61e41ec4` (`forge fetch` tarball, GPG-verified):
  `6977cf4` hooks (ASTRA-0001..0005) + `5fbb7b9` overlay tree + `fcdb2ae`
  vendor refresh. Reproduce with `forge fetch && forge overlay && forge import`.
- Upstream sync: `engine/` has a read-only `mozilla` remote
  (`https://github.com/mozilla-firefox/firefox.git`, the official mirror;
  push disabled). Pinned tag `FIREFOX_153_6_0esr_RELEASE`, branch `esr153`.
  Inspect drift with `git -C engine fetch mozilla <tag> --depth 1` then
  `git diff FETCH_HEAD -- <file>`. NOTE: our baseline is tarball-based, so
  histories are unrelated — never `pull`/`merge mozilla`; updating the base
  means a new `forge fetch` tarball + `forge import` (3-way) + fresh
  `mach vendor rust`, then refresh the stack above.
- Full-build proof of the overlay is P1-T04's gate (`./mach build`).

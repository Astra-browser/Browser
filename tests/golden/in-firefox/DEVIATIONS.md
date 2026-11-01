# In-Firefox golden deviations (P3-T11, 2026-11-02)

`capture_firefox.py` + `compare.py` run green-or-documented: 13/16 desktop
screens PASS the ≤1.5% gate, 3 screens FAIL marginally, 2 narrow screens
SKIP (environment floor). Raw table from `compare.json`:

| screen | status | diff% (tol 16) | half% | strict% | max Δ |
| --- | --- | --- | --- | --- | --- |
| launcher-dark | PASS | 0.125 | 0.112 | 0.319 | 213 |
| launcher-light | PASS | 0.118 | 0.104 | 0.314 | 202 |
| newtab-dark | PASS | 0.734 | 0.227 | 56.444 | 228 |
| newtab-light | PASS | 0.136 | 0.083 | 53.921 | 213 |
| notes-dark | PASS | 0.362 | 0.406 | 1.188 | 218 |
| notes-light | PASS | 0.344 | 0.389 | 1.046 | 221 |
| settings-dark | FAIL | 3.229 | 3.549 | 4.985 | 230 |
| settings-light | FAIL | 2.484 | 2.783 | 5.937 | 227 |
| shell-dark | FAIL | 1.872 | 0.957 | 68.698 | 229 |
| shell-dark-narrow | SKIP | — | — | — | 500px window floor |
| shell-light | PASS | 0.42 | 0.396 | 62.75 | 196 |
| shell-light-narrow | SKIP | — | — | — | 500px window floor |
| spaces-dark | PASS | 0.136 | 0.126 | 0.887 | 210 |
| spaces-light | PASS | 0.138 | 0.128 | 1.031 | 197 |
| tasks-dark | PASS | 0.234 | 0.25 | 0.791 | 218 |
| tasks-light | PASS | 0.226 | 0.25 | 0.689 | 213 |
| time-dark | PASS | 0.89 | 1.037 | 2.784 | 218 |
| time-light | PASS | 0.861 | 1.002 | 2.306 | 226 |

Pinned run: `captures.json` (binary, clock `2026-09-28T14:32:00Z`, TZ=UTC,
`en-US`, `devPixelsPerPx=1.0`, settle 1.2s, `MOZ_ACCELERATED=0`).

## D-01 — shell-dark 1.872% (over gate by 0.37pp): text rasterization

Heatmap: the entire sidebar column differs ≤64/channel (tol64: 0.18%);
solid surfaces match within 1 channel (sidebar bg `(19,21,29)` vs
`(20,21,30)`). Half-res diff drops to 0.957% (under gate) — the residual is
glyph-edge antialiasing across sidebar/tabs text. `MANIFEST.md` "Rerun
variance" documents this exact phenomenon (shell text rasterization varies
run to run even Chromium-vs-Chromium, up to ~13% raw). Cross-engine
(Gecko-vs-Blink) 1.87%-over-tol is consistent with it. No layout, palette,
or content deviation.

## D-02 — settings-light 2.484% / settings-dark 3.229%: glyph + inline-layout deltas

Both themes fail nearly identically, which points at engine text handling,
not theming: heatmaps show diffs only in text columns (labels/values,
headings); solid surfaces match. Unlike D-01 the diff persists at half-res
(2.8%/3.5%), i.e. whole-stem (>64) differences: Gecko and Blink hint DejaVu
differently (stem on/off, advances shifting inline elements by a few px —
e.g. a radio at (560–840, 640–760) sits a few px apart). Settings is the
text-densest page, so the same per-glyph delta accumulates past the gate
here and nowhere else. No missing/wrong content; no control-state
difference (toggles/segments agree).

## D-03 — narrow viewports SKIP: 500px headless window floor

`window/rect` 390×844 reads back 500×844 (probed 390/450/500: all clamp to
500). The slot can never reach 390 wide in this environment, so the two
narrow captures are recorded in `captures.json` as skipped and reported as
SKIP by `compare.py` (never silently dropped). Options for the owning lane:
run headed/Xvfb where the floor may not apply, or accept desktop-only
in-Firefox coverage (the narrow matrix still runs standalone in CI via
`capture.ts`).

## Harness observations for owning lanes (not deviations — no product change)

- **Host API**: `Content.navigate` updates the Tabs model (`tab-1` + URL
  echoed) but the mounted slot browser stays `about:blank` even after 11s in
  headless. The harness loads the slot browser directly with the system
  principal instead; everything below that (docshell, layout, paint) is the
  product's. If model→slot propagation is expected to work headless, that is
  a host-lane bug with a ready repro (see `capture_firefox.py` docstring).
- **Screenshot**: stock WebDriver `/screenshot` 500s on this host/build
  ("Unable to capture screenshot", empty message); `--screenshot` CLI also
  fails (`RenderCompositorSWGL failed mapping default framebuffer`) unless
  `MOZ_ACCELERATED=0`, which the harness sets. Capture goes through
  chrome-scope `drawSnapshot` on the slot browser instead.
- **Color scheme**: the golden UI reads `prefers-color-scheme` (theme-init
  fallback, bootstrap paint, native control tones). Playwright emulates it
  per capture (`colorScheme`); the harness sets `ui.systemUsesDarkTheme`
  per entry to match. Without it, dark screens render light.
- **Chrome geometry**: `hbox#browser` (hidden tabbox container) still
  occupies flex height (347px at 960 winH); the harness hides it and
  `details.astra-about` via live test-only styles so the slot fills the
  window. No repo files touched.

## PARITY.md proposal (orchestrator-owned — do not edit PARITY.md here)

Suggested entries for `docs/astra/PARITY.md`:

- P3-T11/D-01: "In-Firefox shell-dark exceeds the 1.5% pixel gate at 1.87%
  (tol 16); half-res 0.96%. Root cause: cross-engine text antialiasing on
  sidebar/tabs text (MANIFEST rerun-variance class). Proposal: accept, and
  track text-region down-weighting per MASKS.md as the follow-up that brings
  shell/settings under gate without weakening the non-text gate."
- P3-T11/D-02: "settings-light/dark 2.5%/3.2%: Gecko-vs-Blink glyph
  hinting + inline-position deltas on the text-densest page; persists at
  half-res, confined to text columns. Proposal: accept with D-01's
  follow-up; no product change."
- P3-T11/D-03: "390px narrow in-Firefox captures skipped: 500px headless
  window floor. Proposal: accept desktop-only in-Firefox coverage; narrow
  stays standalone-Chromium in CI."

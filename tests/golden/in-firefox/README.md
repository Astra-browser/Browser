# In-Firefox goldens (P3-T11)

Captures of the P0-T07 golden matrix rendered by the **real Astra build**
(Gecko) instead of standalone Chromium. Same screens, themes, viewports,
pinned clock, and fixtures as `tests/golden/MANIFEST.md`; diffed against
`tests/golden/baseline/` by `tools/golden-capture/compare.py` per
`tools/golden-capture/MASKS.md` (gate ≤ 1.5% differing pixels per screen,
channel tolerance 16 for text antialiasing).

## How to re-run

```sh
# needs the built engine (ASTRA_MAIN default: /home/rem/Projects/Astra)
# and bun (golden UI bundle build, output is git-ignored dist/)
python3 tools/golden-capture/capture_firefox.py   # → tests/golden/in-firefox/*.png
python3 tools/golden-capture/compare.py            # → compare.json + per-screen table
```

Pinned environment is recorded in `captures.json` (binary paths, clock,
timezone, locale, settle). See `DEVIATIONS.md` for every screen over gate
plus the harness observations for the owning lanes (incl. the PARITY.md
proposal — orchestrator-owned, not edited here).

## Why the harness looks the way it does

- The stock WebDriver `/screenshot` endpoint 500s on this host/build and even
  `--screenshot` CLI fails on the SWGL compositor (GPU probing), so capture
  goes through chrome-scope `drawSnapshot` on Astra's content browser —
  same Gecko pipeline stage, verified pixel-bearing in isolation.
- The tabbrowser is `display:none` (product chrome policy), so captures use
  Astra's real content slot; urlbar/about chrome and the hidden hbox#browser
  (which still eats flex height) are cropped/hidden by construction via
  live test-only styles.
- Slot navigation goes straight to the slot browser: Host-API
  `Content.navigate` updates the Tabs model but the slot stays `about:blank`
  in headless (see DEVIATIONS.md). Render path below that is the product's.

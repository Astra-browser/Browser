# golden-capture (P0-T07)

Runs the rebranded Svelte UI standalone in a normal browser with mocked IPC
and captures reference screenshots per screen/state/theme/viewport into
`tests/golden/baseline/`.

## Why Playwright + headless Chromium

`firefox --headless --screenshot` was considered (simpler, no download) but
cannot wait for async settle (lazy Svelte chunks, `document.fonts.ready`,
debounced search), pin the clock/locale/timezone per capture, or force
`prefers-reduced-motion`. Playwright gives all four, and it is already a UI
devDependency, so no new browser stack: same engine family as the vitest
browser Look tests. One-time setup downloads the pinned Chromium build.

## Layout

- `manifest.ts` — screen × theme × viewport matrix (source of truth).
- `capture.ts` — Bun runner: builds `ui/app` golden bundle if missing,
  serves `dist/`, walks the matrix, writes PNGs + `.last-run.json`.
- `MASKS.md` — per-region mask doc for future diffing (§9.2).
- `dist/` — golden build output (git-ignored).

The mocked bridge lives in `ui/app/golden/` (vite aliases
`@tauri-apps/api/*` to deterministic fixtures; no native host).

## Usage

```sh
# one-time: install deps + browser
cd tools/golden-capture
bun install
bunx playwright install chromium

# capture (builds golden bundle if dist/ is missing)
bun ./capture.ts
# or: bun run capture

# output
ls ../../tests/golden/baseline/
```

`tests/golden/MANIFEST.md` is rewritten by hand from `.last-run.json`
plus the environment notes below — the runner prints everything needed.

## Environment notes for MANIFEST.md

Record after each run: `bun --version`, Chromium version (printed by the
runner), `fc-list | wc -l` + `fc-list : family | sort -u` (fonts pinned by
name), OS. The clock is pinned in-page (see `PINNED_ISO`); host clock and
timezone do not leak into captures (`timezoneId: UTC`, `locale: en-US`).

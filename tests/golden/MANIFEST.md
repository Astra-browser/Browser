# Golden baselines (P0-T07)

Reference screenshots of the rebranded Svelte UI running standalone in a
normal browser with mocked IPC. Produced by `tools/golden-capture/capture.ts`
(Chromium headless). The in-Firefox captures (P3-T11) diff against these;
see `tools/golden-capture/MASKS.md` for the per-region mask policy
(threshold ≤ 1.5% per screen).

## How to re-run

```sh
cd tools/golden-capture
bun install
bunx playwright install chromium
bun ./capture.ts
```

The runner builds the golden bundle (`ui/app/vite.golden.config.ts`,
`@tauri-apps/api/*` aliased to deterministic mocks) if `dist/` is missing,
serves it, and walks `manifest.ts`. Exit non-zero on any missing ready flag,
page error, or `[golden] unmocked` console error.

## Screens covered (18 captures)

| Screen                                   | Themes      | Viewports         | Notes                                                                     |
| ---------------------------------------- | ----------- | ----------------- | ------------------------------------------------------------------------- |
| shell (sidebar + tabs + new-tab pane)    | light, dark | 1440×900, 390×844 | Active tab is a fresh new tab so the pane shows sky + clock + task counts |
| spaces (sidebar + switcher open)         | light, dark | 1440×900          | 3 spaces (Personal/Studio/Reading), switcher open on Personal             |
| newtab (sidebar stand-in + new-tab pane) | light, dark | 1440×900          | Sky, clock, search, day's tasks                                           |
| launcher (field + 2 results)             | light, dark | 1440×900          | Query `read`; native glass replaced by the `none`-material card           |
| tasks (today page)                       | light, dark | 1440×900          | 2 seeded tasks, scope `today`                                             |
| notes (page)                             | light, dark | 1440×900          | 3 seeded notes, one pinned                                                |
| time (page)                              | light, dark | 1440×900          | Fixed working-day series, 4 sites                                         |
| settings                                 | light, dark | 1440×900          | Default section                                                           |

## Pinned environment (this run, 2026-11-02)

- Chromium headless shell **156.0.8078.4** (Playwright 1.64.1, `chromium_headless_shell-1248`)
- Viewport 1440×900 (desktop) / 390×844 (narrow), deviceScaleFactor 1
- Clock pinned in-page to **2026-09-28T14:32:00Z** (Monday; `Date` overridden
  before page scripts run), timezone `UTC`, locale `en-US`
- `prefers-reduced-motion: reduce`, screenshot `animations: disabled`, caret hidden
- `document.fonts.ready` awaited; no webfonts — system stack
  (Inter, Adwaita Sans, DejaVu; full list: `fc-list : family` on the capture host)
- Runner: Bun 1.4.4

## Deterministic data

- Fixture sites only (`*.example`: Atlas, Beacon, Chorus, Compass, Ledger,
  Northwind, Harbor); no real-world branding — captures stay free of
  third-party marks and rebrand leakage is checkable by `tools/brand-lint.sh`.
- Clock-derived content fixed: new-tab clock `2:32 PM`, `Monday, September 28`;
  tasks due `2026-09-28` / `2026-10-01`; notes modified offsets from the pinned now.
- Favicon rasters are fixed 32px canvas bytes (same input → same bytes).
- IDs/revisions from a monotonic counter; task/note servers are in-memory with
  fixed seeds; `Math.random` is not consumed on any captured path.

## Verification

After capture, each screen was reloaded and asserted: ready flag set, zero
page/console errors, and key content strings present (e.g. task titles, note
titles, `harbor.example`, `2:32 PM`, `Monday, September 28`). 16/16 desktop
captures green (narrow viewports share the shell setup).

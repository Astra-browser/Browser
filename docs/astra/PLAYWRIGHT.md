# Playwright sync (standalone UI lane)

P3-T18. Playwright drives the frame's **standalone** static pages (Vite dev /
preview) with system Chromium. It never launches the native app binary or the
engine.

## Versions / environment (verified 2026-11-02)

- `bunx playwright --version` → **1.64.1** (`playwright ^1.63.0` devDep of
  `ui/app`).
- Chromium present, no download needed (offline-friendly):
  `/home/rem/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`
  (`bunx playwright install --dry-run` reports `chromium v1248` installed
  there).
- Playwright MCP (`~/.config/opencode/opencode.json`) uses the same binary via
  `--executable-path …/chromium-1248/chrome-linux64/chrome --headless
  --isolated`.

## Config / commands

- Config: `ui/app/playwright.config.ts` (testDir `tests/playwright`, output
  `out/playwright-smoke/`, baseURL `http://127.0.0.1:1420`, headless Chromium,
  one smoke spec; `webServer` reuses/starts `bun run dev`).
- BaseURL note: the dev port is **1420** from `ui/app/vite.frame.ts`
  (`server.port`); `vite.config.ts` defines no preview port, so 1420 is used.
- Run from `ui/app/`: `bunx playwright test --list`, `bunx playwright test`.
  Last verified 2026-11-03: `--list` → 1 test; `test` → **1 passed (3.0s**,
  21.2s cold with Vite start). The `trusted browser initialization failed`
  console message from `entries/browser.ts` is expected in standalone Chromium
  (no Tauri host) and is excluded from the BridgeError assertion by design.
- Specs import the runner via the relative path
  `../../ui/app/node_modules/playwright/test.mjs` because repo root has no
  `package.json`, so bare `playwright/test` does not resolve from `tests/`.
  (Do not add `@playwright/test` to `ui/app/package.json` without owner
  review — it is read-only for this lane.)
- Specs live in `tests/playwright/*.spec.ts` — deliberately separate from the
  browser-component convention (`.component.test.ts` under `ui/app/src`,
  Vitest) per `ui/app/AGENTS.md`.

## Lanes

- **Standalone (this doc / Playwright):** static frame pages over Vite,
  Chromium only.
- **In-Firefox (not Playwright):** stays with marionette/geckodriver per plan
  §5.3 — that lane may identify the native executable before interacting
  (AGENTS.md) and belongs to worker-B. Do not mix the two.

## Frontend-rule notes (`ui/app/AGENTS.md`)

- `docs/frontend.md` from the repo root **does not exist** (verified missing
  2026-11-02); the AGENTS.md pointer to it is currently unresolvable.
- Shared `src/shared/testing` mocks concept applies to component tests; these
  e2e specs use no production entry-graph imports (no tests/fixtures leak).
- CSP/sentinels preserved (no app source touched); `bundle-budgets.json`
  untouched (no limits raised). Full-CI failures are reported separately, not
  bypassed.

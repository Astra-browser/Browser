# History mirror into Places (P2-T07, resolves U-06)

Core owns history (astra-store `history` table: `url`, `title`,
`visit_time`). The engine owns `:visited` link styling, which is driven
solely by its Places store. This module mirrors core visits into Places so
visited links render visited.

## API (protocol: `overlay/astra/host/schemas/history.json`)

`overlay/astra/host/History.sys.mjs` — `History.visit({ request_id, url,
title, visit_time })`, `History.clear({ request_id })`,
`History.isVisited({ request_id, url })` (read helper for tests/UI; emits
no events). Every call echoes `request_id` and carries
`host_api_version: 1`; failures return `{ error: { code, message } }` with
`invalid_url` / `mirror_failed`. Successful visits/clears emit
`history.visited` / `history.cleared` through the injectable event sink.

- `visit_time` is ms since epoch (core `visit_time`) or a `Date`; omitted
  means now. Title updates on revisit; revisits append a visit row.
- Mirror policy M-1: only http(s) URLs are mirrored. Places cannot store
  chrome:/about:/resource:/data: schemes (`CanAddURI`/`CanStore` in
  `engine/toolkit/components/places/nsNavHistory.cpp`,
  `History.cpp`); those visits are acknowledged with
  `{ mirrored: false, reason }`, never failed.
- D-15 (no telemetry): the module touches Places history only. It reads
  and writes no prefs, enables no telemetry, performs no network I/O.

## Verified engine API (pinned ESR source, read-only)

`engine/toolkit/components/places/History.sys.mjs`:

- `History.insert({ url, title?, visits: [{ date?, transition? }] })` —
  `transition` defaults to `TRANSITION_LINK`; throws for non-storable
  protocols (hence M-1).
- `History.fetch(url)` → `PageInfo | null`; `History.clear()` removes all
  visits.

Styling chain (why the mirror suffices for `:visited`): each link registers
via `dom/base/Link.cpp` → `IHistory::RegisterVisitedCallback` → parent
`VisitedQuery` (`SELECT url, last_visit_date NOTNULL FROM moz_places ...`,
`engine/toolkit/components/places/History.cpp`) → `VISITED` state → the
`:visited` selector paints. The callback entry point is
`mozIAsyncHistory.isURIVisited` on `@mozilla.org/browser/history;1`
(`engine/toolkit/components/places/mozIAsyncHistory.idl`,
`components.conf`), which runs that exact query.

## Lane isolation

The module has **zero static imports**: importable by Node path in contract
tests and in chrome via `resource://astra/host/History.sys.mjs` (or a
test-only resource substitution). The Events pump is reached through the
injectable `__setHistoryEventSink` (HostAPI wiring connects it; default is
a no-op), and the backend through `__setHistoryBackend` (live Places is
auto-selected in chrome; Node defaults to an in-memory backend).

Not done here (owned by P2-T06 lane / orchestrator merge): `jar.mn`
registration lines, `HostAPI.sys.mjs` re-export, and the sidecar→host call
path that feeds core visits into `History.visit`.

## Verification

- `node tests/contract/history_mirror.mjs` — 27 stub checks: envelope,
  M-1 skips, title/visit_time mapping, `isVisited` transitions, schema
  shape, and visited/unvisited styling on a local fixture page modelled at
  stub level (mirror state → :visited purple / :link blue). PASS.
- `python3 tests/contract/history_mirror.py` — 10 live checks against the
  built binary (SKIP when binary/geckodriver absent): live Places insert +
  fetch, `isURIVisited` true for the mirror-inserted URL **and** for a
  real-load URL (parity), false for the untouched URL; after `clear`, all
  false and the store empty. PASS.
- Content JS can never observe `:visited` (`querySelector`/`matches`/
  `getComputedStyle` lie by design — bug 147777,
  `engine/layout/style/test/test_visited_lying.html`; confirmed: even a
  real load reports `matches(':visited') === false`), and this environment
  cannot capture pixels (`RenderCompositorSWGL failed mapping default
  framebuffer` headless, for both WebDriver and `--screenshot`). So the
  live test asserts the styling engine's own query rather than paint; on a
  headed machine, load the emitted `index.html` fixture to eyeball purple
  vs blue.

# Eval port plan (P6-T10)

Local deterministic port of the upstream `eval/agentic-browsing` harness
(see `docs/astra/INVENTORY.md` §Data & skills) into `tests/eval/`.
Upstream runs against named devices, live providers, and OS-native seams
(most manifests sit at `pending_named_device_capture`); this port covers
the deterministic half that can run hermetically on loopback with
stdlib-only Python 3 — no pip deps, no browser, no build.

## Upstream shape → ported suites

| Upstream manifest | Status here |
|---|---|
| `browse-baseline-v1.json` (cold start, idle tab, 10-tab, concurrent nav + media; wall/CPU/RSS on named devices) | Ported as `browse-baseline`: pinned fixture pages load with exact title + marker + minimum link set over loopback; per-page wall-latency budget is the regression tripwire. Device wall/CPU/RSS stays `pending_named_device_capture`. |
| `capabilities-v1.json` (macOS isolated-world runtime, AppKit routing, AX press, focused input, Windows WebView2 modes) | One subset ported as `dom-read`: deterministic DOM locate (form controls by id) + read/extract (article heading, paragraph count) against static fixtures. Native seams (isolated worlds, AX, OS input, WebView2) stay named-device work. |
| `native-input-matrix-v1.json` (paid-provider Wikipedia fill slice) | Not ported: needs explicit authorization + paid provider. Never runs in CI. |
| `semantic-runtime-*.json/js` (macOS hidden fixed-DOM qualifier) | Not ported: needs an authorized macOS device. |

## Layout

- `tests/eval/run.py` — stdlib runner (conventions borrowed from
  `tools/contract-runner/run.py`): fixture server on 127.0.0.1 with an
  ephemeral port, JSON + Markdown artifacts, exit `0` PASS / `1` FAIL /
  `2` SKIP (fixtures or baselines absent).
- `tests/eval/baselines.json` — recorded baselines: pinned title, marker
  id/text, and minimum counts per page, plus the budget defaults. Fixture
  edits must update this file in the same commit.
- `tests/fixtures/eval-*.html` — static fixture sites with the same marker
  protocol style as `tests/fixtures/astra-smoke.html` (`#astra-eval-ok`
  contains exactly the recorded marker text).
- `out/eval-<UTC>/` (gitignored) — per-run `results.json`, `summary.md`,
  `console.log`.

## Suites and scoring

- `browse-baseline` — 5 checks per pinned page (HTTP 200, title, marker,
  minimum links, latency within budget). `--smoke` runs the first page only.
- `dom-read` — form-locate (controls + form element by id) and read-extract
  (article heading, paragraph count) checks.
- Score is `passed/total` across the selected suites, recorded in
  `results.json` (`score`) and `summary.md`. Overall status is PASS iff
  every check passes — no partial-credit promotion. `--suite NAME`
  (`browse-baseline` | `dom-read`) runs one suite; `--list-suites` lists them.

## Budget caps (enforced in `run.py`, effective values in `results.json`)

| Cap | Default (from `baselines.json`) | Env override |
|---|---|---|
| Per-site (per-fetch) timeout | `10` s | `ASTRA_EVAL_SITE_TIMEOUT_S` |
| Max pages fetched per run | `16` | `ASTRA_EVAL_MAX_PAGES` |
| Max bytes read per page | `262144` | `ASTRA_EVAL_MAX_BYTES` |
| Per-page wall-latency budget | `2000` ms | `ASTRA_EVAL_LATENCY_BUDGET_MS` |

Fetching beyond `max_pages`, or a page beyond `max_bytes`, raises
`BudgetExceeded` and fails the run — caps are load-bearing, not advisory.

## Nightly

The full run (`python3 tests/eval/run.py`) is hermetic and takes seconds,
so it is safe for the fast CI lane today. The nightly job (when wired)
runs the same command and archives `out/eval-*/` for trend comparison;
named-device, provider, and native-seam suites above stay manual with
explicit authorization and are never part of CI. Promotion of any
`pending_named_device_capture` claim remains a code-and-evidence review,
as upstream.

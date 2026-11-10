# Astra performance baselines (P4-T10)

> Status: initial baselines, 2026-11-02. Stock-ESR column is TODO (see §5).
> Budgets: plan §9.3 placeholders — cold start ≤ stock +15%, 50-tab sleeping
> RAM ≤ stock. Blocker budget gates on the P4-T02 network hook (§6).
>
> Environment note: the engine tree used as the read-only binary reference
> was deleted from the main checkout by outside-lane activity mid-task; a
> `forge fetch` + rebuild is in flight. The Astra numbers below are a
> completed 3-run `run_all.py` (exit 0) from before the loss, binary
> `Mozilla Firefox 153.6.0esr`. A confirmation re-run on the rebuilt tree is
> pending (orchestrator will announce); method and commands are unchanged.

## 1. What was measured (Astra, this machine)

Machine: 16 threads · 31 GiB RAM · NVMe. Headless, local fixtures only, no
network. 3 runs, median reported. Full method per bench: `tools/perf/*.py`
docstrings. Raw JSON + markdown summary: `out/perf-P4T10-20261102/`
(git-ignored; `results.json` holds per-run arrays).

| Metric | Astra median | Runs | Stock ESR 153 | Budget | Verdict |
|---|---|---|---|---|---|
| Startup cold (fresh profile → Marionette listen) | 0.301 s | 0.353/0.301/0.301 | TODO | ≤ stock +15% | UNBASELINED |
| Startup warm (reused profile → Marionette listen) | 0.302 s | 0.302/0.302/0.301 | TODO | informational | — |
| RAM 1-tab baseline (summed VmRSS) | 411 MiB | — | TODO | informational | — |
| RAM 10 tabs loaded | 658 MiB | 736/646/658 | TODO | informational | — |
| RAM 50 tabs loaded | 637 MiB | 650/627/637 | TODO | informational | — |
| RAM 50 tabs sleeping (discarded) | 642 MiB | — | TODO (budget ref) | ≤ stock | UNBASELINED |
| Tab-switch median / p95 | 6.77 / 13.99 ms | 3 runs pooled | TODO | TBD (§6) | UNBASELINED |
| Scroll-step median / p95 (20-step sweep) | 16.0 / 17.0 ms | 3 runs pooled | TODO | TBD (§6) | UNBASELINED |
| Blocker `check()` p50 / p95 / p99 (in-process, 131724 rules) | 2307 / 2918 / 4094 ns | p95 runs 2918/2876/2974 | n/a (Astra-only) | set in P4-T02 | RECORDED |

Notes on the numbers (read before comparing):

- Startup is a spawn→Marionette-listen proxy, not first-paint (headless has
  no compositor). Cold ≈ warm here (0.30 s both) because "cold" means fresh
  profile, not cleared page cache — page-cache-cold timing is nightly
  territory. The proxy is identical for Astra vs stock, which is what the
  +15% budget compares.
- 50-tab loaded (637 MiB) < 10-tab loaded (658 MiB): each count ran in a
  fresh session; same-origin loopback tabs share content processes, so the
  marginal tab cost is small and GC timing dominates the delta. Per-run
  arrays are in `results.json`. The 50-tab per-tab figure from that code
  revision used the wrong session baseline and is intentionally omitted —
  totals are the measured facts; the tool now records per-session baselines
  (`session_baseline_kb`) for the confirmation re-run.
- Sleeping ≈ loaded (642 vs 637 MiB): `discardBrowser` unloads documents but
  shared content processes persist for same-origin fixtures — expected, and
  exactly why the budget compares against stock on the same fixtures.
- Scroll rAF counter read [1,1,1]: headless SWGL produces ~no vsync frames.
  The scroll-step number is main-thread layout cost per sweep step, a
  relative jank proxy, never an absolute VSync claim.
- Blocker second dataset (box under full engine-build load, same probe):
  p50 4460 / p95 6472 / p99 8651 ns, seed load 185.5 ms — shows contention
  sensitivity; the idle-box row above is the baseline. Browser-level
  blocking latency needs the P4-T02 hook (§6).

Reproduce: `python3 tools/perf/run_all.py --runs 3` (stdlib only; needs the
built binary + geckodriver, or `ASTRA_BINARY`/`ASTRA_GECKODRIVER` overrides;
exit 1 only on FAIL, SKIP when the toolchain is absent).

## 2. Method (scripted, reproducible)

- `tools/perf/bench_startup.py` — spawn headless `--marionette` with a
  `marionette.port` user.js pref (there is no `--marionette-port` CLI flag);
  time spawn → TCP-listen. Cold = fresh profile per run; warm = one prepared
  profile reused. Proxy for startup, not first-paint (headless has no
  compositor). First-paint via MozAfterPaint lands with the BiDi harness.
- `tools/perf/bench_memory.py` — geckodriver session per count (1/10/50),
  distinct `article.html?i=K` URLs per tab, settle, sum VmRSS over the
  profile's process group via /proc. Sleeping = `gBrowser.discardBrowser(tab)`
  on all background tabs (takes a **tab**, not a browser — verified against
  the ESR 153 tree), re-measure. Chrome context needs
  `-remote-allow-system-access`.
- `tools/perf/bench_scroll_switch.py` — 10 tabs, 20 round-robin switch +
  title reads (median/p95). Scroll: timer-driven 20-step full-page sweep of
  `tall.html` with forced reflow per step (real main-thread layout cost) plus
  a parallel rAF counter. Headless SWGL fires ~0 rAF callbacks (no vsync
  source) — recorded, not hidden: frame numbers are a relative proxy for
  jank, comparable only across same-machine runs, never absolute VSync claims.
- `tools/perf/bench_blocker.py` — builds `blocker-probe/` (Rust bin linking
  `crates/astra-blocker` by path; no crate changes) and runs it 3×: seed load
  + 30k in-process `Blocker::check()` calls over a deterministic 4k-URL
  corpus, mean/p50/p95/p99. Browser-level blocking latency is measured by
  `tools/marionette-probe/blocker-probe.py` (correctness) and belongs to the
  future `bench_blocker_hook.py` (§6).
- `tools/perf/run_all.py` — runs all four, writes `results.json` +
  `SUMMARY.md` into `out/perf-<UTC>`, exit 1 only on FAIL (SKIP = no
  browser/toolchain, recorded not faked).
- Fixtures: `tools/perf/fixtures/` (`blank.html`, `article.html`,
  `tall.html`) — no live web, per plan §9.4.

## 3. Budgets (plan §9.3, locked)

- Cold start ≤ stock ESR +15%.
- 50-tab sleeping RAM ≤ stock ESR.
- Blocker p95 overhead: budget set when the P4-T02 network hook lands
  (in-process `check()` cost is the floor; hook + IPC is the ceiling).
- Scroll/tab-switch: no plan budget yet — proposed in §6, owner to confirm.

## 4. CI-nightly wiring (for orchestrator / CI lane — notes, not implemented)

- New workflow `nightly-perf` (cron): checkout + `forge fetch/import/overlay`
  + release build (self-hosted/large runner, sccache), then
  `python3 tools/perf/run_all.py --runs 3 --out out/perf-$DATE`.
- Pending first: confirmation re-run of the §1 table on the rebuilt tree
  (announced by orchestrator after `forge fetch` + build); then the stock-ESR
  job below fills the TODO column and locks the budgets.
- Publish `SUMMARY.md` as the job summary; archive `results.json` as an
  artifact (retention ≥ 90 days for trend lines).
- Gate: FAIL the job if any bench FAILs; compare medians against the table
  in §1 with the budgets in §3; post a PR comment on >10% regression vs the
  rolling 7-night median. Stock-ESR job runs the same suite with
  `ASTRA_BINARY=<stock esr>` weekly (see §5) and fills the TODO column.
- No live web in PR CI (§9.4): perf runs nightly only, never per-PR.

## 5. Stock ESR baseline — TODO (owner / CI fills in)

Deliberately NOT measured in this task: pulling a ~large stock Firefox ESR
153 binary was avoided (no big downloads without asking). Reproduction steps:

1. On the same machine that produced §1 (else numbers are incomparable):
   download stock Firefox ESR 153 from the official Mozilla release channel
   (verify checksum/signature per the same scheme as `upstream.toml`;
   record exact version + URL + sha256 in this section).
2. `ASTRA_BINARY=/path/to/stock/firefox ASTRA_GECKODRIVER=/path/to/geckodriver
   python3 tools/perf/run_all.py --runs 3 --out out/perf-stock-<date>`
   (stock geckodriver from Mozilla's official geckodriver releases, matching
   ESR 153; the in-tree geckodriver also works but record which was used).
3. Copy the medians into the §1 table, compute budget verdicts, commit.
4. Base-snapshot column (original product): not applicable — no Linux build
   exists (plan X-05); the stock-ESR column is the comparison baseline.

## 6. Follow-ups (not this task)

- The in-tree hook is live (D-42). Add `bench_blocker_hook.py` reusing the
  fixture server + WebDriver: time navigation with the hook on vs off, set the
  p95 overhead budget (proposal: ≤ 2 ms p95 per request on desktop).
- First-paint: MozAfterPaint probe via BiDi (P6 E2E harness) for a
  content-visible startup number to complement the Marionette-listen proxy.
- Scroll/tab-switch budgets: propose after 7-night trend exists
  (candidate: tab-switch p95 ≤ 100 ms; scroll-step p95 ≤ 32 ms headless
  proxy). Owner confirms before they gate.
- `$generichide` cosmetic path and `serialize()`/snapshot reload cost are
  measured at unit level in `crates/astra-blocker`; not repeated here.

## 7. Stress matrix — UI + wiring phase (2026-11-03)

`tools/perf/stress/` is a loopback-only stress harness that samples CPU, PSS,
DRM GPU engine time, GPU memory, iGPU rc6 and dGPU telemetry together while
the real headed build runs. It covers one tab, New Tab, 8 static tabs, 2/6
1080p videos, 1/4 WebGL tabs, a mixed 8-tab run, 6 memory-heavy tabs and a
real-click UI tour, against both the Astra dev build and the installed stock
Firefox 159.

Results: `docs/performance/STRESS_REPORT.md` (consolidated) and
`docs/performance/OBSERVATIONS.md` (one block per
run); raw samples in `out/stress-final/`. Headline: **settled idle is fine and
memory is +~75 MiB**, but a fast page load leaves the tab in `loading: true`
for 15 s (`Content.watch()` waits for a poll to see `isLoadingDocument=true`),
so the shell skeleton/spinner and favicon orbit burn ~0.4–0.5 core and ~12–15%
GPU after the page is already painted. A focused 3D rerun also showed no 60 Hz
cap: Astra held ~144 rAF/s at ~58% GPU vs stock ~139 at ~43%. Background
docshells stay active, so parked tabs still report `visible` and background
video/JS work costs more than stock.

### 7.1 Percentage deltas — Astra vs stock Firefox

Positive Δ = Astra higher. Δ% is `(Astra − Firefox) / Firefox`; the absolute columns are the truth when the baseline is near zero. Stock is Firefox 159.0; Astra is ESR 153.6.0, so some delta is version-related. `n/a` means the Firefox baseline was exactly 0.

**Headline**

| Metric | Astra | Firefox | Δ | Δ% |
|---|---|---|---|---|
| One page — settled PSS | 509.4 MiB | 436.0 MiB | +73.4 MiB | +16.8% |
| New Tab — settled PSS | 512.3 MiB | 431.7 MiB | +80.6 MiB | +18.7% |
| 8 static tabs — settled PSS | 562.8 MiB | 500.1 MiB | +62.7 MiB | +12.5% |
| 6 videos — settled PSS | 760.7 MiB | 687.7 MiB | +73.0 MiB | +10.6% |
| 6 videos — settled CPU | 0.45 cores | 0.28 cores | +0.17 cores | +62.5% |
| 6 videos — GPU video engine | 15.2% | 3.8% | +11.5 pp | +304.5% |
| 4 3D tabs — settled CPU | 0.67 cores | 0.27 cores | +0.40 cores | +148.5% |
| 4 3D tabs — settled PSS | 631.4 MiB | 478.4 MiB | +153.0 MiB | +32.0% |
| 4 3D tabs — GPU memory | 462.5 MiB | 230.9 MiB | +231.6 MiB | +100.3% |
| 3D 720p — rAF/s | 143.6 | 139.4 | +4.2 | +3.0% |
| 3D 720p — GPU render | 58.4% | 43.0% | +15.3 pp | +35.6% |
| One page — first-10s CPU | 0.44 cores | 0.03 cores | +0.42 cores | +1550.0% |
| One page — first-10s GPU | 12.0% | 0.0% | +12.0% | n/a (from 0) |
| Cold start — spawn→UI ready | 1.88–2.14 s | 1.41–1.51 s | +0.4–0.6 s | +30–40% |

**Settled memory (PSS, MiB)**

| Scenario | Astra | Firefox | Δ MiB | Δ% |
|---|---|---|---|---|
| baseline-1tab | 509.4 | 436.0 | +73.4 | +16.8% |
| baseline-newtab | 512.3 | 431.7 | +80.6 | +18.7% |
| tabs-8static | 562.8 | 500.1 | +62.7 | +12.5% |
| video-2 | 626.2 | 522.8 | +103.4 | +19.8% |
| video-6 | 760.7 | 687.7 | +73.0 | +10.6% |
| 3d-1 | 511.5 | 456.2 | +55.3 | +12.1% |
| 3d-4 | 631.4 | 478.4 | +153.0 | +32.0% |
| mixed-8 | 748.4 | 623.9 | +124.5 | +20.0% |
| memory-6 | 1028.5 | 974.0 | +54.5 | +5.6% |
| ui-tour | 672.8 | 593.4 | +79.4 | +13.4% |

**Settled CPU (cores)**

| Scenario | Astra | Firefox | Δ cores | Δ% |
|---|---|---|---|---|
| baseline-1tab | 0.00 | 0.00 | +0.00 | n/a |
| baseline-newtab | 0.04 | 0.00 | +0.04 | n/a (from 0) |
| tabs-8static | 0.04 | 0.02 | +0.02 | +107.7% |
| video-2 | 0.23 | 0.19 | +0.04 | +19.4% |
| video-6 | 0.45 | 0.28 | +0.17 | +62.5% |
| 3d-1 | 0.35 | 0.29 | +0.06 | +21.9% |
| 3d-4 | 0.67 | 0.27 | +0.40 | +148.5% |
| mixed-8 | 5.81 | 4.23 | +1.58 | +37.3% |
| memory-6 | 0.02 | 0.02 | +0.00 | +8.7% |
| ui-tour | 0.10 | 0.22 | -0.12 | -55.0% |

**Post-load transient CPU (first 10 s, cores)**

| Scenario | Astra | Firefox | Δ cores | Δ% |
|---|---|---|---|---|
| baseline-1tab | 0.44 | 0.03 | +0.42 | +1550.0% |
| baseline-newtab | 0.05 | 0.02 | +0.03 | +140.3% |
| tabs-8static | 0.53 | 0.02 | +0.51 | +2275.3% |
| video-2 | 0.23 | 0.21 | +0.02 | +11.9% |
| video-6 | 0.52 | 0.34 | +0.18 | +51.5% |
| 3d-1 | 0.63 | 0.28 | +0.34 | +121.0% |
| 3d-4 | 0.71 | 0.30 | +0.41 | +136.9% |
| mixed-8 | 5.63 | 4.23 | +1.40 | +33.1% |
| memory-6 | 0.57 | 0.02 | +0.55 | +3169.8% |
| ui-tour | 0.71 | 0.20 | +0.51 | +249.1% |

**GPU engines (settled)**
 
| Scenario | Render Astra | Render Firefox | Δ render | Δ% | Video Astra | Video Firefox | Δ video | Δ% |
|---|---|---|---|---|---|---|---|---|
| baseline-1tab | 0.0% | 0.0% | +0.0 pp | n/a | 0.0% | 0.0% | +0.0 pp | n/a |
| baseline-newtab | 0.0% | 0.0% | +0.0 pp | n/a | 0.0% | 0.0% | +0.0 pp | n/a |
| tabs-8static | 0.0% | 0.0% | +0.0 pp | n/a | 0.0% | 0.0% | +0.0 pp | n/a |
| video-2 | 0.9% | 0.9% | -0.0 pp | -1.1% | 5.0% | 3.9% | +1.1 pp | +28.3% |
| video-6 | 0.9% | 0.8% | +0.0 pp | +2.4% | 15.2% | 3.8% | +11.5 pp | +304.5% |
| 3d-1 | 58.4% | 43.0% | +15.3 pp | +35.6% | 0.0% | 0.0% | +0.0 pp | n/a |
| 3d-4 | 48.6% | 51.9% | -3.3 pp | -6.3% | 0.0% | 0.0% | +0.0 pp | n/a |
| mixed-8 | 1.0% | 0.9% | +0.1 pp | +6.7% | 5.5% | 4.1% | +1.5 pp | +36.7% |
| memory-6 | 0.0% | 0.0% | +0.0 pp | n/a | 0.0% | 0.0% | +0.0 pp | n/a |
| ui-tour | 0.0% | 4.6% | -4.6 pp | -100.0% | 0.0% | 0.0% | +0.0 pp | n/a |
 
**GPU memory (settled, MiB)**
 
| Scenario | Astra | Firefox | Δ MiB | Δ% |
|---|---|---|---|---|
| baseline-1tab | 201.3 | 187.0 | +14.3 | +7.6% |
| baseline-newtab | 231.3 | 164.3 | +67.0 | +40.8% |
| tabs-8static | 207.7 | 207.2 | +0.5 | +0.2% |
| video-2 | 312.2 | 264.2 | +48.1 | +18.2% |
| video-6 | 489.4 | 274.8 | +214.6 | +78.1% |
| 3d-1 | 239.5 | 142.8 | +96.7 | +67.7% |
| 3d-4 | 462.5 | 230.9 | +231.6 | +100.3% |
| mixed-8 | 371.0 | 271.1 | +99.9 | +36.8% |
| memory-6 | 199.0 | 199.3 | -0.3 | -0.2% |
| ui-tour | 231.8 | 153.1 | +78.7 | +51.4% |

**3D and per-frame efficiency (settled)**

| Metric | Astra | Firefox | Δ | Δ% |
|---|---|---|---|---|
| 3d-1 rAF/s | 143.6 | 139.4 | +4.2 | +3.0% |
| 3d-1 CPU cores/frame | 0.2435 | 0.2057 | +0.0378 | +18.4% |
| 3d-1 GPU %/frame | 0.4063 | 0.3087 | +0.0976 | +31.6% |
| 3d-4 rAF/s | 143.1 | 144.1 | -1.0 | -0.7% |
| 3d-4 CPU cores/frame | 0.4683 | 0.1872 | +0.2811 | +150.2% |
| 3d-4 GPU %/frame | 0.3400 | 0.3604 | -0.0204 | -5.7% |

**Behaviour counts (not percentages)**

| Scenario | Astra visibility mismatches | Firefox |
|---|---|---|
| baseline-1tab | 0 | 0 |
| baseline-newtab | 0 | 0 |
| tabs-8static | 7 | 0 |
| video-2 | 1 | 0 |
| video-6 | 5 | 0 |
| 3d-1 | 0 | 0 |
| 3d-4 | 3 | 0 |
| mixed-8 | 7 | 0 |
| memory-6 | 5 | 0 |
| ui-tour | 0 | 0 |

Notes: `ui-tour` stock opens `about:preferences`, so its GPU/CPU columns are not an apples-to-apples UI comparison. `tabs-8static`, `memory-6` and `video-2` CPU percentages sit on 0.02–0.23-core baselines and are noisy; the absolute delta is the useful figure. `3d-4` CPU/frame includes the extra parent cost of four live tabs, not pure 3D rendering. The visibility mismatch column is the number of parked pages that still report `document.visibilityState = visible`.

## 8. Final native-merge pass (2026-11-04)

Build: `forge build --faster`, Mozilla Firefox 153.6.0esr engine, private
Weston display (headed; WebRender software) on the same 16-thread machine.
Artifacts: `out/perf-quiet/SUMMARY.md`, `out/matrix-final2/*/summary.json`.

| Bench | Status | Key numbers (3 runs, quiet machine) |
|---|---|---|
| Startup | PASS | cold 0.302 s / warm 0.302 s |
| Memory | PASS | 1 tab 482 MiB; 10 tabs 393 MiB; 50 tabs loaded 444 MiB; 50 sleeping 595 MiB |
| Scroll / switch | PASS | switch median 22.5 ms, p95 52.4 ms; scroll-step median 16.0 ms, p95 17.0 ms; rAF 21/s |
| Blocker (in-process) | PASS | 131724 rules; p50 2.12 µs, p95 2.64 µs, p99 3.14 µs |

UI tour (six static tabs, real clicks): new tab 29.4 ms, navigate 58.6 ms,
tab switch 16.9–24.7 ms, sidebar 802 ms, Work 26 ms, Settings 1068 ms.
The mixed-8 workload (2 video, 2 WebGL, 2 JS-burn, 2 static) passed every
behaviour check on the same build.

An earlier 2-run pass on the same build measured switch median 43.5 ms /
p95 142.5 ms while a separate desktop Firefox session (17 processes) shared
the machine. The quiet 3-run pass above is the product figure; the spread is
scheduler contention, not a code change (the UI tour's per-action switches
were ≤ 20 ms in both passes).

Engine/UI work in this pass that targets the same cost centres: revision
pruning for closed tabs, an in-flight epoch on the extension list, one
`WeakMap` host lookup per window, and a bounded core-call timeout so a wedged
sidecar cannot stall session saves.

## 6. Confirmation run 0.1.744 (2026-11-10, installed release binary)

`ASTRA_BINARY=~/.local/opt/astra/firefox python3 tools/perf/run_all.py --runs 1
--out out/perf-0.1.744` (headed release build; all four benches PASS).

| Metric | 0.1.744 | Note |
|---|---|---|
| Startup cold / warm | 0.302 s / 0.301 s | same Marionette-listen proxy as §1 |
| RAM 1 tab | 674 MiB | includes the native stage + app frame |
| RAM 10 tabs | 929 MiB | |
| RAM 50 tabs | 947 MiB | |
| RAM 50 tabs sleeping | 1 177 MiB | same-origin fixtures share content processes; `discardBrowser` does not shrink them here |
| Tab switch median / p95 | 21.5 / 87.5 ms | one run, loaded box |
| Scroll step median / p95 | 16.7 / 16.7 ms | |
| Blocker p50 / p95 / p99 | 2 160 / 2 616 / 2 852 ns | 131 724 rules, seed 76.5 ms |

These are **not** a regression verdict against §1: that table was measured
before the native tab stage and the current UI. The stock-ESR column is still
TODO, so the budget comparisons in §3 remain unbaselined. The favicon reader
was reduced to one page read per origin (coalesced, cached, bounded at 256
origins) in this run, which removes the duplicated page download on iconless
sites; it is a network/CPU saving, not a measured RSS delta.

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
  corpus, mean/p50/p95/p99. Browser-level blocking latency is NOT measured
  here — it needs the P4-T02 in-tree network hook; §6 records the method.
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

- P4-T02: after the network hook lands, add `bench_blocker_hook.py` reusing
  the fixture server + WebDriver: time navigation with hook on vs off, set
  the p95 overhead budget (proposal: ≤ 2 ms p95 per request on desktop).
- First-paint: MozAfterPaint probe via BiDi (P6 E2E harness) for a
  content-visible startup number to complement the Marionette-listen proxy.
- Scroll/tab-switch budgets: propose after 7-night trend exists
  (candidate: tab-switch p95 ≤ 100 ms; scroll-step p95 ≤ 32 ms headless
  proxy). Owner confirms before they gate.
- `$generichide` cosmetic path and `serialize()`/snapshot reload cost are
  measured at unit level in `crates/astra-blocker`; not repeated here.

# Pref boost plan — memory, CPU, GPU and responsiveness

**Status:** DRAFT. Not approved. Nothing here merges until every gate in
"Merge protocol" is green **and** the owner explicitly approves.
**Branch:** `perf/pref-boost` (from `origin/main` @ `ac71268e`).
**Scope owner:** this document.
**Last evidence run:** 2026-11-17, Windows 11 x64 dev build `0.1.746`
(Gecko 153.6.0), i5-12500H / 31.7 GB / RTX 3050 Laptop + Iris Xe.

This plan changes what Astra keeps alive, not how Gecko renders. The measured
problem is retention: 50 cold tabs hold 8.3 GB private because every page stays
resident forever. Rendering is already healthy (60 fps UI, 46 % peak GPU).
Therefore the work is a **budget policy** plus the small number of bugs that
block it.

## 1. Goal and non-goals

Goal, measured by `tools/perf/stress/web_tabs_probe.py`:

| Metric | Measured today | Target |
|---|---|---|
| Whole tree, 1 blank tab (private / working set) | 510 MB / 952 MB | 350 MB / 600 MB |
| Main process, 1 blank tab | 210 MB | 150 MB |
| 50 real tabs at steady state (private) | 8.30 GB | 2.50 GB |
| 50 tabs, working set | 12.2 GB | 4.0 GB |
| 50 tabs, CPU (cores of 16) | 6.0 median / 9.6 peak | 1.5 / 3.0 |
| GPU process memory | 1.2–1.4 GB | 400 MB |
| Tab activation p95 | 2.9 s | 1.2 s |
| Chrome frame p99 | 17 ms | 17 ms (no regression) |
| Reclaim after closing every tab | 85 % in 15 s | 90 % in 10 s |
| Crashes / OOM at 50 tabs on 16 GB | 0 | 0 |

Non-goals:

- Do not make 50 live pages fit in 1 GB. YouTube alone is 420–578 MB per
  process; that is site memory, not browser overhead.
- Do not disable the GPU process or WebRender to win a number. That trades
  the 60 fps UI and hardware video decode for a metric.
- Do not change Gecko's process model in C++ in this plan. Engine work is
  listed only where a pref cannot reach the problem.
- Do not touch private-window rules, Places, or the Host API wire shapes.

## 2. Evidence

Full report: `out/web-tabs-<stamp>/REPORT.md` from the probe. Summary of the
50-site run:

| Phase | Private (med/max) | Working set | CPU cores (med/max) | GPU | video decode |
|---|---|---|---|---|---|
| 1 blank tab | 0.52 / 0.74 GB | 1.0 GB | 0.1 | 0 % | 0 % |
| Loading 50 (walk) | 4.3 / **8.95 GB** | 12.7 GB | 7.6 / **9.64** | 46 % | 22 % |
| Steady, 17 videos muted | **8.29 / 8.52 GB** | 12.2 GB | **6.0** / 8.5 | 32 % | 17 % |
| Closed, +15 s | 1.29 GB | 1.8 GB | 0.3 | 21 % | 10 % |

Composition at steady state:

| Bucket | Size | Note |
|---|---|---|
| 10 YouTube watch pages | ~5.1 GB | 61 % of the run; 420–578 MB per process |
| GPU process | 1.2–1.4 GB | compositor surfaces for 51 tabs |
| Parent process | 630 MB | UI, Places, session store |
| 44 other content processes | ~3.2 GB | news/apps |
| Baseline overhead | 510 MB | GPU 222 MB + parent 210 MB |

Per-tab activation while cold-loading all 50: median 1.17 s, p95 2.9 s,
max 4.3 s. Chrome UI stayed at 60 fps and a visible 1080p video dropped zero
frames, so the cost is retention, not paint.

## 3. What "under 300 MB" actually means

The `<300 MB` figure people quote for Zen is its **main process**, not the
browser. Zen users report the main process at 465 MB, a 2.38 GB GPU helper and
content processes from 240 MB to 1.13 GB (Zen discussion #14087). Zen does not
unload idle tabs either: "it only does when the system's RAM starts to run
out" (Zen issue #14569), and "each loaded tab uses around 200-300 MB of RAM"
(Zen issue #8742). A published Zen benchmark had to correct its RAM chart
because it summed every process for Chrome but only the main process for
Zen/Firefox.

Astra's main process is 210 MB on a blank tab — already below that number.
The real comparison is whole-tree, and there Astra starts at 510 MB private.

Consequence for this plan: baseline work targets the **parent and GPU
processes**, because they are 432 MB of the 510 MB.

## 4. Invariants (must hold in every increment)

1. Private windows record nothing and are never auto-slept.
2. Selected tab, audible tab, PiP, pinned, DevTools and a tab with an open
   dialog are never discarded.
3. Every new listener, timer, observer and retained page reference has a
   teardown path; nothing grows per navigation or per tab event.
4. No native Firefox UI answers an action; no new Host API route without a UI
   caller.
5. Policy decisions are pure functions with a Rust mirror and a parity test;
   effects stay behind the existing `SleepHost` seam. No second copy of the
   algorithm in a new module.
6. Every claim in this plan is a number produced by a probe on this machine,
   stored under `out/`, not an estimate.

## 5. Design

### 5.1 Where it lives

| Concern | File | Change |
|---|---|---|
| Pure policy (JS) | `overlay/astra/host/Performance.sys.mjs` | extend `selectForSleep`/`runTick`: keep-warm window, footprint budget input |
| Pure policy (Rust mirror) | `crates/astra-core/src/sleeping.rs` | same inputs, same output; existing parity contract |
| Settings surface | `overlay/astra/host/Settings.sys.mjs` + Settings UI | existing `performance.after` values; no new control unless a budget slider is approved |
| Driver | `Performance.sys.mjs` `runTick` | read footprint signal, pass to policy, batch 4 |
| Prefs | `overlay/astra/mozilla.cfg` / build overlay | prealloc, process count, cache cap |
| Probe | `tools/perf/stress/web_tabs_probe.py` | already merged on this branch |

No new module and no helper class is introduced: `Performance.sys.mjs` and
`sleeping.rs` already are the helper seam (pure decision + host effect). Adding
a third copy would be the "repeated function" this plan forbids.

### 5.2 Policy input

```
TabState { id, last_active_ms, active, audible, pinned, devtools_open,
           discarded, selected, private, playing_media }
BudgetInput {
  now_ms,
  idle_timeout_ms,        // existing
  pressure,               // existing: none | moderate | critical
  footprint_kb,           // NEW: browser tree private bytes, or null
  budget_kb,              // NEW: budget derived from RAM, or null
  keep_warm_count,        // NEW: 6 default
  batch                   // existing cap, 4 under pressure
}
```

`footprint_kb == null` means "signal unavailable": the policy falls back to
time-only behaviour, identical to today. This keeps the first increment safe.

### 5.3 Decision order (single function, no branching elsewhere)

1. If the tab is selected, audible, pinned, in PiP, has DevTools open, is
   private, has an open dialog, or is in the last `keep_warm_count` by
   `last_active_ms`: do not sleep.
2. If `footprint_kb > budget_kb`: sleep the oldest eligible tab immediately.
3. Else if `now - last_active >= effective_timeout(idle_timeout_ms, pressure)`:
   sleep the oldest eligible tab.
4. Cap the batch at 4 per tick.
5. Effects: `Tabs.discard` (already the driver's call) and no wake unless the
   person selects the tab.

### 5.4 Footprint signal

`ChromeUtils.requestProcInfo()` throws in this build (`NS_ERROR_FAILURE` on
`nsIURI.userPass`), so `about:processes` and any per-tab memory surface is
broken. Candidate signals, in order:

1. Fix the `requestProcInfo` failure locally (it is a Gecko bug; a patch that
   tolerates a process without a parseable origin is small and reviewable).
2. If no engine patch is approved: sum `nsIMemoryReporterManager` per
   process from the parent where available, else
3. OS-level: Windows `GetProcessMemoryInfo` through the existing host seam,
   Linux `smaps_rollup` (the probe already does both), cached once per tick.

Whichever lands, the policy receives a number or `null`; it never calls the OS
itself. Decision D-3 below picks the option.

### 5.5 Prefs (build overlay, all reversible)

| Pref | Today | Proposed | Why |
|---|---|---|---|
| idle timeout default | three values: 30 min (`DEFAULT_IDLE_TIMEOUT_MS`, Rust + JS), 15 min (`readPolicy` fallback), 10 min (`Settings` fallback 600000 ms) | 5 min, one constant in all three | 50 tabs idle for 4 min held 8.3 GB; three defaults is itself a defect |
| `dom.ipc.processPrelaunch.fission.number` | 3 | 0 | ~25–30 MB idle, no user-visible cost |
| `dom.ipc.processCount` | 8 | 4 | fewer idle processes at 50 tabs; isolation trade-off accepted after measurement |
| `browser.cache.disk.smart_size.enabled` | true | false | 424 MB written in 4 min |
| `browser.cache.disk.capacity` (KB) | 256000 | 131072 | cap disk cache |
| `media.suspend-background-video.enabled` | true | keep true | verify with 10 YouTube tabs |
| `browser.low_commit_space_threshold_mb` | 200 | unchanged | OS pressure is not the trigger we need |

Each pref change is measured alone. A pref that does not move the number is
removed from the patch.

## 6. Workstreams

Owned by one writer at a time. Read-only agents may run in parallel.

### W0 — Evidence harness (done, on this branch)

`tools/perf/stress/web_tabs_probe.py` + README. Produces the numbers above.

### W1 — Budget policy

Increment 1 (safe, JS + Rust parity):
- `keep_warm_count` in `should_sleep` / `selectForSleep` and the JS mirror.
- One idle default: 5 minutes everywhere. Today three numbers disagree —
  `DEFAULT_IDLE_TIMEOUT_MS` is 30 min in `sleeping.rs` and in
  `Performance.sys.mjs`, `readPolicy` falls back to 15 min
  (`AFTER_MINUTES[15]`), and `Settings.sys.mjs` falls back to 600000 ms
  (10 min). Pick 5 min and make the three agree.
- Parity contract walks both implementations with the same cases.
- No new signal required; footprint is `null` and ignored.

Increment 2 (after D-3):
- `footprint_kb` / `budget_kb` inputs, budget derived as
  `min(0.25 * total_ram, 3 GB)` with a floor of 1 GB.
- Pressure mapping: over budget → `critical` for that tick.

Increment 3 (settings, only if approved):
- expose the budget as "Memory" in Settings, values 1/2/3 GB, default 25 % RAM.

### W2 — Baseline trim

- Prealloc and process count prefs, measured one at a time.
- Audit eager `ChromeUtils.importESModule` in `overlay/astra/host/*.sys.mjs`
  loaded at window open (`Boot`, `BootSidecar`, `Work`, `Accounts`,
  `MediaImport`, `Migration`); convert to `lazyModule` where the first caller
  already exists. Each conversion must show a baseline delta or it is dropped.
- Cache cap.
- Startup budget: `tools/perf/bench_startup.py` must not regress.

### W3 — Responsiveness

- Coalesce `items-changed` to one flush per animation frame; emit per-tab
  deltas where the model already supports them. Evidence: muting 17 tabs
  rebuilt the 50-row list 17 times and produced the only 67–83 ms chrome
  frames in the run.
- Virtualize the 50-row tab list (render visible rows + overscan).
- Keep-warm window (W1) makes the warm set likely for the next click.
- Acceptance: activation p95 ≤1.2 s, chrome p99 ≤17 ms at 50 tabs.

### W4 — Bugs and leaks

| Bug | Evidence | Fix |
|---|---|---|
| `ChromeUtils.requestProcInfo()` throws | probe could not read per-process info | tolerate a process without a parseable origin; per-tab memory from `domProcess.osPid` meanwhile |
| YouTube embed Error 153 | 10 embeds as tabs never played | reference fix or do not expose embed-as-tab |
| Background tab loads nothing | 50 tabs created, 0 loaded | surface the state ("Not loaded yet") and a load action |
| Event storm | 17 list rebuilds on mute | W3 |
| Reclaim 85 % | 8.9 GB → 1.29 GB, 15 s | measure again after W1; target 90 % / 10 s |

Leak gate (new, in CI): open 50 tabs, close them, repeat 20 cycles; assert
private ≤ 1.15 × baseline, threads and handles return, GPU memory returns
within 50 MB. Fails on the first cycle that grows.

## 7. Agents

Every agent gets an explicit file list and a "do not touch" list. Only one
writer runs at a time; the rest are read-only. They share this working tree
(worktrees are not usable: `engine/` is not in git), so ownership is the
conflict control.

| Agent | Type | Reads | Writes | Output |
|---|---|---|---|---|
| `decision` | read-only | this plan, `Performance.sys.mjs`, `sleeping.rs`, probe results | nothing | decision memo: thresholds, signal choice, pref cuts accepted/rejected |
| `reviewer` | read-only | plan + diffs | nothing | review findings with file:line, severity, required change |
| `senior-engineer` | writer | owned files | W1 increment 1 files only | patch + parity test + measured delta |
| `engineer-prefs` | writer | W2 files | prefs overlay only | patch + per-pref measurement |
| `tester` | writer (test artifacts only) | whole tree | `out/`, new test files | test matrix results with real numbers |
| `engineer-ui` | writer | W3 files | `ui/app` tab list + host events | patch + frame/activation numbers |

File ownership for increment 1 (the only writer active now):

| File | Owner |
|---|---|
| `overlay/astra/host/Performance.sys.mjs` | senior-engineer |
| `overlay/astra/host/Settings.sys.mjs` | senior-engineer (idle default fallback only) |
| `crates/astra-core/src/sleeping.rs` | senior-engineer |
| `tests/contract/sleep_model.mjs` | senior-engineer |
| `pref_boost_plan.md` | session owner |
| everything else | read-only |

Handoff rules:

- A writer reports the files it touched and the command it ran. Anything
  outside its list is a defect.
- `reviewer` reviews before `tester` runs; `tester` numbers are the only ones
  that count as evidence.
- No agent commits, pushes, or merges. Only the branch owner (this session)
  commits after review and green tests.

## 8. Test matrix

Per increment, in this order:

| Check | Command | Pass condition |
|---|---|---|
| Unit / parity | `cargo test -p astra-core sleeping` (and the JS unit suite) | all pass, same cases both sides |
| Contract | `python3 tests/contract/shell_app_chrome.py`, `tools/state-check.py` | unchanged counts |
| Build | `cargo run -q --manifest-path forge/astra-forge/Cargo.toml -- build --faster` | exit 0; never omit `--jobs 2` for engine builds |
| Probe | `python3 tools/perf/stress/web_tabs_probe.py --tabs 50` | targets in §1 for the increment |
| Leak | probe `--cycles 20` (new) | private ≤1.15 × baseline each cycle |
| Startup | `python3 tools/perf/bench_startup.py` | no regression beyond 5 % |

Real numbers are appended to `out/pref-boost/<increment>.md` and to this plan's
"Results" section before any commit is proposed.

## 9. Merge protocol

1. All increments on `perf/pref-boost`; `origin/main` is merged in (not
   rebased) whenever it moves, to keep the merge honest.
2. Required before proposing a merge: W1–W4 done, full test matrix green, leak
   gate green, probe numbers at or under target, reviewer sign-off, and no
   pref or code change without its own measured delta.
3. The owner approves the merge explicitly. Until then the branch stays
   unmerged even if everything is green.
4. Merge as a `--no-ff` merge commit into `main` with a message that lists
   increments and numbers. No squash: each increment keeps its evidence.
5. After merge: rebuild `build --faster`, rerun the probe on `main`, push to
   GitLab (`origin`) and GitHub (`github`), then fetch both and verify the
   tip SHAs match. A push that succeeds on one host only is a failed merge.
6. Rollback: revert the merge commit (`git revert -m 1 <sha>`); every pref is
   independently revertible; no data migration is involved.

## 10. Risks

| Risk | Impact | Control |
|---|---|---|
| Discarding too eagerly | tab clicks reload (1–4 s cold) | keep-warm 6, idle 5 min, batch 4, exemptions |
| Footprint signal unavailable | budget never fires | fall back to time-only, never guess a number |
| Process count 8 → 4 | less isolation, one crash takes more tabs | measure crash blast radius; revert if probe shows regressions |
| Cache cap | more revalidation on revisit | measure with a revisit phase before keeping |
| `items-changed` coalescing | UI misses a delta | contract test compares list before/after; no lost rows |
| Rust/JS drift | policy differs by engine | existing parity test extended with the new inputs |

## 11. Decisions to record

- D-1 idle default 5 min vs 10 min. (proposed: 5, evidence: 4 min idle held 8.3 GB)
- D-2 keep-warm 6 vs 8. (proposed: 6)
- D-3 footprint signal: local Gecko fix, per-process reporter, or OS sampler.
- D-4 process count 4 vs 6.
- D-5 cache cap 128 MB vs 256 MB.
- D-6 whether a budget control appears in Settings or stays internal.

Each decision is written here with the number that justified it.

## 12. Sequence

1. W0 (done).
2. W1 inc 1 + parity test; probe delta.
3. W3 event coalescing (independent of policy, visible win).
4. W1 inc 2 after D-3; probe delta.
5. W2 prefs one at a time; keep only measured wins.
6. W4 bug fixes + leak gate.
7. Full matrix, reviewer sign-off, owner approval, merge.

## 13. Results

Filled by the tester. Empty until then.

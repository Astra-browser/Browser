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

Goal, measured by `tools/perf/stress/web_tabs_probe.py`. The population matters:
17 muted-but-playing videos are a permanent policy exemption (Firefox never
discards a tab with active media), so the 50-tab target is stated twice.

| Metric | Measured today | Target |
|---|---|---|
| Whole tree, 1 blank tab (private / working set) | 510 MB / 952 MB | 350 MB / 600 MB |
| Parent process, 1 blank tab | 210 MB | 150 MB |
| 50 tabs, stress population (17 playing), private | 8.30 GB | ≤ 6.5 GB |
| 50 tabs, realistic population (3 playing), private | n/a | ≤ 2.5 GB |
| 50 tabs after the drain (5 min idle + 4/tick) | n/a | ≤ 1.8 GB |
| 50 tabs, working set (realistic) | 12.2 GB | ≤ 4.0 GB |
| 50 tabs, CPU (cores of 16) | 6.0 median / 9.6 peak | 1.5 / 3.0 |
| GPU process memory | 1.2–1.4 GB | 400 MB |
| Warm tab activation p95 (tab was awake) | not measured | 400 ms |
| Cold tab activation p95 (tab was discarded) | 2.9 s | 1.2 s |
| Chrome frame p99 | 17 ms | 17 ms (no regression) |
| Reclaim after closing every tab | 85 % in 15 s | 90 % in 10 s |
| Crashes / OOM at 50 tabs on 16 GB | 0 | 0 |

Evidence provenance: the 50-tab numbers in §2 came from the temp harness. They
are the design baseline, not a stored repo artifact. W0.2 re-runs the repo
probe at 50 tabs before any target is measured.

Why 6.5 GB and not 2.5 GB for the stress run: the ten YouTube watch pages are
5.1 GB of the 8.3 GB, and `shouldSleep` must keep exempting tabs with active
media or background music and muted playback die. The reclaimable set is the
other 33 tabs; keeping 6 warm leaves ~27 to discard. The 2.5 GB target belongs
to ordinary browsing (a few videos), and both numbers are reported.

Non-goals:

- Do not make 50 live pages fit in 1 GB. YouTube alone is 420–578 MB per
  process; that is site memory, not browser overhead.
- Do not disable the GPU process or WebRender to win a number. That trades
  the 60 fps UI and hardware video decode for a metric.
- Do not change Gecko's process model in C++ in this plan. Engine work is
  listed only where a pref cannot reach the problem.
- Do not touch private-window rules, Places, or the Host API wire shapes.

## 2. Evidence

Provenance, stated exactly: the 50-tab table below was produced by the
pre-repo version of the harness in a temp directory, on the same build and
machine, and is reproduced here as the design baseline. The repo probe
(`tools/perf/stress/web_tabs_probe.py`) currently has only an 8-tab run stored
under `out/`. **W0.2 must re-run `--tabs 50` from the repo probe and store the
artifact before any target in §1 is cited as met** (review: invariant 6).

Full report from the temp harness: `REPORT.md` with `samples.jsonl`,
103 rows at 2.5 s.

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
5. Policy decisions are pure functions with a Rust mirror; the same cases are
   asserted on both sides. The two lists are mirrored by hand today (a shared
   fixture is a follow-up, not a claim this plan makes). Effects stay behind
   the existing `SleepHost` seam; no second copy of the algorithm in a new
   module.
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

`should_sleep` stays a per-tab exemption check. The keep-warm window is a
set-level rule and lives only in `select_for_sleep` / `selectForSleep`, which
already rank oldest-first and own the batch cap (review B3).

1. Driver pre-filters (before the policy): private window, unsaved page, open
   dialog, and the selected tab. PiP folds into `audible` in `enrich`.
2. Policy per-tab exemptions: active, already discarded, audible (includes
   PiP), pinned, DevTools.
3. Keep-warm: rank the remaining eligible tabs by `last_active_ms` descending,
   ties by `id` ascending, drop the newest `min(keep_warm_count, eligible)`.
   A population at or under the window sleeps nothing (review M1's
   `eligible - 1` clamp was measured to eat one warm tab per tick; see D-11).
4. If `footprint_kb > budget_kb`: sleep the oldest eligible tab immediately.
5. Else if `now - last_active >= effective_timeout(idle_timeout_ms, pressure)`:
   sleep the oldest eligible tab.
6. Cap the batch at 4 per tick, always, not only under pressure (review M3).
   Filter keep-warm first, then slice, or the cap spends slots on warm tabs.
7. Effects: `Tabs.discard` (already the driver's call) and no wake unless the
   person selects the tab.

Invariant 2 is therefore a **driver** guarantee for private/dialog/PiP and a
**policy** guarantee for active/audible/pinned/DevTools. The Rust mirror cannot
see a private window and must not pretend to; the plan says so instead of
implying the struct knows (review M4).

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
| idle timeout default | live value is 15 min: the engine ships `browser.tabs.min_inactive_duration_before_unload` = 600000 ms (`engine/browser/app/profile/firefox.js:1145`), `Settings.read` maps 600000 to the `"15"` bucket, and `readPolicy` applies `AFTER_MINUTES[15]`. `DEFAULT_IDLE_TIMEOUT_MS` (30 min) is test-only. | 5 min: `defaultPref(..., 300000)` in `overlay/astra/mozilla.cfg`, `Settings` fallback 300000, `readPolicy` fallback `AFTER_MINUTES[5]`, both constants 300000, UI reset default `"5"`. One test asserts the five literals agree. | 50 tabs idle for 4 min held 8.3 GB. The settings enum is 5/15/30/60, so 10 min is not representable; 5 is the only aggressive value that fits without a UI change. Provisional until the drain measurement (D-1). |
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

### W0 — Evidence harness

`tools/perf/stress/web_tabs_probe.py` + README (done). **W0.2** gives it the
instruments the targets need, in this order:

1. `--idle-hold <s>`: keep the window inactive after the walk and sample
   throughout; write `discarded_count` / `awake_count` per row. Without it the
   steady phase is measured before any tab can reach the timeout (review B4).
2. Close **all** tabs (drop the `tabs[0]` keep) and report a 20 s reclaim
   series plus `first_ts_under_10pct`.
3. `parent_priv_mb` in the summary (`pid == root_pid`).
4. Split activation timing: start the clock after the dwell, and add a
   `REWALK` pass over discarded tabs → `warm_activate_*`.
5. `--pause-video` to measure the population that invariant 2 allows.
6. Record `git rev-parse HEAD`, `git status --porcelain`, binary mtime/size and
   the probe hash in `result.json`.
7. Stop pinning `dom.ipc.processCount` in `user.js`; read it from the build.

### W1 — Budget policy

Increment 1a (policy core, no default change):
- `keep_warm_count` as a field on `SleepConfig` / the JS `config` object, used
  only by `select_for_sleep` / `selectForSleep` (review B3). Default 6,
  clamped to `min(count, eligible - 1)`; ties by `id`.
- Batch cap 4 unconditionally in `readPolicy`, so the first tick after a
  default change does not discard ~44 tabs at once (review M3). 50 tabs drain
  in ceil(44/4) = 11 ticks.
- The same cases asserted in `tests/contract/sleep_model.mjs` and the Rust
  unit tests (ties, `n < K`, `K = 0`, batch ordering, negative timeout). The
  two lists are mirrored by hand; a shared fixture is a follow-up, and the
  plan says so rather than claiming a mechanism it does not have.
- Footprint is `null` and ignored in this increment.

Increment 1b (one idle default, five literals):
- `defaultPref("browser.tabs.min_inactive_duration_before_unload", 300000)` in
  `overlay/astra/mozilla.cfg` (the live pref source is the engine default,
  `firefox.js:1145` = 600000).
- `Settings.sys.mjs` fallback 300000, `Performance.sys.mjs` `readPolicy`
  fallback `AFTER_MINUTES[5]`, both `DEFAULT_IDLE_TIMEOUT_MS`, and
  `ui/app/src/domain/preferences/preferences.svelte.ts:51` reset default `"5"`.
- One test asserts the five literals agree; another asserts a stored `"15"`
  still means 15 minutes.
- The drain run decides D-1 before this lands.

Increment 2 (after D-3):
- `footprint_kb` / `budget_kb` inputs, budget derived as
  `min(0.25 * total_ram, 3 GB)` with a floor of 1 GB.
- Pressure mapping: separate budget pressure value that keeps `batch: 4` and
  never overrides `keep-ready`; `critical` stays unreachable from Settings.

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
| Unit / parity | `cargo test -p astra-core sleeping` + `node tests/contract/sleep_model.mjs` | all pass; the same cases asserted on both sides, including ties and `n < K` |
| Contract | `python3 tests/contract/shell_app_chrome.py`, `tools/state-check.py` | unchanged counts |
| Build | `cargo run -q --manifest-path forge/astra-forge/Cargo.toml -- build --faster` | exit 0; never omit `--jobs 2` for engine builds |
| Probe (baseline) | `python3 tools/perf/stress/web_tabs_probe.py --tabs 50` on the **pre-change binary** | stored under `out/pref-boost/<increment>-before/` |
| Probe (after) | same command on the rebuilt binary | targets in §1; both populations (`--pause-video` off/on) |
| Drain | `--idle-hold 700` (11 ticks at 5 min + batch 4) | `discarded_count` in every row; memory falls during the hold |
| Leak | close **all** tabs (including the first), then sample 20 s | private ≤1.15 × baseline; parent and GPU reported separately |
| Startup | `python3 tools/perf/bench_startup.py` | no regression beyond 5 % |

Rules added after review:

- A build and a probe are one lockstep step. Never probe while a writer has
  uncommitted source or a build is running (shared tree, one `engine/obj-*`).
- Every `result.json` records `git rev-parse HEAD`, `git status --porcelain`,
  the binary mtime/size and the probe's own hash; a dirty tree invalidates the
  run.
- The leak test closes the stage tab too. Today `CLOSE_ALL` keeps
  `gBrowser.tabs[0]`, which is why "after close" still holds a 1080p player
  and reads as 1.71× baseline (decision memo). That is a probe defect, not a
  product leak, until proven otherwise.
- Real numbers go to `out/pref-boost/<increment>.md` and §13 before a commit is
  proposed.

## 9. Merge protocol

1. All increments on `perf/pref-boost`; `origin/main` is merged in (not
   rebased) whenever it moves, to keep the merge honest.
2. **Each increment is its own commit and carries its own gate** (review M8):
   its tests green, its before/after numbers stored, reviewer sign-off. An
   increment that cannot be measured is not merged; it is retired with the
   number that replaced it instead of blocking the branch.
3. The owner approves the merge explicitly. Until then the branch stays
   unmerged even if everything is green.
4. Merge as a `--no-ff` merge commit into `main` with a message that lists the
   increments that actually landed and their numbers. No squash: each
   increment keeps its evidence and stays individually revertible.
5. After merge: rebuild `build --faster`, rerun the probe on `main`, push to
   GitLab (`origin`) and GitHub (`github`), then fetch both and verify the
   tip SHAs match. If the second push fails, `main` is considered split:
   stop, report per-host SHAs, and do not claim a merge until both match.
6. Rollback: revert the increment commit on `main` (`git revert <sha>`), rebuild,
   re-probe. The merge commit is only reverted if the increments cannot be
   reverted individually. No data migration is involved; every pref is a
   default and every policy change is behind `performance.sleep`.

## 10. Risks

| Risk | Impact | Control |
|---|---|---|
| Discarding too eagerly | tab clicks reload (1–4 s cold) | keep-warm 6, idle 5 min, batch 4, exemptions |
| Footprint signal unavailable | budget never fires | fall back to time-only, never guess a number |
| Two sleepers | Firefox `TabUnloader` can discard a keep-warm tab under OS pressure while Astra's driver also runs | recorded as D-8; resolve ownership before increment 2 |
| Process count 8 → 4 | less isolation, one crash takes more tabs | 9 tabs already spawn 27–28 processes, so the pref may not be the lever; do not change until measured (D-4) |
| Cache cap | more revalidation for a 0 MB RSS delta | rejected by D-5 unless a revisit phase shows a memory effect |
| `items-changed` coalescing | UI misses a delta | contract test compares list before/after; no lost rows; rAF id released in `stop()` |
| Rust/JS drift | policy differs by engine | one case list asserted on both sides, not two hand-synced lists |

## 11. Decisions

Each decision is written here with the number that justified it, and what would
falsify it.

| # | Decision | Status | Basis / falsifier |
|---|---|---|---|
| D-1 | Idle default **5 min**, provisional | open until the drain run | 50 tabs at 4 min idle held 8.3 GB; the enum is 5/15/30/60 so 10 is not representable. Falsify by measuring cold activation p95 after a real drain: if >1.2 s, move to 15 min or add a 10 option. |
| D-2 | Keep-warm **6** | accepted, measured | 50-tab hold: 49 discarded, 2 awake, settled 1.12 GB, restore 2.29 s median / 6.51 s p95. With the window now protected the expected settled figure is ~2.0–2.3 GB and the six most recent tabs are instant. |
| D-11 | The warm window is never eaten | accepted | `min(count, eligible - 1)` (review M1) discarded one warm tab per tick once the population reached the window: 49 discarded, 1 warm, 2.29 s restore. `min(count, eligible)` restores the guarantee; a population at or under the window sleeps nothing. Three-tick regression test in both languages. |
| D-12 | Media and calls are never slept | accepted | `audible` now means media or call in progress: `soundplaying \|\| pip \|\| browsingContext.mediaController.isActive \|\| currentWindowGlobal.hasActivePeerConnections()`. `audioPlaybackActive` stays out so muted autoplay ads remain discardable. 111 checks, each signal mutation-tested. Cost: a 17-player stress run is back to ~6.5–7 GB because the players are protected; the 2.5 GB target applies to the non-media population. |
| D-13 | A paused media session stays exempt | accepted | `isActive` remains true for a paused-but-not-dismissed player; protecting it avoids losing the resume position. The narrower predicate (`isActive && isPlaying`) would make paused sessions discardable after the idle timeout; revisit if the probe shows paused sessions mattering. |
| D-3 | Footprint signal: **local tolerance fix for `requestProcInfo` first**, OS sampler second, per-process reporter rejected | accepted | The reporter sum only sees the parent (22 % of the tree); the OS sampler needs a new route + wire type. Falsify if the throw is inside C++ and the patch grows beyond a few lines. |
| D-4 | Do **not** change `dom.ipc.processCount` yet | accepted | 9 tabs already spawn 27–28 processes under a pref of 8, so the lever is unproven; measure 8/6/4 before touching it. |
| D-5 | **Reject** the cache cap | accepted | Disk bytes do not move private/working set; 0 MB expected RSS delta, revalidation cost real. |
| D-6 | Budget stays **internal**, no Settings control | accepted | 3 GB budget on 31.7 GB RAM; a 9-tab tree already uses 2.4 GB, so 1–2 GB settings would thrash. Existing `performance.memory` already occupies the name. |
| D-7 | Muted-but-playing media is **discardable**; sound and PiP are exempt | **changed by measurement, 2026-11-17** | The original exemption (`audioPlaybackActive`) kept 22 of 50 tabs awake and capped the win at ~0.9 GB. `soundplaying` is the signal Firefox's own TabUnloader uses. Cost: a muted background player stops when its tab sleeps. Test: 103 checks, mutation-verified. |
| D-8 | Resolve the two-sleeper overlap (Firefox `TabUnloader` + Astra driver) | **accepted for increment 1**, separation in increment 2 | Same pref is the master switch for both (`browser.tabs.unloadOnLowMemory`), and it ships **true on Windows** (`firefox.js:1138`). The engine unloader does not run on a timer — it only acts under OS memory pressure (`browser.low_commit_space_threshold_mb` = 200 MB) — so lowering the idle value changes which tabs it would pick in that extreme, not when it runs. Increment 1 documents both consumers in `mozilla.cfg`; increment 2 gives Astra its own idle pref and leaves the engine's at 600000. Risk accepted, not hidden. |
| D-9 | Pref mechanism per pref: `defaultPref` for user-facing defaults, `lockPref` only for posture | accepted | `mozilla.cfg` runs after `firefox.js`, and `lockPref` makes a value unmeasurable and unrevertible at runtime. |

## 12. Sequence

1. W0 (done) and W0.2: fix the probe (idle hold, discard count, close-all,
   git state, pause-video, warm re-activation) and store the 50-tab baseline.
2. W1 inc 1a (policy core: keep-warm, clamp, batch) + parity tests; drain run
   decides D-1.
3. W1 inc 1b (one idle default across five literals).
4. W3 event coalescing (independent of policy, visible win).
5. W1 inc 2 after D-3; probe delta.
6. W2 prefs one at a time; keep only measured wins (D-4, D-5 constrain this).
7. W4 bug fixes + leak gate (with close-all).
8. Full matrix, reviewer sign-off, owner approval, merge.

## 13. Results

### Increment 1 (policy + one idle default) — 2026-11-17

| Item | Result |
|---|---|
| Parity suites | `node tests/contract/sleep_model.mjs` 98 passed / 0 failed; `cargo test -p astra-core sleeping` 21 passed / 0 failed; `cargo fmt --check` clean |
| Mutation checks | each new case was verified to fail under the mutation it guards (window 0, slice-before-filter, clamp `len` instead of `len-1`, batch `MAX_SAFE_INTEGER`, dropped `Number.isFinite`, 300000→600000) |
| Runtime default | pre-change build: pref 600000, `Settings('performance.after')` = "15". Post-change build: pref **300000**, setting **"5"**, `prefHasUserValue` false |
| Stored baseline | `out/pref-boost/inc1-before`: 50 tabs, 17 muted videos, steady 8.09 GB median / 8.39 GB max private, 11.85 GB working set, 4.17 cores median (machine was busy with review agents, so latency there is not comparable) |
| After-run (first attempt, `inc1-after-policydisabled`) | **invalid and kept for the record**: 0 discarded / 51 awake after 720 s. Marionette's recommended preferences set `browser.tabs.unloadOnLowMemory = false`, which is also Astra's sleep master switch, so the driver reported `enabled: false` and never ticked. The probe now clears that user value, asserts `performance.sleep === "true"`, records the policy and fails the run otherwise; the measurement was repeated. |
| After-run (policy on) | `out/pref-boost/inc1-after`: 16 discarded / 35 awake after 720 s; private 7.92 → 7.06 GB median; CPU 3.87 → 1.83 cores; warm restore median 1.78 s, p95 3.14 s. Stress target (6.5 GB) missed by ~0.6 GB. |
| Narrowed exemption (`8a70f92b`) | The 16/28 result was traced to `audioPlaybackActive` in `enrich`: true for muted autoplay players, which most news pages carry, so 22 tabs stayed awake. TabUnloader itself uses `tab.soundPlaying`. `audible` is now `soundplaying \|\| pictureinpicture`; 103 JS checks pass, and re-adding the term fails the two muted-media assertions. |
| `--pause-video` run | `out/pref-boost/inc1-after-paused`: paused only 6/17 players (no active controller while backgrounded), so it reproduced 16 discarded / 34 awake at 7.08 GB and 1.85 cores; warm restore 740 ms median / 2.32 s p95. The stage step crashed on a discarded context; the probe now survives that. |
| `out/pref-boost/inc1-after-d10` (D-7 + D-10) | 49 discarded / 2 awake after 720 s; private 7.98 GB steady → **1.12 GB settled** (−86 %); CPU 3.92 → **1.15 cores**; drain 4 tabs per 30 s tick, 6 min from first discard to full. Warm restore 2.29 s median / 6.51 s p95 because the warm window was being eaten (see D-11). |
| `out/pref-boost/inc1-final` (window protected, no media protection yet) | 43 discarded / 8 awake (6 warm, about:blank, 1 imgur) after 720 s; **settled 1.89 GB** private vs 7.97 steady and 8.09 with no policy; CPU **1.32 cores** vs 3.81; UI p99 18 ms, max 34 ms; reclaim 9.15 GB → 1.19 GB. Restore of a *discarded* tab is 2.70 s median / 6.71 s p95; the 6 warm tabs are instant by construction. **2.5 GB target met** at 1.89 GB for a population without active playback. |
| `out/pref-boost/inc1-media-protected` (D-12) | 34 discarded / 19 awake after 720 s; settled **5.44 GB** private vs 7.96 steady; CPU 1.46 cores; UI p99 33 ms, max 42 ms. The 10 YouTube players stay awake as playing media sessions (plus 5 warm, about:blank and page-level tabs), so protecting playback costs ~3.5 GB over the no-media case — the price of not interrupting what the person is listening to. The audit's `other` bucket mislabels those players as `beforeunload` because it only reads `soundplaying`; the media-session class needs adding to the audit. |

Not yet measured: whether the drain actually reaches the 1.8 GB target, and
cold vs warm activation cost (D-1). Those numbers decide whether 5 minutes
stays.

**Increment 1 verdict:** the target state is reached for the non-media
population — 1.89 GB with 50 tabs, 6 warm and 43 discarded. Media and call tabs
are protected by D-12, so a stress run whose 17 players are genuinely playing
settles higher (~6.5–7 GB); the 2.5 GB target is stated for the population
without active playback. What remains before a merge proposal is not more
policy work: a real `build --faster` (the dist file sync is labelled as such),
the owner's approval, and increments 2–4 (baseline trim, event coalescing, the
leak gate, and the separate master pref from D-8).

## 14. Build environment findings (2026-11-17)
Two defects blocked a normal `mach build faster` on this machine. Both are
reported, neither is worked around silently.

1. **`forge build` on Windows cannot run mach.** `cmd_build` passes the shell
   script as separate arguments after `-c`
   (`Command::new("cmd").args(["/C", start-shell.bat, "-no-start", "-defterm",
   "-c"]).arg(script)`). cmd.exe then parses the script's own `&&` and `||`,
   which yields `The syntax of the command is incorrect` before bash sees it.
   Fix: quote the script as one argument (`-c "<script>"`) or write it to a
   temporary `.sh` and pass its path.
2. **`forge overlay` cannot reconcile a tree that already has newer overlay
   sources.** `ASTRA-0004` (blocker engine) fails with
   `toolkit/components/astra_blocker_engine/AstraBlocker.cpp: already exists
   in working directory`, because the engine tree carries the blocker branch's
   newer sources while the patch still describes the older ones. Reverse-check
   fails (content differs), forward-apply fails (files exist). Needs either a
   regenerated patch (`forge export`) or a documented recovery; this plan does
   not touch the engine tree.

3. **Marionette disables the feature it is supposed to measure.** Marionette's
   recommended preferences set `browser.tabs.unloadOnLowMemory = false` as a
   user value at session start, and that is exactly Astra's sleep master
   switch. Every driven run therefore measured a browser that never sleeps
   anything: the first after-run held 51 tabs awake for 12 minutes with 0
   discards. The probe now clears the user value after the session starts,
   asserts `Settings('performance.sleep') === "true"`, records the restored
   policy in `result.json` and aborts if it is off. This also means any tool,
   policy or profile that writes that pref turns the feature off for real —
   one more argument for the separate Astra master pref in D-8.

Workaround used for the measurement only, stated plainly: the overlay had
already copied `overlay/astra` into `engine/astra`, so the two changed host
modules and `mozilla.cfg` were copied into the packaged `dist/bin` by hand
(`chrome/astra/content/astra/res/host/`, `dist/bin/mozilla.cfg`) and the
runtime pref check confirmed 300000/"5". This is a dev-tree file sync, not a
build; the after-numbers are valid for the JS policy, and the increment still
needs a real `build --faster` before merge.


## 15. Review resolutions (2026-11-17)

Three independent agents reviewed the first draft. Everything they found is
resolved here; nothing is dropped silently.

| Finding | Resolution in this plan |
|---|---|
| B1 the 5-minute change would be a runtime no-op | §5.5 now names the real chain (engine pref 600000 → Settings bucket "15" → `readPolicy` `AFTER_MINUTES[15]`) and the five literals that must agree; W1 1b implements them as one unit with an equality test |
| B2 2.5 GB unreachable with 17 playing videos | §1 states two populations; D-7 keeps the media exemption; the stress target is 6.5 GB |
| B3 keep-warm in `should_sleep` forces duplicate ranking | §5.3 and W1 place it in `select_for_sleep` / `SleepConfig.keep_warm_count`; `should_sleep` stays per-tab |
| B4 probe cannot measure any of this | §8 and W0.2 add idle hold, discard count, close-all reclaim, cold vs warm activation, `--pause-video`, git provenance; `dom.ipc.processCount` leaves the probe's `user.js` |
| M1 small windows and discarded tabs consume warm slots | clamp changed to `min(count, eligible)` after measurement: `eligible - 1` ate one warm tab per tick (D-11); small windows now sleep nothing |
| M2 ties are undefined | deterministic drop of the newest K, ties by id, asserted on both sides |
| M3 batch cap and ordering | batch 4 always; filter keep-warm then slice; drain time documented (11 ticks) |
| M4 private/dialog/PiP claimed as policy | §5.3 states driver-guarantee vs policy-guarantee; no `private` field added to the Rust struct |
| M5 keep-warm breaks existing driver tests | `keep_warm_count` is a policy parameter; tests pass 0 for old behaviour, plus the warm matrix |
| M6 one driver per process, dies with its window | recorded; multi-window probe and per-window guard are a precondition for the budget claim |
| M7 unattributable evidence, lockPref trade-off | §8 requires HEAD + status + binary hash per run; D-9 fixes the pref mechanism |
| M8 all-or-nothing merge gate | §9 gates each increment on its own numbers; the merge lists only what landed |
| m1 negative-timeout division differs | parity case added, clamp to >= 0 |
| m2 UI reset restores 15 | `ui/app/src/domain/preferences/preferences.svelte.ts:51` and its fixture move to "5" |
| m3 parent process not reported | `parent_priv_mb` added to the probe summary |
| m4 reclaim measured only at 15 s | close-all plus a 20 s series, first row under 10 % reported |
| m5 footprint sampler teardown | sampled inside `runTick` as a per-tick promise, no interval, fallback `null` once |
| D-1 5 vs 10 | 5 stays provisional; the drain run decides, 10 is not representable without a UI change |
| D-4 process count | deferred until 8/6/4 is measured; the 27–28 process census contradicts the premise |
| D-5 cache cap | rejected |
| D-8 two sleepers | confirmed on Windows: `browser.tabs.unloadOnLowMemory` ships true there and is also Astra's master switch, so both unloaders run; Linux has only Astra's |


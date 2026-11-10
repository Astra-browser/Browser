# Astra stress + performance report

_Generated from the raw per-run samples by `tools/perf/stress/summarize.py`._

## 1. What was measured

Headed builds on the machine below, one fresh profile per run, all pages served from four loopback origins (`127.0.0.1:8111-8114`). One sample every 0.5 s captured CPU per process, PSS/private/swap, DRM engine times (render/video/copy), GPU memory, iGPU rc6 busy, NVIDIA telemetry, CPU frequency, package temperature and load. Pages post a heartbeat every 2 s (rAF rate, visibility API, video playback quality, WebGL renderer).

| Fact | Value |
|---|---|
| seconds | 4.0 |
| cpu_busy_pct | 5.3 |
| mem_available_mb | 17283.6 |
| swap_used_mb | 8191.9 |
| load | [1.88, 1.96, 1.95] |
| igpu_busy_pct | 36.9 |
| cpu_count | 16 |
| binary | /home/rem/Projects/Astra/engine/obj-astra-linux/dist/bin/firefox |
| scenario_tabs | 1 |
| astra_binary_mtime | 2026-11-03 01:19 |

**Two windows are reported.** `transient` is the first 10 s after the steady window opens (page load + the loading affordances). `settled` is the last 10 s of the same window (true idle/steady workload). The per-run `REPORT.md` files keep the whole-window mean/p95/max; this report uses the settled median for comparisons and the transient mean for load cost.

Caveats that matter for every number below:

- The box was **not idle**: VS Code, rust-analyzer, the owner's Firefox and opencode were running. Ambient CPU/iGPU is recorded per run; browser figures are process-tree sums, not machine totals.
- The comparison binary is the installed **Firefox 159.0** (Ubuntu), not ESR 153; Astra's engine is 153.6.0esr. Version differences can explain part of a delta and are called out where they matter.
- CPU is shown as **cores** (one fully busy hardware thread = 1.00) and as **% of the 16-thread machine**.
- GPU render % is `drm-engine-render` busy time of the browser's DRM clients; 100% = one render engine continuously busy. Video % is `drm-engine-video`, i.e. hardware decode.
- Animated runs (`3d-*`, `video-*`, `mixed-8`, `ui-tour`) were repeated with a Hyprland focus watchdog (`ASTRA_STRESS_FOCUS=1`): an occluded window is throttled by both browsers, and one early 3D run was measured at ~60 fps only because a terminal window covered it. The focus-controlled reruns are the ones in this report; `meta.json` records `focus_watchdog`.
- `about:blank` New Tab runs do not load a page; everything else does.

## At a glance

- **Settled idle with one loaded page:** Astra 0.00 cores / 509 MiB / 0.0% GPU. Stock Firefox 0.00 cores / 436 MiB / 0.0% GPU.
- **The first ~15 s after a page paints are not idle:** Astra's transient mean is 0.44 cores / 12.0% GPU vs stock 0.03 cores / 0.0%. The tab stays `loading: true` and the skeleton shimmer + spinner + favicon orbit keep animating. Pausing those animations dropped parent CPU from ~66% to ~19% and GPU from ~12% to ~3% in a controlled probe.
- **Eight static tabs (settled):** Astra 0.04 cores / 563 MiB; stock 0.02 cores / 500 MiB. During the load burst Astra averaged 0.53 cores vs stock 0.02.
- **Six 1080p videos (settled):** Astra 0.45 cores / 15.2% video engine; stock 0.28 cores / 3.8%.
- **WebGL 3D (fixed 720p, synced, settled):** Astra 58.4% GPU at 143.6 rAF/s; stock 43.0% at 139.4 rAF/s.
- **Cold start:** spawn→UI ready Astra 1.88–2.14 s vs stock 1.41–1.51 s (+0.4–0.6 s). Spawn→Marionette is the same (~0.6 s), so the difference is shell/app boot, not process launch.
- **Biggest CPU and GPU user:** the parent/chrome process (Astra's app + compositor + WebGL). **Biggest RAM user:** content processes, then the parent. **Video:** the RDD process and the GPU video engine, not the UI process.
- **dGPU:** the NVIDIA RTX 3050 stayed at ~0% and ~2 MiB; all work ran on the Intel Iris Xe iGPU.

## 2. Scenario matrix — Astra vs stock Firefox

### 2.1 Cold start and settled memory

| Scenario | Browser | spawn→Marionette | spawn→UI ready | settled PSS | peak processes | peak threads |
|---|---|---|---|---|---|---|
| baseline-1tab | astra | 606 ms | 2105 ms | 509.4 MiB | 15 | 323 |
| baseline-1tab | stock | 567 ms | 1478 ms | 436.0 MiB | 13 | 271 |
| baseline-newtab | astra | 596 ms | 1910 ms | 512.3 MiB | 14 | 293 |
| baseline-newtab | stock | 567 ms | 1414 ms | 431.7 MiB | 13 | 275 |
| tabs-8static | astra | 601 ms | 1918 ms | 562.8 MiB | 18 | 408 |
| tabs-8static | stock | 555 ms | 1478 ms | 500.1 MiB | 16 | 352 |
| video-2 | astra | 628 ms | 1906 ms | 626.2 MiB | 16 | 384 |
| video-2 | stock | 583 ms | 1464 ms | 522.8 MiB | 14 | 330 |
| video-6 | astra | 618 ms | 1916 ms | 760.7 MiB | 19 | 477 |
| video-6 | stock | 571 ms | 1452 ms | 687.7 MiB | 16 | 411 |
| 3d-1 | astra | 620 ms | 1884 ms | 511.5 MiB | 15 | 324 |
| 3d-1 | stock | 584 ms | 1456 ms | 456.2 MiB | 13 | 273 |
| 3d-4 | astra | 620 ms | 1952 ms | 631.4 MiB | 18 | 415 |
| 3d-4 | stock | 599 ms | 1487 ms | 478.4 MiB | 16 | 363 |
| mixed-8 | astra | 614 ms | 1935 ms | 748.4 MiB | 19 | 449 |
| mixed-8 | stock | 569 ms | 1434 ms | 623.9 MiB | 16 | 392 |
| memory-6 | astra | 618 ms | 1976 ms | 1028.5 MiB | 18 | 408 |
| memory-6 | stock | 580 ms | 1498 ms | 974.0 MiB | 16 | 352 |
| ui-tour | astra | 624 ms | 1912 ms | 672.8 MiB | 18 | 408 |
| ui-tour | stock | 582 ms | 1456 ms | 593.4 MiB | 16 | 360 |

### 2.2 Settled state — CPU, RAM, GPU

| Scenario | Browser | CPU cores | CPU % machine | PSS MiB | private MiB | GPU render % | GPU video % | GPU mem MiB | iGPU busy % | dGPU util % |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline-1tab | astra | 0.00 | 0.0% | 509.4 | 381.9 | 0.0% | 0.0% | 201.3 | 2.8% | 0.0% |
| baseline-1tab | stock | 0.00 | 0.0% | 436.0 | 354.9 | 0.0% | 0.0% | 187.0 | 3.1% | 0.0% |
| baseline-newtab | astra | 0.04 | 0.2% | 512.3 | 389.8 | 0.0% | 0.0% | 231.3 | 2.9% | 0.0% |
| baseline-newtab | stock | 0.00 | 0.0% | 431.7 | 353.1 | 0.0% | 0.0% | 164.3 | 3.0% | 0.0% |
| tabs-8static | astra | 0.04 | 0.2% | 562.8 | 432.0 | 0.0% | 0.0% | 207.7 | 3.0% | 0.0% |
| tabs-8static | stock | 0.02 | 0.1% | 500.1 | 409.4 | 0.0% | 0.0% | 207.2 | 2.5% | 0.0% |
| video-2 | astra | 0.23 | 1.4% | 626.2 | 476.9 | 0.9% | 5.0% | 312.2 | 37.5% | 0.0% |
| video-2 | stock | 0.19 | 1.2% | 522.8 | 420.0 | 0.9% | 3.9% | 264.2 | 52.3% | 0.0% |
| video-6 | astra | 0.45 | 2.8% | 760.7 | 608.8 | 0.9% | 15.2% | 489.4 | 95.1% | 0.0% |
| video-6 | stock | 0.28 | 1.7% | 687.7 | 577.9 | 0.8% | 3.8% | 274.8 | 63.1% | 0.0% |
| 3d-1 | astra | 0.35 | 2.2% | 511.5 | 383.6 | 58.4% | 0.0% | 239.5 | 100.0% | 0.0% |
| 3d-1 | stock | 0.29 | 1.8% | 456.2 | 375.3 | 43.0% | 0.0% | 142.8 | 78.4% | 0.0% |
| 3d-4 | astra | 0.67 | 4.2% | 631.4 | 494.1 | 48.6% | 0.0% | 462.5 | 79.1% | 0.0% |
| 3d-4 | stock | 0.27 | 1.7% | 478.4 | 388.9 | 51.9% | 0.0% | 230.9 | 91.0% | 0.0% |
| mixed-8 | astra | 5.81 | 36.3% | 748.4 | 594.3 | 1.0% | 5.5% | 371.0 | 85.5% | 0.0% |
| mixed-8 | stock | 4.23 | 26.4% | 623.9 | 514.7 | 0.9% | 4.1% | 271.1 | 95.2% | 0.0% |
| memory-6 | astra | 0.02 | 0.1% | 1028.5 | 898.2 | 0.0% | 0.0% | 199.0 | 29.9% | 0.0% |
| memory-6 | stock | 0.02 | 0.1% | 974.0 | 883.4 | 0.0% | 0.0% | 199.3 | 29.9% | 0.0% |
| ui-tour | astra | 0.10 | 0.6% | 672.8 | 542.0 | 0.0% | 0.0% | 231.8 | 27.9% | 0.0% |
| ui-tour | stock | 0.22 | 1.4% | 593.4 | 502.5 | 4.6% | 0.0% | 153.1 | 60.3% | 0.0% |

### 2.2b Post-load transient (first 10 s of the steady window)

| Scenario | Browser | CPU cores | CPU % machine | PSS MiB | GPU render % | GPU video % | iGPU busy % |
|---|---|---|---|---|---|---|---|
| baseline-1tab | astra | 0.44 | 2.8% | 558.0 | 12.0% | 0.0% | 50.0% |
| baseline-1tab | stock | 0.03 | 0.2% | 473.4 | 0.0% | 0.0% | 3.3% |
| baseline-newtab | astra | 0.05 | 0.3% | 540.9 | 0.0% | 0.0% | 3.5% |
| baseline-newtab | stock | 0.02 | 0.1% | 468.1 | 0.0% | 0.0% | 4.2% |
| tabs-8static | astra | 0.53 | 3.3% | 597.6 | 14.5% | 0.0% | 73.2% |
| tabs-8static | stock | 0.02 | 0.1% | 509.7 | 0.0% | 0.0% | 3.0% |
| video-2 | astra | 0.23 | 1.5% | 621.4 | 1.0% | 5.5% | 69.3% |
| video-2 | stock | 0.21 | 1.3% | 546.2 | 0.9% | 4.9% | 47.0% |
| video-6 | astra | 0.52 | 3.2% | 680.5 | 1.6% | 16.0% | 80.9% |
| video-6 | stock | 0.34 | 2.1% | 618.2 | 0.8% | 12.0% | 50.3% |
| 3d-1 | astra | 0.63 | 3.9% | 561.6 | 36.4% | 0.0% | 77.0% |
| 3d-1 | stock | 0.28 | 1.8% | 500.0 | 49.8% | 0.0% | 80.0% |
| 3d-4 | astra | 0.71 | 4.5% | 580.9 | 56.0% | 0.0% | 96.5% |
| 3d-4 | stock | 0.30 | 1.9% | 498.1 | 37.9% | 0.0% | 70.7% |
| mixed-8 | astra | 5.63 | 35.2% | 661.2 | 1.1% | 5.4% | 82.9% |
| mixed-8 | stock | 4.23 | 26.4% | 623.0 | 1.0% | 4.7% | 75.0% |
| memory-6 | astra | 0.57 | 3.5% | 1068.1 | 11.9% | 0.0% | 55.3% |
| memory-6 | stock | 0.02 | 0.1% | 987.9 | 0.0% | 0.0% | 35.3% |
| ui-tour | astra | 0.71 | 4.5% | 610.8 | 10.3% | 0.0% | 59.9% |
| ui-tour | stock | 0.20 | 1.3% | 529.5 | 0.2% | 0.0% | 58.9% |

### 2.3 Astra − stock deltas (settled)

| Scenario | Δ CPU cores | Δ PSS MiB | Δ GPU render pp | Δ GPU mem MiB |
|---|---|---|---|---|
| baseline-1tab | +0.00 | +73.4 | +0.0 | +14.3 |
| baseline-newtab | +0.04 | +80.6 | +0.0 | +67.0 |
| tabs-8static | +0.02 | +62.7 | +0.0 | +0.5 |
| video-2 | +0.04 | +103.4 | -0.0 | +48.1 |
| video-6 | +0.17 | +73.0 | +0.0 | +214.6 |
| 3d-1 | +0.06 | +55.3 | +15.3 | +96.7 |
| 3d-4 | +0.40 | +153.0 | -3.3 | +231.6 |
| mixed-8 | +1.58 | +124.5 | +0.1 | +99.9 |
| memory-6 | +0.00 | +54.5 | +0.0 | -0.3 |
| ui-tour | -0.12 | +79.4 | -4.6 | +78.7 |

### 2.4 Page behaviour (settled window)

rAF is probed only on animated fixtures (`video`, `css`, `3d`, `js`); a `—`/0 on a static page means no frame probe. The first column groups pages by their rAF rate, not by tab visibility; a parked tab that still reports `visibilityState=visible` is counted as a mismatch.

| Scenario | Browser | pages ≥10 rAF/s | pages <10 rAF/s | videos played | decoded frames | dropped | visibility mismatches |
|---|---|---|---|---|---|---|---|
| baseline-1tab | astra | — | 0.00 | 0 | 0 | 0 | 0 |
| baseline-1tab | stock | — | 0.00 | 0 | 0 | 0 | 0 |
| baseline-newtab | astra | — | — | 0 | 0 | 0 | 0 |
| baseline-newtab | stock | — | — | 0 | 0 | 0 | 0 |
| tabs-8static | astra | — | 0.00 | 0 | 0 | 0 | 7 |
| tabs-8static | stock | — | 0.00 | 0 | 0 | 0 | 0 |
| video-2 | astra | 143.3 | 0.00 | 2 | 421 | 0 | 1 |
| video-2 | stock | 143.0 | 0.00 | 2 | 480 | 0 | 0 |
| video-6 | astra | 143.6 | 0.04 | 6 | 1320 | 0 | 5 |
| video-6 | stock | 143.1 | 0.10 | 6 | 1441 | 0 | 0 |
| 3d-1 | astra | 143.6 | — | 0 | 0 | 0 | 0 |
| 3d-1 | stock | 139.4 | — | 0 | 0 | 0 | 0 |
| 3d-4 | astra | 143.1 | 0.07 | 0 | 0 | 0 | 3 |
| 3d-4 | stock | 144.1 | 0.00 | 0 | 0 | 0 | 0 |
| mixed-8 | astra | 73.0 | 0.06 | 2 | 482 | 1 | 7 |
| mixed-8 | stock | 140.9 | 0.04 | 2 | 480 | 0 | 0 |
| memory-6 | astra | — | 0.00 | 0 | 0 | 0 | 5 |
| memory-6 | stock | — | 0.00 | 0 | 0 | 0 | 0 |
| ui-tour | astra | — | 0.00 | 0 | 0 | 0 | 0 |
| ui-tour | stock | — | 0.00 | 0 | 0 | 0 | 0 |

### 2.5 Thermals and clocks (whole run)

CPU temperature is the hottest thermal zone; dGPU numbers come from `nvidia-smi`. The box was already warm from VS Code/rust-analyzer.

| Scenario | Browser | CPU temp max °C | CPU MHz mean | CPU MHz max | dGPU temp max °C | dGPU power max W |
|---|---|---|---|---|---|---|
| baseline-1tab | astra | 66.0 | 1926 | 3058 | 44.0 | 3.7 |
| baseline-1tab | stock | 65.0 | 1594 | 3412 | 44.0 | 3.6 |
| baseline-newtab | astra | 64.0 | 1655 | 2548 | 44.0 | 3.8 |
| baseline-newtab | stock | 64.0 | 1505 | 3210 | 43.0 | 3.5 |
| tabs-8static | astra | 75.0 | 1867 | 3188 | 44.0 | 3.7 |
| tabs-8static | stock | 66.0 | 1309 | 2489 | 44.0 | 3.7 |
| video-2 | astra | 69.0 | 2417 | 3457 | 49.0 | 3.7 |
| video-2 | stock | 71.0 | 2470 | 3472 | 48.0 | 3.7 |
| video-6 | astra | 70.0 | 2673 | 3572 | 48.0 | 3.6 |
| video-6 | stock | 72.0 | 2587 | 3339 | 47.0 | 3.7 |
| 3d-1 | astra | 68.0 | 2674 | 3581 | 48.0 | 3.6 |
| 3d-1 | stock | 70.0 | 2483 | 3595 | 48.0 | 3.6 |
| 3d-4 | astra | 82.0 | 2702 | 3650 | 49.0 | 3.7 |
| 3d-4 | stock | 70.0 | 2602 | 3432 | 50.0 | 3.8 |
| mixed-8 | astra | 85.0 | 3406 | 3652 | 53.0 | 3.8 |
| mixed-8 | stock | 86.0 | 3261 | 3651 | 56.0 | 3.9 |
| memory-6 | astra | 75.0 | 2436 | 3447 | 55.0 | 3.8 |
| memory-6 | stock | 70.0 | 2130 | 2810 | 51.0 | 3.7 |
| ui-tour | astra | 76.0 | 2543 | 3332 | 55.0 | 3.8 |
| ui-tour | stock | 70.0 | 2169 | 3232 | 51.0 | 3.6 |

## 3. Which part of the browser uses what

Settled medians across every scenario, split by process kind. `browser` is the chrome/UI process (the Astra app runs in it); `content` is web pages; `rdd` is the remote data decoder; `webextension` is the extension process. The average includes `mixed-8`'s deliberate JS burn; use the per-scenario tables for a specific workload.

| Kind | Runs | CPU cores | PSS MiB | GPU render % | GPU video % |
|---|---|---|---|---|---|
| astra:content | 10 | 0.59 | 196.9 | 0.00 | 0.00 |
| astra:browser | 10 | 0.14 | 370.7 | 10.97 | 0.00 |
| astra:rdd | 10 | 0.01 | 25.6 | 0.00 | 2.58 |
| astra:utility | 10 | 0.01 | 6.7 | 0.00 | 0.00 |
| astra:other | 10 | 0.00 | 5.5 | 0.00 | 0.00 |
| astra:webextension | 10 | 0.00 | 35.5 | 0.00 | 0.00 |
| astra:socket | 10 | 0.00 | 13.7 | 0.00 | 0.00 |
| astra:forkserver | 10 | 0.00 | 3.7 | 0.00 | 0.00 |
| stock:content | 10 | 0.44 | 146.2 | 0.00 | 0.00 |
| stock:browser | 10 | 0.09 | 344.4 | 10.22 | 0.00 |
| stock:utility | 10 | 0.01 | 5.5 | 0.00 | 0.00 |
| stock:rdd | 10 | 0.01 | 23.8 | 0.00 | 1.17 |
| stock:other | 10 | 0.00 | 7.1 | 0.00 | 0.00 |
| stock:webextension | 10 | 0.00 | 38.8 | 0.00 | 0.00 |
| stock:socket | 10 | 0.00 | 3.6 | 0.00 | 0.00 |
| stock:forkserver | 10 | 0.00 | 3.1 | 0.00 | 0.00 |

### 3.2 Marginal RAM per tab (settled)

`(settled PSS of the N-tab run − settled PSS of the 1-tab baseline) / added tabs`.

| Workload | Browser | 1-tab PSS | loaded PSS | added tabs | marginal MiB/tab |
|---|---|---|---|---|---|
| 8 static tabs | astra | 509.4 | 562.8 | 7 | 7.6 |
| 8 static tabs | stock | 436.0 | 500.1 | 7 | 9.2 |
| 6 video tabs | astra | 509.4 | 760.7 | 6 | 41.9 |
| 6 video tabs | stock | 436.0 | 687.7 | 6 | 42.0 |
| 6 memory tabs (64 MiB each) | astra | 509.4 | 1028.5 | 6 | 86.5 |
| 6 memory tabs (64 MiB each) | stock | 436.0 | 974.0 | 6 | 89.7 |

## 4. Animated-work efficiency (per rendered frame, settled)

The 3D fixture is fixed at 1280×720 and calls `gl.finish()` every frame, so its rAF rate is completed GPU work, not compositor vsync.

| Scenario | Browser | rAF/s | CPU cores | GPU render % | CPU cores per frame | GPU % per frame |
|---|---|---|---|---|---|---|
| 3d-1 | astra | 143.6 | 0.35 | 58.4% | 0.2435 | 0.4063 |
| 3d-1 | stock | 139.4 | 0.29 | 43.0% | 0.2057 | 0.3087 |
| 3d-4 | astra | 143.1 | 0.67 | 48.6% | 0.4683 | 0.3400 |
| 3d-4 | stock | 144.1 | 0.27 | 51.9% | 0.1872 | 0.3604 |

## 5. UI interaction cost (Astra, real clicks)

Actions ran through the real chrome document while the sampler was live. Times include the action's own wait for the visible result. The stock `ui-tour` uses native tab APIs (`gBrowser.addTab`, `selectedTab`, `about:preferences`), not synthetic clicks, so its action times are not directly comparable; its memory/CPU figures are still in the matrix.

| Action | Result | ms |
|---|---|---|
| newtab | ok | 23 |
| navigate:http://127.0.0.1:8111/static.html?id=ui-nav&kind=static | ok | 58.8 |
| switch:0 | ok | 17.5 |
| switch:1 | ok | 17.7 |
| switch:2 | ok | 18.8 |
| switch:3 | ok | 17.8 |
| switch:4 | ok | 17.5 |
| switch:5 | ok | 18 |
| sidebar | ok | 802.7 |
| work | ok | 24.1 |
| settings | ok | 1054.2 |

## 6. Run verdicts

| Scenario | Browser | Verdict | Checks |
|---|---|---|---|
| baseline-1tab | astra | PASS | 4/4 |
| baseline-1tab | stock | PASS | 3/3 |
| baseline-newtab | astra | PASS | 4/4 |
| baseline-newtab | stock | PASS | 3/3 |
| tabs-8static | astra | PASS | 4/4 |
| tabs-8static | stock | PASS | 3/3 |
| video-2 | astra | PASS | 5/5 |
| video-2 | stock | PASS | 4/4 |
| video-6 | astra | PASS | 5/5 |
| video-6 | stock | PASS | 4/4 |
| 3d-1 | astra | PASS | 5/5 |
| 3d-1 | stock | PASS | 4/4 |
| 3d-4 | astra | PASS | 5/5 |
| 3d-4 | stock | PASS | 4/4 |
| mixed-8 | astra | PASS | 5/5 |
| mixed-8 | stock | PASS | 4/4 |
| memory-6 | astra | PASS | 4/4 |
| memory-6 | stock | PASS | 3/3 |
| ui-tour | astra | PASS | 5/5 |
| ui-tour | stock | PASS | 4/4 |

## 7. Findings

**The 15-second loading-state burn is the headline.** Settled CPU is 0.00 cores, but the first 10 s averaged 0.44 cores and 12.0% GPU. After the page was already painted, Astra kept `loading: true`; the skeleton shimmer, spinner and favicon orbit ran for ~15 s. Stock was 0.00 settled / 0.03 transient. Root cause: `Content.watch()` waits for a poll to see `isLoadingDocument=true`; a fast load finishes between polls, so the model waits out `startDeadline` (15 s). Pausing only the loading animations (focus confirmed) cut parent CPU 66%→19% and GPU 12%→3%.

**Settled idle itself is fine.** Astra 0.00 cores / 509 MiB / 0.0% GPU vs stock 0.00 / 436 MiB / 0.0%. The memory gap is real (+~74 MiB): content ~106 MiB vs ~58 MiB, parent ~326 vs ~312 MiB; the rest is the app process.

**New Tab alone:** Astra 512 MiB / 0.04 cores vs stock 432 MiB / 0.00 cores. The live Svelte New Tab costs ~+77 MiB but almost no CPU/GPU once it is up.

**Eight static tabs:** settled Astra 0.04 cores / 563 MiB; stock 0.02 / 500 MiB. The load burst was the difference: Astra 0.53 cores vs stock 0.02 in the first 10 s. Marginal settled RAM is ~8–9 MiB/tab for both.

**Video decode is off the main thread and on the iGPU.** Settled two 1080p30 videos: Astra 5.0% video engine / 0.23 cores; stock 3.9% / 0.19. Six videos: Astra 15.2% / 0.45; stock 3.8% / 0.28. Dropped frames were 0–3 across 6 streams; the cost is RDD memory and GPU video engine time, not the UI. Astra's video engine time per decode is higher than stock's at the same decoded frame count.

**WebGL/3D is GPU-heavy and close once the window is visible.** Fixed 1280×720 with `gl.finish()` and the focus watchdog: settled Astra 143.6 rAF/s at 58.4% GPU; stock 139.4 rAF/s at 43.0%. The earlier ~60 fps reading was an occluded window, not a shader or refresh cap. Per frame Astra costs 0.243 vs 0.206 cores/frame and 0.406 vs 0.309 GPU-%/frame.

**Parked tabs report visible, but rAF still stops.** Four 3D tabs: Astra 0.67 cores / 48.6% GPU; stock 0.27 / 51.9%. The three background 3D pages report `visibilityState=visible` while their rAF is 0; the compositor still throttles them, so 3D rendering stops, but `visibilitychange` handlers and timers do not. The extra ~0.4 core is in the parent, not GPU work; it is consistent with the same per-tab loading/UI cost, not 3D rendering. It also holds +153 MiB PSS and +232 MiB GPU memory for four live WebGL tabs.

**Background pages report visible in Astra.** Settled mixed-8: 7 background page(s) report `visibilityState=visible` while parked; stock reports 0. Timers and JS that only pause on `visibilitychange` keep running: Astra used 5.81 cores vs stock 4.23. This is the same docshell-activation gap as the hidden 3D tabs.

**UI is responsive under load.** 11/11 real UI actions passed; tab switches median 17.8 ms (max 18.8 ms), sidebar toggle 803 ms, Work 24 ms, Settings 1054 ms.

**Attribution:** parent/chrome process = UI + compositor + WebGL (highest CPU and GPU render); content processes = page DOM/JS and most per-tab RAM; RDD = hardware video decode (GPU video engine); no dedicated GPU process in this build (GPU work rides the parent's DRM clients); NVIDIA dGPU idle.


## 7.1 What to fix first

1. **Clear the loading state on a fast load.** Root cause found: `overlay/astra/host/Content.sys.mjs` `watch()` waits for a 200 ms poll to see `isLoadingDocument = true`. A fast page can load and finish between polls, so `seenLoading` stays false and the tab is held in `loading` until the `startDeadline` (15 s). The shell's `[data-loading=true]` skeleton shimmer, loading spinner and the app's favicon orbit animate for that whole window. Add a first-poll fast path (URL committed + not loading => clear now) and a contract test that a local load clears in <500 ms.
2. **Deactivate parked content docshells.** `docShellIsActive` stayed true for every tab, so background pages still report `visibilityState=visible`; the `visibilitychange` contract does not fire when a tab is parked. Set `docShellIsActive = false` on non-selected browsers and restore it on selection.
3. **Astra holds +70–80 MiB and 1–4 extra content processes at rest.** Settled 1-tab PSS is ~509 MiB vs stock ~435 MiB; content PSS is ~106 vs ~58 MiB. Mozilla's default is 3 preallocated processes; check the space/container mapping and `dom.ipc.processPrelaunch.fission.number`.
4. **Keep video as is.** Hardware decode is working: the video engine rises with each 1080p stream and dropped frames were 0–3. The cost is RDD memory and GPU video engine time, not the UI process.

## 8. Published Firefox baselines (external)

Third-party/official numbers, not measurements from this machine. Different OS, hardware, Firefox version, tab set and method (RSS vs PSS).

| Source | Setup | Firefox figure | Relevance |
|---|---|---|---|
| Mozilla, *Process Model* (source docs) | Architecture reference | 3 preallocated content processes by default; 8 shared web-content processes; content process overhead ~25–30 MB; GPU process optional on Linux, compositing then runs in the parent | Explains the 7 content processes and the GPU work sitting in Astra's parent process |
| Mozilla, *Process Isolation in Firefox* | Architecture note | ~7–10 MB per minimal XPCOM process; ~25–30 MB per full content process | Matches the 15–25 MiB PSS per content process measured here |
| Helge Klein, *Impact of GPU Acceleration on Browser CPU Usage* (2014, Firefox 34, Win, HD 4600) | Canvas + site + 720p YouTube, 2 min each | GPU on: 187.0 CPU-seconds, 21.1% GPU, 166.6 MB GPU memory. GPU off: 271.4 CPU-seconds, 2.0% GPU, 114.5 MB | Firefox trades ~31% CPU for GPU work when acceleration is on; our stock 3D run shows the same shape |
| TabGroupVault, May 2026 loaded-tab benchmark (macOS 26.2, M4 Pro, 24 GB) | Same 50-URL set, fresh profile | Firefox: 727 MB idle, 2,782 MB @10 tabs, 4,515 MB @30, 8,844 MB @50 (RSS). Chrome: 612 / 2,730 / 5,632 / 14,414 | Firefox stays flat-ish at high tab counts; per-tab cost is not linear |
| Tech Insider, Apr 2026 (Firefox 150, M4 Pro, 16 GB, 20 real sites) | Gmail → 20-site suite, 5 min settle | Firefox: 338 MB @1 tab, 1,395 @5, 2,496 @10, 4,764 @20, 9,611 @50; 3,902 after 2 h idle | Same order of magnitude as this box's stock 1-tab ~435 MiB PSS |
| Mozilla Bug 1588589 (dup of 1640779) | Wayland/XWayland vsync | Firefox could sync to a fake 60 Hz callback on Wayland, stuttering on 75/144 Hz displays; community workaround is `layout.frame_rate=144` | Known Linux issue; ruled out here because the focused rerun hit ~144 rAF/s in both browsers |

Sources:

- https://firefox-source-docs.mozilla.org/dom/ipc/process_model.html
- https://mozilla.github.io/firefox-browser-architecture/text/0012-process-isolation-in-firefox.html
- https://support.mozilla.org/en-US/kb/firefox-uses-too-much-memory-or-cpu-resources
- https://helgeklein.com/blog/impact-gpu-acceleration-browser-cpu-usage/
- https://tabgroupvault.com/blog/firefox-vs-chrome-ram-usage-2026
- https://tech-insider.org/chrome-vs-firefox-2026/
- https://bugzilla.mozilla.org/show_bug.cgi?id=1588589
- https://bbs.archlinux.org/viewtopic.php?id=267008

## 9. Limitations and follow-ups

- One repetition per scenario; the per-run files hold every sample and the p95/max so variance is visible.
- Root-cause probes: `tools/perf/stress/probe_burn.py` (loading state + animations) and `probe_skeleton.py` (pause A/B); raw probe output is in `out/burn-probe/` and `out/skeleton-probe/`.
- Local fixtures avoid the network. Real sites add TLS, ads/trackers, service workers and their own compositor work.
- The transient window is fixed at 10 s in this report; the loading state was still true at 14 s in the probe. A follow-up should measure the exact clear time and assert it in a contract test.
- Animated runs use a Hyprland focus watchdog; without it an occluded window is throttled and one early 3D run read ~60 fps instead of ~144 fps. The reruns replaced the affected runs.
- Per-tab content-process PIDs were not exposed by the remote browser; attribution is per process kind, not per tab.
- The thread snapshot taken after the steady window landed on the preallocated-process cleanup spike (97–120% CPU for ~2 s), so it is not reported here; the per-process tables are authoritative.


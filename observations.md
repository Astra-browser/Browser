# Astra stress observations

Every block below is one measured run. Raw samples, summaries, page heartbeats and screenshots live in `out/stress-*/<run>/`.

Method: headed browser, fresh profile, local loopback fixtures, one sample per 0.5 s of CPU + PSS + DRM engine counters + iGPU rc6 + dGPU. CPU cores = one fully busy hardware thread. GPU render % = one render engine fully busy; values can exceed 100% when several DRM clients share the engine.

<!-- KEY-OBSERVATIONS -->
## Key observations (all runs)

- **Settled one-page idle:** Astra 0.00 cores / 509 MiB / 0.0% GPU; stock 0.00 / 436 MiB / 0.0%.
- **Post-load burn:** first 10 s Astra 0.44 cores / 12.0% GPU vs stock 0.03 / 0.0%. Cause: tab stays `loading: true` ~15 s; skeleton/spinner/favicon animations keep running.
- **Eight static tabs (settled):** Astra 0.04 cores / 563 MiB; stock 0.02 / 500 MiB.
- **Six 1080p videos (settled):** Astra 15.2% video engine / 0.45 cores; stock 3.8% / 0.28.
- **WebGL 720p synced (settled):** Astra 58.4% GPU at 143.6 rAF/s; stock 43.0% at 139.4.
- **Biggest CPU + GPU:** parent/chrome process (UI + compositor + WebGL). **Biggest RAM:** content processes, then parent. **Video:** RDD + GPU video engine.
- **Bugs found:** stale `loading:true` keeps skeleton/spinner animations alive for ~15 s; parked tabs keep `visibilityState=visible`; animated runs must be measured with the window focused (an unfocused window is throttled).
- Per-run blocks below use the whole steady window (including the post-load burn); settled medians in `STRESS_REPORT.md` are the idle comparison.
- Full analysis: `STRESS_REPORT.md`; raw data: `out/stress-final/`.

<!-- RUN:astra-baseline-1tab-r1 -->
## astra · baseline-1tab · repeat 1 — PASS

- Cold start: spawn→Marionette 606 ms, spawn→UI ready 2105 ms
- Steady CPU 0.24 cores (1.5% of the machine), PSS 531.3 MiB, private 404.1 MiB
- GPU render 6.6%, video 0.0%, GPU memory 195.1 MiB, iGPU busy 32.1%
- Processes 15, threads 315; peak PSS 683.8 MiB
- Full report: `out/stress-final/astra-baseline-1tab-r1/REPORT.md`

<!-- RUN:stock-baseline-1tab-r1 -->
## stock · baseline-1tab · repeat 1 — PASS

- Cold start: spawn→Marionette 567 ms, spawn→UI ready 1478 ms
- Steady CPU 0.02 cores (0.1% of the machine), PSS 451.8 MiB, private 371.4 MiB
- GPU render 0.0%, video 0.0%, GPU memory 187.0 MiB, iGPU busy 3.3%
- Processes 13, threads 263; peak PSS 578.9 MiB
- Full report: `out/stress-final/stock-baseline-1tab-r1/REPORT.md`

<!-- RUN:astra-baseline-newtab-r1 -->
## astra · baseline-newtab · repeat 1 — PASS

- Cold start: spawn→Marionette 596 ms, spawn→UI ready 1910 ms
- Steady CPU 0.06 cores (0.3% of the machine), PSS 526.7 MiB, private 404.3 MiB
- GPU render 0.0%, video 0.0%, GPU memory 231.3 MiB, iGPU busy 3.4%
- Processes 14, threads 286; peak PSS 674.6 MiB
- Full report: `out/stress-final/astra-baseline-newtab-r1/REPORT.md`

<!-- RUN:stock-baseline-newtab-r1 -->
## stock · baseline-newtab · repeat 1 — PASS

- Cold start: spawn→Marionette 567 ms, spawn→UI ready 1414 ms
- Steady CPU 0.02 cores (0.1% of the machine), PSS 449.5 MiB, private 371.2 MiB
- GPU render 0.0%, video 0.0%, GPU memory 164.3 MiB, iGPU busy 3.7%
- Processes 13, threads 266; peak PSS 560.2 MiB
- Full report: `out/stress-final/stock-baseline-newtab-r1/REPORT.md`

<!-- RUN:astra-tabs-8static-r1 -->
## astra · tabs-8static · repeat 1 — PASS

- Cold start: spawn→Marionette 601 ms, spawn→UI ready 1918 ms
- Steady CPU 0.29 cores (1.8% of the machine), PSS 589.7 MiB, private 459.1 MiB
- GPU render 5.7%, video 0.0%, GPU memory 200.6 MiB, iGPU busy 31.0%
- Processes 18, threads 400; peak PSS 734.9 MiB
- Full report: `out/stress-final/astra-tabs-8static-r1/REPORT.md`

<!-- RUN:stock-tabs-8static-r1 -->
## stock · tabs-8static · repeat 1 — PASS

- Cold start: spawn→Marionette 555 ms, spawn→UI ready 1478 ms
- Steady CPU 0.08 cores (0.5% of the machine), PSS 514.8 MiB, private 424.9 MiB
- GPU render 0.0%, video 0.0%, GPU memory 207.2 MiB, iGPU busy 3.0%
- Processes 16, threads 347; peak PSS 655.1 MiB
- Full report: `out/stress-final/stock-tabs-8static-r1/REPORT.md`

<!-- RUN:astra-video-2-r1 -->
## astra · video-2 · repeat 1 — PASS

- Cold start: spawn→Marionette 628 ms, spawn→UI ready 1906 ms
- Steady CPU 0.28 cores (1.7% of the machine), PSS 631.4 MiB, private 482.4 MiB
- GPU render 1.0%, video 5.4%, GPU memory 312.9 MiB, iGPU busy 59.2%
- Processes 15, threads 374; peak PSS 761.4 MiB
- Full report: `out/stress-final/astra-video-2-r1/REPORT.md`

<!-- RUN:stock-video-2-r1 -->
## stock · video-2 · repeat 1 — PASS

- Cold start: spawn→Marionette 583 ms, spawn→UI ready 1464 ms
- Steady CPU 0.23 cores (1.5% of the machine), PSS 548.3 MiB, private 446.3 MiB
- GPU render 0.9%, video 4.2%, GPU memory 273.5 MiB, iGPU busy 49.6%
- Processes 14, threads 320; peak PSS 646.0 MiB
- Full report: `out/stress-final/stock-video-2-r1/REPORT.md`

<!-- RUN:astra-video-6-r1 -->
## astra · video-6 · repeat 1 — PASS

- Cold start: spawn→Marionette 618 ms, spawn→UI ready 1916 ms
- Steady CPU 0.52 cores (3.2% of the machine), PSS 702.6 MiB, private 551.0 MiB
- GPU render 1.2%, video 15.7%, GPU memory 488.1 MiB, iGPU busy 78.4%
- Processes 17, threads 465; peak PSS 837.6 MiB
- Full report: `out/stress-final/astra-video-6-r1/REPORT.md`

<!-- RUN:stock-video-6-r1 -->
## stock · video-6 · repeat 1 — PASS

- Cold start: spawn→Marionette 571 ms, spawn→UI ready 1452 ms
- Steady CPU 0.34 cores (2.1% of the machine), PSS 632.4 MiB, private 522.7 MiB
- GPU render 0.8%, video 6.4%, GPU memory 317.2 MiB, iGPU busy 49.9%
- Processes 15, threads 403; peak PSS 733.7 MiB
- Full report: `out/stress-final/stock-video-6-r1/REPORT.md`

<!-- RUN:astra-3d-1-r1 -->
## astra · 3d-1 · repeat 1 — PASS

- Cold start: spawn→Marionette 620 ms, spawn→UI ready 1884 ms
- Steady CPU 0.52 cores (3.3% of the machine), PSS 547.2 MiB, private 419.8 MiB
- GPU render 49.4%, video 0.0%, GPU memory 231.1 MiB, iGPU busy 89.7%
- Processes 15, threads 315; peak PSS 726.7 MiB
- Full report: `out/stress-final/astra-3d-1-r1/REPORT.md`

<!-- RUN:stock-3d-1-r1 -->
## stock · 3d-1 · repeat 1 — PASS

- Cold start: spawn→Marionette 584 ms, spawn→UI ready 1456 ms
- Steady CPU 0.33 cores (2.0% of the machine), PSS 486.0 MiB, private 405.4 MiB
- GPU render 48.8%, video 0.0%, GPU memory 188.4 MiB, iGPU busy 83.5%
- Processes 13, threads 265; peak PSS 640.9 MiB
- Full report: `out/stress-final/stock-3d-1-r1/REPORT.md`

<!-- RUN:astra-3d-4-r1 -->
## astra · 3d-4 · repeat 1 — PASS

- Cold start: spawn→Marionette 620 ms, spawn→UI ready 1952 ms
- Steady CPU 0.77 cores (4.8% of the machine), PSS 611.0 MiB, private 477.4 MiB
- GPU render 51.5%, video 0.0%, GPU memory 391.1 MiB, iGPU busy 88.3%
- Processes 18, threads 412; peak PSS 776.4 MiB
- Full report: `out/stress-final/astra-3d-4-r1/REPORT.md`

<!-- RUN:stock-3d-4-r1 -->
## stock · 3d-4 · repeat 1 — PASS

- Cold start: spawn→Marionette 599 ms, spawn→UI ready 1487 ms
- Steady CPU 0.31 cores (1.9% of the machine), PSS 487.6 MiB, private 398.3 MiB
- GPU render 45.2%, video 0.0%, GPU memory 253.4 MiB, iGPU busy 77.9%
- Processes 16, threads 357; peak PSS 615.4 MiB
- Full report: `out/stress-final/stock-3d-4-r1/REPORT.md`

<!-- RUN:astra-mixed-8-r1 -->
## astra · mixed-8 · repeat 1 — PASS

- Cold start: spawn→Marionette 614 ms, spawn→UI ready 1935 ms
- Steady CPU 5.72 cores (35.8% of the machine), PSS 686.5 MiB, private 532.4 MiB
- GPU render 1.1%, video 5.4%, GPU memory 370.8 MiB, iGPU busy 76.6%
- Processes 17, threads 438; peak PSS 811.0 MiB
- Full report: `out/stress-final/astra-mixed-8-r1/REPORT.md`

<!-- RUN:stock-mixed-8-r1 -->
## stock · mixed-8 · repeat 1 — PASS

- Cold start: spawn→Marionette 569 ms, spawn→UI ready 1434 ms
- Steady CPU 4.28 cores (26.8% of the machine), PSS 607.9 MiB, private 498.8 MiB
- GPU render 1.1%, video 4.2%, GPU memory 295.1 MiB, iGPU busy 76.6%
- Processes 15, threads 383; peak PSS 732.9 MiB
- Full report: `out/stress-final/stock-mixed-8-r1/REPORT.md`

<!-- RUN:astra-memory-6-r1 -->
## astra · memory-6 · repeat 1 — PASS

- Cold start: spawn→Marionette 618 ms, spawn→UI ready 1976 ms
- Steady CPU 0.31 cores (2.0% of the machine), PSS 1048.9 MiB, private 918.6 MiB
- GPU render 6.1%, video 0.0%, GPU memory 193.3 MiB, iGPU busy 49.1%
- Processes 18, threads 401; peak PSS 1173.1 MiB
- Full report: `out/stress-final/astra-memory-6-r1/REPORT.md`

<!-- RUN:stock-memory-6-r1 -->
## stock · memory-6 · repeat 1 — PASS

- Cold start: spawn→Marionette 580 ms, spawn→UI ready 1498 ms
- Steady CPU 0.02 cores (0.1% of the machine), PSS 981.1 MiB, private 891.2 MiB
- GPU render 0.0%, video 0.0%, GPU memory 199.3 MiB, iGPU busy 38.8%
- Processes 16, threads 347; peak PSS 1113.1 MiB
- Full report: `out/stress-final/stock-memory-6-r1/REPORT.md`

<!-- RUN:astra-ui-tour-r1 -->
## astra · ui-tour · repeat 1 — PASS

- Cold start: spawn→Marionette 624 ms, spawn→UI ready 1912 ms
- Steady CPU 0.42 cores (2.6% of the machine), PSS 619.4 MiB, private 488.5 MiB
- GPU render 3.6%, video 0.0%, GPU memory 235.1 MiB, iGPU busy 45.9%
- Processes 17, threads 398; peak PSS 729.5 MiB
- Full report: `out/stress-final/astra-ui-tour-r1/REPORT.md`

<!-- RUN:stock-ui-tour-r1 -->
## stock · ui-tour · repeat 1 — PASS

- Cold start: spawn→Marionette 582 ms, spawn→UI ready 1456 ms
- Steady CPU 0.20 cores (1.3% of the machine), PSS 573.9 MiB, private 483.4 MiB
- GPU render 2.2%, video 0.0%, GPU memory 158.9 MiB, iGPU busy 53.3%
- Processes 15, threads 344; peak PSS 695.9 MiB
- Full report: `out/stress-final/stock-ui-tour-r1/REPORT.md`


#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""bench_scroll_switch: scrolling smoothness + tab-switch latency (P4-T10).

Method (local fixtures only, headless, stdlib):
- Tab switch: open 10 tabs on distinct fixture URLs, then round-robin
  switch+read-title 20x via WebDriver; report median switch ms.
- Scroll: load tall.html, run an async rAF probe that sweeps the full page
  in 40 steps and records per-frame deltas; report median frame ms, p95
  frame ms, and total sweep ms. Also a sync main-thread sweep cost.
Caveat (recorded in PERF.md): headless uses a software compositor, so frame
numbers are a relative proxy for jank, comparable across Astra-vs-stock runs
on the same machine, not absolute display-VSync claims.

Usage: bench_scroll_switch.py [--runs 3] [--json out.json]
Exit: 0 PASS, 1 FAIL, 2 SKIP (no binary/geckodriver).
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

SCROLL_PROBE = """
const done = arguments[arguments.length - 1];
// Headless software-GL builds may never fire rAF (no vsync source), so the
// sweep itself is timer-driven with forced reflow per step (real main-thread
// layout cost). A parallel rAF loop only counts how many frames the compositor
// produced during the sweep; zero is an honest headless signal, not a hang.
const max = document.body.scrollHeight - window.innerHeight;
const steps = 20;
const deltas = [];
let rafFrames = 0;
let spinning = true;
function raf() { if (spinning) { rafFrames++; requestAnimationFrame(raf); } }
requestAnimationFrame(raf);
let i = 0;
let last = performance.now();
window.scrollTo(0, 0);
void document.body.offsetHeight;
function step() {
  const now = performance.now();
  deltas.push(now - last);
  last = now;
  i++;
  window.scrollTo(0, max * i / steps);
  void document.body.offsetHeight;
  if (i < steps) setTimeout(step, 16);
  else {
    spinning = false;
    done({ steps: steps, deltas: deltas, raf_frames: rafFrames,
           total_ms: deltas.reduce((a, b) => a + b, 0) });
  }
}
setTimeout(step, 16);
"""

SYNC_SWEEP = """
const max = document.body.scrollHeight - window.innerHeight;
const t0 = performance.now();
for (let i = 0; i <= 40; i++) {
  window.scrollTo(0, max * i / 40);
  void document.body.offsetHeight;
}
return performance.now() - t0;
"""


def one_run(binary, gd_bin):
    gd = common.Geckodriver(binary, gd_bin)
    try:
        gd.start()
        gd.wd("POST", f"/session/{gd.session}/timeouts", {"script": 120000})
        with common.FixtureServer() as server:
            gd.navigate(server.url("blank.html"))
            for i in range(9):
                gd.new_tab(server.url(f"article.html?i={i}"))
            handles = gd.handles()
            assert len(handles) == 10, f"expected 10 tabs, got {len(handles)}"
            switch_ms = []
            for k in range(20):
                h = handles[k % len(handles)]
                t0 = time.monotonic()
                gd.switch(h)
                gd.title()
                switch_ms.append((time.monotonic() - t0) * 1000.0)
            gd.switch(handles[0])
            gd.navigate(server.url("tall.html"))
            time.sleep(3)
            probe = gd.execute_async(SCROLL_PROBE)
            sweep_ms = gd.execute(SYNC_SWEEP)
            return {
                "switch_ms": switch_ms,
                "step_deltas_ms": probe["deltas"],
                "sweep_total_ms": probe["total_ms"],
                "raf_frames": probe["raf_frames"],
                "sync_sweep_ms": sweep_ms,
            }
    finally:
        gd.stop()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    binary, b_origin = common.resolve_binary()
    gd_bin, gd_origin = common.resolve_geckodriver()
    result = {
        "bench": "scroll_switch",
        "binary": binary, "binary_origin": b_origin,
        "binary_version": common.firefox_version(binary) if binary else None,
        "geckodriver": gd_bin, "geckodriver_origin": gd_origin,
    }
    if not binary or not gd_bin:
        result.update(status="SKIP", reason=f"binary={b_origin} geckodriver={gd_origin}")
        print(f"SKIP scroll_switch: {result['reason']}")
        return _emit(args.json, result, 2)

    runs = []
    try:
        for i in range(args.runs):
            print(f"scroll_switch run {i + 1}/{args.runs} ...", flush=True)
            runs.append(one_run(binary, gd_bin))
    except Exception as e:
        result.update(status="FAIL", reason=f"{e!r}")
        print(f"FAIL scroll_switch: {e!r}")
        return _emit(args.json, result, 1)

    all_switch = [x for r in runs for x in r["switch_ms"]]
    all_steps = [x for r in runs for x in r["step_deltas_ms"]]
    result.update(
        status="PASS",
        switch_ms_median=round(common.median(all_switch), 2),
        switch_ms_p95=round(common.percentile(all_switch, 95), 2),
        scroll_step_ms_median=round(common.median(all_steps), 2),
        scroll_step_ms_p95=round(common.percentile(all_steps, 95), 2),
        raf_frames_per_sweep=[r["raf_frames"] for r in runs],
        sweep_total_ms_median=round(common.median([r["sweep_total_ms"] for r in runs]), 1),
        sync_sweep_ms_median=round(common.median([r["sync_sweep_ms"] for r in runs]), 1),
        runs=len(runs),
        unit="ms; headless software compositor (relative proxy, see PERF.md)",
    )
    print(f"PASS scroll_switch: switch median {result['switch_ms_median']}ms "
          f"p95 {result['switch_ms_p95']}ms; scroll-step median {result['scroll_step_ms_median']}ms "
          f"p95 {result['scroll_step_ms_p95']}ms; raf frames {result['raf_frames_per_sweep']}; "
          f"sync sweep {result['sync_sweep_ms_median']}ms")
    return _emit(args.json, result, 0)


def _emit(json_path, result, rc):
    if json_path:
        with open(json_path, "w") as f:
            json.dump(result, f, indent=1)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

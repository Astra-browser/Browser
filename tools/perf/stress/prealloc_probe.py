#!/usr/bin/env python3
"""Measure the cost of preallocated content processes on a settled boot.

Launches the built Astra on the private Weston display with
`dom.ipc.processPrelaunch.fission.number` = 3 and 1, then compares the process
table and PSS after the window settles. Read-only; no pref is changed in the
product or the user's profile.

Usage:
  tools/perf/hidden-display.sh python3 tools/perf/stress/prealloc_probe.py
"""
import json
import os
import shutil
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, HERE)

import run_matrix as R
from profiler import Sampler


def one(prealloc, port, outroot):
    out = os.path.join(outroot, f"prealloc-{prealloc}")
    profile = os.path.join(out, "profile")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(profile)
    with open(os.path.join(profile, "user.js"), "w", encoding="utf-8") as fh:
        fh.write(f'user_pref("marionette.port", {port});\nuser_pref("astra.onboarding.force", "skip");\n')
        fh.write('user_pref("browser.shell.checkDefaultBrowser", false);\n')
        fh.write('user_pref("browser.aboutwelcome.enabled", false);\n')
        fh.write('user_pref("datareporting.policy.dataSubmissionEnabled", false);\n')
        fh.write(f'user_pref("dom.ipc.processPrelaunch.fission.number", {prealloc});\n')
    run = R.BrowserRun("astra", out, profile, port, 1)
    sampler = Sampler(0, out, interval=0.5, label=f"prealloc-{prealloc}")
    try:
        run.launch(sampler)
        run.connect(sampler)
        run.wait_ready(sampler)
        time.sleep(4.0)
        rows = sampler.samples[-6:]
        if not rows:
            return {"prealloc": prealloc, "error": "no samples"}
        last = rows[-1]
        kinds = {k: v["procs"] for k, v in last["by_kind"].items()}
        return {
            "prealloc": prealloc,
            "boot_ms": run.timings.get("spawn_to_ui_ready_ms"),
            "processes": last["browser"]["procs"],
            "content_procs": sum(v["procs"] for k, v in last["by_kind"].items() if k == "content"),
            "kinds": kinds,
            "pss_mb": round(statistics.fmean([r["browser"]["pss_mb"] for r in rows]), 1),
            "private_mb": round(statistics.fmean([r["browser"]["private_mb"] for r in rows]), 1),
        }
    finally:
        sampler.stop()
        run.close()


def main():
    outroot = os.path.join(ROOT, "out", "prealloc-probe")
    shutil.rmtree(outroot, ignore_errors=True)
    os.makedirs(outroot)
    results = []
    for i, prealloc in enumerate((3, 1)):
        results.append(one(prealloc, 2845 + i, outroot))
    print(json.dumps(results, indent=2))
    with open(os.path.join(outroot, "results.json"), "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())

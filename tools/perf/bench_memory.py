#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""bench_memory: RAM at 10 and 50 tabs (P4-T10). Stdlib only.

Method: drive the browser via geckodriver (headless), open N tabs each on a
distinct local-fixture URL (article.html?i=K, cache-shared like real
browsing), then sum VmRSS over every process whose cmdline contains the
profile path. Reports total MiB and per-tab KiB for N=10 and N=50, plus a
single-tab baseline. Then attempts tab discard via chrome-context
gBrowser.discardBrowser (the P4-T06 sleeping mechanism); when the build has
no such path the sleeping number is reported as SKIP with the reason, and
the loaded-tab RAM stands as the conservative upper bound.

Usage: bench_memory.py [--runs 3] [--json out.json] [--tabs 10,50]
Exit: 0 PASS, 1 FAIL, 2 SKIP (no binary/geckodriver).
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

DISCARD_SCRIPT = """
const S = (typeof Services !== "undefined") ? Services
      : ChromeUtils.importESModule(
      "resource://gre/modules/Services.sys.mjs").Services;
const win = S.wm.getMostRecentWindow("navigator:browser");
if (!win || !win.gBrowser) {
  return "unsupported:no-browser-window";
}
if (typeof win.gBrowser.discardBrowser !== "function") {
  return "unsupported:no-discardBrowser";
}
let n = 0;
for (const tab of win.gBrowser.tabs) {
  if (!tab.selected) { win.gBrowser.discardBrowser(tab); n++; }
}
return "discarded:" + n;
"""


def measure_tabs(gd, server, n, profile):
    # Session holds exactly 1 tab on entry; open n-1 more.
    gd.navigate(server.url("blank.html"))
    for i in range(n - 1):
        gd.new_tab(server.url(f"article.html?i={i}"))
    # Let navigations settle so RSS reflects loaded tabs, not in-flight ones.
    time.sleep(8 if n <= 10 else 20)
    total_kb, procs = common.proc_rss_kb(profile)
    try:
        discard = gd.chrome(DISCARD_SCRIPT)
    except Exception as e:
        discard = f"error: {e}"
    sleeping_kb, sleeping_procs = None, None
    if isinstance(discard, str) and discard.startswith("discarded:"):
        time.sleep(5)
        sleeping_kb, sleeping_procs = common.proc_rss_kb(profile)
    return {
        "tabs": n,
        "total_kb": total_kb,
        "procs": procs,
        "system_access": getattr(gd, "system_access", True),
        "discard": discard,
        "sleeping_kb": sleeping_kb,
        "sleeping_procs": sleeping_procs,
    }


def one_run(binary, gd_bin, tab_counts):
    out = {"counts": []}
    with common.FixtureServer() as server:
        for n in tab_counts:
            gd = common.Geckodriver(binary, gd_bin)
            try:
                gd.start()
                profile = gd.profile
                # Fresh session per count: settle, then take a same-session
                # single-tab baseline so per-tab cost is computed likeWISE.
                time.sleep(3)
                base_kb, base_procs = common.proc_rss_kb(profile)
                entry = measure_tabs(gd, server, n, profile)
                entry.update(session_baseline_kb=base_kb,
                             session_baseline_procs=base_procs)
                out["counts"].append(entry)
            finally:
                gd.stop()
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--tabs", default="10,50")
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)
    tab_counts = [int(x) for x in args.tabs.split(",") if x.strip()]

    binary, b_origin = common.resolve_binary()
    gd_bin, gd_origin = common.resolve_geckodriver()
    result = {
        "bench": "memory",
        "binary": binary, "binary_origin": b_origin,
        "binary_version": common.firefox_version(binary) if binary else None,
        "geckodriver": gd_bin, "geckodriver_origin": gd_origin,
    }
    if not binary or not gd_bin:
        result.update(status="SKIP", reason=f"binary={b_origin} geckodriver={gd_origin}")
        print(f"SKIP memory: {result['reason']}")
        return _emit(args.json, result, 2)

    runs = []
    try:
        for i in range(args.runs):
            # One retry per run: a session-start can fail under load
            # (stale profile lock, port race); stop() reaps orphans, the
            # retry then starts clean. A double failure is a real FAIL.
            last_exc = None
            for attempt in (1, 2):
                try:
                    print(f"memory run {i + 1}/{args.runs} (attempt {attempt}) ...", flush=True)
                    runs.append(one_run(binary, gd_bin, tab_counts))
                    last_exc = None
                    break
                except Exception as e:
                    last_exc = e
                    print(f"memory run {i + 1} attempt {attempt} failed: {e!r}", flush=True)
                    time.sleep(10)
            if last_exc is not None:
                raise last_exc
    except Exception as e:
        result.update(status="FAIL", reason=f"{e!r}")
        print(f"FAIL memory: {e!r}")
        return _emit(args.json, result, 1)

    summary = {}
    for n in tab_counts:
        entries = []
        for r in runs:
            c = r["counts"][[c["tabs"] for c in r["counts"]].index(n)]
            entries.append((c["total_kb"], c["session_baseline_kb"]))
        totals = [t for t, _ in entries]
        summary[str(n)] = {
            "total_kb_median": int(common.median(totals)),
            "per_tab_kb_median": int(common.median([(t - b) / n for t, b in entries])),
            "runs_kb": totals,
        }
    baselines = [r["counts"][0]["session_baseline_kb"] for r in runs]
    sleep_vals = [c["sleeping_kb"] for r in runs for c in r["counts"]
                  if c["tabs"] == max(tab_counts) and c["sleeping_kb"]]
    discards = {str(sorted({str(c["discard"]) for r in runs for c in r["counts"]}))}
    result.update(
        status="PASS",
        baseline_kb_median=int(common.median(baselines)),
        summary=summary,
        sleeping_kb_median=(int(common.median(sleep_vals)) if sleep_vals else None),
        discard_probes=sorted(discards),
        unit="KiB summed VmRSS over browser process group (headless, local fixtures)",
    )
    print(f"PASS memory: baseline={result['baseline_kb_median']}KiB " +
          " ".join(f"{k}tabs={v['total_kb_median']}KiB" for k, v in summary.items()))
    if result["sleeping_kb_median"]:
        print(f"  sleeping@{max(tab_counts)}tabs={result['sleeping_kb_median']}KiB")
    else:
        print(f"  sleeping: SKIP ({result['discard_probes']})")
    return _emit(args.json, result, 0)


def _emit(json_path, result, rc):
    if json_path:
        with open(json_path, "w") as f:
            json.dump(result, f, indent=1)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

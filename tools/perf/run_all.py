#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""run_all: run every P4-T10 benchmark, aggregate, emit report (stdlib only).

Runs bench_startup, bench_memory, bench_scroll_switch, bench_blocker with
--runs 3, collects each JSON into out/perf-<UTC ts>/, writes results.json and
a SUMMARY.md markdown table, prints the table. Exit 0 unless some bench
FAILs (SKIPs are recorded, not failures -- e.g. no browser on a worker box).

Usage: run_all.py [--runs 3] [--out DIR]
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

PERF_DIR = os.path.dirname(os.path.abspath(__file__))
BENCHES = ["bench_startup", "bench_memory", "bench_scroll_switch", "bench_blocker"]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    outdir = args.out or os.path.join(PERF_DIR, "..", "..", "out", f"perf-{ts}")
    os.makedirs(outdir, exist_ok=True)

    collected = {}
    worst = 0
    for bench in BENCHES:
        dest = os.path.join(outdir, f"{bench}.json")
        print(f"=== {bench} ===", flush=True)
        rc = subprocess.run(
            [sys.executable, os.path.join(PERF_DIR, f"{bench}.py"),
             "--runs", str(args.runs), "--json", dest],
            timeout=1800,
        ).returncode
        try:
            with open(dest) as f:
                collected[bench] = json.load(f)
        except (OSError, ValueError):
            collected[bench] = {"bench": bench, "status": "FAIL",
                                "reason": "no parsable JSON emitted"}
            rc = 1
        worst = max(worst, 1 if rc == 1 else 0)
        print(f"--- {bench}: rc={rc} status={collected[bench].get('status')}", flush=True)

    with open(os.path.join(outdir, "results.json"), "w") as f:
        json.dump(collected, f, indent=1)
    summary = render_summary(collected)
    with open(os.path.join(outdir, "SUMMARY.md"), "w") as f:
        f.write(summary)
    print()
    print(summary)
    print(f"artifacts: {outdir}")
    return 1 if worst else 0


def _cell(collected, bench, *keys):
    v = collected.get(bench, {}).get(keys[0])
    for k in keys[1:]:
        v = (v or {}).get(k) if isinstance(v, dict) else None
    if v is None:
        return "—"
    return str(v)


def render_summary(collected):
    L = ["# Astra perf summary (P4-T10)", ""]
    bv = next((c.get("binary_version") for c in collected.values() if c.get("binary_version")), "—")
    L.append(f"Binary: {bv}")
    L.append("")
    L.append("| Bench | Status | Key numbers |")
    L.append("|---|---|---|")
    s = collected.get("bench_startup", {})
    L.append(f"| startup | {s.get('status')} | cold {s.get('cold_s', '—')}s / warm {s.get('warm_s', '—')}s |")
    m = collected.get("bench_memory", {})
    mem = "; ".join(f"{k}tabs={v.get('total_kb_median', '—')}KiB"
                    for k, v in (m.get("summary") or {}).items()) or "—"
    L.append(f"| memory | {m.get('status')} | baseline {m.get('baseline_kb_median', '—')}KiB; {mem}"
             f" (sleeping {m.get('sleeping_kb_median', '—')}KiB) |")
    w = collected.get("bench_scroll_switch", {})
    L.append(f"| scroll/switch | {w.get('status')} | switch median {w.get('switch_ms_median', '—')}ms "
             f"p95 {w.get('switch_ms_p95', '—')}ms; scroll-step median {w.get('scroll_step_ms_median', '—')}ms "
             f"p95 {w.get('scroll_step_ms_p95', '—')}ms; raf {w.get('raf_frames_per_sweep', '—')} |")
    b = collected.get("bench_blocker", {})
    L.append(f"| blocker (in-process) | {b.get('status')} | rules {b.get('rule_count', '—')}; "
             f"p50 {b.get('p50_ns_median', '—')}ns p95 {b.get('p95_ns_median', '—')}ns "
             f"p99 {b.get('p99_ns_median', '—')}ns |")
    L.append("")
    L.append("Budgets: cold start <= stock ESR +15%; 50-tab sleeping RAM <= stock ESR; "
             "blocker p95 overhead within P4-T02 budget (set when the network hook lands). "
             "Stock ESR column is TODO (see docs/astra/PERF.md).")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

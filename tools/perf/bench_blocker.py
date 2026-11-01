#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""bench_blocker: astra-blocker in-process matching overhead (P4-T10).

Method: build & run tools/perf/blocker-probe (a Rust binary linking
crates/astra-blocker by path -- no crate changes needed) 3x. The probe loads
the EasyList/EasyPrivacy seed into a Blocker, warms up, then times 30k
in-process check() calls over a deterministic 4k-URL corpus and prints one
JSON object with mean/p50/p95/p99 per-check ns. This driver takes the median
of the 3 runs' p95. Browser-level blocking latency (network-hook path) is
NOT measured here: the in-tree hook lands in P4-T02, and PERF.md records the
method to re-measure once it does.

Usage: bench_blocker.py [--runs 3] [--json out.json] [--rebuild]
Exit: 0 PASS, 1 FAIL, 2 SKIP (cargo build failed, e.g. offline registry gap).
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

PERF_DIR = os.path.dirname(os.path.abspath(__file__))
PROBE = os.path.join(PERF_DIR, "blocker-probe", "Cargo.toml")


def build_probe():
    probe_bin = os.path.join(PERF_DIR, "blocker-probe", "target", "release", "blocker-probe")
    if os.path.exists(probe_bin):
        return probe_bin, "cached"
    r = subprocess.run(
        ["cargo", "build", "--release", "--offline", "--manifest-path", PROBE],
        capture_output=True, text=True, timeout=900,
    )
    if r.returncode != 0 or not os.path.exists(probe_bin):
        return None, (r.stderr.strip()[-2000:] or r.stdout.strip()[-2000:] or "build failed")
    return probe_bin, "built"


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json", default=None)
    ap.add_argument("--rebuild", action="store_true",
                    help="force a fresh release rebuild of the probe")
    args = ap.parse_args(argv)
    result = {"bench": "blocker", "runs_requested": args.runs}

    if args.rebuild:
        import shutil as _sh
        _sh.rmtree(os.path.join(PERF_DIR, "blocker-probe", "target"), ignore_errors=True)

    try:
        probe_bin, how = build_probe()
    except subprocess.TimeoutExpired:
        probe_bin, how = None, "cargo build timed out after 900s"
    if not probe_bin:
        result.update(status="SKIP", reason=f"probe build unavailable: {how}")
        print(f"SKIP blocker: {result['reason']}")
        return _emit(args.json, result, 2)
    result["probe_build"] = how

    runs = []
    try:
        for i in range(args.runs):
            print(f"blocker run {i + 1}/{args.runs} ...", flush=True)
            r = subprocess.run([probe_bin], capture_output=True, text=True, timeout=600)
            if r.returncode != 0:
                result.update(status="FAIL",
                              reason=f"probe exit {r.returncode}: {r.stdout[-500:]} {r.stderr[-500:]}")
                print(f"FAIL blocker: {result['reason']}")
                return _emit(args.json, result, 1)
            runs.append(json.loads(r.stdout.strip().splitlines()[-1]))
    except Exception as e:
        result.update(status="FAIL", reason=f"{e!r}")
        print(f"FAIL blocker: {e!r}")
        return _emit(args.json, result, 1)

    if any(r.get("status") != "PASS" for r in runs):
        result.update(status="FAIL", reason=str(runs))
        print(f"FAIL blocker: {runs}")
        return _emit(args.json, result, 1)

    result.update(
        status="PASS",
        rule_count=runs[0]["rule_count"],
        corpus_size=runs[0]["corpus_size"],
        iters=runs[0]["iters"],
        p50_ns_median=int(common.median([r["p50_ns"] for r in runs])),
        p95_ns_median=int(common.median([r["p95_ns"] for r in runs])),
        p99_ns_median=int(common.median([r["p99_ns"] for r in runs])),
        mean_ns_median=round(common.median([r["mean_ns"] for r in runs]), 1),
        max_ns_median=int(common.median([r["max_ns"] for r in runs])),
        seed_load_ms_median=round(common.median([r["seed_load_ms"] for r in runs]), 1),
        runs_p95_ns=[r["p95_ns"] for r in runs],
        unit="nanoseconds per in-process Blocker::check() (release build)",
    )
    print(f"PASS blocker: rules={result['rule_count']} "
          f"p50={result['p50_ns_median']}ns p95={result['p95_ns_median']}ns "
          f"p99={result['p99_ns_median']}ns seed_load={result['seed_load_ms_median']}ms")
    return _emit(args.json, result, 0)


def _emit(json_path, result, rc):
    if json_path:
        with open(json_path, "w") as f:
            json.dump(result, f, indent=1)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""bench_startup: cold vs warm startup latency (P4-T10). Stdlib only.

Method: spawn the browser headless with --marionette on a dedicated port and
measure spawn -> TCP-listen time (Marionette "Listening on port" moment).
Cold = fresh profile per run (first-run init path). Warm = one prepared
profile reused across runs (steady-state path). 3 runs each, median reported.

This is a startup *proxy*, not first-paint: headless has no compositor, and
screenshot mode is unusable in software-GL containers. The proxy is stable,
local-only, and identical for Astra vs stock ESR, which is what the budget
(cold start <= stock + 15%) compares. First-paint via MozAfterPaint lands
with the BiDi harness (P6 E2E) and is recorded as a TODO in PERF.md.

Usage: bench_startup.py [--runs 3] [--json out.json]
Exit: 0 PASS, 2 SKIP (no binary).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common

ENV = {"MOZ_HEADLESS": "1"}


def one_startup(binary, profile, port, fresh):
    if fresh:
        shutil.rmtree(profile, ignore_errors=True)
    os.makedirs(profile, exist_ok=True)
    # Marionette has no --marionette-port CLI flag; the port comes from the
    # profile (same mechanism geckodriver uses). Rewrite it per run so
    # parallel/sequential runs never collide on the default 2828.
    with open(os.path.join(profile, "user.js"), "w") as f:
        f.write(f'user_pref("marionette.port", {port});\nuser_pref("astra.onboarding.force", "skip");\n')
        f.write('user_pref("marionette.enabled", true);\n')
    env = dict(os.environ)
    env.update(ENV)
    # Fresh profiles print first-run noise; silence stdout, keep stderr tail.
    proc = subprocess.Popen(
        [binary, "--headless", "--no-remote", "--profile", profile,
         "--marionette", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )
    try:
        waited = common.wait_tcp(port, timeout=120.0)
        if waited is None:
            return None
        return waited
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json", default=None)
    args = ap.parse_args(argv)

    binary, origin = common.resolve_binary()
    result = {
        "bench": "startup",
        "binary": binary,
        "binary_origin": origin,
        "binary_version": common.firefox_version(binary) if binary else None,
        "runs_requested": args.runs,
    }
    if not binary:
        result.update(status="SKIP", reason=origin)
        print(f"SKIP startup: {origin}")
        return _emit(args.json, result, 2)

    cold, warm = [], []
    base = tempfile.mkdtemp(prefix="astra-perf-startup-")
    try:
        for i in range(args.runs):
            port = common.free_port()
            t = one_startup(binary, os.path.join(base, f"cold-{i}"), port, True)
            print(f"cold run {i + 1}/{args.runs}: {t:.2f}s" if t else f"cold run {i+1}: TIMEOUT", flush=True)
            if t is None:
                return _fail(args.json, result, "cold startup timed out waiting for Marionette")
            cold.append(t)
        warm_profile = os.path.join(base, "warm")
        # Prepare the warm profile once (untimed), then measure reuse.
        port = common.free_port()
        prep = one_startup(binary, warm_profile, port, True)
        print(f"warm profile prepared in {prep:.2f}s (untimed)" if prep else "warm prep TIMEOUT", flush=True)
        if prep is None:
            return _fail(args.json, result, "warm profile preparation timed out")
        for i in range(args.runs):
            port = common.free_port()
            t = one_startup(binary, warm_profile, port, False)
            print(f"warm run {i + 1}/{args.runs}: {t:.2f}s" if t else f"warm run {i+1}: TIMEOUT", flush=True)
            if t is None:
                return _fail(args.json, result, "warm startup timed out waiting for Marionette")
            warm.append(t)
    finally:
        shutil.rmtree(base, ignore_errors=True)

    result.update(
        status="PASS",
        cold_s=round(common.median(cold), 3),
        warm_s=round(common.median(warm), 3),
        cold_runs=[round(x, 3) for x in cold],
        warm_runs=[round(x, 3) for x in warm],
        unit="seconds spawn->marionette-listen (headless, local only)",
    )
    print(f"PASS startup: cold median {result['cold_s']}s, warm median {result['warm_s']}s")
    return _emit(args.json, result, 0)


def _fail(json_path, result, reason):
    result.update(status="FAIL", reason=reason)
    print(f"FAIL startup: {reason}")
    return _emit(json_path, result, 1)


def _emit(json_path, result, rc):
    if json_path:
        with open(json_path, "w") as f:
            json.dump(result, f, indent=1)
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

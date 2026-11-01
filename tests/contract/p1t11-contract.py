#!/usr/bin/env python3
"""P1-T11 contract entry point: geckodriver/Marionette boots Astra.

Thin shim over tools/contract-runner/run.py (the real harness), kept here
so every contract test has the same shape: `python3 tests/contract/<id>.py`.
Forwards --smoke / --fixture-only. Exit 0 PASS, 1 FAIL, 2 SKIP.
"""
import os
import runpy
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNNER = os.path.join(ROOT, "tools", "contract-runner", "run.py")

if __name__ == "__main__":
    sys.argv = [RUNNER] + sys.argv[1:]
    runpy.run_path(RUNNER, run_name="__main__")
